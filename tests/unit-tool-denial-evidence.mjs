import { it } from "node:test";
import assert from "node:assert/strict";
import { unexplainedToolRequests } from "./lib/tool-denial-evidence.mjs";
const request = (id = "call_1", name = "Bash") => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: {} }] } });
const reply = (is_error, content, tool_use_id = "call_1") => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id, is_error, content }] } });
const log = (name = "Bash", id = "call_1") => `2026-09-30T17:54:13.441Z [DEBUG] Unknown tool ${name}: ${id}\n`;
const check = (frames, cli = "") => unexplainedToolRequests(frames, cli, ["Bash", "Write", "Edit"]);

it("accepts a matched SDK tool-unavailable error", () => {
	assert.deepEqual(check([request(), reply(true, "Error: No such tool available: Bash")]), []);
});
it("accepts the exact tool ID and name in Claude's unknown-tool diagnostic", () => {
	assert.deepEqual(check([request()], log()), []);
});
it("rejects successful results even beside an unknown-tool diagnostic", () => {
	assert.deepEqual(check([request(), reply(false, "done")], log()), [{ id: "call_1", name: "Bash", reason: "successful-result" }]);
	assert.equal(check([request(), reply(undefined, "Error: No such tool available: Bash")]).length, 1);
});
it("rejects unmatched IDs, wrong names, and generic execution errors", () => {
	for (const cli of [log("Bash", "another-call"), log("Write"), `tool output: ${log()}`]) {
		assert.deepEqual(check([request()], cli), [{ id: "call_1", name: "Bash", reason: "missing-denial" }]);
	}
	assert.equal(check([request(), reply(true, "touch: permission denied")]).length, 1);
	assert.equal(check([request(), reply(true, "Error: No such tool available: Write")]).length, 1);
});
it("requires a denial for every request, not one denial for the whole tool name", () => {
	assert.deepEqual(check([request(), request("call_2")], log()), [{ id: "call_2", name: "Bash", reason: "missing-denial" }]);
});
it("deduplicates streamed and completed requests and preserves nested request IDs", () => {
	const frame = request();
	assert.deepEqual(check([
		{ type: "stream_event", parent_tool_use_id: "parent", event: { type: "content_block_start", content_block: frame.message.content[0] } },
		{ ...frame, parent_tool_use_id: "parent" },
		reply(true, [{ type: "text", text: "<tool_use_error>Error: No such tool available: Bash</tool_use_error>" }]),
	]), []);
});
it("ignores permitted tools and rejects conflicting or missing request IDs", () => {
	assert.deepEqual(check([request("read_1", "Read")]), []);
	assert.ok(check([request("call_1"), request("call_1", "Write")], log()).some(item => item.reason === "conflicting-tool-name"));
	assert.ok(check([request("", "Write")]).some(item => item.reason === "missing-tool-id"));
});
