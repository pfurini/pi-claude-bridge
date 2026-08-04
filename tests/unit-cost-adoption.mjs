/**
 * Cost adoption: the reported cost for a bridged query is Claude Code's own
 * total_cost_usd, applied by truing up the still-open final segment so pi's
 * session sum (which reads message.usage.cost.total) equals CC's figure exactly.
 * Closed segments keep their per-segment estimates; only the final total is
 * authoritative. Abort/missing-result leaves the estimates untouched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.CLAUDE_BRIDGE_DEBUG = "1";
const { __test } = await import("../src/index.js");
const { QueryContext } = await import("../src/query-state.js");
const { driveConsumeQuery, loadFixture, fixtureCost, haikuModel, debugMatches: matchDebug } = await import("./lib/replay.mjs");

const DEBUG_PATH = process.env.CLAUDE_BRIDGE_DEBUG_PATH;
const debugMatches = (re) => matchDebug(DEBUG_PATH, re);

// Zero cost so a segment's ESTIMATE is 0 and the adopted final cost equals
// total_cost_usd outright — the assertions then read the pure adoption.
const zeroModel = haikuModel;
// Real rates so the estimate is non-zero — used to prove the abort path keeps it.
const pricedModel = {
	api: "anthropic-messages", provider: "anthropic", id: "abort-priced-model",
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

const fixture = loadFixture;
const run = (messages, opts = {}) => driveConsumeQuery(__test.consumeQuery, QueryContext, messages, { model: zeroModel, ...opts });

describe("cost adoption", () => {
	it("a single-response turn reports CC's total_cost_usd exactly", async () => {
		const messages = fixture("text");
		const { ctx } = await run(messages);
		assert.equal(ctx.turnOutput.usage.cost.total, fixtureCost(messages));
	});

	it("trues up the final segment so the query's cost sum equals CC's figure", async () => {
		const messages = fixture("single-tool");
		const { ctx, doneMessages } = await run(messages, { rearm: true });
		const cc = fixtureCost(messages);

		// The tool-boundary segment kept its estimate (0 under the zero-cost model)…
		assert.equal(doneMessages.length, 1, "one closed segment (the tool-boundary one)");
		assert.equal(doneMessages[0].usage.cost.total, 0, "closed segment keeps its estimate, not the true-up");
		// …and the whole true-up landed on the final segment.
		assert.equal(ctx.turnOutput.usage.cost.total, cc, "final segment carries cc - bankedEstimate");

		const sum = [...doneMessages, ctx.turnOutput].reduce((a, m) => a + m.usage.cost.total, 0);
		assert.equal(sum, cc, "session sum across every segment equals CC's total_cost_usd");
	});

	it("logs cc/est/delta and allows a negative true-up (catalog drift)", async () => {
		// A synthetic query whose CC cost is BELOW the banked estimate would drive the
		// final segment negative; here the estimate is 0 so we just assert the log shape.
		const messages = fixture("parallel-tools");
		await run(messages, { rearm: true });
		const cc = fixtureCost(messages);
		assert.ok(debugMatches(new RegExp(`cost: cc=${cc} est=0 delta=${cc} `)).length >= 1, "a cost: cc/est/delta line");
	});

	it("leaves estimates untouched when the result frame never arrives (abort)", async () => {
		// A stream that ends without a `result` — adoptCcCost never runs.
		const messages = fixture("text").filter((m) => m.type !== "result");
		const { ctx } = await run(messages, { model: pricedModel });
		assert.ok(ctx.turnOutput.usage.cost.total > 0, "the streaming estimate survives");
		assert.equal(debugMatches(/cost: cc=.* model=abort-priced-model/).length, 0, "no adoption line — estimates untouched");
	});
});
