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
 * The stop-* fixtures are real Claude Code streams too, but answered by the stub
 * API in diag/probe-stop-reasons.mjs: no prompt provokes a refusal or a context
 * window exhausted mid-generation. The probe re-records them, and
 * record-sdk-streams.mjs --from-raw scrubs them.
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

// --- Stops recorded against a scripted API (diag/probe-stop-reasons.mjs) ---
//
// Each response streams the text PARTIAL and then stops. The probe's stub repeats the
// stop on every request, so these record Claude Code's own handling end to end: one
// refusal retry, three max-output recovery attempts, then its notice and the result.
// The exception is refusal-tool, whose stub answers normally from its third request.

const fourFields = (u) => ({ input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite });
const texts = (ctx) => blocks(ctx, "text").map((b) => b.text);
const { isContextOverflow } = await import("@earendil-works/pi-ai/utils/overflow");
const { isRetryableAssistantError } = await import("@earendil-works/pi-ai/utils/retry");

/** Replay, then settle the last segment as the provider does once consumeQuery returns. */
async function replayToEnd(messages) {
	const { events, ctx } = await driveConsumeQuery(__test.consumeQuery, QueryContext, messages);
	__test.finalizeCurrentStream(ctx, ctx.turnOutput.stopReason);
	return { events, ctx, terminal: events.at(-2) };
}

describe("replaying a recorded stop: end_turn (the control)", () => {
	it("finalizes as a clean stop with the streamed text", async () => {
		const { ctx, terminal } = await replayToEnd(loadFixture("stop-end-turn"));
		assert.deepEqual(texts(ctx), ["CONTROL"]);
		assert.equal(terminal.type, "done");
		assert.equal(ctx.turnOutput.stopReason, "stop");
	});
});

describe("replaying a recorded stop: refusal", () => {
	// Claude Code retries a first refusal once, then sends its notice: a <synthetic>
	// assistant message with `error` set, BEFORE the refused stream's message_delta.
	const messages = loadFixture("stop-refusal");
	const notice = messages.find((m) => m.type === "assistant" && m.error !== undefined);

	it("records the notice ahead of message_delta, under a fresh id", () => {
		// The shape the handling below depends on. If CC moves the notice, re-probe.
		assert.equal(notice?.message.model, "<synthetic>");
		const at = messages.indexOf(notice);
		assert.equal(messages[at + 1].event?.type, "message_delta");
		assert.notEqual(notice.message.id, messages.findLast((m) => m.event?.type === "message_start").event.message.id);
	});

	it("keeps the refused response's streamed blocks and starts each index once", async () => {
		const { ctx, events } = await replayToEnd(messages);
		assert.deepEqual(texts(ctx), ["PARTIAL", "PARTIAL"], "the notice must not replace the streamed text");
		const starts = events.filter((e) => e.type === "text_start").map((e) => e.contentIndex);
		assert.equal(new Set(starts).size, starts.length, `a content index was started twice: ${starts}`);
	});

	it("counts each API response once: the query total equals CC's result.usage", async () => {
		const { ctx } = await replayToEnd(messages);
		assert.deepEqual(fourFields(ctx.queryTokenTotal()), resultUsage(messages));
		assert.deepEqual(fourFields(ctx.turnOutput.usage), resultUsage(messages));
	});

	it("ends as an error Pi neither retries nor compacts", async () => {
		const { ctx, terminal } = await replayToEnd(messages);
		assert.equal(terminal.type, "error");
		assert.equal(ctx.turnOutput.stopReason, "error");
		assert.equal(ctx.turnOutput.errorMessage, "Claude refused to complete the request");
		assert.equal(isRetryableAssistantError(ctx.turnOutput), false);
		assert.equal(isContextOverflow(ctx.turnOutput), false);
	});

	const withDetails = (details) => messages.map((m) => (m === notice ? { ...m, message: { ...m.message, stop_details: details } } : m));

	it("names the refusal's category and explanation when the API gives them", async () => {
		const { ctx } = await replayToEnd(withDetails({ type: "refusal", category: "cyber", explanation: "Flagged by a safeguard." }));
		assert.equal(ctx.turnOutput.errorMessage, "Claude refused to complete the request (cyber): Flagged by a safeguard.");
	});

	it("drops an explanation that would make Pi retry the refusal", async () => {
		const { ctx } = await replayToEnd(withDetails({ type: "refusal", category: "cyber", explanation: "Request timed out of policy review." }));
		assert.equal(ctx.turnOutput.errorMessage, "Claude refused to complete the request");
		assert.equal(isRetryableAssistantError(ctx.turnOutput), false);
	});

	it("does not carry a refusal's details into the next query", async () => {
		// The first query is cut after the notice, as an abort would leave it.
		const c = new QueryContext();
		const cut = withDetails({ type: "refusal", category: "cyber", explanation: null });
		await driveConsumeQuery(__test.consumeQuery, QueryContext, cut.slice(0, cut.findIndex((m) => m.error !== undefined) + 1), { ctx: c });
		const result = messages.find((m) => m.type === "result");
		await driveConsumeQuery(__test.consumeQuery, QueryContext, [result], { ctx: c });
		assert.equal(c.turnOutput.errorMessage, "Claude refused to complete the request");
	});

	// The first refusal, cut where Claude Code decides to retry it.
	const firstRefusal = messages.slice(0, messages.findIndex((m) => m.event?.type === "message_stop") + 1);

	it("reads a refusal stop as an error before any result arrives", async () => {
		const { ctx } = await driveConsumeQuery(__test.consumeQuery, QueryContext, firstRefusal);
		assert.equal(ctx.turnOutput.stopReason, "error");
	});

	it("ends a turn CC completed as a stop, even when its last message_delta was a refusal", async () => {
		// A retry that fell back to non-streaming carries no message_delta of its own.
		const success = { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: "fine" };
		const { ctx, terminal } = await replayToEnd([...firstRefusal, success]);
		assert.equal(terminal.type, "done");
		assert.equal(ctx.turnOutput.stopReason, "stop");
	});
});

describe("replaying a recorded stop: refusal of a response with a tool call", () => {
	// CC does not end the turn on this final refusal: after its notice it dispatches
	// the refused response's tool call over MCP and goes on (CC 2.1.284). Pi must run
	// that call, or CC waits on an MCP handler that never gets a result.
	const messages = loadFixture("stop-refusal-tool");
	const results = messages.filter((m) => m.type === "user").flatMap((m) => (Array.isArray(m.message.content) ? m.message.content : []))
		.filter((b) => b.type === "tool_result");
	const dispatched = results.find((b) => !JSON.stringify(b.content).includes("Interrupted"))?.tool_use_id;

	it("records CC dispatching the call after its notice", () => {
		assert.ok(dispatched, "no tool call ran to completion — re-probe");
		const notice = messages.findIndex((m) => m.error !== undefined);
		assert.ok(notice !== -1 && messages.findIndex((m) => m.message?.content?.[0]?.tool_use_id === dispatched) > notice);
		assert.equal(messages.find((m) => m.type === "result").is_error, false);
	});

	it("hands the call CC dispatches to pi as a tool-use stop", async () => {
		const { doneMessages, ctx } = await driveConsumeQuery(__test.consumeQuery, QueryContext, messages, { rearm: true, toolNames: ["probe"] });
		const handed = doneMessages.filter((m) => m.stopReason === "toolUse").flatMap((m) => m.content.filter((b) => b.type === "toolCall").map((b) => b.id));
		assert.ok(handed.includes(dispatched), `pi never got ${dispatched}; it got ${handed}`);
		const allText = [...doneMessages, ctx.turnOutput].flatMap((m) => m.content).filter((b) => b.type === "text").map((b) => b.text);
		assert.ok(!allText.some((t) => t.startsWith("API Error")), "the notice must not become content");
	});
});

describe("replaying a recorded stop: model_context_window_exceeded", () => {
	// Claude Code withholds this notice through its max-output recovery, so it arrives
	// after the last stream closed. It still must not reach pi as content.
	it("reports the failure once, as an overflow Pi compacts", async () => {
		const { ctx, terminal } = await replayToEnd(loadFixture("stop-context-window"));
		assert.deepEqual(texts(ctx), ["PARTIAL", "PARTIAL", "PARTIAL", "PARTIAL"], "the notice must not become content");
		assert.equal(terminal.type, "error");
		assert.equal(ctx.turnOutput.errorMessage, "API Error: The model has reached its context window limit. (context_length_exceeded)");
		assert.equal(isContextOverflow(ctx.turnOutput), true);
	});
});

describe("replaying a recorded stop: max_tokens", () => {
	it("reports the failure once, through the result", async () => {
		const messages = loadFixture("stop-max-tokens");
		const { ctx, terminal } = await replayToEnd(messages);
		assert.deepEqual(texts(ctx), ["PARTIAL", "PARTIAL", "PARTIAL", "PARTIAL"], "the notice must not become content");
		assert.equal(terminal.type, "error");
		assert.equal(ctx.turnOutput.errorMessage, messages.find((m) => m.type === "result").result);
	});
});
