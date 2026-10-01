#!/usr/bin/env node
// Explicit live probe of the Pi fork and real bridge SDK. Uses subscription quota.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { getSessionPath } from "cc-session-io";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { subagentServiceFor } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/fork-builtins/subagents/service/sessions.js";
import { defaultClaudeConfigDir } from "../src/claude-config.ts";
import { assertClaudeAuthenticated } from "../tests/lib/claude-auth.mjs";

if (!process.argv.includes("--run")) throw new Error("Pass --run to authorize this live, quota-consuming probe.");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = process.env.CLAUDE_BRIDGE_LIVE_AUTH_PROFILE ?? defaultClaudeConfigDir();
assertClaudeAuthenticated(profile);
const evidenceRoot = join(repo, ".test-output", "live-merge-2026-09-30");
mkdirSync(evidenceRoot, { recursive: true });
const root = mkdtempSync(join(evidenceRoot, "pi-session-context-"));
const agentDir = join(root, "agent");
const parentCwd = join(root, "parent");
const childCwd = join(root, "child");
for (const path of [agentDir, parentCwd, childCwd, join(agentDir, "agents")]) mkdirSync(path, { recursive: true });
const streamPath = join(root, "sdk-stream.jsonl");
const debugPath = join(root, "session-context-debug.log");
process.env.CLAUDE_BRIDGE_DEBUG = "1";
process.env.CLAUDE_BRIDGE_DEBUG_PATH = debugPath;
process.env.CLAUDE_BRIDGE_DIAG_PATH = join(root, "diagnostics.jsonl");
process.env.CLAUDE_BRIDGE_RECORD_STREAM = streamPath;
const nonce = randomUUID().slice(0, 8);
const parentMarker = `PARENT_${nonce}`;
const childMarker = `CHILD_${nonce}`;
const nestedMarker = `NESTED_${nonce}`;
writeFileSync(join(parentCwd, "marker.txt"), `${parentMarker}\n`);
writeFileSync(join(childCwd, "marker.txt"), `${childMarker}\n`);
writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({
	startupNoticeShown: "live-test",
	provider: { plan: "max", usageEvents: false, claudeConfigDir: profile, excludeModels: ["claude-opus-4-5", "claude-sonnet-4-5"] },
}));
writeFileSync(join(agentDir, "agents", "live-reader.md"), [
	"---", "name: live-reader", "description: Read the disposable live-test marker.", "tools: [read]", "extensions: false", "skills: false",
	"isolated: true", "prompt_mode: replace", "persist_session: false", "output_transcript: false", "run_in_background: false", "max_turns: 4", "---",
	"You are a test reader. Use read to read marker.txt relative to your current directory. Return its exact content. Never guess.",
].join("\n"));
const evidence = { root, model: "claude-haiku-4-5", steps: [], errors: [] };
const writeEvidence = () => writeFileSync(join(root, "results.json"), JSON.stringify(evidence, null, 2));
function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}
async function bounded(promise, label, ms = 90000) {
	let timer;
	try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]); }
	finally { clearTimeout(timer); }
}
function records() {
	return existsSync(streamPath) ? readFileSync(streamPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
function initSince(offset) {
	const init = records().slice(offset).find(message => message.type === "system" && message.subtype === "init");
	assert.ok(init?.session_id, "the actual SDK must report the Claude session identity");
	return init.session_id;
}
function assertStored(sessionId, cwd) {
	const path = getSessionPath(sessionId, cwd, profile);
	assert.ok(existsSync(path), `Claude must persist its actual session under the serving cwd: ${path}`);
	return path;
}
function claudeDescendants() {
	const scan = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
	assert.equal(scan.status, 0, "process observation must succeed rather than treating inaccessible state as clean");
	const rows = scan.stdout.split("\n").flatMap(line => {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
		return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : [];
	});
	const descendants = new Set([process.pid]);
	for (let changed = true; changed;) {
		changed = false;
		for (const row of rows) if (descendants.has(row.parent) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; }
	}
	return rows.filter(row => descendants.has(row.pid) && /claude-agent-sdk.*[/\\]claude(?:\s|$)/.test(row.command)).map(row => row.pid);
}
const paused = deferred();
const release = deferred();
let holdRead = false;
let nestedCalls = 0;
let parent;
let service;
let pendingParent;
const settingsManager = SettingsManager.inMemory({
	compaction: { enabled: false }, retry: { enabled: false },
	forkBuiltins: { subagents: { backgroundByDefault: false, rememberAgents: false, outputTranscript: false, agentMentions: "off" } },
});
const loader = new DefaultResourceLoader({
	cwd: parentCwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	additionalExtensionPaths: [join(repo, "src", "index.ts")],
	extensionFactories: [pi => {
		pi.on("tool_call", async event => {
			if (holdRead && event.toolName === "read") { holdRead = false; paused.resolve(); await release.promise; }
		});
		pi.registerTool({ name: "mcp__live__echo", label: "Nested MCP echo", description: "Return the exact supplied text for a disposable mapping test.", parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, params) => { nestedCalls++; return { content: [{ type: "text", text: params.text }], details: {} }; },
		});
	}],
});
try {
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const runtime = await ModelRuntime.create({ credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} }, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	for (const registration of loader.getExtensions().runtime.pendingProviderRegistrations) runtime.registerProvider(registration.name, registration.config);
	const model = runtime.getModel("claude-bridge", evidence.model);
	assert.ok(model);
	({ session: parent } = await createAgentSession({ cwd: parentCwd, agentDir, settingsManager, sessionManager: SessionManager.inMemory(parentCwd), resourceLoader: loader, modelRuntime: runtime, model, tools: ["read", "mcp__live__echo"] }));
	await parent.bindExtensions({ mode: "json", onError: error => evidence.errors.push(error.error ?? String(error)) });
	const firstOffset = records().length;
	await bounded(parent.prompt("Use read on the relative path marker.txt. Reply with only its exact contents."), "parent seed");
	assert.equal(parent.getLastAssistantText().trim(), parentMarker);
	const parentId = initSince(firstOffset);
	evidence.steps.push({ step: "parent-seed", claudeSessionId: parentId, cwd: parentCwd, sessionFile: assertStored(parentId, parentCwd) });
	writeEvidence();

	holdRead = true;
	pendingParent = parent.prompt("Use read on marker.txt again and reply with only its exact contents.");
	pendingParent.catch(() => {});
	await bounded(paused.promise, "parent parked at read");
	service = subagentServiceFor(parent);
	assert.ok(service, "the real Pi native subagent service must be present");
	const childOffset = records().length;
	const child = await service.spawn({ type: "live-reader", description: "Live metadata test", cwd: childCwd, model, params: { isolated: true, run_in_background: false }, prompt: "Use read on the relative path marker.txt and reply with only its exact contents." });
	const childResult = await bounded(service.waitForResult(child.id), "native isolated child");
	assert.equal(childResult.status, "completed", childResult.error);
	assert.equal(childResult.result.trim(), childMarker);
	assert.ok(childResult.toolUses >= 1);
	assert.equal(childResult.definition.extensions, false);
	const childId = initSince(childOffset);
	assert.notEqual(childId, parentId);
	evidence.steps.push({ step: "extension-free-child", childId: child.id, claudeSessionId: childId, cwd: childCwd, sessionFile: assertStored(childId, childCwd), usage: childResult.usage });
	writeEvidence();

	const resumeOffset = records().length;
	service.resume(child.id, "Use read on marker.txt once more and return only its exact contents.", { background: false });
	const resumed = await bounded(service.waitForResult(child.id), "native child resume");
	assert.equal(resumed.status, "completed", resumed.error);
	assert.equal(resumed.result.trim(), childMarker);
	assert.equal(initSince(resumeOffset), childId, "the retained native child must resume its own Claude mirror");
	await bounded(service.shutdown(), "native child teardown", 10000);
	assert.ok(claudeDescendants().length >= 1, "the parked parent's Claude process must survive child teardown");
	evidence.steps.push({ step: "child-resume-and-teardown", claudeSessionId: childId, parentRemainsLive: true });
	writeEvidence();

	release.resolve();
	await bounded(pendingParent, "parent continuation");
	assert.equal(parent.getLastAssistantText().trim(), parentMarker);
	const lastOffset = records().length;
	await bounded(parent.prompt("Use read on marker.txt and return only its exact contents."), "parent after child teardown");
	assert.equal(parent.getLastAssistantText().trim(), parentMarker);
	assert.equal(initSince(lastOffset), parentId, "child teardown must preserve the parent's reusable Claude mirror");
	evidence.steps.push({ step: "parent-reuse-after-child-teardown", claudeSessionId: parentId });

	await bounded(parent.prompt(`Call mcp__live__echo exactly once with text=${nestedMarker}. Return only its output.`), "nested MCP name");
	assert.equal(parent.getLastAssistantText().trim(), nestedMarker);
	assert.equal(nestedCalls, 1);
	assert.ok(records().some(message => JSON.stringify(message).includes("mcp__custom-tools__mcp__live__echo")));
	evidence.steps.push({ step: "nested-mcp-round-trip", calls: nestedCalls });
	assert.deepEqual(evidence.errors, []);
	assert.doesNotMatch(readFileSync(debugPath, "utf8"), /\] (?:BUG:|WARNING: \d+ MCP handlers still waiting)/);
	await bounded(parent.shutdown(), "parent shutdown", 10000);
	for (let attempt = 0; attempt < 40 && claudeDescendants().length; attempt++) await delay(100);
	assert.deepEqual(claudeDescendants(), [], "no real Claude process may outlive the owned sessions");
	evidence.steps.push({ step: "all-claude-children-exited" });
	evidence.status = "passed";
} catch (error) {
	evidence.status = "failed";
	evidence.failure = error instanceof Error ? error.stack : String(error);
	process.exitCode = 1;
} finally {
	release.resolve();
	try { if (service) await bounded(service.shutdown(), "final child teardown", 10000); } catch (error) { evidence.errors.push(String(error)); process.exitCode = 1; }
	try { if (parent) await bounded(parent.shutdown(), "final parent teardown", 10000); } catch (error) { evidence.errors.push(String(error)); process.exitCode = 1; }
	loader.dispose();
	writeEvidence();
	console.log(JSON.stringify({ status: evidence.status, steps: evidence.steps.map(step => step.step), evidence: root, failure: evidence.failure, errors: evidence.errors }, null, 2));
}
