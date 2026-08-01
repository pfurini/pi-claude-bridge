// Query state: QueryContext class.
//
// All per-query and per-turn mutable state lives here. Reentrant queries
// (subagents) each get their own QueryContext instance, managed by index.ts.
// Adding a new field = one property on the class.
//
// Extracted from index.ts so tests can import without activating the extension.

import type { AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { McpResult } from "./extract-tool-results.js";

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
	turnToolCallIds: string[] = [];
	nextHandlerIdx = 0;
	deferredUserMessages: string[] = [];

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
		// turnToolCallIds and nextHandlerIdx are NOT reset — they persist across
		// tool-result delivery callbacks within the same assistant message.
	}
}

let _ctx = new QueryContext();

export function ctx(): QueryContext { return _ctx; }

// Test-only: replace the module-level context so test files start clean.
// Not called from production.
export function resetCtx(): void {
	_ctx = new QueryContext();
}
