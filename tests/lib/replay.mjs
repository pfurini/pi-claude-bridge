/**
 * Shared harness for replaying SDK message streams through the real consumeQuery.
 *
 * consumeQuery and QueryContext are passed IN rather than imported here: the
 * reconcile/cost tests set CLAUDE_BRIDGE_DEBUG=1 before dynamically importing the
 * extension, and a static import of the module from this helper would run first
 * (imports hoist) and fix DEBUG at its load-time value. Keeping the extension out
 * of this file leaves that timing under each test's control.
 */
import { readFileSync, existsSync } from "node:fs";

/** Zero cost like buildModels ships (CC billing is per-plan); cost adoption trues
 *  the final segment up to the fixture's own total_cost_usd, so the reported cost
 *  is independent of this table. */
export const haikuModel = {
	api: "anthropic-messages", provider: "anthropic", id: "claude-haiku-4-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function loadFixture(name) {
	const path = new URL(`../fixtures/sdk-streams/${name}.jsonl`, import.meta.url);
	return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** A fixture's terminal result frame's four billable token fields — CC's own ground truth. */
export function resultUsage(messages) {
	const u = messages.find((m) => m.type === "result")?.usage ?? {};
	return {
		input: u.input_tokens ?? 0, output: u.output_tokens ?? 0,
		cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0,
	};
}
export function fixtureCost(messages) {
	return messages.find((m) => m.type === "result")?.total_cost_usd;
}

export function readLines(path) {
	if (!path || !existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").filter(Boolean);
}
export function debugMatches(path, re) {
	return readLines(path).filter((l) => re.test(l));
}
export function diagEntries(path, label) {
	return readLines(path).map((l) => { try { return JSON.parse(l); } catch { return null; } })
		.filter((e) => e && e.label === label);
}

/** Drive the real consumeQuery over `messages`, collecting the pi-side events.
 *
 *  With `rearm`, mimics the provider's tool-result delivery: when a tool call ends
 *  a segment (currentPiStream nulled), re-claim a fresh stream and call
 *  resetTurnState, exactly as streamClaudeAgentSdk does on the next streamSimple
 *  call. A plain replay leaves post-tool segments unaccumulated (the null-stream
 *  guard skips them), so multi-segment assertions need it.
 *
 *  `doneMessages` are the closed segments' AssistantMessages (each tool boundary
 *  emits one); the final segment stays as ctx.turnOutput (it is finalized after
 *  consumeQuery, in the provider). */
export async function driveConsumeQuery(consumeQuery, QueryContext, messages, { model = haikuModel, rearm = false, toolNames = ["read"], ctx } = {}) {
	const events = [];
	const c = ctx ?? new QueryContext();
	const arm = () => { c.currentPiStream = { push: (e) => events.push(e), end: () => events.push({ type: "end" }) }; };
	arm();
	c.beginQuery();
	c.resetTurnState(model);
	const map = new Map(toolNames.map((n) => [`mcp__custom-tools__${n}`, n]));
	async function* stream() {
		for (const m of messages) {
			if (rearm && c.currentPiStream === null) { arm(); c.resetTurnState(model); }
			yield m;
		}
	}
	const { capturedSessionId } = await consumeQuery(stream(), map, model, () => false, c);
	const doneMessages = events.filter((e) => e.type === "done").map((e) => e.message);
	return { events, ctx: c, capturedSessionId, doneMessages };
}
