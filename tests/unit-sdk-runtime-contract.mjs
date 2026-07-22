import { it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const fakeClaude = fileURLToPath(new URL("./fixtures/fake-claude-cli.mjs", import.meta.url));

it("runs an unauthenticated stream-json query through the fake Claude executable", { timeout: 10_000 }, async () => {
	const abortController = new AbortController();
	const sdkQuery = query({
		prompt: "offline contract prompt",
		options: {
			abortController,
			cwd: process.cwd(),
			env: {
				...process.env,
				FAKE_CLAUDE_RESPONSE: "offline contract response",
			},
			pathToClaudeCodeExecutable: fakeClaude,
			tools: [],
			settingSources: [],
			persistSession: false,
			maxTurns: 1,
		},
	});

	const messages = [];
	try {
		for await (const message of sdkQuery) messages.push(message);
	} finally {
		sdkQuery.close();
	}

	const init = messages.find((message) => message.type === "system" && message.subtype === "init");
	assert.equal(init.claude_code_version, "0.0.0-fake");
	assert.equal(init.session_id, "00000000-0000-4000-8000-000000000001");

	const streamedText = messages
		.filter((message) => message.type === "stream_event")
		.filter((message) => message.event?.type === "content_block_delta")
		.map((message) => message.event.delta?.text ?? "")
		.join("");
	assert.equal(streamedText, "offline contract response");

	const assistant = messages.find((message) => message.type === "assistant");
	assert.equal(assistant.message.content[0].text, "offline contract response");

	const result = messages.find((message) => message.type === "result");
	assert.equal(result.subtype, "success");
	assert.equal(result.is_error, false);
	assert.equal(result.result, "offline contract response");
});
