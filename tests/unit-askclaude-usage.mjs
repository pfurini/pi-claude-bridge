/**
 * AskClaude and compaction summaries attribute their own token/cost spend so it
 * lands in pi's /usage "Tools/summaries" bucket instead of being discarded. Two
 * pieces are unit-testable without a live query: the SDK-usage → pi-Usage mapping,
 * and the compact usage line the result row renders.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatUsageLine } from "../src/askclaude-ui.js";

const { __test } = await import("../src/index.js");
const map = __test.resultFrameToPiUsage;
// resultFrameToPiUsage takes the raw SDK result frame.
const frame = (usage, { totalCostUsd, modelUsage } = {}) => ({ type: "result", subtype: "success", usage, total_cost_usd: totalCostUsd, ...(modelUsage ? { modelUsage } : {}) });

describe("resultFrameToPiUsage", () => {
	it("maps the four billable fields, sets totalTokens, and adopts total_cost_usd", () => {
		const u = map(frame({ input_tokens: 10, output_tokens: 47, cache_read_input_tokens: 100, cache_creation_input_tokens: 200 }, { totalCostUsd: 0.0190428 }));
		assert.equal(u.input, 10);
		assert.equal(u.output, 47);
		assert.equal(u.cacheRead, 100);
		assert.equal(u.cacheWrite, 200);
		assert.equal(u.totalTokens, 357, "totalTokens = in+out+cacheRead+cacheWrite");
		assert.equal(u.cost.total, 0.0190428, "cost.total adopts CC's figure");
		// Components stay zero — only the total is authoritative (Decision 6).
		assert.deepEqual({ ...u.cost, total: 0 }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
	});

	it("prefers the modelUsage sum (subagent-inclusive) over result.usage tokens", () => {
		// A read/full AskClaude call ran a subagent: result.usage counts only the
		// top-level loop (200 output), modelUsage counts both models (200 + 500).
		const u = map(frame(
			{ input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			{ totalCostUsd: 0.5, modelUsage: {
				"claude-opus-5": { inputTokens: 10, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
				"claude-haiku-4-5": { inputTokens: 5, outputTokens: 500, cacheReadInputTokens: 40, cacheCreationInputTokens: 7 },
			} }));
		assert.equal(u.input, 15, "input sums across models");
		assert.equal(u.output, 700, "output includes the subagent's 500, not just the top-level 200");
		assert.equal(u.cacheRead, 40);
		assert.equal(u.cacheWrite, 7);
		assert.equal(u.totalTokens, 762);
		assert.equal(u.cost.total, 0.5, "cost is CC's subagent-inclusive figure");
	});

	it("carries reasoning from result.usage output_tokens_details, omitting it when absent", () => {
		assert.equal(map(frame({ output_tokens: 47, output_tokens_details: { thinking_tokens: 39 } }, { totalCostUsd: 1 })).reasoning, 39);
		assert.equal(map(frame({ output_tokens: 47 }, { totalCostUsd: 1 })).reasoning, undefined);
	});

	it("falls back to result.usage when modelUsage is absent, defaulting missing fields to 0", () => {
		const u = map(frame(undefined, {}));
		assert.deepEqual(
			{ input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, totalTokens: u.totalTokens },
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		);
		assert.equal(u.cost.total, 0, "non-numeric total_cost_usd yields 0, not NaN");
	});
});

describe("formatUsageLine", () => {
	it("renders k-tokens with cost", () => {
		assert.equal(formatUsageLine({ totalTokens: 12400, cost: 0.31 }), "12.4k tok · $0.31");
	});
	it("renders bare tokens under 1k and drops zero cost", () => {
		assert.equal(formatUsageLine({ totalTokens: 850, cost: 0 }), "850 tok");
	});
	it("returns empty when there is nothing to show", () => {
		assert.equal(formatUsageLine({ totalTokens: 0, cost: 0 }), "");
		assert.equal(formatUsageLine(undefined), "");
	});
});
