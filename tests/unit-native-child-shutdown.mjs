import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareBridge, stateKey } from "./lib/mocked-bridge.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const piDist = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist");

for (const variant of ["bridge extension", "no extensions", "forced prompt without extensions"]) {
it(`native child teardown preserves its shared-runtime parent (${variant})`, { timeout: 30_000 }, async () => {
	const { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession } = await import(join(piDist, "index.js"));
	const { loadExtensions } = await import(join(piDist, "core/extensions/loader.js"));
	const { teardownChild } = await import(join(piDist, "core/fork-builtins/subagents/runner/run.js"));
	const root = mkdtempSync(join(tmpdir(), "bridge-native-shutdown-"));
	const activeKey = Symbol.for("claude-bridge:activeStreamSimple");
	const previousActive = globalThis[activeKey];
	const previousState = globalThis[stateKey];
	const state = { queries: [], controls: [], prompts: [], seeds: 0 };
	globalThis[stateKey] = state;
	delete globalThis[activeKey];
	const children = [];
	try {
		const bridge = prepareBridge(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "parent");
		mkdirSync(agentDir); mkdirSync(cwd);
		writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({
			startupNoticeShown: "test", provider: { plan: "max", usageEvents: false, claudeConfigDir: join(root, "claude") }, askClaude: { enabled: false },
		}));
		const loaded = await loadExtensions([bridge], cwd, agentDir);
		assert.deepEqual(loaded.errors, []);
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models"), allowModelNetwork: false, refreshOnCreate: false });
		const registration = loaded.runtime.pendingProviderRegistrations[0];
		runtime.registerProvider(registration.name, registration.config);
		const model = runtime.getModel("claude-bridge", "claude-opus-5");
		assert.ok(model);
		const errors = [];
		const create = async directory => {
			const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
			const loader = new DefaultResourceLoader({ cwd: directory, agentDir, settingsManager, noExtensions: true,
				additionalExtensionPaths: directory === cwd || variant === "bridge extension" ? [bridge] : [],
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				...(directory !== cwd && variant.startsWith("forced") ? { systemPromptOverride: () => "CUSTOM_CHILD_PROMPT_WITHOUT_DIRECTORIES" } : {}),
			});
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			const { session } = await createAgentSession({ cwd: directory, agentDir, settingsManager, sessionManager: SessionManager.inMemory(directory), resourceLoader: loader, modelRuntime: runtime, model, tools: [] });
			const child = { session, loader, renarrow() {}, report: activity => errors.push(activity) };
			children.push(child);
			await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
			return child;
		};
		const parent = await create(cwd);
		await parent.session.prompt("parent first turn");
		const parentMirror = state.controls[0].sessionId;
		const childCwd = join(root, "worktree-child"); mkdirSync(childCwd);
		const child = await create(childCwd);
		await child.session.prompt("child first turn");
		assert.notEqual(state.controls[1].sessionId, parentMirror);
		assert.equal(state.queries[1].options.cwd, childCwd);
		await teardownChild(child);
		await parent.session.prompt("parent second turn");
		assert.equal(state.queries[2].options.resume, parentMirror);
		assert.equal(state.queries[2].options.cwd, cwd);
		assert.deepEqual(errors, []);
	} finally {
		for (const child of children.toReversed()) await teardownChild(child);
		await Promise.all(state.controls.map(control => control.done));
		if (previousActive === undefined) delete globalThis[activeKey]; else globalThis[activeKey] = previousActive;
		if (previousState === undefined) delete globalThis[stateKey]; else globalThis[stateKey] = previousState;
		rmSync(root, { recursive: true, force: true });
	}
});
}
