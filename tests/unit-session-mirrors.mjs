import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBridge, stateKey } from "./lib/mocked-bridge.mjs";

const user = content => ({ role: "user", content, timestamp: 1 });
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }];
const flush = () => new Promise(resolve => setImmediate(resolve));

async function withBridge(plans, run) {
	const root = mkdtempSync(join(tmpdir(), "bridge-session-mirrors-"));
	const activeKey = Symbol.for("claude-bridge:activeStreamSimple");
	const previousActive = globalThis[activeKey];
	const previousState = globalThis[stateKey];
	const state = { plans, queries: [], controls: [], prompts: [], seeds: 0 };
	globalThis[stateKey] = state;
	delete globalThis[activeKey];
	const sessions = [];
	const releases = [];
	try {
		const module = await import(prepareBridge(root));
		let provider;
		const makeSession = (id, name = id) => {
			const cwd = join(root, `${name}-cwd`);
			const agentDir = join(root, `${name}-agent`);
			const profile = join(root, `${name}-claude`);
			mkdirSync(cwd); mkdirSync(agentDir);
			writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({
				startupNoticeShown: "test", provider: { plan: "max", usageEvents: false, claudeConfigDir: profile }, askClaude: { enabled: false },
			}));
			const handlers = new Map();
			module.default({
				cwd, agentDir,
				on(name, handler) { const entries = handlers.get(name) ?? []; entries.push(handler); handlers.set(name, entries); },
				registerProvider(_id, config) { provider = config; }, registerTool() {},
			});
			const context = { cwd, agentDir, mode: "rpc", ui: { notify() {} }, sessionManager: { getSessionId: () => id }, modelRegistry: { getProvider: () => provider } };
			const emit = async (name, event = {}) => { for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, context); };
			const request = (messages, options = {}) => {
				const model = { ...provider.models.find(model => model.id === "claude-opus-5"), api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge" };
				return provider.streamSimple(model, { messages, tools, systemPrompt: `<project_context>${name} rules</project_context>` }, { sessionId: id, ...options });
			};
			const session = { id, cwd, agentDir, profile, emit, request };
			sessions.push(session);
			return session;
		};
		const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); releases.push(resolve); return { promise, resolve }; };
		await run({ state, makeSession, bridge: module.__test, gate, registration: () => globalThis[activeKey] });
	} finally {
		for (const session of sessions.toReversed()) await session.emit("session_shutdown", { reason: "quit" });
		for (const release of releases) release();
		await Promise.all(state.controls.map(control => control.done));
		await flush();
		if (previousActive === undefined) delete globalThis[activeKey]; else globalThis[activeKey] = previousActive;
		if (previousState === undefined) delete globalThis[stateKey]; else globalThis[stateKey] = previousState;
		rmSync(root, { recursive: true, force: true });
	}
}

it("child shutdown preserves a parked parent, its mirror, rewrite marks, and provider registration", { timeout: 10_000 }, () => withBridge([
	{ reply: "parent seed" }, { tool: "read", reply: "parent completed" }, { reply: "child completed" },
], async ({ state, makeSession, bridge, registration }) => {
	const parent = makeSession("parent");
	await parent.emit("session_start", { reason: "new" });
	const initial = user("seed parent");
	const seed = await parent.request([initial]).result();
	await flush();
	const followup = user("read a file");
	const toolOutput = await parent.request([initial, seed, followup]).result();
	const parentMirror = bridge.getSharedSession("parent");
	const parentQuery = [...bridge.activeQueryContexts].find(c => c.piSessionId === "parent");
	const registered = registration();
	const child = makeSession("child");
	await child.emit("session_start", { reason: "new" });
	await child.request([user("child task")]).result();
	await flush();
	bridge.markRebuildForSession("parent", "fixture");
	await child.emit("session_shutdown", { reason: "quit" });
	assert.equal(bridge.getSharedSession("child"), null);
	assert.equal(bridge.getSharedSession("parent").sessionId, parentMirror.sessionId);
	assert.equal(bridge.getSharedSession("parent").accounting, parentMirror.accounting);
	assert.ok(bridge.historyRewrittenBySession.has("parent"));
	assert.equal(registration(), registered);
	assert.ok(parentQuery.activeQuery);
	assert.equal(state.controls[1].closed, false);
	// The mark was only a cleanup probe; complete the original query normally.
	bridge.historyRewrittenBySession.delete("parent"); parentQuery.historyStale = false;
	const call = toolOutput.content.find(block => block.type === "toolCall");
	const result = { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "done" }], isError: false, timestamp: 2 };
	const final = await parent.request([initial, seed, followup, toolOutput, result]).result();
	assert.equal(final.content[0].text, "parent completed");
	assert.equal(state.queries.length, 3);
}));

it("retained child resumes use its own cwd, profile, mirror, and accounting epoch", { timeout: 10_000 }, () => withBridge([
	{ reply: "parent", result: { total_cost_usd: 0.4 } },
	{ reply: "child", result: { total_cost_usd: 0.2 } },
	{ reply: "child next", result: { total_cost_usd: 0.5 } },
	{ reply: "parent next", result: { total_cost_usd: 0.7 } },
], async ({ state, makeSession, bridge }) => {
	const parent = makeSession("parent"); const child = makeSession("child");
	await parent.emit("session_start", { reason: "new" });
	await child.emit("session_start", { reason: "new" });
	const p = user("parent"); const c = user("child");
	const pa = await parent.request([p]).result(); await flush();
	const ca = await child.request([c]).result(); await flush();
	const parentId = bridge.getSharedSession("parent").sessionId;
	const childId = bridge.getSharedSession("child").sessionId;
	assert.notEqual(parentId, childId);
	const cb = await child.request([c, ca, user("continue child")]).result(); await flush();
	const pb = await parent.request([p, pa, user("continue parent")]).result(); await flush();
	assert.equal(state.queries[2].options.resume, childId);
	assert.equal(state.queries[3].options.resume, parentId);
	assert.equal(state.queries[2].options.cwd, child.cwd);
	assert.equal(state.queries[2].options.env.CLAUDE_CONFIG_DIR, child.profile);
	assert.equal(state.queries[3].options.cwd, parent.cwd);
	assert.equal(state.queries[3].options.env.CLAUDE_CONFIG_DIR, parent.profile);
	assert.ok(Math.abs(cb.usage.cost.total - 0.3) < 1e-10);
	assert.ok(Math.abs(pb.usage.cost.total - 0.3) < 1e-10);
}));

it("same-session overlapping queries cannot replace an active reusable mirror", { timeout: 10_000 }, () => withBridge([
	{ reply: "seed" }, { tool: "read", reply: "original" }, { reply: "side request" },
], async ({ state, makeSession, bridge }) => {
	const parent = makeSession("parent"); await parent.emit("session_start", { reason: "new" });
	const first = user("seed"); const seed = await parent.request([first]).result(); await flush();
	const next = user("read"); const parked = await parent.request([first, seed, next]).result();
	const original = bridge.getSharedSession("parent");
	await parent.request([user("concurrent isolated input")]).result(); await flush();
	assert.equal(bridge.getSharedSession("parent"), original);
	assert.equal(state.queries[2].options.resume, undefined);
	assert.equal(original.accounting.inFlight, true);
	const call = parked.content.find(block => block.type === "toolCall");
	const result = { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "done" }], isError: false, timestamp: 2 };
	assert.equal((await parent.request([first, seed, next, parked, result]).result()).content[0].text, "original");
}));

it("replacement fences callbacks from a former lifetime with the same Pi session ID", { timeout: 10_000 }, () => withBridge([], async ({ state, makeSession, bridge, gate }) => {
	const late = gate();
	state.plans.push({ reply: "OLD", lateFinish: late.promise }, { reply: "NEW" });
	const parent = makeSession("same-id"); await parent.emit("session_start", { reason: "new" });
	const old = parent.request([user("old lifetime")]);
	await flush();
	await parent.emit("session_start", { reason: "reload" });
	assert.equal((await old.result()).stopReason, "aborted");
	assert.equal(state.controls[0].closed, true);
	const current = await parent.request([user("replacement lifetime")]).result(); await flush();
	assert.equal(current.content[0].text, "NEW");
	const mirror = bridge.getSharedSession("same-id");
	late.resolve(); await state.controls[0].done; await flush();
	assert.equal(bridge.getSharedSession("same-id"), mirror);
}));

it("auxiliary routing IDs remain private while disposal follows the owning session", { timeout: 10_000 }, () => withBridge([
	{ reply: "parent seed" }, { tool: "read", reply: "auxiliary" },
], async ({ state, makeSession, bridge }) => {
	const { cleanupSessionResources } = await import("@earendil-works/pi-ai");
	const parent = makeSession("owner"); await parent.emit("session_start", { reason: "new" });
	const first = user("parent"); await parent.request([first]).result(); await flush();
	const mirror = bridge.getSharedSession("owner");
	await parent.request([user("separate work")], {
		sessionId: "auxiliary-route",
		sessionContext: { ownerSessionId: "owner", cwd: parent.cwd, agentDir: parent.agentDir },
	}).result();
	assert.equal(bridge.getSharedSession("auxiliary-route"), null);
	assert.equal(bridge.getSharedSession("owner"), mirror);
	assert.equal([...bridge.activeQueryContexts].find(c => c.piSessionId === "auxiliary-route").ownerSessionId, "owner");
	cleanupSessionResources("owner");
	assert.equal(state.controls[1].closed, true);
	assert.equal(bridge.getSharedSession("owner"), null);
	assert.equal(bridge.activeQueryContexts.size, 0);
}));

it("unbound requests fail before SDK startup instead of guessing process directories", { timeout: 10_000 }, () => withBridge([], async ({ state, makeSession }) => {
	const session = makeSession("unbound");
	const response = await session.request([user("no session metadata")]).result();
	assert.equal(response.stopReason, "error");
	assert.match(response.errorMessage, /requires sessionContext/);
	assert.equal(state.queries.length, 0);
}));
