/**
 * /new, /resume and /fork in the same cwd reuse this module and re-run its factory
 * after the old session's session_shutdown. The replacement must own the provider
 * again: before it did, the process kept the first session's settings and the
 * disposed usage publisher for its whole life.
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBridge, stateKey } from "./lib/mocked-bridge.mjs";

it("hands provider ownership to the session that replaces the owner", async () => {
	const root = mkdtempSync(join(tmpdir(), "bridge-owner-"));
	const key = Symbol.for("claude-bridge:activeStreamSimple");
	const saved = globalThis[key];
	delete globalThis[key];
	globalThis[stateKey] = { plans: [], queries: [], controls: [], prompts: [], seeds: 0 };
	try {
		const path = prepareBridge(root);
		const dirs = ["first", "second"].map((name, index) => {
			const dir = join(root, name);
			mkdirSync(dir);
			writeFileSync(join(dir, "claude-bridge.json"), JSON.stringify({ provider: { usageEvents: false, appendSystemPrompt: index === 0 } }));
			return dir;
		});
		const { default: activate, __test } = await import(path);
		let provider;
		// Pi runs the replacement's factory after the old session's session_shutdown.
		const open = (index) => {
			const dir = dirs[index];
			const handlers = new Map();
			activate({ cwd: dir, agentDir: dir, on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerProvider(_name, config) { provider = config; }, registerTool() {} });
			const context = { cwd: dir, agentDir: dir, mode: "rpc", ui: { notify() {} }, sessionManager: { getSessionId: () => `session-${index}` }, modelRegistry: { getProvider: () => undefined } };
			return (name, event) => { for (const handler of handlers.get(name) ?? []) handler(event, context); };
		};
		const first = open(0);
		const model = { ...provider.models[0], api: "claude-bridge", provider: "claude-bridge" };
		const append = () => __test.buildProviderSystemPromptAppend(model, { systemPrompt: "<project_context>PROJECT_RULE</project_context>", messages: [] }) ?? "";
		first("session_start", { type: "session_start", reason: "startup" });
		assert.match(append(), /PROJECT_RULE/);
		first("session_shutdown", { type: "session_shutdown", reason: "new" });
		const second = open(1);
		second("session_start", { type: "session_start", reason: "new" });
		// The replacement's own config (appendSystemPrompt: false) is now the process default.
		assert.doesNotMatch(append(), /PROJECT_RULE/);
	} finally {
		if (saved === undefined) delete globalThis[key]; else globalThis[key] = saved;
		delete globalThis[stateKey];
		rmSync(root, { recursive: true, force: true });
	}
});
