// Cross-process cache for Claude subscription usage.
//
// Every Pi session that loads this extension would otherwise ask
// api.anthropic.com for the same numbers on its own, so the request rate would
// scale with session count exactly like the pathology this whole feature exists
// to remove. One file per Claude profile, a lock around the refresh, and a TTL
// make the rate a function of the TTL instead.
//
// This is deliberately *not* a port of pi-usage-bars' cache (D8): the two repos
// version their own file formats, and a review of that implementation found four
// defects in precisely this machinery. Each is designed out here rather than
// inherited — see the lock's own comments for the ownership token, the
// heartbeat, negative caching, and exception-safe acquisition.

import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface UsageQuota {
	kind: "session" | "weekly" | "scoped";
	label?: string;
	percent: number;
	resetsAt?: string;
}

export interface UsageSnapshot {
	quotas: UsageQuota[];
	/** ISO 8601, when the numbers were true. Immutable across cache round-trips. */
	capturedAt: string;
	notice?: string;
}

export interface UsageCacheState {
	lastSuccess?: UsageSnapshot;
	lastSuccessAtMs?: number;
	/** Set after any failure: nothing refetches before this, in any process. */
	nextAttemptAtMs?: number;
	lastFailureReason?: string;
	consecutive429s?: number;
}

const CACHE_VERSION = 2;

// Strictly below the consumer's own one-minute poll, so a snapshot is never a
// full poll old by the time it is asked for. A forced refresh (a rate limit
// event, meaning "something changed") bypasses this; a cooldown does not.
export const USAGE_TTL_MS = 55_000;

// An ordinary failure is cached too. Without this, a 500 or a DNS failure leaves
// every session refetching on every trigger, multiplying the request count by
// session count exactly when the upstream is least able to take it.
export const FAILURE_RETRY_MS = 30_000;

// 429 backoff, matching the consumer's shipped numbers so an operator reading
// either repo's documentation sees one set of figures.
export const BASE_BACKOFF_MS = 2 * 60 * 1000;
export const MAX_BACKOFF_MS = 30 * 60 * 1000;

const LOCK_WAIT_MS = 4_000;
const LOCK_RETRY_MS = 25;
const LOCK_HEARTBEAT_MS = 1_000;
// A holder refreshes its lock's mtime while it works, so an old mtime means the
// holder died rather than that its work is slow. That is what lets the threshold
// be a small constant: it is a count of missed beats, and no change to a request
// timeout can invalidate it.
const LOCK_STALE_MS = 5_000;
// A lock with no heartbeat marker was written by a build that did not beat, so
// its age says nothing about whether its holder is alive. Judge it by a bound
// generous enough to cover a slow fetch instead, so a mixed-version cache
// directory degrades to the old behaviour rather than to stolen locks.
const LEGACY_LOCK_STALE_MS = 60_000;

export function resolveUsageCacheDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.CLAUDE_BRIDGE_USAGE_CACHE_DIR || join(tmpdir(), "pi-claude-bridge-usage");
}

// Keyed by the Claude profile directory, not by the token: two profiles are two
// accounts with two quotas, and hashing a path rather than a secret keeps
// credential material out of this module entirely.
export function usageCacheFilePath(cacheDir: string, claudeConfigDir: string): string {
	const fingerprint = createHash("sha256").update(claudeConfigDir).digest("hex").slice(0, 12);
	return join(cacheDir, `usage-${fingerprint}.json`);
}

function ensureCacheDir(cacheDir: string): void {
	mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
	// A directory that already existed may be wider than we want it. Tightening
	// is best-effort: a directory owned by somebody else is not ours to chmod,
	// and failing the whole refresh over it would be a worse trade.
	try {
		const stat = statSync(cacheDir);
		if (stat.uid === process.getuid?.() && (stat.mode & 0o077) !== 0) {
			chmodSync(cacheDir, 0o700);
		}
	} catch {
		// Not POSIX, not ours, or gone again. Either way, carry on.
	}
}

function isUsageQuota(value: unknown): value is UsageQuota {
	const quota = value as UsageQuota | null;
	if (!quota || typeof quota !== "object") return false;
	if (quota.kind !== "session" && quota.kind !== "weekly" && quota.kind !== "scoped") return false;
	if (typeof quota.percent !== "number" || !Number.isFinite(quota.percent)) return false;
	if (quota.label !== undefined && typeof quota.label !== "string") return false;
	if (quota.resetsAt !== undefined && typeof quota.resetsAt !== "string") return false;
	return true;
}

// Structure is checked, not just syntax: a file with the right version and the
// wrong field types parses cleanly and would otherwise be cast and trusted, and
// this state feeds numbers rendered in somebody else's UI.
function isUsageSnapshot(value: unknown): value is UsageSnapshot {
	const snapshot = value as UsageSnapshot | null;
	if (!snapshot || typeof snapshot !== "object") return false;
	if (typeof snapshot.capturedAt !== "string" || !Number.isFinite(Date.parse(snapshot.capturedAt))) return false;
	if (!Array.isArray(snapshot.quotas) || !snapshot.quotas.every(isUsageQuota)) return false;
	if (snapshot.notice !== undefined && typeof snapshot.notice !== "string") return false;
	return true;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readUsageCacheState(cacheFile: string): UsageCacheState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(cacheFile, "utf-8"));
	} catch {
		// Missing, unreadable, or corrupt: an empty cache, never an exception.
		return {};
	}
	const root = parsed as { version?: unknown; state?: unknown } | null;
	if (!root || typeof root !== "object" || root.version !== CACHE_VERSION) return {};
	const state = root.state as UsageCacheState | null;
	if (!state || typeof state !== "object") return {};
	return {
		lastSuccess: isUsageSnapshot(state.lastSuccess) ? state.lastSuccess : undefined,
		lastSuccessAtMs: readNumber(state.lastSuccessAtMs),
		nextAttemptAtMs: readNumber(state.nextAttemptAtMs),
		lastFailureReason: typeof state.lastFailureReason === "string" ? state.lastFailureReason : undefined,
		consecutive429s: readNumber(state.consecutive429s),
	};
}

export function writeUsageCacheState(cacheFile: string, state: UsageCacheState): void {
	ensureCacheDir(dirname(cacheFile));
	const tempFile = `${cacheFile}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
	try {
		const fd = openSync(tempFile, "wx", 0o600);
		try {
			writeSync(fd, JSON.stringify({ version: CACHE_VERSION, state }));
		} finally {
			closeSync(fd);
		}
		// Atomic with respect to the cache path, so a concurrent reader sees the
		// old file or the new one and never a half-written one.
		renameSync(tempFile, cacheFile);
	} catch {
		// A failed rename would otherwise leave its temp file behind forever, and
		// this directory is never swept by anything else.
		safeUnlink(tempFile);
	}
}

function safeUnlink(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Already gone.
	}
}

interface LockContents {
	owner: string;
	pid: number;
	/** Present only on locks written by a build that heartbeats them. */
	beats?: boolean;
}

function readLockFile(lockFile: string): LockContents | null {
	try {
		const parsed = JSON.parse(readFileSync(lockFile, "utf-8")) as LockContents;
		return typeof parsed?.owner === "string" ? parsed : null;
	} catch {
		return null;
	}
}

function staleThresholdFor(contents: LockContents | null): number {
	return contents?.beats === true ? LOCK_STALE_MS : LEGACY_LOCK_STALE_MS;
}

// Removes one specific lock instance, or nothing at all.
//
// Reading the owner and then unlinking the path is a check-then-act with a
// window in between, so a lock replaced inside that window is destroyed by
// whoever held the stale reading. `rename` has no such window: it detaches the
// file from the path in one step, and a second caller racing for the same
// instance gets ENOENT rather than operating on its successor.
//
// Taking the file off the path before inspecting it means we can briefly hold a
// lock that turns out not to be ours, so the mismatch path puts it back with
// `link`, which fails rather than clobbering when a new lock already exists —
// precisely the case where we must not win.
export function removeLockInstance(lockFile: string, expectedOwner: string | null): boolean {
	const claimPath = `${lockFile}.claim-${process.pid}-${randomBytes(6).toString("hex")}`;
	try {
		renameSync(lockFile, claimPath);
	} catch {
		return false;
	}

	if ((readLockFile(claimPath)?.owner ?? null) !== expectedOwner) {
		restoreLock(claimPath, lockFile);
		return false;
	}
	safeUnlink(claimPath);
	return true;
}

function restoreLock(claimPath: string, lockFile: string): void {
	try {
		linkSync(claimPath, lockFile);
	} catch (error) {
		// EEXIST means a new lock appeared while we were checking, so the path is
		// legitimately its holder's and ours is the one to discard. Anything else
		// (a filesystem without hard links) falls back to a rename, but only while
		// the path is free, so a newer lock is still never clobbered.
		if ((error as NodeJS.ErrnoException)?.code !== "EEXIST" && !existsSync(lockFile)) {
			try {
				renameSync(claimPath, lockFile);
				return;
			} catch {
				// Nothing left to try: the next exclusive create wins the path.
			}
		}
	}
	safeUnlink(claimPath);
}

export interface LockHandle {
	release(): void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function acquireUsageLock(
	lockFile: string,
	// `write` is injected only so a test can force a failure between create and
	// close, which is the one path where a leaked descriptor and an orphan lock
	// are possible and the one path no filesystem will produce on demand.
	options: { waitMs?: number; write?: (fd: number, data: string) => void } = {},
): Promise<LockHandle | null> {
	const waitMs = options.waitMs ?? LOCK_WAIT_MS;
	const write = options.write ?? ((fd, data) => { writeSync(fd, data); });
	const deadline = Date.now() + waitMs;
	const owner = randomBytes(8).toString("hex");
	const contents: LockContents = { owner, pid: process.pid, beats: true };

	for (;;) {
		let fd: number | undefined;
		try {
			fd = openSync(lockFile, "wx", 0o600);
			write(fd, JSON.stringify(contents));
			closeSync(fd);
			fd = undefined;

			const heartbeat = setInterval(() => {
				try {
					const stamp = new Date();
					utimesSync(lockFile, stamp, stamp);
				} catch {
					// The lock is gone (reclaimed, or the directory was removed).
					// Nothing to refresh; release() still runs its ownership check.
				}
			}, LOCK_HEARTBEAT_MS);
			heartbeat.unref?.();

			return {
				release: () => {
					clearInterval(heartbeat);
					// Only ever removes the instance we wrote, so a holder whose lock
					// was reclaimed as stale cannot delete its successor's lock.
					removeLockInstance(lockFile, owner);
				},
			};
		} catch (error) {
			// An exception between create and close would otherwise leak the
			// descriptor and orphan a lock file nobody owns.
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {
					// Already closed.
				}
				safeUnlink(lockFile);
			}
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") return null;
		}

		try {
			// The owner is captured before the staleness verdict, not re-read at
			// removal time: comparing a value against itself, read at the same
			// moment, would make the ownership check a no-op.
			const observed = readLockFile(lockFile);
			if (Date.now() - statSync(lockFile).mtimeMs >= staleThresholdFor(observed)) {
				removeLockInstance(lockFile, observed?.owner ?? null);
				continue;
			}
		} catch {
			// The lock vanished between the failed create and this check; retry.
			continue;
		}

		if (Date.now() >= deadline) return null;
		await sleep(LOCK_RETRY_MS);
	}
}

// One shape rather than a discriminated union: this repo compiles with
// strict: false, where a union keyed on a boolean literal does not narrow, so a
// union here would cost a cast at every use.
export interface UsageFetchOutcome {
	ok: boolean;
	/** Present when ok. */
	snapshot?: UsageSnapshot;
	/** Present when not ok: the fixed phrase a publisher reports (B3.7). */
	reason?: string;
	rateLimited?: boolean;
	retryAfterMs?: number;
}

export interface UsageLoadResult {
	/** Last known good numbers, from this refresh or from an earlier one. */
	snapshot?: UsageSnapshot;
	/** Set when the most recent attempt failed; the reason a publisher should report. */
	unavailable?: string;
	source: "cache" | "fetch" | "cooldown" | "contended" | "failed";
}

export interface UsageLoadOptions {
	cacheFile: string;
	fetchUsage: () => Promise<UsageFetchOutcome>;
	nowMs?: () => number;
	ttlMs?: number;
	lockWaitMs?: number;
	/** A rate limit event means "something changed", so it bypasses the TTL (never the cooldown). */
	force?: boolean;
}

export function backoffAfter429(consecutive429s: number, retryAfterMs?: number): number {
	const exponential = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, consecutive429s - 1), MAX_BACKOFF_MS);
	if (retryAfterMs === undefined) return exponential;
	// A server-stated wait is honoured, but never used to retry sooner than our
	// own backoff nor to pause for longer than the cap.
	return Math.min(Math.max(retryAfterMs, exponential), MAX_BACKOFF_MS);
}

function formatWait(waitMs: number): string {
	const minutes = Math.round(waitMs / 60_000);
	return minutes >= 1 ? `${minutes}m` : `${Math.max(1, Math.round(waitMs / 1_000))}s`;
}

export async function loadUsageThroughCache(options: UsageLoadOptions): Promise<UsageLoadResult> {
	const now = options.nowMs ?? (() => Date.now());
	const ttlMs = options.ttlMs ?? USAGE_TTL_MS;
	const lockFile = `${options.cacheFile}.lock`;

	const fresh = (state: UsageCacheState, at: number): boolean =>
		state.lastSuccess !== undefined &&
		state.lastSuccessAtMs !== undefined &&
		at - state.lastSuccessAtMs < ttlMs;

	const before = readUsageCacheState(options.cacheFile);
	if (!options.force && fresh(before, now())) {
		return { snapshot: before.lastSuccess, source: "cache" };
	}
	// A cooldown outlives a forced refresh: "something changed" is not a reason to
	// hammer an endpoint that has just told us to stop.
	if (before.nextAttemptAtMs !== undefined && now() < before.nextAttemptAtMs) {
		return { snapshot: before.lastSuccess, unavailable: before.lastFailureReason, source: "cooldown" };
	}

	ensureCacheDir(dirname(options.cacheFile));
	const lock = await acquireUsageLock(lockFile, { waitMs: options.lockWaitMs });
	if (!lock) {
		// Another process is refreshing. Fetching anyway is what makes a cold cache
		// stampede, which is the one moment the upstream can least afford it.
		return { snapshot: before.lastSuccess, source: "contended" };
	}

	try {
		// Re-read under the lock: the process we queued behind has very likely just
		// written the answer we were about to fetch.
		const state = readUsageCacheState(options.cacheFile);
		const at = now();
		if (!options.force && fresh(state, at)) {
			return { snapshot: state.lastSuccess, source: "cache" };
		}
		if (state.nextAttemptAtMs !== undefined && at < state.nextAttemptAtMs) {
			return { snapshot: state.lastSuccess, unavailable: state.lastFailureReason, source: "cooldown" };
		}

		const outcome = await options.fetchUsage();
		const completedAt = now();
		if (outcome.ok && outcome.snapshot) {
			writeUsageCacheState(options.cacheFile, {
				lastSuccess: outcome.snapshot,
				lastSuccessAtMs: completedAt,
			});
			return { snapshot: outcome.snapshot, source: "fetch" };
		}

		const consecutive429s = outcome.rateLimited ? (state.consecutive429s ?? 0) + 1 : 0;
		const waitMs = outcome.rateLimited
			? backoffAfter429(consecutive429s, outcome.retryAfterMs)
			: FAILURE_RETRY_MS;
		// A rate limit gets its retry hint here rather than at the fetch, because
		// this is where the wait is actually decided. It is computed, never quoted
		// from upstream text, and it is fixed once: recomputing it on every read
		// would change the reason string each poll and make a publisher that emits
		// on transition emit continuously instead.
		const reason = (outcome.reason ?? "usage unavailable") +
			(outcome.rateLimited ? ` (retry in ${formatWait(waitMs)})` : "");
		writeUsageCacheState(options.cacheFile, {
			...state,
			nextAttemptAtMs: completedAt + waitMs,
			lastFailureReason: reason,
			consecutive429s,
		});
		return { snapshot: state.lastSuccess, unavailable: reason, source: "failed" };
	} finally {
		lock.release();
	}
}
