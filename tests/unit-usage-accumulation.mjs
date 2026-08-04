/**
 * Usage across a bridged turn is a SUM over API responses, not the last value.
 *
 * pi's contract is one AssistantMessage per API response, so its native
 * providers assign usage - message_start and message_delta refine the same
 * response. This provider wraps a whole Claude Code session (many responses) in
 * one pi turn, so assigning reported only the final response's tokens: a turn
 * with a dozen tool calls showed the tokens of its closing sentence, and the
 * arm looked an order of magnitude cheaper than it was.
 *
 * These scenarios drive the REAL updateUsage (via __test) against a real
 * QueryContext, so the arithmetic under test is the code the provider runs, not
 * a hand-mirrored copy that can drift from it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const { __test } = await import("../src/index.js");

// Zero cost like buildModels ships (Claude Code billing is per-plan); updateUsage
// still reaches calculateCost, so the model must carry a cost table.
const model = {
	api: "anthropic-messages", provider: "anthropic", id: "claude-haiku-4-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

// One updateUsage call (one message_start/message_delta) against the turn output.
function applyUsage(c, usage) {
	__test.updateUsage(c.turnOutput, usage, model, c);
	const u = c.turnOutput.usage;
	return { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite };
}

describe("turn usage accumulation", () => {
	it("refines within one response without double counting", () => {
		const c = new QueryContext();
		c.resetTurnState(model);
		c.beginUsageResponse();
		applyUsage(c, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 500 });
		// message_delta refines the SAME response: output grows, not adds twice
		const out = applyUsage(c, { output_tokens: 250 });
		assert.deepEqual(out, { input: 10, output: 250, cacheRead: 500, cacheWrite: 0 });
	});

	it("sums across responses in one turn", () => {
		const c = new QueryContext();
		c.resetTurnState(model);
		// response 1
		c.beginUsageResponse();
		applyUsage(c, { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 });
		applyUsage(c, { output_tokens: 300 });
		// response 2 (a tool round-trip)
		c.beginUsageResponse();
		applyUsage(c, { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 1200 });
		const out = applyUsage(c, { output_tokens: 150 });
		assert.deepEqual(out, { input: 8, output: 450, cacheRead: 2200, cacheWrite: 200 });
	});

	it("a twelve-response turn reports the sum, not the last response", () => {
		const c = new QueryContext();
		c.resetTurnState(model);
		let out;
		for (let i = 0; i < 12; i++) {
			c.beginUsageResponse();
			out = applyUsage(c, { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 50_000 });
		}
		assert.equal(out.output, 1200, "output must be 12x100, not 100");
		assert.equal(out.cacheRead, 600_000, "cache reads bill per request and must sum");
	});

	it("resetTurnState clears the accumulator between turns", () => {
		const c = new QueryContext();
		c.resetTurnState(model);
		c.beginUsageResponse();
		applyUsage(c, { output_tokens: 999, cache_read_input_tokens: 9999 });
		c.resetTurnState(model);
		c.beginUsageResponse();
		const out = applyUsage(c, { output_tokens: 7 });
		assert.deepEqual(out, { input: 0, output: 7, cacheRead: 0, cacheWrite: 0 });
	});
});

describe("reasoning tokens", () => {
	it("reads output_tokens_details.thinking_tokens and reports it, not the dead top-level fields", () => {
		const c = new QueryContext();
		c.resetTurnState(model);
		c.beginUsageResponse();
		// The dead reads the rewire removed: neither must surface anything.
		applyUsage(c, { output_tokens: 47, reasoning_tokens: 111, thinking_tokens: 222 });
		assert.equal(c.turnOutput.usage.reasoning, undefined, "no reasoning without output_tokens_details");
		applyUsage(c, { output_tokens: 47, output_tokens_details: { thinking_tokens: 39 } });
		assert.equal(c.turnOutput.usage.reasoning, 39);
	});

	it("sums across responses and stays a subset of output (never in totalTokens)", () => {
		const c = new QueryContext();
		c.resetTurnState(model);
		c.beginUsageResponse();
		applyUsage(c, { output_tokens: 176, output_tokens_details: { thinking_tokens: 113 } });
		c.beginUsageResponse();
		applyUsage(c, { output_tokens: 45, output_tokens_details: { thinking_tokens: 39 } });
		const u = c.turnOutput.usage;
		assert.equal(u.reasoning, 152, "reasoning sums 113 + 39");
		assert.equal(u.output, 221, "output sums 176 + 45");
		assert.equal(u.totalTokens, u.input + u.output + u.cacheRead + u.cacheWrite, "reasoning must not inflate totalTokens");
	});
});

// The query-scoped accumulator survives resetTurnState (which fires on every
// tool-result delivery) so the query's sum equals CC's result.usage. The
// fold-order pin: the closing segment's live response is banked BEFORE the wipe.
describe("query-scoped accumulator", () => {
	it("closeSegment banks the open live response before resetTurnState wipes it", () => {
		const c = new QueryContext();
		c.resetTurnState(model);
		// Segment 1 (ends on a tool call): its final values sit in usageLive.
		c.beginUsageResponse();
		applyUsage(c, { input_tokens: 10, output_tokens: 176, cache_read_input_tokens: 9332, output_tokens_details: { thinking_tokens: 113 } });
		// Tool boundary: bank, THEN the delivery path wipes per-segment state.
		c.closeSegment();
		c.resetTurnState(model);
		// Segment 2 (final): a fresh response.
		c.beginUsageResponse();
		applyUsage(c, { input_tokens: 8, output_tokens: 45, cache_read_input_tokens: 9332, cache_creation_input_tokens: 199, output_tokens_details: { thinking_tokens: 39 } });

		assert.deepEqual(c.queryTokenTotal(), {
			input: 18, output: 221, cacheRead: 18664, cacheWrite: 199, reasoning: 152,
		}, "query total = both segments, proving the closing segment survived the wipe");
	});

	it("beginQuery clears the accumulator so a second query starts from zero", () => {
		const c = new QueryContext();
		c.resetTurnState(model);
		c.beginUsageResponse();
		applyUsage(c, { input_tokens: 10, output_tokens: 47, cache_creation_input_tokens: 9317 });
		c.closeSegment();
		assert.equal(c.queryTotals.output, 47);

		c.beginQuery();
		c.resetTurnState(model);
		c.beginUsageResponse();
		applyUsage(c, { input_tokens: 3, output_tokens: 5 });
		assert.deepEqual(c.queryTokenTotal(), { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
	});
});
