/**
 * Populates a usage cache file from a separate process.
 *
 * Cross-process deduplication is the whole point of the cache (B1.2), and an
 * in-process test proves only that two awaits in one event loop share a
 * variable. This writes the state from a real child process so the parent's
 * "served from cache, zero requests" assertion means what it says.
 *
 * Usage: node --import tsx tests/lib/populate-usage-cache.mjs <cacheFile> <nowMs>
 */
import { writeUsageCacheState } from "../../src/usage-cache.js";

const [cacheFile, nowMs] = process.argv.slice(2);
writeUsageCacheState(cacheFile, {
	lastSuccess: {
		quotas: [{ kind: "session", percent: 71 }, { kind: "weekly", percent: 82 }],
		capturedAt: new Date(Number(nowMs)).toISOString(),
	},
	lastSuccessAtMs: Number(nowMs),
});
