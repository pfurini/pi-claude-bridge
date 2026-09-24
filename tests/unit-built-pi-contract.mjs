import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSession } from "cc-session-io";

const repo = fileURLToPath(new URL("../", import.meta.url));
const piDist = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist");
const onFork = existsSync(join(piDist, "core/fork-capabilities.js"));
import { prepareBridge, stateKey } from "./lib/mocked-bridge.mjs";

const user = content => ({ role: "user", content, timestamp: Date.now() });
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = content => ({ role: "assistant", content: [{ type: "text", text: content }], timestamp: Date.now(), api: "claude-bridge", provider: "claude-bridge", model: "claude-opus-5-5", usage: zeroUsage, stopReason: "stop" });
const tool = name => ({ name, description: name, parameters: { type: "object", properties: {} } });
const servedTools = query => Object.values(query.options.mcpServers ?? {}).flatMap(server => server.instance.handlers.get("tools/list")().tools.map(tool => tool.name));

it("the real bridge factory honors the compiled Pi transcript and summary contracts", { skip: !onFork, timeout: 60_000 }, async () => {
	const { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession, createSyntheticSourceInfo } = await import(join(piDist, "index.js"));
	const { getCurrentSystemPrompt } = await import("@earendil-works/pi-ai");
	const { loadExtensions } = await import(join(piDist, "core/extensions/loader.js"));
	const { prepareCompaction } = await import(join(piDist, "core/compaction/compaction.js"));
	const root = mkdtempSync(join(tmpdir(), "bridge-built-pi-"));
	const state = { queries: [], prompts: [], seeds: 0 };
	globalThis[stateKey] = state;
	const activeKey = Symbol.for("claude-bridge:activeStreamSimple");
	const savedActive = globalThis[activeKey];
	delete globalThis[activeKey];
	let childSession;
	try {
		const bridge = prepareBridge(root);
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		mkdirSync(cwd); mkdirSync(agentDir);
		writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ startupNoticeShown: "test", askClaude: { enabled: false }, provider: { usageEvents: false, plan: "max", claudeConfigDir: join(root, "claude") } }));
		const loaded = await loadExtensions([bridge], cwd, agentDir);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.runtime.pendingProviderRegistrations.length, 1);
		const registration = loaded.runtime.pendingProviderRegistrations[0];
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(root, "model-cache"), allowModelNetwork: false, refreshOnCreate: false });
		runtime.registerProvider(registration.name, registration.config);
		const model = runtime.getModel("claude-bridge", "claude-opus-5-5");
		assert.ok(model);
		const project = '<project_context><project_instructions path="/fixture/AGENTS.md">PROJECT_CONTRACT_RULE</project_instructions></project_context>';
		const skills = '<available_skills version="2"><skill><name>contract-skill</name><description>Test skill</description><location>/fixture/SKILL.md</location></skill></available_skills>';
		const response = await runtime.completeSimple(model, { systemPrompt: `${project}\n\n${skills}`, tools: [tool("read"), tool("bash"), tool("skill")], messages: [user("provider turn")] }, { sessionId: "built-parent" });
		assert.equal(response.stopReason, "stop");
		assert.deepEqual(servedTools(state.queries.at(-1)).sort(), ["bash", "read", "skill"]);
		assert.ok(state.queries.at(-1).options.systemPrompt.append.includes("PROJECT_CONTRACT_RULE"));
		assert.ok(state.queries.at(-1).options.systemPrompt.append.includes(skills));
		assert.equal(state.queries.at(-1).options.extraArgs.model, "claude-opus-5-5");
		const seedsBeforeReuse = state.seeds;
		const secondContext = [user("provider turn"), response, user("unchanged followup")];
		const secondResponse = await runtime.completeSimple(model, { systemPrompt: project, messages: secondContext }, { sessionId: "built-parent" });
		assert.equal(state.seeds, seedsBeforeReuse, "unchanged history must reuse rather than reimport");
		const editedLatest = [...secondContext, { ...secondResponse, content: [{ type: "text", text: "EDITED_LATEST_ASSISTANT" }] }, user("after edit")];
		await runtime.completeSimple(model, { systemPrompt: project, messages: editedLatest }, { sessionId: "built-parent" });
		assert.equal(state.seeds, seedsBeforeReuse + 1, "editing the latest assistant must rebuild too");
		const editedQuery = state.queries.at(-1).options;
		const editedHistory = openSession({ sessionId: editedQuery.resume, projectPath: editedQuery.cwd, claudeDir: editedQuery.env.CLAUDE_CONFIG_DIR }).messages;
		assert.ok(JSON.stringify(editedHistory).includes("EDITED_LATEST_ASSISTANT"));

		const head = { role: "system", content: `${project}\n\n${skills}`, toolsAdded: [tool("read"), tool("bash")], timestamp: 0 };
		const removed = { role: "system", content: "", toolsRemoved: [{ name: "bash" }], timestamp: 1 };
		await runtime.completeSimple(model, { messages: [head, removed, user("restricted turn")] }, { sessionId: "built-tools" });
		assert.deepEqual(servedTools(state.queries.at(-1)), ["read"]);
		await runtime.completeSimple(model, { messages: [head, removed, { role: "system", content: "", toolsAdded: [tool("bash")], timestamp: 2 }, user("restored turn")] }, { sessionId: "built-tools" });
		assert.deepEqual(servedTools(state.queries.at(-1)).sort(), ["bash", "read"]);

		const manager = SessionManager.inMemory(cwd);
		for (let i = 0; i < 4; i++) { manager.appendMessage(user(`step ${i}`)); manager.appendMessage(assistant(`result ${i}`)); }
		const branchEntries = manager.getBranch();
		const preparation = prepareCompaction(branchEntries, { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 });
		assert.ok(preparation);
		const notices = [];
		const ctx = { model, cwd, agentDir, ui: { notify: message => notices.push(message) } };
		const handlers = loaded.extensions[0].handlers;
		const compact = await handlers.get("session_before_compact")[0]({ type: "session_before_compact", preparation, branchEntries, reason: "manual", willRetry: false, signal: new AbortController().signal }, ctx);
		assert.ok(compact.compaction?.summary.includes("MOCK_BRIDGE_REPLY"), JSON.stringify({ compact, notices }));
		assert.equal(state.queries.at(-1).options.persistSession, false);
		assert.equal(typeof state.queries.at(-1).options.systemPrompt, "string");
		const tree = await handlers.get("session_before_tree")[0]({ type: "session_before_tree", preparation: { entriesToSummarize: branchEntries, userWantsSummary: true, targetId: branchEntries[0].id }, signal: new AbortController().signal }, ctx);
		assert.ok(tree.summary?.summary.includes("MOCK_BRIDGE_REPLY"), JSON.stringify({ tree, notices }));
		const oneOff = await runtime.completeSimple(model, { systemPrompt: "SUMMARY_SYSTEM", messages: [user("summarize")] }, { cacheRetention: "none", reasoning: "max" });
		assert.equal(oneOff.stopReason, "stop");
		assert.equal(state.queries.at(-1).options.systemPrompt, "SUMMARY_SYSTEM");
		assert.equal(state.queries.at(-1).options.persistSession, false);
		assert.equal(state.queries.at(-1).options.effort, "max");

		const childCwd = join(root, "child"); mkdirSync(childCwd);
		const skillPath = join(root, "SKILL.md");
		writeFileSync(skillPath, "---\nname: contract-skill\ndescription: Test skill\ndisallowed-tools: [bash]\n---\nSKILL_BODY_CONTRACT\n");
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({ cwd: childCwd, agentDir, settingsManager, noExtensions: true, additionalExtensionPaths: [bridge], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [pi => {
				pi.on("before_agent_start", event => { event.systemPromptOptions.sections.contract_policy = "EXTENSION_SECTION_RULE"; });
				pi.on("context_with_system", event => { state.lastTranscript = structuredClone(event.messages); });
				pi.on("tool_call", async event => {
					if (state.pauseRead && event.toolName === "read") {
						state.pauseRead = false;
						await new Promise(resolve => { state.releaseRead = resolve; state.onReadPaused(); });
					}
				});
				pi.on("tool_execution_start", event => { if (event.toolName === "read") state.realReads = (state.realReads ?? 0) + 1; });
			}],
			agentsFilesOverride: () => ({ agentsFiles: [{ path: join(childCwd, "AGENTS.md"), content: "CHILD_PROJECT_CONTRACT" }] }),
			skillsOverride: () => ({ skills: [{ name: "contract-skill", description: "Test skill", filePath: skillPath, baseDir: root, disableModelInvocation: false, sourceInfo: createSyntheticSourceInfo(skillPath, { source: "test" }), frontmatter: { "disallowed-tools": ["bash"] } }], diagnostics: [] }),
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const childRuntime = await ModelRuntime.create({ authPath: join(root, "child-auth.json"), modelsPath: null, modelsStorePath: join(root, "child-cache"), allowModelNetwork: false, refreshOnCreate: false });
		({ session: childSession } = await createAgentSession({ cwd: childCwd, agentDir, settingsManager, sessionManager: SessionManager.inMemory(childCwd), resourceLoader: loader, modelRuntime: childRuntime, model, tools: ["read", "bash"] }));
		const extensionErrors = [];
		await childSession.bindExtensions({ mode: "json", onError: error => extensionErrors.push(error) });
		assert.deepEqual(extensionErrors, []);
		await childSession.prompt("child smoke turn");
		assert.match(childSession.getLastAssistantText(), /MOCK_BRIDGE_REPLY/);
		assert.ok(childRuntime.getModel("claude-bridge", model.id));
		assert.ok(state.queries.at(-1).options.systemPrompt.append.includes("CHILD_PROJECT_CONTRACT"));
		assert.ok(state.queries.at(-1).options.systemPrompt.append.includes("EXTENSION_SECTION_RULE"), "the SDK must receive the final effective custom section");
		assert.ok(state.queries.at(-1).options.systemPrompt.append.includes('version="2"'));
		assert.ok(servedTools(state.queries.at(-1)).includes("bash"));
		state.pauseNext = true;
		const paused = new Promise(resolve => { state.onPaused = resolve; });
		const heldTurn = childSession.prompt("hold while a skill is queued");
		await paused;
		await childSession.prompt("/skill:contract-skill apply restrictions", { streamingBehavior: "followUp" });
		state.release();
		await heldTurn;
		await childSession.waitForIdle();
		assert.ok(!servedTools(state.queries.at(-1)).includes("bash"));
		assert.ok(getCurrentSystemPrompt(state.lastTranscript).includes("EXTENSION_SECTION_RULE"));
		assert.ok(state.queries.at(-1).options.systemPrompt.append.includes("CHILD_PROJECT_CONTRACT"));
		await childSession.prompt("ordinary turn after skill");
		assert.ok(servedTools(state.queries.at(-1)).includes("bash"));
		const compacted = await childSession.compact();
		assert.ok(compacted.summary.includes("MOCK_BRIDGE_REPLY"));
		await childSession.prompt("continue after compaction");
		assert.ok(JSON.stringify(state.lastTranscript).includes("SKILL_BODY_CONTRACT"), "Pi must project the carried skill");
		const lastQuery = state.queries.at(-1);
		const imported = lastQuery.options.resume ? openSession({ sessionId: lastQuery.options.resume, projectPath: lastQuery.options.cwd, claudeDir: lastQuery.options.env.CLAUDE_CONFIG_DIR }).messages : [];
		const forwarded = JSON.stringify({ prompt: state.prompts.at(-1), imported });
		assert.ok(forwarded.includes("SKILL_BODY_CONTRACT"), "request-only skill carry-forward must reach the SDK prompt or imported history");
		const editTarget = childSession.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "user");
		const originalContent = structuredClone(editTarget.message.content);
		childSession.sessionManager.appendContextEdit(editTarget.id, { content: "EDITED_PROJECTED_USER" });
		await childSession.prompt("after projected edit");
		assert.ok(JSON.stringify(state.lastTranscript).includes("EDITED_PROJECTED_USER"));
		assert.deepEqual(childSession.sessionManager.getEntry(editTarget.id).message.content, originalContent, "the raw entry stays unchanged");
		const projectedQuery = state.queries.at(-1).options;
		const projectedImport = openSession({ sessionId: projectedQuery.resume, projectPath: projectedQuery.cwd, claudeDir: projectedQuery.env.CLAUDE_CONFIG_DIR }).messages;
		assert.ok(JSON.stringify(projectedImport).includes("EDITED_PROJECTED_USER"), "import must use the projection, not raw session entries");
		const queriesBeforeSteer = state.queries.length;
		state.plans = [{ tool: "read", arguments: { path: skillPath }, reply: "STALE_TOOL_CONTEXT" }, { reply: "AUTO_RESTART" }];
		state.pauseRead = true;
		const readPaused = new Promise(resolve => { state.onReadPaused = resolve; });
		const toolTurn = childSession.prompt("read the skill fixture");
		await readPaused;
		await childSession.prompt("/skill:contract-skill restrict the continuing turn", { streamingBehavior: "steer" });
		state.releaseRead();
		await toolTurn;
		assert.equal(childSession.getLastAssistantText(), "AUTO_RESTART");
		assert.equal(state.queries.length, queriesBeforeSteer + 2, "the tool-boundary skill change restarts once");
		assert.equal(state.realReads, 1, "recovery must not execute the completed read again");
		assert.ok(!servedTools(state.queries.at(-1)).includes("bash"));
		assert.deepEqual(extensionErrors, []);
	} finally {
		childSession?.dispose();
		if (savedActive === undefined) delete globalThis[activeKey]; else globalThis[activeKey] = savedActive;
		delete globalThis[stateKey];
		rmSync(root, { recursive: true, force: true });
	}
});
