import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "cc-session-io";
import { prepareBridge, stateKey } from "./lib/mocked-bridge.mjs";

const tool = (name, description = name, parameters = { type: "object", properties: {} }) => ({ name, description, parameters });
const tools = [tool("read"), tool("bash")];
const user = content => ({ role: "user", content, timestamp: 1 });
const flush = () => new Promise(resolve => setImmediate(resolve));

async function withBridge(plans, run, providerOverrides = {}) {
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
		writeFileSync(join(root, "claude-bridge.json"), JSON.stringify({ provider: { plan: "max", usageEvents: false, claudeConfigDir: join(root, "profile"), ...providerOverrides }, askClaude: { enabled: false } }));
		const { default: activate, __test } = await import(path);
		let provider;
		activate({ cwd: root, agentDir: root, on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); }, registerProvider(_name, config) { provider = config; }, registerTool() {} });
		const model = { ...provider.models.find(model => model.id === "claude-opus-5"), api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge" };
		const request = (messages, inventory = tools, options = {}) => provider.streamSimple(model, { messages, tools: inventory, systemPrompt: "<project_context>RULE</project_context>" }, { cwd: root, sessionId: "parent", ...options });
		const completeTool = output => {
			assert.equal(output.stopReason, "toolUse");
			const call = output.content.find(block => block.type === "toolCall");
			state.executions++;
			return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: `COMPLETED_${call.id}` }], isError: false, timestamp: 2 };
		};
		const imported = query => openSession({ sessionId: query.options.resume, projectPath: query.options.cwd, claudeDir: query.options.env.CLAUDE_CONFIG_DIR }).messages;
		const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); gates.push(() => resolve()); return { promise, resolve }; };
		await run({ state, request, completeTool, imported, deferred, bridgeTest: __test, root, shutdown: () => { for (const handler of handlers.get('session_shutdown') ?? []) handler(); } });
	} finally {
		for (const release of gates) release();
		state.release?.();
		for (const shutdown of handlers.get("session_shutdown") ?? []) shutdown();
		await Promise.all(state.controls.map(control => control.done));
		await flush();
		if (saved === undefined) delete globalThis[key]; else globalThis[key] = saved;
		delete globalThis[stateKey];
		rmSync(root, { recursive: true, force: true });
	}
}

it('keeps disabled project forwarding disabled for flat and sectioned requests without reviving stale forced content', { timeout: 10_000 }, () => withBridge([{}, {}, {}], async ({ state, request, bridgeTest }) => {
	bridgeTest.setUserSystemPrompt({ custom: 'EXPLICIT_CUSTOM' });
	await request([user('flat request')]).result();
	assert.doesNotMatch(state.queries[0].options.systemPrompt.append, /<project_context>|RULE/);
	assert.match(state.queries[0].options.systemPrompt.append, /EXPLICIT_CUSTOM/);
	const head = { role: 'system', content: '', sections: { project_context: '<project_context>PRIVATE_PROJECT_RULE</project_context>', custom: '<custom>AUTHORED_RULE</custom>' }, toolsAdded: tools, timestamp: 0 };
	await request([head, user('sectioned request')]).result();
	assert.doesNotMatch(state.queries[1].options.systemPrompt.append, /PRIVATE_PROJECT_RULE|EXPLICIT_CUSTOM/);
	assert.match(state.queries[1].options.systemPrompt.append, /AUTHORED_RULE/);
	await request([{ role: 'system', content: '', timestamp: 0 }, user('forced empty')]).result();
	assert.doesNotMatch(state.queries[2].options.systemPrompt.append, /PRIVATE_PROJECT_RULE|EXPLICIT_CUSTOM|AUTHORED_RULE/);
}, { appendSystemPrompt: false }));

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

for (const change of ['replace-project-rule', 'remove-project-rule', 'skill-listing']) {
	it(`restarts for ${change} without changed history or tools`, { timeout: 10_000 }, () => withBridge([{ tool: 'read', reply: 'STALE' }, { reply: 'CURRENT' }], async ({ state, request, completeTool, imported }) => {
		const project = '<project_context><project_instructions path="/fixture/AGENTS.md">OLD_RULE</project_instructions></project_context>';
		const head = { role: 'system', content: '', sections: { project_context: project }, toolsAdded: tools, timestamp: 0 };
		const initial = user('finish the task');
		const first = await request([head, initial]).result();
		const result = completeTool(first);
		const sections = change === 'replace-project-rule' ? { project_context: project.replace('OLD_RULE', 'NEW_RULE') }
			: change === 'remove-project-rule' ? { project_context: null }
			: { skills: '<available_skills version="2"><skill><name>new-skill</name><description>NEW_SKILL_RULE</description><location>/fixture/SKILL.md</location></skill></available_skills>' };
		const patch = { role: 'system', content: '', sections, timestamp: 3 };
		const final = await request([head, initial, first, result, patch]).result();
		assert.equal(final.content[0].text, 'CURRENT');
		assert.equal(state.queries.length, 2);
		assert.equal(state.executions, 1);
		assert.equal(state.controls[0].closedWhenResult, true);
		const append = state.queries[1].options.systemPrompt.append;
		if (change === 'replace-project-rule') { assert.match(append, /NEW_RULE/); assert.doesNotMatch(append, /OLD_RULE/); }
		if (change === 'remove-project-rule') assert.doesNotMatch(append, /OLD_RULE/);
		if (change === 'skill-listing') assert.match(append, /NEW_SKILL_RULE/);
		assert.match(JSON.stringify(imported(state.queries[1])), new RegExp(result.content[0].text));
	}));
}

it('does not restart when a system delta leaves forwarded instructions unchanged', { timeout: 10_000 }, () => withBridge([{ tool: 'read', reply: 'NORMAL' }], async ({ state, request, completeTool }) => {
	const head = { role: 'system', content: '', sections: { project_context: '<project_context>RULE</project_context>', cwd: '/old' }, toolsAdded: tools, timestamp: 0 };
	const initial = user('finish the task');
	const first = await request([head, initial]).result();
	const patch = { role: 'system', content: '', sections: { cwd: '/new' }, timestamp: 3 };
	const final = await request([head, initial, first, completeTool(first), patch]).result();
	assert.equal(final.content[0].text, 'NORMAL');
	assert.equal(state.queries.length, 1);
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

it('fences callbacks from a shutdown query before the same factory serves another session', { timeout: 10_000 }, () => withBridge([], async ({ state, request, completeTool, deferred, shutdown }) => {
	const late = deferred();
	state.plans.push({ tool: 'read', lateFinish: late.promise, failFinish: true }, { tool: 'read', reply: 'NEW_SESSION' });
	await request([user('old session')]).result();
	shutdown();
	const next = await request([user('new session')], tools, { sessionId: 'new-owner' }).result();
	late.resolve();
	await state.controls[0].done;
	await flush();
	const final = await request([user('new session'), next, completeTool(next)], tools, { sessionId: 'new-owner' }).result();
	assert.equal(final.stopReason, 'stop');
	assert.equal(final.content[0].text, 'NEW_SESSION');
}));

it('settles an open Pi stream when shutdown retires its SDK query', { timeout: 10_000 }, () => withBridge([], async ({ state, request, deferred, shutdown }) => {
	const held = deferred();
	state.plans.push({ lateFinish: held.promise });
	const stream = request([user('held response')]);
	await flush();
	shutdown();
	const result = await stream.result();
	assert.equal(result.stopReason, 'aborted');
	assert.match(result.errorMessage, /session_shutdown/);
	assert.equal(state.controls[0].closed, true);
}));

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

it("recovers beyond three tool changes in one productive turn", { timeout: 20_000 }, () => withBridge(Array.from({ length: 9 }, () => ({ tool: "read" })), async ({ state, request, completeTool, imported }) => {
	const history = [user("many context changes")];
	let output = await request(history).result();
	for (let i = 1; i <= 8; i++) {
		history.push(output, completeTool(output));
		output = await request(history, [tool("read", `policy ${i}`)]).result();
		assert.equal(output.stopReason, "toolUse");
	}
	history.push(output, completeTool(output));
	const final = await request(history, [tool("read", "policy 8")]).result();
	assert.equal(final.stopReason, "stop");
	assert.equal(state.executions, 9);
	assert.equal(state.queries.length, 9);
	assert.ok(state.controls.slice(0, 8).every(control => control.closedWhenResult));
	assert.match(JSON.stringify(imported(state.queries.at(-1))), /COMPLETED_tool_8/);
	assert.match(JSON.stringify(state.controls.at(-1).toolResult), /COMPLETED_tool_9/);
	const diagnostic = readFileSync(process.env.CLAUDE_BRIDGE_DIAG_PATH, "utf8").trim().split("\n").map(JSON.parse).findLast(entry => entry.label === "query_restart_threshold");
	assert.equal(diagnostic.toolsChanged, true);
	assert.equal(diagnostic.historyChanged, false);
}));

it('recovers beyond three instruction-only changes in one productive turn', { timeout: 20_000 }, () => withBridge(Array.from({ length: 9 }, () => ({ tool: 'read' })), async ({ state, request, completeTool }) => {
	const head = { role: 'system', content: '', sections: { project_context: '<project_context>RULE_0</project_context>' }, toolsAdded: tools, timestamp: 0 };
	const history = [head, user('changing instructions')];
	let output = await request(history).result();
	for (let i = 1; i <= 8; i++) {
		history.push(output, completeTool(output), { role: 'system', content: '', sections: { project_context: `<project_context>RULE_${i}</project_context>` }, timestamp: i });
		output = await request(history).result();
		assert.equal(output.stopReason, 'toolUse');
	}
	history.push(output, completeTool(output));
	const final = await request(history).result();
	assert.equal(final.stopReason, 'stop');
	assert.equal(state.executions, 9);
	assert.equal(state.queries.length, 9);
	assert.ok(state.controls.slice(0, 8).every(control => control.closedWhenResult));
}));

it("surfaces replacement startup failure without an unbounded retry", { timeout: 10_000 }, () => withBridge([{ tool: "read" }, { failStart: true }], async ({ state, request, completeTool }) => {
	const first = await request([user("old")]).result();
	const failed = await request([user("new"), first, completeTool(first)]).result();
	assert.equal(failed.stopReason, "error");
	assert.match(failed.errorMessage, /MOCK_START_FAILURE/);
	assert.equal(state.queries.length, 2);
	await flush();
	assert.equal(state.controls[0].closed, true);
	assert.equal(state.controls[0].closedWhenResult, true);
	assert.match(JSON.stringify(state.controls[0].toolResult), /Operation aborted/);
}));

it("does not launch a replacement after cancellation", { timeout: 10_000 }, () => withBridge([{ tool: "read" }], async ({ state, request, completeTool }) => {
	const first = await request([user("old")]).result();
	const controller = new AbortController(); controller.abort();
	const final = await request([user("new"), first, completeTool(first)], tools, { signal: controller.signal }).result();
	assert.equal(final.stopReason, "aborted");
	assert.equal(state.queries.length, 1);
}));

for (const timed of [false, true]) {
	it(`cancels a replacement query ${timed ? 'when its deadline fires' : 'during construction'}`, { timeout: 10_000 }, () => withBridge([{ tool: 'read' }, {}], async ({ state, request, completeTool, deferred }) => {
		const controller = new AbortController();
		const first = await request([user('old')], tools, { signal: controller.signal }).result();
		const gate = deferred();
		if (timed) state.plans[0].lateFinish = gate.promise;
		state.onQuery = () => {
			if (state.queries.length !== 2) return;
			if (timed) setTimeout(() => { controller.abort(); gate.resolve(); }, 1);
			else controller.abort();
		};
		const final = await request([user('changed'), first, completeTool(first)], tools, { signal: controller.signal }).result();
		assert.equal(final.stopReason, 'aborted');
		assert.equal(state.queries.length, 2);
		assert.ok(state.controls.every(control => control.closed));
	}));
}

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

const accountingPlan = (cost, input, cumulativeInput) => ({ usage: { input_tokens: input }, result: { total_cost_usd: cost, modelUsage: { main: { inputTokens: cumulativeInput, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost } } } });

it('shares a cumulative accounting checkpoint between provider and shared AskClaude', { timeout: 10_000 }, () => withBridge([accountingPlan(1, 10, 10), accountingPlan(3, 25, 35), accountingPlan(6, 40, 75)], async ({ state, request, bridgeTest, root }) => {
	const initial = user('accounting task');
	const first = await request([initial]).result();
	const shared = await bridgeTest.promptAndWait('delegated question', 'none', new Map(), undefined, { model: 'claude-opus-5', context: [initial, first], cwd: root, piSessionId: 'parent' });
	assert.equal(shared.usage.cost.total, 2);
	assert.equal(shared.usage.input, 25);
	const next = await request([initial, first, user('next task')]).result();
	assert.equal(first.usage.cost.total, 1);
	assert.equal(next.usage.cost.total, 3);
	assert.equal(state.queries[1].options.resume, state.queries[2].options.resume);
}));

it('rebuilds an unknown accounting baseline instead of assuming zero on reuse', { timeout: 10_000 }, () => withBridge([accountingPlan(1, 10, 10), accountingPlan(0.2, 5, 5)], async ({ state, request, bridgeTest }) => {
	const initial = user('accounting task');
	const first = await request([initial]).result();
	const old = bridgeTest.getSharedSession();
	old.accounting.snapshot = undefined;
	const next = await request([initial, first, user('next')]).result();
	assert.equal(state.seeds, 1);
	assert.equal(next.usage.cost.total, 0.2);
}));

it('preserves failed shared AskClaude usage when the SDK throws after its result and rotates before reuse', { timeout: 10_000 }, () => withBridge([accountingPlan(1, 10, 10), { ...accountingPlan(3, 25, 35), failAfterResult: true }], async ({ request, bridgeTest, root }) => {
	const initial = user('accounting task');
	const first = await request([initial]).result();
	await assert.rejects(bridgeTest.promptAndWait('failed question', 'none', new Map(), undefined, { model: 'claude-opus-5', context: [initial, first], cwd: root, piSessionId: 'parent' }), error => {
		assert.match(error.message, /MOCK_AFTER_RESULT/);
		assert.equal(error.usage.cost.total, 2);
		assert.equal(error.usage.input, 25);
		return true;
	});
	assert.equal(bridgeTest.getSharedSession().accounting.snapshot, undefined);
	assert.equal(bridgeTest.getSharedSession().forceRotate, true);
}));

it('closes an AskClaude query cancelled during construction even when interrupt resolves', { timeout: 10_000 }, () => withBridge([{}], async ({ state, bridgeTest, root }) => {
	const controller = new AbortController();
	state.onQuery = () => controller.abort();
	await assert.rejects(bridgeTest.promptAndWait('cancel', 'none', new Map(), controller.signal, { model: 'claude-opus-5', isolated: true, cwd: root }), /Aborted/);
	assert.equal(state.controls[0].closed, true);
}));

it('forks parallel shared AskClaude calls instead of racing one transcript accounting epoch', { timeout: 10_000 }, () => withBridge([accountingPlan(1, 10, 10), accountingPlan(3, 20, 30), accountingPlan(0.5, 5, 5)], async ({ state, request, bridgeTest, root }) => {
	const initial = user('parent task');
	const first = await request([initial]).result();
	state.pauseNext = true;
	const paused = new Promise(resolve => { state.onPaused = resolve; });
	const options = { model: 'claude-opus-5', context: [initial, first], cwd: root, piSessionId: 'parent' };
	const pending = bridgeTest.promptAndWait('one', 'none', new Map(), undefined, options);
	await paused;
	const child = await bridgeTest.promptAndWait('two', 'none', new Map(), undefined, options);
	assert.notEqual(state.queries[1].options.resume, state.queries[2].options.resume);
	assert.equal(child.usage.cost.total, 0.5);
	assert.equal(bridgeTest.getSharedSession().accounting.inFlight, true);
	state.release();
	assert.equal((await pending).usage.cost.total, 2);
	assert.equal(bridgeTest.getSharedSession().accounting.snapshot.totalCostUsd, 3);
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
