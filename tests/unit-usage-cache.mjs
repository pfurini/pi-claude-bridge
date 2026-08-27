/**
 * Cross-process usage cache (B1).
 *
 * Every Pi session would otherwise ask Anthropic for the same numbers, so the
 * request rate would scale with session count. These drive the cache directly
 * with an injected clock and an injected fetch: no network, no extension
 * activation, and no real sleeps except where a lock's own timing is the thing
 * under test.
 *
 * The lock cases exist because a review of pi-usage-bars' equivalent found four
 * defects in this exact machinery (unowned reclaim, a stale threshold that
 * guesses how long the work takes, uncached failures, and leaked descriptors).
 * Each has a test here so the second implementation cannot rediscover them.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	acquireUsageLock,
	backoffAfter429,
	BASE_BACKOFF_MS,
	FAILURE_RETRY_MS,
	loadUsageThroughCache,
	MAX_BACKOFF_MS,
	readUsageCacheState,
	removeLockInstance,
	resolveUsageCacheDir,
	usageCacheFilePath,
	USAGE_TTL_MS,
	writeUsageCacheState,
} from "../src/usage-cache.js";

const FIXTURE_TOKEN = "sk-ant-oat01-fixture-token-do-not-leak";

// Async throughout, and awaited at every call site. A synchronous try/finally
// around an async body runs its cleanup the moment the body returns its promise,
// so the directory would be deleted out from under the test still using it — the
// failure surfaces as ENOENT in whichever test happens to run next.
async function withTempCache(fn) {
	const dir = mkdtempSync(join(tmpdir(), "claude-bridge-usage-cache-"));
	try {
		return await fn(join(dir, "usage-test.json"), dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function snapshot(percent = 23, capturedAt = "2026-08-27T12:00:00.000Z") {
	return { quotas: [{ kind: "session", percent }, { kind: "weekly", percent: 44 }], capturedAt };
}

// A fetch that counts its calls, so "exactly one upstream request" is asserted
// against a number rather than against the absence of a network error.
function countingFetch(outcome = { ok: true, snapshot: snapshot() }) {
	const calls = { count: 0 };
	return {
		calls,
		fetchUsage: async () => {
			calls.count += 1;
			return typeof outcome === "function" ? outcome(calls.count) : outcome;
		},
	};
}

describe("usage cache: deduplication and TTL", () => {
	it("serves a second caller inside the TTL window without a second request (B1.1)", async () => {
		await withTempCache(async (cacheFile) => {
			const fetcher = countingFetch();
			let now = 1_000_000;
			const options = { cacheFile, fetchUsage: fetcher.fetchUsage, nowMs: () => now };

			const first = await loadUsageThroughCache(options);
			assert.equal(first.source, "fetch");
			assert.equal(first.snapshot.quotas[0].percent, 23);

			now += USAGE_TTL_MS - 1;
			const second = await loadUsageThroughCache(options);
			assert.equal(second.source, "cache");
			assert.equal(fetcher.calls.count, 1);
		});
	});

	it("refetches at exactly the TTL rather than alternating across the boundary (B1.9)", async () => {
		await withTempCache(async (cacheFile) => {
			const fetcher = countingFetch();
			let now = 1_000_000;
			const options = { cacheFile, fetchUsage: fetcher.fetchUsage, nowMs: () => now };

			await loadUsageThroughCache(options);
			now += USAGE_TTL_MS;
			const atBoundary = await loadUsageThroughCache(options);

			assert.equal(atBoundary.source, "fetch");
			assert.equal(fetcher.calls.count, 2);
		});
	});

	it("keeps the TTL strictly below the consumer's poll interval", () => {
		// A TTL equal to the interval driving it puts every poll on the freshness
		// boundary, which halves the effective refresh rate rather than doubling it.
		assert.ok(USAGE_TTL_MS < 60_000, `expected TTL below 60s, got ${USAGE_TTL_MS}`);
	});

	it("bypasses the TTL for a forced refresh but never the cooldown", async () => {
		await withTempCache(async (cacheFile) => {
			const fetcher = countingFetch();
			let now = 1_000_000;
			const options = { cacheFile, fetchUsage: fetcher.fetchUsage, nowMs: () => now };

			await loadUsageThroughCache(options);
			const forced = await loadUsageThroughCache({ ...options, force: true });
			assert.equal(forced.source, "fetch");
			assert.equal(fetcher.calls.count, 2);

			// A rate limit event means "something changed", which is not a reason to
			// keep hitting an endpoint that has just told us to stop.
			writeUsageCacheState(cacheFile, { nextAttemptAtMs: now + 60_000, lastFailureReason: "usage endpoint returned 429" });
			const duringCooldown = await loadUsageThroughCache({ ...options, force: true });
			assert.equal(duringCooldown.source, "cooldown");
			assert.equal(duringCooldown.unavailable, "usage endpoint returned 429");
			assert.equal(fetcher.calls.count, 2);
		});
	});

	it("deduplicates across processes, not just across concurrent callers (B1.2)", async () => {
		await withTempCache(async (cacheFile) => {
			// A child process populates the cache; the parent must serve it without
			// its own fetch. Without cross-process state this test cannot pass.
			const populate = fileURLToPath(new URL("./lib/populate-usage-cache.mjs", import.meta.url));
			execFileSync(process.execPath, ["--import", "tsx", populate, cacheFile, "2000000"], { encoding: "utf8" });

			const fetcher = countingFetch();
			const result = await loadUsageThroughCache({
				cacheFile,
				fetchUsage: fetcher.fetchUsage,
				nowMs: () => 2_000_000 + 1_000,
			});

			assert.equal(result.source, "cache");
			assert.equal(result.snapshot.quotas[0].percent, 71);
			assert.equal(fetcher.calls.count, 0);
		});
	});

	it("never shares state between two Claude profiles (B1.6)", () => {
		const dir = resolveUsageCacheDir({ CLAUDE_BRIDGE_USAGE_CACHE_DIR: "/tmp/example" });
		const first = usageCacheFilePath(dir, "/home/a/.pi/agent/claude");
		const second = usageCacheFilePath(dir, "/home/a/.pi/agent/claude-work");
		assert.notEqual(first, second);
	});
});

describe("usage cache: persistence", () => {
	it("round-trips state and writes atomically without residue (B1.3)", async () => {
		await withTempCache((cacheFile, dir) => {
			writeUsageCacheState(cacheFile, { lastSuccess: snapshot(), lastSuccessAtMs: 5 });
			assert.deepEqual(readUsageCacheState(cacheFile).lastSuccess, snapshot());
			assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp-")), []);
		});
	});

	it("leaves no temp file behind when the rename fails (B1.3)", async () => {
		await withTempCache((cacheFile, dir) => {
			// A directory at the cache path makes rename fail the way a full or
			// read-only filesystem would, without needing either.
			mkdirSync(cacheFile);
			writeUsageCacheState(cacheFile, { lastSuccess: snapshot(), lastSuccessAtMs: 5 });
			assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp-")), []);
		});
	});

	it("treats missing, corrupt, wrong-version and structurally invalid files as empty (B1.4)", async () => {
		await withTempCache((cacheFile) => {
			assert.deepEqual(readUsageCacheState(cacheFile), {});

			writeFileSync(cacheFile, "{not json");
			assert.deepEqual(readUsageCacheState(cacheFile), {});

			writeFileSync(cacheFile, JSON.stringify({ version: 1, state: { lastSuccess: snapshot() } }));
			assert.deepEqual(readUsageCacheState(cacheFile), {});

			// Right version, wrong field types: syntactically fine, so a cast would
			// accept it and hand a percent of "lots" to another extension's renderer.
			writeFileSync(cacheFile, JSON.stringify({
				version: 2,
				state: { lastSuccess: { quotas: [{ kind: "session", percent: "lots" }], capturedAt: "nope" }, lastSuccessAtMs: "soon" },
			}));
			const parsed = readUsageCacheState(cacheFile);
			assert.equal(parsed.lastSuccess, undefined);
			assert.equal(parsed.lastSuccessAtMs, undefined);
		});
	});

	it("stores no credential material (B1.5)", async () => {
		await withTempCache(async (cacheFile) => {
			// The fetcher holds the token; only its normalized output may be cached.
			const fetcher = countingFetch({
				ok: true,
				snapshot: { ...snapshot(), notice: "overage disabled" },
			});
			await loadUsageThroughCache({ cacheFile, fetchUsage: fetcher.fetchUsage, nowMs: () => 1 });

			const bytes = readFileSync(cacheFile, "utf8");
			assert.ok(bytes.length > 0, "cache file must not be empty, or this scan is vacuous");
			assert.ok(!bytes.includes(FIXTURE_TOKEN));
			assert.ok(!bytes.includes("sk-ant"));
		});
	});

	it("creates the cache directory 0700 and files 0600, tightening a wider one (B1.12)", async () => {
		if (process.platform === "win32") return;
		await withTempCache((cacheFile) => {
			const dir = join(dirname(cacheFile), "nested");
			mkdirSync(dir, { recursive: true });
			chmodSync(dir, 0o755);
			const nested = join(dir, "usage.json");

			writeUsageCacheState(nested, { lastSuccessAtMs: 1 });

			assert.equal(statSync(dir).mode & 0o777, 0o700);
			assert.equal(statSync(nested).mode & 0o777, 0o600);
		});
	});
});

describe("usage cache: failure handling", () => {
	it("caches an ordinary failure so N processes make one request, not N (B1.10)", async () => {
		await withTempCache(async (cacheFile) => {
			const fetcher = countingFetch({ ok: false, reason: "usage endpoint returned 503" });
			let now = 1_000_000;
			const options = { cacheFile, fetchUsage: fetcher.fetchUsage, nowMs: () => now };

			const first = await loadUsageThroughCache(options);
			assert.equal(first.source, "failed");
			assert.equal(first.unavailable, "usage endpoint returned 503");

			// Four more sessions arriving inside the window. Without negative
			// caching each of them retries, exactly when the upstream is least able
			// to take it.
			for (let i = 0; i < 4; i += 1) {
				now += 1_000;
				const next = await loadUsageThroughCache(options);
				assert.equal(next.source, "cooldown");
				assert.equal(next.unavailable, "usage endpoint returned 503");
			}
			assert.equal(fetcher.calls.count, 1);

			now += FAILURE_RETRY_MS;
			await loadUsageThroughCache(options);
			assert.equal(fetcher.calls.count, 2);
		});
	});

	it("keeps serving the last known numbers while a failure is held off", async () => {
		await withTempCache(async (cacheFile) => {
			let now = 1_000_000;
			const outcomes = [{ ok: true, snapshot: snapshot() }, { ok: false, reason: "usage endpoint unreachable" }];
			const fetcher = countingFetch((call) => outcomes[Math.min(call, outcomes.length) - 1]);
			const options = { cacheFile, fetchUsage: fetcher.fetchUsage, nowMs: () => now };

			await loadUsageThroughCache(options);
			now += USAGE_TTL_MS;
			const failed = await loadUsageThroughCache(options);

			// Losing a good reading because a later poll failed would be a downgrade,
			// not a diagnosis.
			assert.equal(failed.snapshot.quotas[0].percent, 23);
			assert.equal(failed.unavailable, "usage endpoint unreachable");
		});
	});

	it("backs off exponentially from a base of two minutes, capped at thirty", () => {
		assert.equal(backoffAfter429(1), BASE_BACKOFF_MS);
		assert.equal(backoffAfter429(2), BASE_BACKOFF_MS * 2);
		assert.equal(backoffAfter429(20), MAX_BACKOFF_MS);
		// Retry-After is honoured, but never to retry sooner than our own backoff
		// nor to pause beyond the cap.
		assert.equal(backoffAfter429(1, 10_000), BASE_BACKOFF_MS);
		assert.equal(backoffAfter429(1, 5 * 60_000), 5 * 60_000);
		assert.equal(backoffAfter429(1, 60 * 60_000), MAX_BACKOFF_MS);
	});

	it("doubles the cooldown across consecutive rate limits and clears it on success", async () => {
		await withTempCache(async (cacheFile) => {
			let now = 1_000_000;
			let outcome = { ok: false, reason: "usage endpoint rate limited", rateLimited: true };
			const options = { cacheFile, fetchUsage: async () => outcome, nowMs: () => now };

			await loadUsageThroughCache(options);
			assert.equal(readUsageCacheState(cacheFile).nextAttemptAtMs, now + BASE_BACKOFF_MS);

			now += BASE_BACKOFF_MS;
			await loadUsageThroughCache(options);
			assert.equal(readUsageCacheState(cacheFile).nextAttemptAtMs, now + BASE_BACKOFF_MS * 2);

			now += BASE_BACKOFF_MS * 2;
			outcome = { ok: true, snapshot: snapshot() };
			await loadUsageThroughCache(options);
			const cleared = readUsageCacheState(cacheFile);
			assert.equal(cleared.nextAttemptAtMs, undefined);
			assert.equal(cleared.consecutive429s, undefined);
		});
	});
});

describe("usage cache: locking", () => {
	it("does not fetch while another process holds the lock", async () => {
		await withTempCache(async (cacheFile) => {
			const held = await acquireUsageLock(`${cacheFile}.lock`, { waitMs: 50 });
			assert.ok(held);
			try {
				const fetcher = countingFetch();
				const result = await loadUsageThroughCache({
					cacheFile,
					fetchUsage: fetcher.fetchUsage,
					nowMs: () => 1,
					lockWaitMs: 50,
				});
				// A cold cache is exactly when a stampede does the most damage, so a
				// contended lock returns nothing rather than fetching anyway.
				assert.equal(result.source, "contended");
				assert.equal(fetcher.calls.count, 0);
			} finally {
				held.release();
			}
		});
	});

	it("does not delete a successor's lock when a superseded holder releases (B1.7)", async () => {
		await withTempCache(async (cacheFile) => {
			const lockFile = `${cacheFile}.lock`;
			const first = await acquireUsageLock(lockFile, { waitMs: 50 });
			assert.ok(first);

			// The first holder's lock is reclaimed as stale and a second holder takes
			// the path. Releasing the first must not remove the second's lock.
			removeLockInstance(lockFile, readOwner(lockFile));
			const second = await acquireUsageLock(lockFile, { waitMs: 50 });
			assert.ok(second);
			const secondOwner = readOwner(lockFile);

			first.release();

			assert.ok(existsSync(lockFile), "the successor's lock was deleted by its predecessor");
			assert.equal(readOwner(lockFile), secondOwner);
			second.release();
			assert.ok(!existsSync(lockFile));
		});
	});

	it("restores a lock it detached but does not own", async () => {
		await withTempCache((cacheFile) => {
			const lockFile = `${cacheFile}.lock`;
			writeFileSync(lockFile, JSON.stringify({ owner: "real-holder", pid: 1, beats: true }));

			assert.equal(removeLockInstance(lockFile, "someone-else"), false);
			assert.ok(existsSync(lockFile), "a lock that was not ours must be put back");
			assert.equal(readOwner(lockFile), "real-holder");
		});
	});

	it("never reclaims a lock whose holder is still beating, however slow the work (B1.8)", async () => {
		await withTempCache(async (cacheFile) => {
			const lockFile = `${cacheFile}.lock`;
			const held = await acquireUsageLock(lockFile, { waitMs: 50 });
			assert.ok(held);
			const owner = readOwner(lockFile);
			try {
				// Age the lock far past the threshold, then let the heartbeat run. A
				// threshold derived from how long the work "should" take would have
				// already declared this holder dead.
				const ancient = new Date(Date.now() - 60_000);
				utimesSync(lockFile, ancient, ancient);
				await new Promise((resolve) => setTimeout(resolve, 1_200));

				const contender = await acquireUsageLock(lockFile, { waitMs: 100 });
				assert.equal(contender, null, "a live, beating holder was reclaimed");
				assert.equal(readOwner(lockFile), owner);
			} finally {
				held.release();
			}
		});
	});

	it("reclaims a lock whose holder stopped beating (B1.8)", async () => {
		await withTempCache(async (cacheFile) => {
			const lockFile = `${cacheFile}.lock`;
			// A dead holder: its file is present, marked as beating, and its mtime
			// has not moved past the threshold.
			writeFileSync(lockFile, JSON.stringify({ owner: "dead-holder", pid: 999_999, beats: true }));
			const ancient = new Date(Date.now() - 30_000);
			utimesSync(lockFile, ancient, ancient);

			const taken = await acquireUsageLock(lockFile, { waitMs: 200 });
			assert.ok(taken, "an abandoned lock must not deadlock the cache");
			assert.notEqual(readOwner(lockFile), "dead-holder");
			taken.release();
		});
	});

	it("judges a lock with no heartbeat marker by a conservative threshold (B1.13)", async () => {
		await withTempCache(async (cacheFile) => {
			const lockFile = `${cacheFile}.lock`;
			// Written by an older build sharing this directory: its age says nothing
			// about whether its holder is alive, so the small threshold must not apply.
			writeFileSync(lockFile, JSON.stringify({ owner: "legacy-holder", pid: 999_999 }));
			const aged = new Date(Date.now() - 30_000);
			utimesSync(lockFile, aged, aged);

			assert.equal(await acquireUsageLock(lockFile, { waitMs: 100 }), null);
			assert.equal(readOwner(lockFile), "legacy-holder");

			const ancient = new Date(Date.now() - 120_000);
			utimesSync(lockFile, ancient, ancient);
			const taken = await acquireUsageLock(lockFile, { waitMs: 200 });
			assert.ok(taken, "even a legacy lock must eventually be reclaimable");
			taken.release();
		});
	});

	it("leaves no descriptor and no orphan lock when the lock write fails (B1.11)", async () => {
		await withTempCache(async (cacheFile, dir) => {
			const lockFile = `${cacheFile}.lock`;
			const failed = await acquireUsageLock(lockFile, {
				waitMs: 50,
				write: () => { throw new Error("disk full"); },
			});

			assert.equal(failed, null);
			// The file was created before the write failed, so without cleanup the
			// path stays claimed by a lock nobody holds and nothing can reclaim.
			assert.ok(!existsSync(lockFile), "a failed acquisition orphaned its lock file");
			assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".claim-")), []);

			const taken = await acquireUsageLock(lockFile, { waitMs: 50 });
			assert.ok(taken, "the lock path must still be acquirable");
			taken.release();
		});
	});
});

function readOwner(lockFile) {
	try {
		return JSON.parse(readFileSync(lockFile, "utf8")).owner;
	} catch {
		return null;
	}
}
