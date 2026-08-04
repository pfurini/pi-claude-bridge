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
	usageBase = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	usageLive = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;

	/** Fold the live response into the base; call when a new API response starts. */
	beginUsageResponse(): void {
		for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			this.usageBase[k] += this.usageLive[k];
			this.usageLive[k] = 0;
		}
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
		this.usageBase = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		this.usageLive = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
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
