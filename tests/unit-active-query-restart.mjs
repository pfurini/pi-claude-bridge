import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "cc-session-io";
import { prepareBridge, stateKey } from "./lib/mocked-bridge.mjs";

const tool = (name, description = name, parameters = { type: "object", properties: {} }) => ({ name, description, parameters });
const tools = [tool("read"), tool("bash")];
const user = content => ({ role: "user", content, timestamp: 1 });
const flush = () => new Promise(resolve => setImmediate(resolve));

async function withBridge(plans, run) {
	const root = mkdtempSync(join(tmpdir(), "bridge-active-restart-"));
	const state = { plans, queries: [], controls: [], prompts: [], seeds: 0, executions: 0 };
	const key = Symbol.for("claude-bridge:activeStreamSimple");
	const saved = globalThis[key];
	delete globalThis[key];
	globalThis[stateKey] = state;
	const gates = [];
	const handlers = new Map();
	try {
		const path = prepareBridge(root);
		writeFileSync(join(root, "claude-bridge.json"), JSON.stringify({ provider: { plan: "max", usageEvents: false, claudeConfigDir: join(root, "profile") }, askClaude: { enabled: false } }));
		const { default: activate, __test } = await import(path);
		let provider;
		activate({ cwd: root, agentDir: root, on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); }, registerProvider(_name, config) { provider = config; }, registerTool() {} });
		const model = { ...provider.models.find(model => model.id === "claude-opus-5"), api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge" };
		const request = (messages, inventory = tools, options = {}) => provider.streamSimple(model, { messages, tools: inventory, systemPrompt: "<project_context>RULE</project_context>" }, { sessionId: "parent", ...options });
		const completeTool = output => {
			assert.equal(output.stopReason, "toolUse");
			const call = output.content.find(block => block.type === "toolCall");
			state.executions++;
			return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: `COMPLETED_${call.id}` }], isError: false, timestamp: 2 };
		};
		const imported = query => openSession({ sessionId: query.options.resume, projectPath: query.options.cwd, claudeDir: query.options.env.CLAUDE_CONFIG_DIR }).messages;
		const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); gates.push(() => resolve()); return { promise, resolve }; };
		await run({ state, request, completeTool, imported, deferred, bridgeTest: __test });
	} finally {
		for (const release of gates) release();
		for (const shutdown of handlers.get("session_shutdown") ?? []) shutdown();
		await Promise.all(state.controls.map(control => control.done));
		await flush();
		if (saved === undefined) delete globalThis[key]; else globalThis[key] = saved;
		delete globalThis[stateKey];
		rmSync(root, { recursive: true, force: true });
	}
}

it("continues an unchanged query despite metadata and equivalent declaration ordering", { timeout: 10_000 }, () => withBridge([{ tool: "read", reply: "NORMAL" }], async ({ state, request, completeTool }) => {
	const initial = user("same content");
	const first = await request([initial]).result();
	const result = completeTool(first);
	const reordered = [tool("bash", "bash", { properties: {}, type: "object" }), tool("read")];
	const final = await request([{ ...initial, timestamp: 99 }, first, result], reordered).result();
	assert.equal(final.stopReason, "stop");
	assert.equal(final.content[0].text, "NORMAL");
	assert.equal(state.queries.length, 1);
	assert.equal(state.controls[0].toolResult.isError, false);
}));

for (const change of ["history", "last-assistant", "remove-tool", "schema"]) {
	it(`automatically restarts for ${change} without replaying completed tools`, { timeout: 10_000 }, () => withBridge([{ tool: "read", reply: "STALE" }, { reply: "RECOVERED" }], async ({ state, request, completeTool, imported }) => {
		const first = await request([user("ORIGINAL")]).result();
		const result = completeTool(first);
		const changedAssistant = change === "last-assistant" ? { ...first, content: first.content.map(block => block.type === "toolCall" ? { ...block, arguments: { corrected: true } } : block) } : first;
		const context = [user(change === "history" ? "UPDATED" : "ORIGINAL"), changedAssistant, result, user("LATEST_STEER")];
		const inventory = change === "remove-tool" ? [tools[0]] : change === "schema" ? [tool("read", "read", { type: "object", properties: { path: { type: "string" } } }), tools[1]] : tools;
		const events = [];
		const stream = request(context, inventory);
		for await (const event of stream) events.push(event);
		const final = await stream.result();
		assert.equal(final.stopReason, "stop");
		assert.equal(final.content[0].text, "RECOVERED");
		assert.equal(events.filter(event => event.type === "done" || event.type === "error").length, 1);
		assert.equal(events.filter(event => event.type === "toolcall_end").length, 0);
		assert.equal(state.executions, 1);
		assert.equal(state.queries.length, 2);
		assert.equal(state.controls[0].closed, true);
		assert.match(JSON.stringify(state.controls[0].toolResult), /Operation aborted/);
		assert.ok(!JSON.stringify(state.controls[0].toolResult).includes(result.content[0].text));
		assert.equal(state.controls[0].closedWhenResult, true);
		const second = state.queries[1];
		assert.notEqual(second.options.resume, state.controls[0].sessionId);
		const history = JSON.stringify(imported(second));
		assert.ok(history.includes(result.content[0].text));
		assert.ok(history.includes("LATEST_STEER"));
		if (change === "history") { assert.ok(history.includes("UPDATED")); assert.ok(!history.includes("ORIGINAL")); }
		if (change === "last-assistant") assert.ok(history.includes("corrected"));
		const names = Object.values(second.options.mcpServers)[0].instance.handlers.get("tools/list")().tools.map(tool => tool.name);
		assert.deepEqual(names, inventory.map(tool => tool.name));
		assert.ok(JSON.stringify(state.controls[1].prompts).includes("Completed tools are already recorded"));
	}));
}

for (const failFinish of [false, true]) {
	it(`ignores retired ${failFinish ? "errors" : "events and completion"} after a newer query starts`, { timeout: 10_000 }, () => withBridge([], async ({ state, request, completeTool, deferred }) => {
		const late = deferred();
		state.plans.push({ tool: "read", lateFinish: late.promise, failFinish, reply: "STALE" }, { reply: "RECOVERED" }, { tool: "read", reply: "NEXT" });
		const first = await request([user("old")]).result();
		const history = [user("new"), first, completeTool(first)];
		const recovered = await request(history).result();
		const nextHistory = [...history, recovered, user("next task")];
		const nextTool = await request(nextHistory).result();
		const oldServer = Object.values(state.queries[0].options.mcpServers)[0].instance;
		const lateCall = await oldServer.handlers.get("tools/call")({ params: { name: "read", _meta: { "claudecode/toolUseId": "late_old_call" } } });
		assert.equal(lateCall.isError, true, "a retired MCP callback must not park inside the new query");
		late.resolve();
		await state.controls[0].done;
		await flush();
		const final = await request([...nextHistory, nextTool, completeTool(nextTool)]).result();
		assert.equal(final.stopReason, "stop");
		assert.equal(final.content[0].text, "NEXT");
		assert.equal(state.queries.length, 3);
	}));
}

it("caps automatic recovery at three restarts per turn", { timeout: 10_000 }, () => withBridge(Array.from({ length: 4 }, () => ({ tool: "read" })), async ({ state, request, completeTool }) => {
	const history = [user("bounded")];
	let output = await request(history).result();
	for (let i = 1; i <= 4; i++) {
		history.push(output, completeTool(output));
		output = await request(history, [tool("read", `policy ${i}`)]).result();
	}
	assert.equal(output.stopReason, "error");
	assert.match(output.errorMessage, /exceeded 3 automatic context restarts/);
	assert.equal(state.queries.length, 4);
	assert.ok(state.controls.every(control => control.closed));
}));

it("surfaces replacement startup failure without an unbounded retry", { timeout: 10_000 }, () => withBridge([{ tool: "read" }, { failStart: true }], async ({ state, request, completeTool }) => {
	const first = await request([user("old")]).result();
	const failed = await request([user("new"), first, completeTool(first)]).result();
	assert.equal(failed.stopReason, "error");
	assert.match(failed.errorMessage, /MOCK_START_FAILURE/);
	assert.equal(state.queries.length, 2);
}));

it("does not launch a replacement after cancellation", { timeout: 10_000 }, () => withBridge([{ tool: "read" }], async ({ state, request, completeTool }) => {
	const first = await request([user("old")]).result();
	const controller = new AbortController(); controller.abort();
	const final = await request([user("new"), first, completeTool(first)], tools, { signal: controller.signal }).result();
	assert.equal(final.stopReason, "aborted");
	assert.equal(state.queries.length, 1);
}));

it("restarts a background child without disturbing its waiting parent", { timeout: 10_000 }, () => withBridge([{ tool: "read", reply: "PARENT" }, { tool: "read", reply: "STALE_CHILD" }, { reply: "CHILD" }], async ({ state, request, completeTool }) => {
	const parent = await request([user("parent")]).result();
	const child = await request([user("child old")], tools, { sessionId: "child" }).result();
	const childFinal = await request([user("child new"), child, completeTool(child)], tools, { sessionId: "child" }).result();
	assert.equal(childFinal.content[0].text, "CHILD");
	assert.equal(state.controls[0].closed, false);
	const parentFinal = await request([user("parent"), parent, completeTool(parent)]).result();
	assert.equal(parentFinal.content[0].text, "PARENT");
	assert.equal(state.queries.length, 3);
}));

it("a retired asynchronous delivery cannot mutate its replacement", { timeout: 10_000 }, () => withBridge([], async ({ bridgeTest }) => {
	let rejectPush;
	let current = true;
	let delivered = false;
	const c = { promptStream: { push: () => new Promise((_resolve, reject) => { rejectPush = reject; }) }, pendingToolCalls: new Map(), pendingResults: new Map() };
	const delivery = bridgeTest.deliverToolResults(c, [{ toolCallId: "old", content: [] }], [{ type: "text", text: "steer" }], 1, () => current);
	current = false;
	c.pendingToolCalls.set("old", { toolName: "read", resolve: () => { delivered = true; } });
	bridgeTest.setSharedSession({ sessionId: "replacement", cursor: 1, cwd: "/fixture" });
	rejectPush(new Error("retired"));
	await delivery;
	assert.equal(delivered, false);
	assert.equal(c.pendingResults.size, 0);
	assert.equal(c.pendingToolCalls.size, 1);
	assert.equal(bridgeTest.getSharedSession().needsRebuild, undefined);
}));
