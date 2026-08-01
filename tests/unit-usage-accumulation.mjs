/**
 * Usage across a bridged turn is a SUM over API responses, not the last value.
 *
 * pi's contract is one AssistantMessage per API response, so its native
 * providers assign usage - message_start and message_delta refine the same
 * response. This provider wraps a whole Claude Code session (many responses) in
 * one pi turn, so assigning reported only the final response's tokens: a turn
 * with a dozen tool calls showed the tokens of its closing sentence, and the
 * arm looked an order of magnitude cheaper than it was.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

// Mirrors updateUsage's arithmetic against a real QueryContext, which is what
// the provider calls; keeps the test independent of index.ts's activation.
function applyUsage(c, usage) {
	if (usage.input_tokens != null) c.usageLive.input = usage.input_tokens;
	if (usage.output_tokens != null) c.usageLive.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) c.usageLive.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) c.usageLive.cacheWrite = usage.cache_creation_input_tokens;
	return {
		input: c.usageBase.input + c.usageLive.input,
		output: c.usageBase.output + c.usageLive.output,
		cacheRead: c.usageBase.cacheRead + c.usageLive.cacheRead,
		cacheWrite: c.usageBase.cacheWrite + c.usageLive.cacheWrite,
	};
}

const model = { id: "m", api: "anthropic", provider: "p" };

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
