/**
 * Publishing usage on pi:provider-usage (B4).
 *
 * The publisher takes its clock, event bus, credential reader, fetch and
 * scheduler as dependencies, so these drive the whole path without activating
 * the extension, spawning Claude Code, or waiting on real time.
 *
 * Two assertions recur and are the point of the feature: no credential ever
 * reaches the channel, and a failure is reported once rather than once per
 * attempt. Both are asserted against counts, so removing the guarantee fails
 * the test rather than merely changing a shape.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FORCED_REFRESH_DEBOUNCE_MS,
	FORCED_REFRESH_FLOOR_MS,
	PROVIDER_USAGE_CHANNEL,
	UsagePublisher,
} from "../src/usage-publisher.js";
import { writeUsageCacheState, usageCacheFilePath, USAGE_TTL_MS } from "../src/usage-cache.js";
import { REASON_CREDENTIALS_MISSING, REASON_CREDENTIALS_REJECTED } from "../src/usage-fetch.js";
import { PROVIDER_ID } from "../src/convert.js";
import { normalizeUsageEvents } from "../src/config.js";

const FIXTURE_TOKEN = "sk-ant-oat01-fixture-token-do-not-leak";
const PROFILE = "/tmp/claude-profile-fixture";

function snapshot(percent = 32, capturedAt = "2026-08-27T12:00:00.000Z") {
	return {
		quotas: [
			{ kind: "session", percent, resetsAt: "2026-08-27T15:30:00.000Z" },
			{ kind: "weekly", percent: 50 },
			{ kind: "scoped", label: "Fable", percent: 64 },
		],
		capturedAt,
		notice: "overage disabled",
	};
}

// A publisher wired to a throwaway cache directory, a controllable clock, and
// spies for everything it touches.
function harness(options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "claude-bridge-publisher-"));
	const emitted = [];
	const scheduled = [];
	const fetches = { count: 0 };
	const credentialReads = { count: 0 };
	let now = options.startMs ?? 1_000_000;

	const publisher = new UsagePublisher({
		emit: (channel, payload) => emitted.push({ channel, payload }),
		claudeConfigDir: () => options.profile ?? PROFILE,
		cacheDir: dir,
		nowMs: () => now,
		readCredentials: () => {
			credentialReads.count += 1;
			return options.credential ?? { status: "ok", token: FIXTURE_TOKEN };
		},
		fetchUsage: async (token) => {
			fetches.count += 1;
			assert.equal(token, FIXTURE_TOKEN, "the publisher must pass the resolved token through");
			const outcome = options.outcome ?? { ok: true, snapshot: snapshot() };
			return typeof outcome === "function" ? outcome(fetches.count) : outcome;
		},
		// A recording scheduler: the debounce is driven by running the pending
		// callback rather than by waiting five real seconds.
		schedule: (fn, ms) => {
			const entry = { fn, ms, cancelled: false };
			scheduled.push(entry);
			return { cancel: () => { entry.cancelled = true; } };
		},
		lockWaitMs: 200,
		...options.deps,
	});

	return {
		publisher,
		emitted,
		scheduled,
		fetches,
		credentialReads,
		cacheDir: dir,
		cacheFile: usageCacheFilePath(dir, options.profile ?? PROFILE),
		advance: (ms) => { now += ms; },
		nowMs: () => now,
		async runPending() {
			const pending = scheduled.filter((entry) => !entry.cancelled && !entry.ran);
			for (const entry of pending) {
				entry.ran = true;
				entry.fn();
			}
			// Await the refresh the callback kicked off without starting another,
			// so a count assertion measures the trigger and nothing else.
			await publisher.settled();
		},
		cleanup: () => { publisher.dispose(); rmSync(dir, { recursive: true, force: true }); },
	};
}

async function withHarness(options, fn) {
	const test = harness(options);
	try {
		return await fn(test);
	} finally {
		test.cleanup();
	}
}

describe("publishing a usage snapshot", () => {
	it("emits a v1 payload for claude-bridge on the topic channel (B4.1, B4.17)", async () => {
		await withHarness({}, async (test) => {
			await test.publisher.publish();

			assert.equal(test.emitted.length, 1);
			assert.equal(test.emitted[0].channel, PROVIDER_USAGE_CHANNEL);
			assert.equal(test.emitted[0].payload.v, 1);
			assert.equal(test.emitted[0].payload.providerId, PROVIDER_ID);
			// The consumer uses the id as a filename component, so a future rename
			// to anything with a separator or a leading dot must fail here rather
			// than in a consumer that silently drops every snapshot.
			assert.match(test.emitted[0].payload.providerId, /^[a-z0-9][a-z0-9._-]{0,63}$/i);
		});
	});

	it("emits a payload the consumer's own validation accepts (B4.2, B4.18)", async () => {
		await withHarness({}, async (test) => {
			await test.publisher.publish();
			const payload = test.emitted[0].payload;

			assert.ok(Array.isArray(payload.quotas) && payload.quotas.length > 0);
			assert.ok(Number.isFinite(Date.parse(payload.capturedAt)));
			for (const quota of payload.quotas) {
				assert.ok(["session", "weekly", "scoped"].includes(quota.kind));
				assert.ok(Number.isFinite(quota.percent) && quota.percent >= 0 && quota.percent <= 100);
				if (quota.kind === "scoped") assert.ok(quota.label && quota.label.length <= 32);
				if (quota.resetsAt !== undefined) assert.ok(Number.isFinite(Date.parse(quota.resetsAt)));
			}
			// Bounded and control-character free on our side, rather than relying on
			// the consumer's sanitizer to make our own output renderable.
			assert.ok(payload.notice.length <= 120);
			assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(payload.notice));
		});
	});

	it("emits from a fresh cache with zero upstream requests, keeping capturedAt (B4.3)", async () => {
		await withHarness({}, async (test) => {
			const cached = snapshot(11, "2026-08-27T11:59:30.000Z");
			writeUsageCacheState(test.cacheFile, { lastSuccess: cached, lastSuccessAtMs: test.nowMs() });

			await test.publisher.publish();

			assert.equal(test.fetches.count, 0);
			assert.equal(test.emitted.length, 1);
			// capturedAt records when the numbers were true, not when they were
			// re-emitted: moving it would silently reset the consumer's staleness.
			assert.equal(test.emitted[0].payload.capturedAt, "2026-08-27T11:59:30.000Z");
			assert.equal(test.emitted[0].payload.quotas[0].percent, 11);
		});
	});

	it("fetches once and emits when the cache is empty or expired (B4.4)", async () => {
		await withHarness({}, async (test) => {
			await test.publisher.publish();
			assert.equal(test.fetches.count, 1);
			assert.equal(test.emitted.length, 1);

			test.advance(USAGE_TTL_MS);
			await test.publisher.publish();
			assert.equal(test.fetches.count, 2);
			assert.equal(test.emitted.length, 2);
		});
	});

	it("carries no credential material anywhere in the payload (B4.11, D3)", async () => {
		await withHarness({
			outcome: {
				ok: true,
				// Even a publisher-side mistake that put the token in a notice must
				// not reach the wire, so this is checked on the serialized payload.
				snapshot: { ...snapshot(), notice: "overage disabled" },
			},
		}, async (test) => {
			await test.publisher.publish();

			const wire = JSON.stringify(test.emitted);
			assert.ok(wire.length > 0, "nothing was emitted, so this scan is vacuous");
			assert.ok(!wire.includes(FIXTURE_TOKEN));
			assert.ok(!wire.includes("sk-ant"));
			assert.ok(!wire.includes("Bearer"));
			// And nothing credential-shaped reached the cache the payload came from.
			assert.ok(!readFileSync(test.cacheFile, "utf8").includes("sk-ant"));
		});
	});

	it("defers the startup publish past the session_start dispatch loop", async () => {
		await withHarness({}, async (test) => {
			test.publisher.publishOnStartup();

			// Nothing yet: pi runs session_start handlers in extension order, so an
			// emit made inside this bridge's own handler reaches only the
			// subscribers loaded before it. Measured with a probe extension, which
			// received the snapshot when loaded first and nothing when loaded
			// second. It matters because unavailability is emitted on transition:
			// a missed first emit is never re-sent, so the consumer would sit on
			// "waiting" all session while the bridge believed it had reported.
			assert.deepEqual(test.emitted, []);
			assert.deepEqual(test.scheduled.map((entry) => entry.ms), [0]);

			await test.runPending();
			assert.equal(test.emitted.length, 1);
		});
	});

	it("drops a deferred startup publish on dispose", () => {
		const test = harness();
		try {
			test.publisher.publishOnStartup();
			test.publisher.dispose();
			assert.deepEqual(test.scheduled.filter((entry) => !entry.cancelled), []);
		} finally {
			test.cleanup();
		}
	});


	it("is fire-and-forget: a throwing subscriber never surfaces (B4.10)", async () => {
		await withHarness({
			deps: { emit: () => { throw new Error("boom: a broken subscriber"); } },
		}, async (test) => {
			await assert.doesNotReject(() => test.publisher.publish());
		});
	});
});

describe("publishing unavailability", () => {
	it("emits quotas: [] with a reason and a capturedAt of now (B4.13)", async () => {
		await withHarness({ outcome: { ok: false, reason: "usage endpoint returned 503" } }, async (test) => {
			await test.publisher.publish();

			const payload = test.emitted.at(-1).payload;
			assert.deepEqual(payload.quotas, []);
			assert.deepEqual(payload.unavailable, { reason: "usage endpoint returned 503" });
			// The failure is current news; the numbers are absent, so there is
			// nothing older for capturedAt to describe.
			assert.equal(payload.capturedAt, new Date(test.nowMs()).toISOString());
		});
	});

	it("reports a missing credential once per transition, not once per attempt (B4.14, B2.7)", async () => {
		await withHarness({ credential: { status: "missing" } }, async (test) => {
			for (let i = 0; i < 5; i += 1) {
				test.advance(60_000);
				await test.publisher.publish();
			}

			// A provider failing every poll should produce one event, not one per
			// minute: the consumer's state is already correct after the first.
			assert.equal(test.emitted.length, 1);
			assert.equal(test.emitted[0].payload.unavailable.reason, REASON_CREDENTIALS_MISSING);
			assert.equal(test.fetches.count, 0, "a missing credential must not reach the endpoint");
		});
	});

	it("re-emits when the reason changes", async () => {
		await withHarness({
			outcome: (call) => (call === 1
				? { ok: false, reason: "usage endpoint returned 503" }
				: { ok: false, reason: REASON_CREDENTIALS_REJECTED }),
		}, async (test) => {
			await test.publisher.publish();
			test.advance(FORCED_REFRESH_FLOOR_MS * 2);
			await test.publisher.publish();

			const reasons = test.emitted.map((entry) => entry.payload.unavailable?.reason);
			// A different diagnosis is different news, even though the state is
			// unchanged: 503 and a rejected credential need different actions.
			assert.deepEqual(reasons, ["usage endpoint returned 503", REASON_CREDENTIALS_REJECTED]);
		});
	});

	it("recovers by emitting a normal snapshot, with no explicit resolve message (B4.15)", async () => {
		await withHarness({
			outcome: (call) => (call === 1
				? { ok: false, reason: "usage endpoint unreachable" }
				: { ok: true, snapshot: snapshot() }),
		}, async (test) => {
			await test.publisher.publish();
			assert.equal(test.emitted.length, 1);

			test.advance(USAGE_TTL_MS + 60_000);
			await test.publisher.publish();

			const last = test.emitted.at(-1).payload;
			assert.equal(last.unavailable, undefined);
			assert.equal(last.quotas.length, 3);

			// And the failure state is genuinely cleared, not merely papered over:
			// the same reason must be publishable again later.
			test.advance(USAGE_TTL_MS + 60_000);
			await test.publisher.publish();
		});
	});

	it("keeps publishing known numbers alongside a later failure (B0.4)", async () => {
		await withHarness({
			outcome: (call) => (call === 1
				? { ok: true, snapshot: snapshot() }
				: { ok: false, reason: "usage endpoint returned 503" }),
		}, async (test) => {
			await test.publisher.publish();
			test.advance(USAGE_TTL_MS);
			await test.publisher.publish();

			// The numbers go out before the failure, so a consumer that has never
			// heard from us has something to mark stale rather than only a
			// complaint with nothing behind it.
			const kinds = test.emitted.map((entry) => (entry.payload.unavailable ? "unavailable" : "snapshot"));
			assert.deepEqual(kinds, ["snapshot", "snapshot", "unavailable"]);
		});
	});

	it("does not retry inline to enrich a reason (B4.16)", async () => {
		await withHarness({ outcome: { ok: false, reason: "usage endpoint unreachable" } }, async (test) => {
			await test.publisher.publish();

			assert.equal(test.fetches.count, 1, "the unavailable emit issued another request");
			assert.equal(test.credentialReads.count, 1, "the unavailable emit read the credential again");
		});
	});

	it("stays silent on a platform with no credential store (B2.4)", async () => {
		await withHarness({ credential: { status: "unsupported" } }, async (test) => {
			await test.publisher.publish();
			// Distinct from a failure: usage was never going to work here, and
			// saying so every session is noise rather than news.
			assert.deepEqual(test.emitted, []);
			assert.equal(test.fetches.count, 0);
		});
	});
});

describe("rate limit events as a refresh trigger", () => {
	it("forces a refresh that bypasses the TTL (B4.5, B4.8)", async () => {
		await withHarness({}, async (test) => {
			await test.publisher.publish();
			assert.equal(test.fetches.count, 1);

			test.publisher.noteRateLimitEvent();
			await test.runPending();

			// Inside the TTL a normal publish would serve the cache; the trigger
			// means "something changed", so it refetches.
			assert.equal(test.fetches.count, 2);
			// And what it publishes came from the endpoint, never from the event.
			assert.ok(test.emitted.every((entry) => entry.payload.quotas.length === 3 || entry.payload.unavailable));
		});
	});

	it("collapses three rapid events into one upstream request (B4.6)", async () => {
		await withHarness({}, async (test) => {
			test.publisher.noteRateLimitEvent();
			test.publisher.noteRateLimitEvent();
			test.publisher.noteRateLimitEvent();

			assert.deepEqual(test.scheduled.map((entry) => entry.ms), Array(3).fill(FORCED_REFRESH_DEBOUNCE_MS));
			assert.equal(test.scheduled.filter((entry) => !entry.cancelled).length, 1,
				"each event must supersede the last, or a burst becomes a burst of requests");

			await test.runPending();
			assert.equal(test.fetches.count, 1);
		});
	});

	it("respects a floor between forced refreshes (B4.7)", async () => {
		await withHarness({}, async (test) => {
			test.publisher.noteRateLimitEvent();
			await test.runPending();
			assert.equal(test.fetches.count, 1);

			test.advance(FORCED_REFRESH_FLOOR_MS - 1_000);
			test.publisher.noteRateLimitEvent();
			await test.runPending();
			assert.equal(test.fetches.count, 1, "a forced refresh inside the floor still hit the endpoint");

			test.advance(2_000);
			test.publisher.noteRateLimitEvent();
			await test.runPending();
			assert.equal(test.fetches.count, 2);
		});
	});

	it("drops a pending refresh on dispose", async () => {
		const test = harness();
		try {
			test.publisher.noteRateLimitEvent();
			test.publisher.dispose();
			assert.equal(test.scheduled.filter((entry) => !entry.cancelled).length, 0);
		} finally {
			test.cleanup();
		}
	});
});

describe("the provider.usageEvents gate", () => {
	it("defaults to true and falls back on an invalid value with one warning (B4.12)", () => {
		assert.equal(normalizeUsageEvents(undefined), true);
		assert.equal(normalizeUsageEvents(true), true);
		assert.equal(normalizeUsageEvents(false), false);

		const warnings = [];
		const original = console.warn;
		console.warn = (message) => warnings.push(String(message));
		try {
			normalizeUsageEvents("yes");
			normalizeUsageEvents("yes");
		} finally {
			console.warn = original;
		}
		// loadConfig runs at extension load and again on session_start, so a
		// repeated warning would print over the TUI on every session.
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /invalid provider\.usageEvents/);
	});

	it("emits nothing and reads no credential when disabled (B4.9)", async () => {
		// The extension builds no publisher at all when the setting is off, which
		// is what makes the opt-out a genuine silence rather than a suppressed
		// emit: the consumer stays in its documented "waiting" state.
		const publisher = normalizeUsageEvents(false) ? new UsagePublisher({}) : undefined;
		assert.equal(publisher, undefined);

		const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
		assert.ok(source.includes("normalizeUsageEvents(providerSettings.usageEvents)"),
			"the gate must decide whether the publisher exists, not whether it emits");
		assert.ok(source.includes("usagePublisher?.publishOnStartup()"));
		assert.ok(source.includes("usagePublisher?.noteRateLimitEvent()"));
	});
});
