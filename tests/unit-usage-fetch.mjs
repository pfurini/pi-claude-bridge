/**
 * Fetching and normalizing Claude subscription usage (B3).
 *
 * The fixture is a verbatim capture of a live 200 from the endpoint (Max plan,
 * 2026-08-27), not a shape we imagined: the whole point of normalizing against
 * the endpoint's own values is that they differ from the rate_limit_event ones
 * the SDK helpers were written for, and a hand-written fixture would encode
 * whichever assumption the implementation already made.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	fetchClaudeUsage,
	normalizeUsagePayload,
	OAUTH_BETA_HEADER,
	parseRetryAfterMs,
	REASON_CREDENTIALS_REJECTED,
	REASON_RATE_LIMITED,
	REASON_UNREACHABLE,
	REASON_UNREADABLE,
	reasonForStatus,
	USAGE_ENDPOINT,
} from "../src/usage-fetch.js";

const FIXTURE_TOKEN = "sk-ant-oat01-fixture-token-do-not-leak";
const LIVE_PAYLOAD = JSON.parse(
	readFileSync(new URL("./fixtures/oauth-usage-200.json", import.meta.url), "utf8"),
);

function response(body, { status = 200, headers = {}, json } = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (name) => headers[name.toLowerCase()] ?? null },
		json: json ?? (async () => body),
	};
}

function recordingFetch(result) {
	const calls = [];
	return {
		calls,
		fetchFn: async (url, init) => {
			calls.push({ url, init });
			if (result instanceof Error) throw result;
			return result;
		},
	};
}

describe("usage endpoint request", () => {
	it("GETs the OAuth usage endpoint with a bearer token and the beta header (B3.1)", async () => {
		const recorder = recordingFetch(response(LIVE_PAYLOAD));
		await fetchClaudeUsage(FIXTURE_TOKEN, { fetchFn: recorder.fetchFn });

		assert.equal(recorder.calls.length, 1);
		assert.equal(recorder.calls[0].url, USAGE_ENDPOINT);
		assert.equal(recorder.calls[0].init.headers.Authorization, `Bearer ${FIXTURE_TOKEN}`);
		assert.equal(recorder.calls[0].init.headers["anthropic-beta"], OAUTH_BETA_HEADER);
	});
});

describe("usage payload normalization", () => {
	const capturedAt = "2026-08-27T12:00:00.000Z";

	it("maps five_hour to session, seven_day to weekly, and scoped limits to lanes (B3.2)", () => {
		const snapshot = normalizeUsagePayload(LIVE_PAYLOAD, capturedAt);
		const scopedLimit = LIVE_PAYLOAD.limits.find((limit) => limit.kind === "weekly_scoped");
		assert.deepEqual(snapshot.quotas, [
			{ kind: "session", percent: 32, resetsAt: LIVE_PAYLOAD.five_hour.resets_at },
			{ kind: "weekly", percent: 50, resetsAt: LIVE_PAYLOAD.seven_day.resets_at },
			{ kind: "scoped", label: "Fable", percent: scopedLimit.percent, resetsAt: scopedLimit.resets_at },
		]);
		assert.equal(snapshot.capturedAt, capturedAt);
	});

	it("passes the endpoint's ISO resets_at through unchanged (B3.3)", () => {
		const snapshot = normalizeUsagePayload(LIVE_PAYLOAD, capturedAt);
		// The SDK's rateLimitResetDate multiplies by 1000 because rate_limit_event
		// reports epoch seconds. Applied here it would turn a date into a year.
		assert.equal(snapshot.quotas[0].resetsAt, LIVE_PAYLOAD.five_hour.resets_at);
		assert.equal(snapshot.quotas[1].resetsAt, LIVE_PAYLOAD.seven_day.resets_at);
	});

	it("treats utilization as 0..100, never as a fraction to scale (B3.4)", () => {
		const snapshot = normalizeUsagePayload(LIVE_PAYLOAD, capturedAt);
		// rateLimitUtilizationPercent(32) would be 3200.
		assert.equal(snapshot.quotas[0].percent, 32);
		assert.ok(snapshot.quotas.every((quota) => quota.percent >= 0 && quota.percent <= 100));

		const clamped = normalizeUsagePayload({ five_hour: { utilization: 240 }, seven_day: { utilization: -5 } }, capturedAt);
		assert.deepEqual(clamped.quotas.map((quota) => quota.percent), [100, 0]);
	});

	it("omits a window the endpoint does not report rather than publishing a zero", () => {
		const snapshot = normalizeUsagePayload({ five_hour: null, seven_day: { utilization: 50 } }, capturedAt);
		assert.deepEqual(snapshot.quotas, [{ kind: "weekly", percent: 50, resetsAt: undefined }]);
	});

	it("drops scoped entries with no model name and caps the lanes at four", () => {
		const limits = [
			{ kind: "session", percent: 10, scope: null },
			{ kind: "weekly_all", percent: 20, scope: null },
			{ kind: "weekly_scoped", percent: 30, scope: { model: { display_name: null } } },
			...Array.from({ length: 6 }, (_, index) => ({
				kind: "weekly_scoped",
				percent: 40 + index,
				scope: { model: { display_name: `Model ${index}\u001b[2J` } },
			})),
		];
		const snapshot = normalizeUsagePayload({ five_hour: { utilization: 1 }, limits }, capturedAt);
		const scoped = snapshot.quotas.filter((quota) => quota.kind === "scoped");

		// The session and weekly_all entries duplicate the two windows above, so
		// they must not become lanes of their own.
		assert.equal(scoped.length, 4);
		assert.equal(scoped[0].label, "Model 0[2J");
		assert.ok(!scoped.some((quota) => quota.label.includes("\u001b")));
	});

	it("reports a response carrying no window at all as unreadable, not as an empty reading", () => {
		assert.equal(normalizeUsagePayload({}, capturedAt), undefined);
		assert.equal(normalizeUsagePayload(null, capturedAt), undefined);
		assert.equal(normalizeUsagePayload("nope", capturedAt), undefined);
	});

	it("names overage as disabled only for an account that has used it", () => {
		assert.equal(normalizeUsagePayload(LIVE_PAYLOAD, capturedAt).notice, "overage disabled");
		const never = { ...LIVE_PAYLOAD, extra_usage: { is_enabled: false, credits_ever_enabled: false } };
		assert.equal(normalizeUsagePayload(never, capturedAt).notice, undefined);
	});
});

describe("usage endpoint failures", () => {
	it("reports a transport failure, a non-2xx status, and an unreadable body distinctly (B3.6)", async () => {
		const unreachable = await fetchClaudeUsage(FIXTURE_TOKEN, {
			fetchFn: recordingFetch(new Error("getaddrinfo ENOTFOUND api.anthropic.com")).fetchFn,
		});
		assert.deepEqual(unreachable, { ok: false, reason: REASON_UNREACHABLE });

		const serverError = await fetchClaudeUsage(FIXTURE_TOKEN, {
			fetchFn: recordingFetch(response(null, { status: 503 })).fetchFn,
		});
		assert.deepEqual(serverError, { ok: false, reason: "usage endpoint returned 503" });
		assert.equal(reasonForStatus(503), "usage endpoint returned 503");

		const unreadable = await fetchClaudeUsage(FIXTURE_TOKEN, {
			fetchFn: recordingFetch(response(null, { json: async () => { throw new SyntaxError("Unexpected token <"); } })).fetchFn,
		});
		assert.deepEqual(unreadable, { ok: false, reason: REASON_UNREADABLE });

		// None of the three fabricates a zero, which would render as a real quota
		// of nothing used rather than as an absence of numbers.
		for (const outcome of [unreachable, serverError, unreadable]) {
			assert.equal(outcome.snapshot, undefined);
		}
	});

	it("distinguishes a rejected credential from a transport failure (B3.8)", async () => {
		for (const status of [401, 403]) {
			const outcome = await fetchClaudeUsage(FIXTURE_TOKEN, {
				fetchFn: recordingFetch(response(null, { status })).fetchFn,
			});
			// The one failure an operator can act on, and the only place token
			// unusability is ever decided (D11).
			assert.deepEqual(outcome, { ok: false, reason: REASON_CREDENTIALS_REJECTED });
		}
	});

	it("flags a 429 as rate limited and carries its Retry-After (B3.5)", async () => {
		const outcome = await fetchClaudeUsage(FIXTURE_TOKEN, {
			fetchFn: recordingFetch(response(null, { status: 429, headers: { "retry-after": "90" } })).fetchFn,
			nowMs: () => 1_000_000,
		});
		assert.equal(outcome.ok, false);
		assert.equal(outcome.reason, REASON_RATE_LIMITED);
		assert.equal(outcome.rateLimited, true);
		assert.equal(outcome.retryAfterMs, 90_000);
	});

	it("reads Retry-After as delta-seconds and as an HTTP date", () => {
		const now = Date.parse("2026-08-27T12:00:00.000Z");
		assert.equal(parseRetryAfterMs("120", now), 120_000);
		assert.equal(parseRetryAfterMs("Thu, 27 Aug 2026 12:02:00 GMT", now), 120_000);
		// A date already in the past is a wait of zero, not a negative one.
		assert.equal(parseRetryAfterMs("Thu, 27 Aug 2026 11:00:00 GMT", now), 0);
		assert.equal(parseRetryAfterMs(null, now), undefined);
		assert.equal(parseRetryAfterMs("soon", now), undefined);
	});

	it("never interpolates a response body, an exception, or a credential into a reason (B3.7)", async () => {
		const leakyBody = `{"error":"token ${FIXTURE_TOKEN} rejected at /Users/someone/.claude"}`;
		const outcomes = [
			await fetchClaudeUsage(FIXTURE_TOKEN, {
				fetchFn: recordingFetch(new Error(`connect failed using ${FIXTURE_TOKEN}`)).fetchFn,
			}),
			await fetchClaudeUsage(FIXTURE_TOKEN, {
				fetchFn: recordingFetch(response(null, { status: 500, json: async () => JSON.parse(leakyBody) })).fetchFn,
			}),
			await fetchClaudeUsage(FIXTURE_TOKEN, {
				fetchFn: recordingFetch(response(null, {
					json: async () => { throw new Error(`parse failed on ${leakyBody}`); },
				})).fetchFn,
			}),
		];

		for (const outcome of outcomes) {
			assert.ok(outcome.reason, "every failure must carry a reason, or this scan is vacuous");
			assert.ok(!outcome.reason.includes(FIXTURE_TOKEN), outcome.reason);
			assert.ok(!outcome.reason.includes("sk-ant"), outcome.reason);
			assert.ok(!outcome.reason.includes("/Users/"), outcome.reason);
			assert.ok(!outcome.reason.includes("rejected at"), outcome.reason);
			// The status code is the only dynamic part the contract allows.
			assert.ok(/^[a-zA-Z0-9 ]+$/.test(outcome.reason), outcome.reason);
		}
	});
});
