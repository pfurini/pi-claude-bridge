import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convertPiMessages, mapPiToolNameToSdk } from "../src/convert.js";
import { __test } from "../src/index.js";

const PREFIX = "mcp__custom-tools__";
// Official API tool-name constraint (undated; retrieved 2026-09-30):
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
const API_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

function inventory(...names) {
	return __test.resolveMcpTools({
		messages: [],
		tools: names.map(name => ({ name, description: "Fixture tool", parameters: { type: "object", properties: {} } })),
	});
}

describe("nested MCP tool names", () => {
	for (const name of ["mcp__server__tool", "mcp__MixedServer__MixedTool", "codemode"]) {
		it(`round-trips ${name} through the served inventory and transcript conversion`, () => {
			const { mcpTools, customToolNameToSdk, customToolNameToPi } = inventory(name);
			const sdkName = `${PREFIX}${name}`;
			assert.equal(mcpTools[0].name, name);
			assert.equal(mapPiToolNameToSdk(name, customToolNameToSdk), sdkName);
			assert.equal(mapPiToolNameToSdk(name.toLowerCase(), customToolNameToSdk), sdkName);
			assert.equal(__test.piToolNameFor(sdkName, customToolNameToPi), name);
			assert.equal(__test.piToolNameFor(sdkName.toLowerCase(), customToolNameToPi), name);

			const input = name === "codemode" ? { code: "return 1;" } : { query: "fixture" };
			const { anthropicMessages } = convertPiMessages([
				{ role: "assistant", content: [{ type: "toolCall", id: "call_1", name, arguments: input }] },
				{ role: "toolResult", toolCallId: "call_1", content: "fixture result", isError: false },
			], customToolNameToSdk);
			assert.deepEqual(anthropicMessages[0].content, [
				{ type: "tool_use", id: "call_1", name: sdkName, input },
			]);
			assert.deepEqual(anthropicMessages[1].content, [
				{ type: "tool_result", tool_use_id: "call_1", content: "fixture result", is_error: false },
			]);
			assert.equal(__test.piToolNameFor(anthropicMessages[0].content[0].name, customToolNameToPi), name);
		});
	}

	it("rejects unknown nested names by inventory rather than stripping a prefix", () => {
		const { customToolNameToPi } = inventory("mcp__server__tool");
		for (const name of [
			"mcp__server__tool",
			`${PREFIX}mcp__unknown__tool`,
			`${PREFIX}mcp__server__unknown`,
			`${PREFIX}${PREFIX}mcp__server__tool`,
		]) assert.equal(__test.piToolNameFor(name, customToolNameToPi), undefined, name);
	});

	for (const length of [128, 129]) {
		it(`characterizes the API boundary at ${length} total prefixed characters without imposing a bridge policy`, () => {
			const stem = "mcp__server__";
			const name = stem + "t".repeat(length - PREFIX.length - stem.length);
			const { mcpTools, customToolNameToSdk, customToolNameToPi } = inventory(name);
			const sdkName = mapPiToolNameToSdk(name, customToolNameToSdk);
			assert.match(name, API_TOOL_NAME);
			assert.equal(sdkName, `${PREFIX}${name}`);
			assert.equal(sdkName.length, length);
			assert.equal(API_TOOL_NAME.test(sdkName), length === 128);
			// The bridge currently preserves names, even when the prefixed name exceeds the API limit.
			assert.equal(mcpTools[0].name, name);
			assert.equal(__test.piToolNameFor(sdkName, customToolNameToPi), name);
		});
	}
});
