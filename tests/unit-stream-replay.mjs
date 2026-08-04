/**
 * consumeQuery against real recorded SDK streams.
 *
 * The fixtures in tests/fixtures/sdk-streams/ are verbatim message sequences from
 * live Claude Code turns, captured by tests/lib/record-sdk-streams.mjs. Nothing
 * here is hand-authored, so these cover the message shapes CC actually emits —
 * including ones we would not have thought to write, like the `system/status`
 * frames and the `rate_limit_event` every turn carries. Re-record on an SDK bump
 * and the diff is the contract change.
 *
 * The synthetic streams in unit-error-result.mjs and unit-unserved-tool-use.mjs
 * stay synthetic on purpose: a 429 and a hallucinated tool name cannot be recorded
 * on demand.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";
import { driveConsumeQuery, loadFixture, resultUsage } from "./lib/replay.mjs";

const { __test } = await import("../src/index.js");

// buildModels (src/models.ts) forwards each catalog entry's real pricing; the zero
// cost in the shared harness model is a deliberate test choice — cost adoption
// trues the final segment up to the fixture's own `total_cost_usd`, so the reported
// cost is independent of the model's local price table (see the cost-adoption suite).
async function replay(name, opts = {}) {
	const messages = loadFixture(name);
	const { events, ctx, capturedSessionId } = await driveConsumeQuery(__test.consumeQuery, QueryContext, messages, opts);
	return { events, ctx, messages, capturedSessionId };
}

const blocks = (ctx, type) => ctx.turnOutput.content.filter((b) => b.type === type);

describe("replaying a recorded text-only turn", () => {
	it("produces the assistant text and a clean stop", async () => {
		const { ctx, events } = await replay("text");

		assert.equal(blocks(ctx, "text").map((b) => b.text).join("").trim(), "ALPHA");
		assert.equal(ctx.turnOutput.stopReason, "stop");
		assert.equal(ctx.turnSawToolCall, false);
		assert.ok(events.some((e) => e.type === "text_delta"), "pi should have seen streaming deltas");
	});

	it("reports usage and captures the session id", async () => {
		const { ctx, capturedSessionId } = await replay("text");

		assert.ok(ctx.turnOutput.usage.output > 0, "output tokens");
		assert.ok(ctx.turnOutput.usage.input + ctx.turnOutput.usage.cacheRead + ctx.turnOutput.usage.cacheWrite > 0, "prompt tokens");
		assert.match(capturedSessionId ?? "", /^[0-9a-f-]{36}$/);
	});

	it("accumulates reasoning from output_tokens_details.thinking_tokens", async () => {
		const { ctx } = await replay("text");
		// The recorded turn thinks 39 of its 47 output tokens.
		assert.equal(ctx.turnOutput.usage.reasoning, 39);
		assert.ok(ctx.turnOutput.usage.reasoning < ctx.turnOutput.usage.output, "reasoning is a subset of output");
	});

	it("the query token total equals CC's result.usage", async () => {
		const { ctx, messages } = await replay("text");
		const total = ctx.queryTokenTotal();
		const cc = resultUsage(messages);
		assert.deepEqual(
			{ input: total.input, output: total.output, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite },
			cc,
		);
	});

	it("clears the accumulator between queries (twice through one context)", async () => {
		// Reusing the top-level ctx() is the real production path; a missing
		// beginQuery would leave the first query's totals to double the second.
		const c = new QueryContext();
		await replay("text", { ctx: c });
		const first = c.queryTokenTotal();
		const { messages } = await replay("text", { ctx: c });
		const second = c.queryTokenTotal();
		assert.deepEqual(second, first, "second query must not inherit the first query's totals");
		const cc = resultUsage(messages);
		assert.deepEqual(
			{ input: second.input, output: second.output, cacheRead: second.cacheRead, cacheWrite: second.cacheWrite },
			cc,
		);
	});
});

describe("replaying a recorded single-tool turn", () => {
	it("surfaces the tool call under its pi name and ends the turn on it", async () => {
		const { ctx } = await replay("single-tool");

		const calls = blocks(ctx, "toolCall");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].name, "read", "SDK's mcp__custom-tools__read must arrive as pi's read");
		assert.ok(calls[0].id.startsWith("toolu_"));
		assert.equal(ctx.turnSawToolCall, true);
		assert.deepEqual(ctx.turnToolCallIds, [calls[0].id]);
	});

	// The load-bearing fold-order pin at the call site: segment 1 closes at the
	// tool boundary, and closeSegment must bank it BEFORE the delivery path's
	// resetTurnState wipes usageLive. Pre-fix this yields only segment 1's tokens.
	it("sums both segments into the query total, matching result.usage", async () => {
		const { ctx, messages } = await replay("single-tool", { rearm: true });
		const total = ctx.queryTokenTotal();
		const cc = resultUsage(messages);
		assert.deepEqual(
			{ input: total.input, output: total.output, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite },
			cc,
			"query total must equal CC's result.usage across the tool boundary",
		);
	});
});

describe("replaying a recorded parallel-tool turn", () => {
	it("keeps every parallel call, in emission order", async () => {
		const { ctx } = await replay("parallel-tools");

		const calls = blocks(ctx, "toolCall");
		assert.ok(calls.length >= 2, `expected a parallel batch, got ${calls.length}`);
		assert.deepEqual(ctx.turnToolCallIds, calls.map((c) => c.id), "routing ids must match the emitted calls, in order");
		assert.equal(new Set(calls.map((c) => c.id)).size, calls.length, "no duplicate ids");
		for (const call of calls) assert.equal(call.name, "read");
	});

	// The bug in 122914dd was a tool_use surviving into pi under a name the bridge
	// does not serve. Recorded streams are the check that the names CC really sends
	// are the ones the map is keyed on.
	it("leaves nothing unmapped when the served tool list is empty", async () => {
		const { ctx } = await replay("parallel-tools", { toolNames: [] });

		assert.equal(blocks(ctx, "toolCall").length, 0, "unserved names must not reach pi");
		assert.equal(ctx.turnSawToolCall, false);
	});

	it("sums both segments into the query total, matching result.usage", async () => {
		const { ctx, messages } = await replay("parallel-tools", { rearm: true });
		const total = ctx.queryTokenTotal();
		const cc = resultUsage(messages);
		assert.deepEqual(
			{ input: total.input, output: total.output, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite },
			cc,
		);
	});
});
