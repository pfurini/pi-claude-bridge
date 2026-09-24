import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

type ModelCounters = Record<string, Record<string, unknown>>;

/** Claude Code resumes these cumulative counters from its persisted session. */
export interface AccountingSnapshot {
	totalCostUsd: number;
	modelUsage?: ModelCounters;
}

/** A rebuild starts a new epoch even when the transcript keeps the same session UUID. */
export interface AccountingEpoch {
	snapshot: AccountingSnapshot | undefined;
	inFlight: boolean;
}

export function newAccountingEpoch(): AccountingEpoch {
	return { snapshot: { totalCostUsd: 0, modelUsage: {} }, inFlight: false };
}

const COUNTERS = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "thinkingTokens", "webSearchRequests", "costUSD"] as const;
const validNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function modelUsageDelta(current: ModelCounters | undefined, baseline: AccountingSnapshot): ModelCounters | undefined {
	if (!current || (!baseline.modelUsage && baseline.totalCostUsd > 0)) return undefined;
	const previous = baseline.modelUsage ?? {};
	const delta: ModelCounters = {};
	for (const name of new Set([...Object.keys(previous), ...Object.keys(current)])) {
		const row = current[name];
		if (!row || typeof row !== "object") return undefined;
		const result = { ...row };
		for (const key of COUNTERS) {
			if (row[key] === undefined && previous[name]?.[key] === undefined) continue;
			const now = row[key] ?? 0;
			const before = previous[name]?.[key] ?? 0;
			if (!validNumber(now) || !validNumber(before) || now + (key === "costUSD" ? 1e-12 : 0) < before) return undefined;
			result[key] = Math.max(0, now - before);
		}
		delta[name] = result;
	}
	return delta;
}

/** Project cumulative cost/model usage onto one query without changing current-query result.usage. */
export function queryAccounting(message: SDKMessage, baseline: AccountingSnapshot = { totalCostUsd: 0, modelUsage: {} }): {
	message: SDKMessage;
	snapshot: AccountingSnapshot | undefined;
} {
	const raw = message as SDKMessage & { total_cost_usd?: unknown; modelUsage?: ModelCounters; is_error?: boolean; subtype?: string };
	const cost = raw.total_cost_usd;
	const failed = raw.is_error === true || (raw.subtype !== undefined && raw.subtype !== "success");
	const validCost = validNumber(cost) && cost + 1e-12 >= baseline.totalCostUsd && !(failed && cost === 0);
	const deltaModels = modelUsageDelta(raw.modelUsage, baseline);
	const validModels = modelUsageDelta(raw.modelUsage, { totalCostUsd: 0, modelUsage: {} });
	return {
		message: { ...message, total_cost_usd: validCost ? Math.max(0, cost - baseline.totalCostUsd) : undefined, modelUsage: deltaModels } as SDKMessage,
		snapshot: validCost ? {
			totalCostUsd: cost,
			...(validModels ? { modelUsage: structuredClone(raw.modelUsage) } : {}),
		} : undefined,
	};
}
