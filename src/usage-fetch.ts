// Fetches and normalizes Claude subscription usage from Anthropic's OAuth usage
// endpoint, the single data path for published usage (D6).
//
// Normalization is defined against this endpoint's own shapes. The SDK helpers
// rateLimitResetDate/rateLimitUtilizationPercent in sdk-messages.ts convert
// epoch seconds and 0..1 fractions out of rate_limit_event, and must not be
// applied here: the endpoint already reports utilization as 0..100 and resets_at
// as ISO 8601, so running them over these values would report 32% as 3200%.

import type { UsageFetchOutcome, UsageQuota, UsageSnapshot } from "./usage-cache.js";

export const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
export const OAUTH_BETA_HEADER = "oauth-2025-04-20";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_SCOPED_QUOTAS = 4;

// The closed set of reasons a publisher may report. These are rendered verbatim
// in another extension's terminal, so nothing from an upstream response body, an
// exception message, a file path, or a credential is ever interpolated into one.
// A status code is the only dynamic part, because it is the only part that tells
// an operator something they can act on.
export const REASON_CREDENTIALS_MISSING = "Claude Code credentials not found";
export const REASON_CREDENTIALS_REJECTED = "Claude Code credentials expired or rejected";
export const REASON_UNREACHABLE = "usage endpoint unreachable";
export const REASON_UNREADABLE = "unreadable usage response";
export const REASON_RATE_LIMITED = "usage endpoint rate limited";
export const reasonForStatus = (status: number): string => `usage endpoint returned ${status}`;

export interface UsageFetchDeps {
	fetchFn?: typeof fetch;
	timeoutMs?: number;
	nowMs?: () => number;
}

function clampPercent(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(100, Math.round(value)));
}

function isoOrUndefined(value: unknown): string | undefined {
	// Passed through verbatim: the endpoint already reports ISO 8601, and any
	// conversion here would be the epoch-seconds mistake in a different disguise.
	return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

// Terminal-facing text, so the same treatment a label gets on the consumer side:
// control characters stripped and length bounded here, rather than relying on
// the consumer's sanitizer to make our own output renderable.
function sanitizeText(value: string, maxLength: number): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, maxLength);
}

export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | undefined {
	if (!header) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(header);
	return Number.isFinite(date) ? Math.max(0, date - nowMs) : undefined;
}

export function normalizeUsagePayload(payload: unknown, capturedAt: string): UsageSnapshot | undefined {
	const data = payload as Record<string, any> | null;
	if (!data || typeof data !== "object") return undefined;

	const quotas: UsageQuota[] = [];
	const session = clampPercent(data.five_hour?.utilization);
	if (session !== undefined) {
		quotas.push({ kind: "session", percent: session, resetsAt: isoOrUndefined(data.five_hour?.resets_at) });
	}
	const weekly = clampPercent(data.seven_day?.utilization);
	if (weekly !== undefined) {
		quotas.push({ kind: "weekly", percent: weekly, resetsAt: isoOrUndefined(data.seven_day?.resets_at) });
	}

	// Model-scoped weekly allowances (for example the Max-plan Fable allowance).
	// The session and weekly_all siblings duplicate the two windows above, so
	// only scoped entries carrying a model name become their own lane.
	let scopedLanes = 0;
	for (const entry of Array.isArray(data.limits) ? data.limits : []) {
		if (scopedLanes >= MAX_SCOPED_QUOTAS) break;
		if (entry?.kind !== "weekly_scoped") continue;
		const percent = clampPercent(entry.percent);
		const label = typeof entry.scope?.model?.display_name === "string"
			? sanitizeText(entry.scope.model.display_name, 32)
			: "";
		if (percent === undefined || !label) continue;
		quotas.push({ kind: "scoped", label, percent, resetsAt: isoOrUndefined(entry.resets_at) });
		scopedLanes += 1;
	}

	// A response that carries no window at all is not a reading. Treating it as
	// one would publish an empty snapshot that the consumer renders as a bare
	// provider name, which says less than an explicit failure would.
	if (quotas.length === 0) return undefined;

	const extra = data.extra_usage;
	// Fixed phrase, never assembled from a response field: an account that has
	// used metered usage before and has it switched off now is a state worth
	// naming, because it changes what happens when a limit is reached.
	const notice = extra?.is_enabled === false && extra?.credits_ever_enabled === true
		? "overage disabled"
		: undefined;

	return { quotas, capturedAt, notice };
}

export async function fetchClaudeUsage(token: string, deps: UsageFetchDeps = {}): Promise<UsageFetchOutcome> {
	const fetchFn = deps.fetchFn ?? fetch;
	const now = deps.nowMs ?? (() => Date.now());
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? REQUEST_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetchFn(USAGE_ENDPOINT, {
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": OAUTH_BETA_HEADER,
			},
			signal: controller.signal,
		});
	} catch {
		// The exception message can quote the request, so it is neither reported
		// nor logged: a transport failure is one fact, and that fact is the reason.
		return { ok: false, reason: REASON_UNREACHABLE };
	} finally {
		clearTimeout(timeout);
	}

	if (response.status === 401 || response.status === 403) {
		// The one failure an operator can actually act on, and the reason a token
		// is never pre-validated against an expiry field (D11): this is where
		// unusability is discovered.
		return { ok: false, reason: REASON_CREDENTIALS_REJECTED };
	}
	if (response.status === 429) {
		return {
			ok: false,
			reason: REASON_RATE_LIMITED,
			rateLimited: true,
			retryAfterMs: parseRetryAfterMs(response.headers?.get?.("retry-after"), now()),
		};
	}
	if (!response.ok) {
		return { ok: false, reason: reasonForStatus(response.status) };
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return { ok: false, reason: REASON_UNREADABLE };
	}

	// capturedAt records when the numbers were true, which is when we read them.
	const snapshot = normalizeUsagePayload(payload, new Date(now()).toISOString());
	if (!snapshot) return { ok: false, reason: REASON_UNREADABLE };
	return { ok: true, snapshot };
}
