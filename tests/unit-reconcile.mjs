/**
 * Reconciliation at result time: the query's stream-derived token sum must equal
 * Claude Code's own result.usage, exactly. A match logs a `reconcile: ok` line; a
 * mismatch logs a `WARNING: reconcile mismatch` line AND writes a reconcile_mismatch
 * diagDump entry carrying both sides and the per-segment breakdown.
 *
 * debug() is gated on CLAUDE_BRIDGE_DEBUG, so this file enables it before importing
 * the module — that makes the reconcile:/WARNING: lines observable in the redirected
 * debug log. diagDump() writes unconditionally to the redirected diag log.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.CLAUDE_BRIDGE_DEBUG = "1";
const { __test } = await import("../src/index.js");
const { QueryContext } = await import("../src/query-state.js");
const { driveConsumeQuery, loadFixture, debugMatches: matchDebug, diagEntries: readDiag } = await import("./lib/replay.mjs");

const DIAG_PATH = process.env.CLAUDE_BRIDGE_DIAG_PATH;
const DEBUG_PATH = process.env.CLAUDE_BRIDGE_DEBUG_PATH;
const diagEntries = (label) => readDiag(DIAG_PATH, label);
const debugMatches = (re) => matchDebug(DEBUG_PATH, re);

/** A one-response query: message_start, a text block, message_delta (end_turn),
 *  message_stop, then a result frame whose usage we control. */
function syntheticStream(sessionId, resultUsage, { totalCostUsd = 0.001, modelUsage } = {}) {
	return [
		{ type: "system", subtype: "init", session_id: sessionId, tools: [], mcp_servers: [] },
		{ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 1 } } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } } },
		{ type: "stream_event", event: { type: "message_stop" } },
		{ type: "result", subtype: "success", session_id: sessionId, usage: resultUsage, total_cost_usd: totalCostUsd, ...(modelUsage ? { modelUsage } : {}) },
	];
}

const run = (messages, opts = {}) => driveConsumeQuery(__test.consumeQuery, QueryContext, messages, opts);

describe("reconciliation", () => {
	it("matching result.usage logs reconcile: ok and writes no mismatch entry", async () => {
		const session = "recon-ok-0000-0000-0000-000000000000";
		// Accumulated sum for the synthetic stream: in=10, out=20, cacheRead=0, cacheWrite=100.
		await run(syntheticStream(session, { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 }));
		assert.equal(diagEntries("reconcile_mismatch").filter((e) => e.session === session).length, 0, "no mismatch entry on a clean reconcile");
		assert.ok(debugMatches(/reconcile: ok in=10 out=20 cacheRead=0 cacheWrite=100/).length >= 1, "a reconcile: ok line");
	});

	it("wrong result.usage logs a WARNING and dumps ours/cc/delta with the segment breakdown", async () => {
		const session = "recon-bad-1111-1111-1111-111111111111";
		// CC claims 999 output; we streamed 20. Everything else matches.
		await run(syntheticStream(session, { input_tokens: 10, output_tokens: 999, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 }));

		assert.ok(debugMatches(/WARNING: reconcile mismatch/).length >= 1, "a WARNING: reconcile mismatch line");
		const entry = diagEntries("reconcile_mismatch").find((e) => e.session === session);
		assert.ok(entry, "a reconcile_mismatch diag entry for this session");
		assert.deepEqual(entry.ours, { input: 10, output: 20, cacheRead: 0, cacheWrite: 100 });
		assert.deepEqual(entry.cc, { input: 10, output: 999, cacheRead: 0, cacheWrite: 100 });
		assert.equal(entry.delta.output, 20 - 999, "delta is ours - cc");
		assert.equal(entry.model, "claude-haiku-4-5");
		// One segment (final, open), so no closed segments and the open one carries the tokens.
		assert.deepEqual(entry.closedSegments, []);
		assert.equal(entry.openSegment.output, 20);
	});

	it("modelUsage diverging from result.usage logs a side-model warning (log-only)", async () => {
		const session = "recon-mu-2222-2222-2222-222222222222";
		// modelUsage sums to a different output than result.usage — the log-only cross-check.
		await run(syntheticStream(session,
			{ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 },
			{ modelUsage: { "claude-haiku-4-5": { inputTokens: 10, outputTokens: 999, cacheReadInputTokens: 0, cacheCreationInputTokens: 100 } } }));
		assert.ok(debugMatches(/reconcile: WARNING modelUsage != result\.usage/).length >= 1, "a modelUsage cross-check warning");
		// result.usage itself still matched our stream, so no reconcile_mismatch dump.
		assert.equal(diagEntries("reconcile_mismatch").filter((e) => e.session === session).length, 0);
	});
});

describe("reconciliation against recorded fixtures", () => {
	for (const name of ["text", "single-tool", "parallel-tools"]) {
		it(`${name}.jsonl reconciles clean against its own result.usage`, async () => {
			const before = diagEntries("reconcile_mismatch").length;
			await run(loadFixture(name), { rearm: true });
			assert.equal(diagEntries("reconcile_mismatch").length, before, `${name} must not produce a mismatch`);
		});
	}
});
