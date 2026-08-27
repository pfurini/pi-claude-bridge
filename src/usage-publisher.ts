// Publishes Claude subscription usage on pi's pi:provider-usage channel.
//
// The bridge registers with a static placeholder credential, so a usage
// indicator cannot authenticate as this provider and fetch the numbers itself.
// Instead it subscribes to this topic-named channel and renders whatever a
// publisher sends. Nothing here shares a credential: only normalized
// percentages, labels, and timestamps go out.
//
// Everything is dependency-injected (clock, event bus, credential reader, fetch,
// scheduler) so the unit suite drives the whole publisher without activating the
// extension or spawning Claude Code.

import { PROVIDER_ID } from "./convert.js";
import { readClaudeCredentials, type CredentialLookup } from "./claude-credentials.js";
import {
	loadUsageThroughCache,
	resolveUsageCacheDir,
	usageCacheFilePath,
	type UsageFetchOutcome,
	type UsageQuota,
	type UsageSnapshot,
} from "./usage-cache.js";
import { fetchClaudeUsage, REASON_CREDENTIALS_MISSING } from "./usage-fetch.js";

export const PROVIDER_USAGE_CHANNEL = "pi:provider-usage";

// A rate limit event means "something changed", so a triggered refresh bypasses
// the TTL. Claude Code emits one per query, hence the debounce; the floor keeps
// a busy session from turning every burst into an upstream request.
export const FORCED_REFRESH_DEBOUNCE_MS = 5_000;
export const FORCED_REFRESH_FLOOR_MS = 30_000;

const MAX_NOTICE_LENGTH = 120;
const MAX_REASON_LENGTH = 80;

export interface ProviderUsageEventV1 {
	v: 1;
	providerId: string;
	quotas: UsageQuota[];
	capturedAt: string;
	notice?: string;
	unavailable?: { reason: string };
}

export interface UsagePublisherDeps {
	emit: (channel: string, payload: unknown) => void;
	claudeConfigDir: () => string;
	nowMs?: () => number;
	readCredentials?: (claudeConfigDir: string) => CredentialLookup;
	fetchUsage?: (token: string) => Promise<UsageFetchOutcome>;
	cacheDir?: string;
	ttlMs?: number;
	lockWaitMs?: number;
	/** Injected so tests drive the debounce without real time passing. */
	schedule?: (fn: () => void, ms: number) => { cancel: () => void };
	debounceMs?: number;
	floorMs?: number;
}

function defaultSchedule(fn: () => void, ms: number): { cancel: () => void } {
	const timer = setTimeout(fn, ms);
	timer.unref?.();
	return { cancel: () => clearTimeout(timer) };
}

// Bounded and stripped here rather than relying on the consumer's sanitizer:
// the bridge should never depend on somebody else's code to make its own output
// renderable, and the consumer's bounds are part of a contract, not a promise
// about what it will accept.
function sanitizeText(value: string, maxLength: number): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, maxLength);
}

export class UsagePublisher {
	private readonly deps: UsagePublisherDeps;
	private readonly now: () => number;
	private readonly schedule: (fn: () => void, ms: number) => { cancel: () => void };

	// Unavailability is emitted on transition, not per attempt: a provider
	// failing every poll should produce one event, not one per minute.
	private lastUnavailableReason: string | undefined;
	private pendingForce: { cancel: () => void } | undefined;
	private pendingStartup: { cancel: () => void } | undefined;
	private lastForcedAtMs: number | undefined;
	private inFlight: Promise<void> | undefined;

	constructor(deps: UsagePublisherDeps) {
		this.deps = deps;
		this.now = deps.nowMs ?? (() => Date.now());
		this.schedule = deps.schedule ?? defaultSchedule;
	}

	/** Refreshes and publishes. Never throws: a broken publisher must not break its caller. */
	async publish(options: { force?: boolean } = {}): Promise<void> {
		// Serialized rather than overlapped: two concurrent refreshes in one
		// process would contend for the same lock and produce two emits of the
		// same numbers, which is exactly what the cache exists to prevent.
		const run = (this.inFlight ?? Promise.resolve()).then(() => this.refresh(options));
		this.inFlight = run.catch(() => undefined);
		return this.inFlight;
	}

	/**
	 * Publishes once the whole startup has settled, rather than during it.
	 *
	 * Pi dispatches session_start sequentially in extension order, so an emit
	 * made inside this bridge's own handler reaches only the subscribers that
	 * came before it: an extension loaded after the bridge has not subscribed
	 * yet, and a fire-and-forget emit to nobody is simply lost. Measured, not
	 * assumed -- a probe extension received the snapshot when loaded first and
	 * nothing at all when loaded second.
	 *
	 * That matters more than it looks, because unavailability is emitted on
	 * transition: a missed first emit is not re-sent later, so a consumer would
	 * sit on "waiting" for the whole session while the bridge believed it had
	 * already reported the failure. Deferring past the dispatch loop makes the
	 * load order immaterial, which is what the cross-repo integration check
	 * requires.
	 */
	publishOnStartup(): void {
		this.pendingStartup?.cancel();
		this.pendingStartup = this.schedule(() => {
			this.pendingStartup = undefined;
			void this.publish();
		}, 0);
	}


	/**
	 * Records a rate limit event. The event is a trigger only: nothing it carries
	 * is ever published as usage (D6, D10), because merging two partial data
	 * sources is the shape of bug this design exists to avoid.
	 */
	noteRateLimitEvent(): void {
		const debounceMs = this.deps.debounceMs ?? FORCED_REFRESH_DEBOUNCE_MS;
		this.pendingForce?.cancel();
		this.pendingForce = this.schedule(() => {
			this.pendingForce = undefined;
			const floorMs = this.deps.floorMs ?? FORCED_REFRESH_FLOOR_MS;
			if (this.lastForcedAtMs !== undefined && this.now() - this.lastForcedAtMs < floorMs) return;
			this.lastForcedAtMs = this.now();
			void this.publish({ force: true });
		}, debounceMs);
	}

	/** Drops any scheduled refresh, so a shutdown leaves nothing pending. */
	dispose(): void {
		this.pendingForce?.cancel();
		this.pendingForce = undefined;
		this.pendingStartup?.cancel();
		this.pendingStartup = undefined;
	}

	/** Resolves once any refresh already under way has finished, without starting one. */
	settled(): Promise<void> {
		return this.inFlight ?? Promise.resolve();
	}

	private async refresh(options: { force?: boolean }): Promise<void> {
		try {
			const claudeConfigDir = this.deps.claudeConfigDir();
			const readCredentials = this.deps.readCredentials ?? readClaudeCredentials;
			const credential = readCredentials(claudeConfigDir);

			// A platform with no credential store was never going to work here, and
			// reporting that every session is noise rather than news (B2.4).
			if (credential.status === "unsupported") return;
			if (credential.status !== "ok" || !credential.token) {
				this.emitUnavailable(REASON_CREDENTIALS_MISSING);
				return;
			}

			const token = credential.token;
			const fetchUsage = this.deps.fetchUsage ?? ((value: string) => fetchClaudeUsage(value));
			const result = await loadUsageThroughCache({
				cacheFile: usageCacheFilePath(this.deps.cacheDir ?? resolveUsageCacheDir(), claudeConfigDir),
				fetchUsage: () => fetchUsage(token),
				nowMs: this.now,
				ttlMs: this.deps.ttlMs,
				lockWaitMs: this.deps.lockWaitMs,
				force: options.force,
			});

			// The numbers go first when we have them, even alongside a failure: a
			// consumer that has never heard from us would otherwise be told only
			// that we are broken, and would have nothing to mark stale.
			if (result.snapshot) this.emitSnapshot(result.snapshot);
			if (result.unavailable) {
				this.emitUnavailable(result.unavailable);
				return;
			}
			// Numbers arriving are the whole recovery protocol: there is no separate
			// "resolved" message for a consumer to miss.
			if (result.snapshot) this.lastUnavailableReason = undefined;
		} catch {
			// Publishing usage must never take a session down with it.
		}
	}

	private emitSnapshot(snapshot: UsageSnapshot): void {
		const notice = snapshot.notice ? sanitizeText(snapshot.notice, MAX_NOTICE_LENGTH) : "";
		this.send({
			v: 1,
			providerId: PROVIDER_ID,
			// Preserved verbatim from when the numbers were true, never reset to
			// now on re-publication, or staleness would silently never arrive.
			capturedAt: snapshot.capturedAt,
			quotas: snapshot.quotas,
			...(notice ? { notice } : {}),
		});
	}

	private emitUnavailable(reason: string): void {
		const sanitized = sanitizeText(reason, MAX_REASON_LENGTH) || "usage unavailable";
		if (sanitized === this.lastUnavailableReason) return;
		this.lastUnavailableReason = sanitized;
		this.send({
			v: 1,
			providerId: PROVIDER_ID,
			quotas: [],
			// The one snapshot whose capturedAt is now: it timestamps the failure,
			// which is current news, rather than the numbers, which are absent.
			capturedAt: new Date(this.now()).toISOString(),
			unavailable: { reason: sanitized },
		});
	}

	private send(payload: ProviderUsageEventV1): void {
		try {
			this.deps.emit(PROVIDER_USAGE_CHANNEL, payload);
		} catch {
			// Fire and forget: no subscribers is a no-op, and a throwing subscriber
			// is not this publisher's problem to surface.
		}
	}
}
