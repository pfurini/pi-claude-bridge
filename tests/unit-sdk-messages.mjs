import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createSdkMessageState,
	parseSdkResult,
	reduceSdkMessage,
	resultErrorText,
} from "../src/sdk-messages.js";

function message(value) {
	return value;
}

describe("SDK message reduction", () => {
	it("accumulates streamed text and reports each delta", () => {
		const state = createSdkMessageState();
		const first = reduceSdkMessage(state, message({
			type: "stream_event",
			event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello " } },
		}));
		const second = reduceSdkMessage(state, message({
			type: "stream_event",
			event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } },
		}));

		assert.equal(first.textDelta, "hello ");
		assert.equal(second.textDelta, "world");
		assert.equal(state.streamedText, "hello world");
		assert.equal(state.textDeltaCount, 2);
	});

	it("captures tool starts and completed tool inputs", () => {
		const state = createSdkMessageState();
		const started = reduceSdkMessage(state, message({
			type: "stream_event",
			event: {
				type: "content_block_start",
				content_block: { type: "tool_use", id: "tool-1", name: "Read" },
			},
		}));
		const completed = reduceSdkMessage(state, message({
			type: "assistant",
			message: {
				content: [
					{ type: "text", text: "done" },
					{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
				],
			},
		}));

		assert.deepEqual(started.toolUseStarted, { id: "tool-1", name: "Read" });
		assert.deepEqual(completed.toolUsesCompleted, [{
			id: "tool-1",
			name: "Read",
			input: { file_path: "README.md" },
		}]);
		assert.equal(state.assistantText, "done");
	});

	it("captures session initialization without depending on the full init shape", () => {
		const state = createSdkMessageState();
		const reduced = reduceSdkMessage(state, message({
			type: "system",
			subtype: "init",
			session_id: "session-1",
			tools: ["Read"],
		}));

		assert.equal(reduced.sessionId, "session-1");
		assert.equal(state.sessionId, "session-1");
	});

	it("uses completed assistant text when a success result omits result text", () => {
		const state = createSdkMessageState();
		reduceSdkMessage(state, message({
			type: "assistant",
			message: { content: [{ type: "text", text: "assistant fallback" }] },
		}));
		const reduced = reduceSdkMessage(state, message({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "",
		}));

		assert.equal(reduced.result.successful, true);
		assert.equal(reduced.result.isError, false);
		assert.equal(reduced.result.text, "assistant fallback");
	});

	it("preserves terminal error detail for non-success results", () => {
		const result = parseSdkResult(message({
			type: "result",
			subtype: "error_during_execution",
			is_error: true,
			errors: ["first failure", "second failure"],
		}), "", "Claude Code summary");

		assert.equal(result.successful, false);
		assert.equal(result.isError, true);
		assert.equal(result.errorText, "first failure\nsecond failure");
		assert.equal(resultErrorText(message({ type: "result", subtype: "timeout" }), "Claude Code summary"), "Claude Code summary failed: timeout");
	});

	it("marks unknown future message types without throwing", () => {
		const state = createSdkMessageState();
		const reduced = reduceSdkMessage(state, message({ type: "future_message", payload: 1 }));

		assert.equal(reduced.unknown, true);
		assert.deepEqual(state.unknownMessageTypes, ["future_message"]);
	});
});
