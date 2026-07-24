import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import {
	createSdkMessageState,
	parseSdkResult,
	rateLimitResetDate,
	rateLimitUtilizationPercent,
	reduceSdkMessage,
	resultErrorText,
} from "../src/sdk-messages.js";

function message(value) {
	return value;
}

describe("SDK message reduction", () => {
	it("accumulates streamed text and reports each delta", () => {
		const state = createSdkMessageState();
		const first = reduceSdkMessage(
			state,
			message({
				type: "stream_event",
				event: {
					type: "content_block_delta",
					delta: { type: "text_delta", text: "hello " },
				},
			}),
		);
		const second = reduceSdkMessage(
			state,
			message({
				type: "stream_event",
				event: {
					type: "content_block_delta",
					delta: { type: "text_delta", text: "world" },
				},
			}),
		);

		assert.equal(first.textDelta, "hello ");
		assert.equal(second.textDelta, "world");
		assert.equal(state.streamedText, "hello world");
		assert.equal(state.textDeltaCount, 2);
	});

	it("captures tool starts and completed tool inputs", () => {
		const state = createSdkMessageState();
		const started = reduceSdkMessage(
			state,
			message({
				type: "stream_event",
				event: {
					type: "content_block_start",
					content_block: { type: "tool_use", id: "tool-1", name: "Read" },
				},
			}),
		);
		const completed = reduceSdkMessage(
			state,
			message({
				type: "assistant",
				message: {
					content: [
						{ type: "text", text: "done" },
						{
							type: "tool_use",
							id: "tool-1",
							name: "Read",
							input: { file_path: "README.md" },
						},
					],
				},
			}),
		);

		assert.deepEqual(started.toolUseStarted, { id: "tool-1", name: "Read" });
		assert.deepEqual(completed.toolUsesCompleted, [
			{
				id: "tool-1",
				name: "Read",
				input: { file_path: "README.md" },
			},
		]);
		assert.equal(state.assistantText, "done");
	});

	it("captures the functional system initialization contract", () => {
		const state = createSdkMessageState();
		const reduced = reduceSdkMessage(
			state,
			message({
				type: "system",
				subtype: "init",
				session_id: "session-1",
				claude_code_version: "2.1.test",
				tools: ["Read", "mcp__custom-tools__echo"],
				mcp_servers: [{ name: "custom-tools", status: "connected" }],
			}),
		);

		assert.equal(reduced.sessionId, "session-1");
		assert.deepEqual(reduced.systemInit, {
			sessionId: "session-1",
			claudeCodeVersion: "2.1.test",
			tools: ["Read", "mcp__custom-tools__echo"],
			mcpServers: [{ name: "custom-tools", status: "connected" }],
		});
		assert.deepEqual(state.systemInit, reduced.systemInit);
	});

	it("uses completed assistant text when a success result omits result text", () => {
		const state = createSdkMessageState();
		reduceSdkMessage(
			state,
			message({
				type: "assistant",
				message: { content: [{ type: "text", text: "assistant fallback" }] },
			}),
		);
		const reduced = reduceSdkMessage(
			state,
			message({
				type: "result",
				subtype: "success",
				is_error: false,
				result: "",
			}),
		);

		assert.equal(reduced.result.successful, true);
		assert.equal(reduced.result.isError, false);
		assert.equal(reduced.result.text, "assistant fallback");
	});

	it("preserves terminal error detail for non-success results", () => {
		const result = parseSdkResult(
			message({
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
				errors: ["first failure", "second failure"],
			}),
			"",
			"Claude Code summary",
		);

		assert.equal(result.successful, false);
		assert.equal(result.isError, true);
		assert.equal(result.errorText, "first failure\nsecond failure");
		assert.equal(
			resultErrorText(
				message({ type: "result", subtype: "timeout" }),
				"Claude Code summary",
			),
			"Claude Code summary failed: timeout",
		);
	});

	it("keeps terminal metadata structured and out of retry-classified error text", () => {
		const state = createSdkMessageState();
		const reduced = reduceSdkMessage(
			state,
			message({
				type: "result",
				subtype: "success",
				is_error: true,
				result: "Credit balance is too low",
				terminal_reason: "api_error",
				session_id: "00000000-0504-4000-8000-000000000000",
			}),
		);

		assert.equal(reduced.result.successful, false);
		assert.equal(reduced.result.isError, true);
		assert.equal(reduced.result.terminalReason, "api_error");
		assert.equal(reduced.result.sessionId, "00000000-0504-4000-8000-000000000000");
		assert.equal(state.sessionId, "00000000-0504-4000-8000-000000000000");
		assert.equal(reduced.result.errorText, "Credit balance is too low");
		assert.doesNotMatch(reduced.result.errorText, /504|session_id/);
		assert.equal(isRetryableAssistantError({
			stopReason: "error",
			errorMessage: reduced.result.errorText,
		}), false);
	});

	it("marks unknown future message types without throwing", () => {
		const state = createSdkMessageState();
		const reduced = reduceSdkMessage(
			state,
			message({ type: "future_message", payload: 1 }),
		);

		assert.equal(reduced.unknown, true);
		assert.deepEqual(state.unknownMessageTypes, ["future_message"]);
	});
});

describe("rate-limit display conversions", () => {
	it("converts SDK epoch seconds to JavaScript milliseconds", () => {
		assert.equal(rateLimitResetDate(1_700_000_000).getTime(), 1_700_000_000_000);
		assert.equal(rateLimitResetDate(undefined), undefined);
		assert.equal(rateLimitResetDate(Number.NaN), undefined);
		assert.equal(rateLimitResetDate(Number.POSITIVE_INFINITY), undefined);
	});

	it("formats SDK utilization fractions as floored percentages", () => {
		assert.equal(rateLimitUtilizationPercent(undefined), 0);
		assert.equal(rateLimitUtilizationPercent(0), 0);
		assert.equal(rateLimitUtilizationPercent(0.7), 70);
		assert.equal(rateLimitUtilizationPercent(0.85), 85);
		assert.equal(rateLimitUtilizationPercent(1), 100);
	});
});
