import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "cc-session-io";
import { QueryContext } from "../src/query-state.js";
import { __test } from "../src/index.js";
import { prepareBridge, stateKey } from "./lib/mocked-bridge.mjs";

const user = content => ({ role: "user", content, timestamp: 1 });
const tools = [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }];
const flush = () => new Promise(resolve => setImmediate(resolve));

it("records attributed rewrites before a mirror exists and arms only their queries", () => {
	__test.resetSharedSession();
	const parent = new QueryContext(), child = new QueryContext();
	parent.piSessionId = "parent";
	child.piSessionId = "child";
	__test.activeQueryContexts.add(parent);
	__test.activeQueryContexts.add(child);
	try {
		assert.equal(__test.getSharedSession("parent"), null);
		__test.markRebuildForSession("parent", "session_compact:threshold");
		assert.ok(__test.historyRewrittenBySession.has("parent"));
		__test.armStaleContexts();
		assert.equal(parent.historyStale, true);
		assert.equal(child.historyStale, false);
	} finally {
		__test.activeQueryContexts.delete(parent);
		__test.activeQueryContexts.delete(child);
		__test.resetSharedSession();
	}
});

it("does not record or arm an unattributed rewrite", () => {
	__test.resetSharedSession();
	const context = new QueryContext();
	context.piSessionId = "parent";
	__test.activeQueryContexts.add(context);
	try {
		__test.markRebuildForSession(null, "session_compact:manual");
		__test.armStaleContexts();
		assert.equal(context.historyStale, false);
		assert.equal(__test.historyRewrittenBySession.size, 0);
		assert.equal(__test.getHistoryRewritten(), false);
	} finally { __test.activeQueryContexts.delete(context); __test.resetSharedSession(); }
});

async function fixture(plans, run) {
	const root = mkdtempSync(join(tmpdir(), "bridge-rewrite-"));
	const state = { plans, queries: [], controls: [], prompts: [], seeds: 0 };
	const activeKey = Symbol.for("claude-bridge:activeStreamSimple");
	const saved = globalThis[activeKey];
	delete globalThis[activeKey];
	globalThis[stateKey] = state;
	const handlers = new Map(), releases = [];
	try {
		const entry = prepareBridge(root);
		writeFileSync(join(root, "claude-bridge.json"), JSON.stringify({ provider: { plan: "max", usageEvents: false, claudeConfigDir: join(root, "profile") }, askClaude: { enabled: false } }));
		const { default: activate, __test: bridge } = await import(entry);
		let provider;
		activate({ cwd: root, agentDir: root, on(name, handler) { handlers.set(name, handler); }, registerProvider(_name, config) { provider = config; }, registerTool() {} });
		await handlers.get("session_start")?.({ type: "session_start", reason: "new" }, { cwd: root, agentDir: root, mode: "rpc", ui: { notify() {} }, sessionManager: { getSessionId: () => "parent" }, modelRegistry: { getProvider: () => provider } });
		const model = { ...provider.models[0], api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge" };
		const request = (messages, sessionId = "parent") => provider.streamSimple(model, { messages, tools }, { sessionId, sessionContext: { agentSessionId: sessionId, cwd: root, agentDir: root } });
		const complete = output => {
			assert.equal(output.stopReason, "toolUse");
			const call = output.content.find(block => block.type === "toolCall");
			return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: `COMPLETED_${call.id}` }], isError: false, timestamp: 2 };
		};
		const imported = query => JSON.stringify(openSession({ sessionId: query.options.resume, projectPath: root, claudeDir: join(root, "profile") }).messages);
		const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); releases.push(resolve); return { promise, resolve }; };
		await run({ state, bridge, request, complete, imported, deferred });
	} finally {
		for (const release of releases) release();
		handlers.get("session_shutdown")?.();
		await Promise.all(state.controls.map(control => control.done));
		await flush();
		if (saved === undefined) delete globalThis[activeKey]; else globalThis[activeKey] = saved;
		delete globalThis[stateKey];
		rmSync(root, { recursive: true, force: true });
	}
}

it("retires an attributed rewrite before releasing handlers and imports completed results", { timeout: 10000 }, () => fixture([{ tool: "read", reply: "STALE" }, { reply: "RECOVERED" }], async ({ state, bridge, request, complete, imported }) => {
	const initial = user("ORIGINAL");
	const output = await request([initial]).result();
	const result = complete(output);
	const old = bridge.contextForToolResults([result], "parent");
	assert.ok(old);
	const oldQuery = old.activeQuery;
	assert.equal(bridge.getSharedSession("parent"), null, "rewrite occurs before the first mirror exists");
	bridge.markRebuildForSession("parent", "session_compact:threshold");
	bridge.markRebuildForSession("sibling", "session_compact:threshold");
	const final = await request([user("CURRENT_PROJECTION"), output, result]).result();
	assert.equal(final.content[0].text, "RECOVERED");
	assert.equal(state.queries.length, 2);
	assert.equal(state.controls[0].closedWhenResult, true, "transport closes before pending MCP handlers are released");
	assert.match(JSON.stringify(state.controls[0].toolResult), /Operation aborted/);
	assert.notEqual(old.activeQuery, oldQuery, "the retired transport cannot remain active on the recovered context");
	assert.equal(bridge.contextForToolResults([result], "parent"), undefined);
	assert.notEqual(state.queries[1].options.resume, state.controls[0].sessionId);
	assert.match(imported(state.queries[1]), /CURRENT_PROJECTION/);
	assert.match(imported(state.queries[1]), /COMPLETED_tool_1/);
	assert.doesNotMatch(imported(state.queries[1]), /ORIGINAL/);
	assert.equal(bridge.historyRewrittenBySession.has("parent"), false);
	assert.equal(bridge.historyRewrittenBySession.has("sibling"), true);
}));

it("leaves a foreign parked query and mirror untouched by a child's rewrite", { timeout: 10000 }, () => fixture([{ tool: "read", reply: "PARENT" }, { tool: "read", reply: "STALE_CHILD" }, { reply: "CHILD" }], async ({ state, bridge, request, complete }) => {
	const p = user("parent task"), c = user("child task");
	const parent = await request([p]).result();
	const parentResult = complete(parent);
	const parentContext = bridge.contextForToolResults([parentResult], "parent");
	const child = await request([c], "child").result();
	bridge.markRebuildForSession("child", "session_compact:threshold");
	const childFinal = await request([c, child, complete(child)], "child").result();
	assert.equal(childFinal.content[0].text, "CHILD");
	assert.equal(parentContext.historyStale, false);
	assert.equal(state.controls[0].closed, false);
	assert.equal(bridge.contextForToolResults([parentResult], "parent"), parentContext);
	const final = await request([p, parent, parentResult]).result();
	assert.equal(final.content[0].text, "PARENT");
	assert.equal(state.queries.length, 3);
	assert.equal(bridge.getSharedSession("parent").sessionId, state.controls[0].sessionId);
	assert.equal(bridge.getSharedSession("child").sessionId, state.controls[2].sessionId);
}));

for (const failFinish of [false, true]) {
	it(`guards late ${failFinish ? "errors" : "completion and callbacks"} after rewrite recovery`, { timeout: 10000 }, () => fixture([], async ({ state, bridge, request, complete, deferred }) => {
		const late = deferred();
		state.plans.push({ tool: "read", lateFinish: late.promise, failFinish, reply: "STALE" }, { reply: "RECOVERED" }, { tool: "read", reply: "NEXT" });
		const initial = user("task");
		const output = await request([initial]).result();
		const history = [initial, output, complete(output)];
		bridge.markRebuildForSession("parent", "session_compact:threshold");
		const recovered = await request(history).result();
		const mirror = bridge.getSharedSession("parent");
		const nextHistory = [...history, recovered, user("next")];
		const next = await request(nextHistory).result();
		const oldServer = Object.values(state.queries[0].options.mcpServers)[0].instance;
		const callback = await oldServer.handlers.get("tools/call")({ params: { name: "read", _meta: { "claudecode/toolUseId": "late_old" } } });
		assert.equal(callback.isError, true);
		late.resolve();
		await state.controls[0].done;
		await flush();
		assert.equal(bridge.getSharedSession("parent").sessionId, mirror.sessionId);
		const final = await request([...nextHistory, next, complete(next)]).result();
		assert.equal(final.content[0].text, "NEXT");
		assert.equal(state.queries.length, 3);
	}));
}

it("recovers through multiple attributed compactions in one productive turn", { timeout: 15000 }, () => fixture(Array.from({ length: 5 }, () => ({ tool: "read", reply: "FINAL" })), async ({ state, bridge, request, complete, imported }) => {
	const history = [user("long turn")];
	let output = await request(history).result();
	for (let index = 1; index <= 4; index++) {
		history.push(output, complete(output));
		bridge.markRebuildForSession("parent", "session_compact:threshold");
		output = await request(history).result();
		assert.equal(output.stopReason, "toolUse");
		assert.equal(bridge.historyRewrittenBySession.has("parent"), false);
	}
	history.push(output, complete(output));
	assert.equal((await request(history).result()).content[0].text, "FINAL");
	assert.equal(state.queries.length, 5);
	assert.ok(state.controls.slice(0, 4).every(control => control.closedWhenResult));
	assert.match(imported(state.queries[4]), /COMPLETED_tool_4/);
}));
