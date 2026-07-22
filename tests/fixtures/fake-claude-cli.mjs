#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const ASSISTANT_ID = "msg_000000000000000000000001";
const ASSISTANT_UUID = "00000000-0000-4000-8000-000000000002";
const RESULT_UUID = "00000000-0000-4000-8000-000000000003";
const responseText = process.env.FAKE_CLAUDE_RESPONSE ?? "Fake Claude response";

if (process.argv.includes("--version")) {
	process.stdout.write("0.0.0-fake (Claude Code)\n");
	process.exit(0);
}

function log(value) {
	if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(value)}\n`);
}

function emit(value) {
	log({ direction: "out", value });
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respondToControlRequest(message) {
	emit({
		type: "control_response",
		response: {
			subtype: "success",
			request_id: message.request_id,
			response: {
				commands: [],
				models: [],
				agents: [],
				account: null,
			},
		},
	});
}

function emitConversation() {
	emit({
		type: "system",
		subtype: "init",
		cwd: process.cwd(),
		session_id: SESSION_ID,
		tools: [],
		mcp_servers: [],
		model: "fake-claude",
		permissionMode: "bypassPermissions",
		slash_commands: [],
		apiKeySource: "none",
		claude_code_version: "0.0.0-fake",
		output_style: "default",
		uuid: "00000000-0000-4000-8000-000000000000",
	});

	if (process.env.FAKE_CLAUDE_EMIT_UNKNOWN === "1") {
		emit({ type: "future_message", value: "ignored by current consumers" });
	}

	emit({
		type: "stream_event",
		event: {
			type: "message_start",
			message: {
				id: ASSISTANT_ID,
				type: "message",
				role: "assistant",
				content: [],
				model: "fake-claude",
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		parent_tool_use_id: null,
		uuid: ASSISTANT_UUID,
		session_id: SESSION_ID,
	});
	emit({
		type: "stream_event",
		event: {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		},
		parent_tool_use_id: null,
		uuid: ASSISTANT_UUID,
		session_id: SESSION_ID,
	});
	emit({
		type: "stream_event",
		event: {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: responseText },
		},
		parent_tool_use_id: null,
		uuid: ASSISTANT_UUID,
		session_id: SESSION_ID,
	});
	emit({
		type: "stream_event",
		event: { type: "content_block_stop", index: 0 },
		parent_tool_use_id: null,
		uuid: ASSISTANT_UUID,
		session_id: SESSION_ID,
	});
	emit({
		type: "stream_event",
		event: {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 3 },
		},
		parent_tool_use_id: null,
		uuid: ASSISTANT_UUID,
		session_id: SESSION_ID,
	});
	emit({
		type: "stream_event",
		event: { type: "message_stop" },
		parent_tool_use_id: null,
		uuid: ASSISTANT_UUID,
		session_id: SESSION_ID,
	});
	emit({
		type: "assistant",
		message: {
			id: ASSISTANT_ID,
			type: "message",
			role: "assistant",
			model: "fake-claude",
			content: [{ type: "text", text: responseText }],
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 3 },
		},
		parent_tool_use_id: null,
		uuid: ASSISTANT_UUID,
		session_id: SESSION_ID,
	});
	emit({
		type: "result",
		subtype: "success",
		duration_ms: 1,
		duration_api_ms: 1,
		is_error: false,
		num_turns: 1,
		result: responseText,
		session_id: SESSION_ID,
		total_cost_usd: 0,
		usage: { input_tokens: 1, output_tokens: 3 },
		modelUsage: {},
		permission_denials: [],
		uuid: RESULT_UUID,
	});
}

let emitted = false;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
	if (!line.trim()) return;
	let message;
	try {
		message = JSON.parse(line);
	} catch (error) {
		process.stderr.write(`fake-claude: invalid JSON input: ${error.message}\n`);
		process.exitCode = 1;
		return;
	}
	log({ direction: "in", value: message });
	if (message.type === "control_request") {
		respondToControlRequest(message);
		return;
	}
	if (message.type === "user" && !emitted) {
		emitted = true;
		emitConversation();
	}
});
