// Query state: QueryContext class.
//
// All per-query and per-turn mutable state lives here. Reentrant queries
// (subagents) each get their own QueryContext instance, managed by index.ts.
// Adding a new field = one property on the class.
//
// Extracted from index.ts so tests can import without activating the extension.

import type { AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { McpResult } from "./extract-tool-results.js";
import type { PromptStream } from "./prompt-stream.js";

export interface PendingToolCall {
	toolName: string;
	resolve: (result: McpResult) => void;
}

/** The token fields accumulated per segment and per query. The first four are the
 *  billable set reconciled against CC's result.usage; `reasoning` is a subset of
 *  `output`, carried informationally and never reconciled or added to totals. */
export interface UsageTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
}
const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const;
const zeroUsageTokens = (): UsageTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });

export class QueryContext {
	// Query-scoped (fully isolated per query)
	activeQuery: unknown | null = null;
	currentPiStream: AssistantMessageEventStream | null = null;
	latestCursor = 0;
	pendingToolCalls = new Map<string, PendingToolCall>();
	pendingResults = new Map<string, McpResult>();
	/** tool_use ids emitted this turn. Sole purpose is routing a delivered result
	 *  to the owning query when several queries are in flight — pairing a result
	 *  to its call is done by id from Claude's tools/call _meta, not from here. */
	turnToolCallIds: string[] = [];
	/** Streaming-input handle for the active query — how steers reach CC mid-turn. */
	promptStream: PromptStream | null = null;

	// Per-turn (reset together)
	turnOutput: AssistantMessage | null = null;
	// USAGE ACROSS A TURN IS A SUM, NOT THE LAST VALUE.
	//
	// pi's contract is one AssistantMessage per API response, so its native
	// providers assign usage: message_start and message_delta refine the SAME
	// response. This provider is different - one pi turn wraps a whole Claude
	// Code session, dozens of API responses, and assigning meant the turn
	// reported only its final response's tokens. A twelve-tool-call turn showed
	// the tokens of its closing sentence.
	//
	// usageBase holds the responses already completed this turn; the live
	// response's values are assigned as they refine, and the reported usage is
	// base + live. message_start marks the boundary where the live response
	// folds into the base.
	usageBase: UsageTokens = zeroUsageTokens();
	usageLive: UsageTokens = zeroUsageTokens();
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;
	/** True once any API response this turn carried a reasoning/thinking breakdown.
	 *  Gates whether `usage.reasoning` and the `reasoning=` debug field are emitted,
	 *  so non-thinking traffic keeps its shape. */
	turnSawReasoning = false;

	// QUERY-SCOPED TOTALS — the sum across every API response of the whole query()
	// call, which is what CC's result.usage reports. One pi query wraps many pi
	// messages (one per tool round-trip); usageBase/usageLive above are per-message
	// and are wiped by resetTurnState on each tool-result delivery. These survive
	// that wipe: closeSegment() folds a message's usage in as it closes, and
	// queryTokenTotal() adds the still-open final segment. Cleared only by
	// beginQuery() where a query begins — never by resetTurnState.
	queryTotals: UsageTokens = zeroUsageTokens();
	/** Sum of closed segments' estimated `cost.total`. The final segment's cost is
	 *  trued-up to CC's figure at result time, so it is deliberately NOT banked here. */
	queryBankedCost = 0;
	/** Per-closed-segment token snapshots, for the reconciler's diag breakdown on a
	 *  mismatch. The still-open final segment is not here — the reconciler appends it. */
	querySegments: UsageTokens[] = [];

	/** Fold the live response into the base; call when a new API response starts. */
	beginUsageResponse(): void {
		for (const k of USAGE_KEYS) {
			this.usageBase[k] += this.usageLive[k];
			this.usageLive[k] = 0;
		}
	}

	/** Clear the query-scoped accumulator. Call once where a query begins (the
	 *  fresh-query path reusing the top-level ctx(); reentrant contexts are fresh
	 *  instances that already start clean). Without this the totals would carry
	 *  from the previous query and trip the reconciler on every later turn. */
	beginQuery(): void {
		this.queryTotals = zeroUsageTokens();
		this.queryBankedCost = 0;
		this.querySegments = [];
	}

	/** Bank the current segment (this pi message) into the query totals before
	 *  resetTurnState wipes usageBase/usageLive on the next tool-result delivery.
	 *  Folds the live response into the base first (the closing response's tokens
	 *  are still in the live slot at a tool boundary), then adds the whole segment
	 *  to the query totals and banks its estimated cost. Idempotent: it zeroes the
	 *  per-segment slots, so a redundant call adds nothing. */
	closeSegment(): void {
		this.beginUsageResponse();
		const segment = zeroUsageTokens();
		for (const k of USAGE_KEYS) {
			segment[k] = this.usageBase[k];
			this.queryTotals[k] += this.usageBase[k];
			this.usageBase[k] = 0;
		}
		this.querySegments.push(segment);
		this.queryBankedCost += this.turnOutput?.usage.cost.total ?? 0;
	}

	/** The query's token sum so far: closed segments plus the still-open segment
	 *  (usageBase + usageLive). At result time this equals CC's result.usage. */
	queryTokenTotal(): UsageTokens {
		const out = { ...this.queryTotals };
		for (const k of USAGE_KEYS) {
			out[k] += this.usageBase[k] + this.usageLive[k];
		}
		return out;
	}

	get turnBlocks(): Array<any> {
		if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
		return this.turnOutput.content;
	}

	/** Answer every parked MCP handler with `reason` and forget the turn's queued
	 *  results. Called when the query it belongs to is going away (abort, error,
	 *  normal end). Handlers must be *resolved*, not rejected: an error reply is
	 *  still a reply, and a handler left awaiting a subprocess that is gone keeps
	 *  CC's tools/call open forever, which wedges pi's turn behind it. */
	releasePendingToolCalls(reason: string): void {
		for (const pending of this.pendingToolCalls.values()) pending.resolve({ content: [{ type: "text", text: reason }] });
		this.pendingToolCalls.clear();
		this.pendingResults.clear();
	}

	resetTurnState(model: Model<any>): void {
		this.turnOutput = {
			role: "assistant", content: [],
			api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		};
		this.turnStarted = false;
		this.turnSawStreamEvent = false;
		this.turnSawToolCall = false;
		this.turnSawReasoning = false;
		this.usageBase = zeroUsageTokens();
		this.usageLive = zeroUsageTokens();
		// turnToolCallIds is NOT reset — it persists across tool-result delivery
		// callbacks within the same assistant message so results can be routed to
		// this query while its handlers are still pending.
	}
}

let _ctx = new QueryContext();

export function ctx(): QueryContext { return _ctx; }

// Test-only: replace the module-level context so test files start clean.
// Not called from production.
export function resetCtx(): void {
	_ctx = new QueryContext();
}

/** Abort teardown for one query: settle everything that would otherwise be left
 *  awaiting a subprocess we are about to kill. The pump abandons iteration on
 *  abort, so an in-flight prompt-stream push would hang forever and take
 *  tool-result delivery with it. `reason` is the text handed to parked MCP
 *  handlers and the failed prompt stream; it defaults to the abort wording so the
 *  onAbort call site is unchanged. */
export function drainForAbort(c: QueryContext, promptStream: PromptStream, reason = "Operation aborted"): void {
	promptStream.fail(new Error(reason));
	c.releasePendingToolCalls(reason);
}

/** The minimal live-query handle the reaper drives (the SDK `query()` result). */
interface ReapableQuery {
	interrupt(): Promise<unknown>;
	close(): void;
}

/** Kill every Claude Code child still parked in `contexts` and empty the set.
 *  Pure and importable (takes the set explicitly) so it is unit-testable without
 *  activating the extension. Snapshots first: each query's own `.finally()` deletes
 *  from `contexts` as it settles, so iterating the live set would skip entries.
 *  Each context is torn down in its own try/catch so one throwing handle cannot
 *  strand the rest. */
export function reapLiveQueries(contexts: Set<QueryContext>, reason: string): void {
	for (const queryCtx of [...contexts]) {
		try {
			if (queryCtx.promptStream) drainForAbort(queryCtx, queryCtx.promptStream, reason);
			const q = queryCtx.activeQuery as ReapableQuery | null;
			if (q) {
				// interrupt() asks the CLI to stop gracefully; close() kills it. Both
				// are needed (interrupt alone lets the current API call finish), and
				// interrupt must NOT be awaited before close — a sync try/catch would
				// not catch its rejection, so swallow it on the promise instead.
				void q.interrupt().catch(() => {});
				try { q.close(); } catch {}
			}
			queryCtx.activeQuery = null;
			contexts.delete(queryCtx);
		} catch {
			// A single context's teardown throwing must not stop the others.
		}
	}
}

/** Owner-gated wrapper over `reapLiveQueries`. The gate is a separate pure seam so
 *  the non-owner no-op is unit-testable; the pure reaper itself takes no ownership
 *  input. Only the provider-owner instance reaps, mirroring the existing
 *  ACTIVE_STREAM_SIMPLE_KEY guard, so a non-owner same-cwd session's shutdown does
 *  not tear down the owner's queries. */
export function reapLiveQueriesIfOwner(isOwner: boolean, contexts: Set<QueryContext>, reason: string): void {
	if (isOwner) reapLiveQueries(contexts, reason);
}
