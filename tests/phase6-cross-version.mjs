#!/usr/bin/env node
// Authenticated cross-version session compatibility matrix for upgrade Phase 6.
// The old and target SDK installations and Claude profiles must remain separate.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSession } from "cc-session-io";

const ROOT = resolve(import.meta.dirname, "..");
const PHASE6_ROOT = resolve(ROOT, ".test-output/phase6");
const OLD_INSTALL = resolve(process.env.PHASE6_OLD_INSTALL ?? join(PHASE6_ROOT, "install-old"));
const TARGET_INSTALL = resolve(process.env.PHASE6_TARGET_INSTALL ?? join(PHASE6_ROOT, "install-target"));
const OLD_PROFILE = resolve(process.env.PHASE6_OLD_PROFILE ?? join(PHASE6_ROOT, "profiles/old"));
const TARGET_PROFILE = resolve(process.env.PHASE6_TARGET_PROFILE ?? join(PHASE6_ROOT, "profiles/target"));
const WORKSPACES = join(PHASE6_ROOT, "workspaces");
const MODEL = process.env.PHASE6_MODEL ?? "claude-haiku-4-5";

assert.notEqual(OLD_PROFILE, TARGET_PROFILE, "old and target CLAUDE_CONFIG_DIR values must differ");
assert.notEqual(OLD_PROFILE, resolve(homedir(), ".claude"), "old profile must not be the normal Claude profile");
assert.notEqual(TARGET_PROFILE, resolve(homedir(), ".claude"), "target profile must not be the normal Claude profile");
for (const path of [OLD_INSTALL, TARGET_INSTALL, OLD_PROFILE, TARGET_PROFILE]) {
	assert.ok(existsSync(path), `required isolated Phase 6 path is missing: ${path}`);
}
mkdirSync(WORKSPACES, { recursive: true });
const runRoot = mkdtempSync(join(WORKSPACES, "run-"));

async function loadSdk(install) {
	const entry = join(install, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs");
	assert.ok(existsSync(entry), `SDK entry is missing: ${entry}`);
	return import(pathToFileURL(entry).href);
}

async function withConfigDir(configDir, callback) {
	const previous = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = configDir;
	try {
		return await callback();
	} finally {
		if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = previous;
	}
}

function textFromAssistant(message) {
	if (message.type !== "assistant") return "";
	return (message.message?.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

async function runQuery({ sdk, profile, prompt, cwd, resume, expectedClaudeCode }) {
	return withConfigDir(profile, async () => {
		const query = sdk.query({
			prompt,
			options: {
				model: MODEL,
				cwd,
				resume,
				maxTurns: 1,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				settingSources: [],
			},
		});
		let text = "";
		let sessionId;
		let claudeCodeVersion;
		let terminal;
		try {
			for await (const message of query) {
				if (message.type === "system" && message.subtype === "init") {
					sessionId = message.session_id;
					claudeCodeVersion = message.claude_code_version;
				}
				text += textFromAssistant(message);
				if (message.type === "result") {
					terminal = message;
					sessionId = message.session_id ?? sessionId;
				}
			}
		} finally {
			query.close();
		}
		assert.ok(terminal, "query produced no terminal result");
		assert.equal(terminal.is_error, false, typeof terminal.result === "string" ? terminal.result : terminal.subtype);
		assert.equal(claudeCodeVersion, expectedClaudeCode, "query selected the wrong bundled Claude Code binary");
		return { text, sessionId, claudeCodeVersion };
	});
}

function createSynthetic(profile, projectPath, sessionId, phrase, version) {
	const session = createSession({
		projectPath,
		claudeDir: profile,
		sessionId,
		version,
		model: MODEL,
	});
	session.addUserMessage(`The synthetic history phrase is ${phrase}. Remember it.`);
	session.addAssistantMessage([{ type: "text", text: `I will remember ${phrase}.` }]);
	session.save();
	return session.jsonlPath;
}

function destinationSessionPath(profile, projectPath, sessionId) {
	return createSession({
		projectPath,
		claudeDir: profile,
		sessionId,
		version: "phase6-copy-destination",
		model: MODEL,
	}).jsonlPath;
}

function copyTranscript({ sourcePath, destinationProfile, projectPath, sessionId }) {
	const destinationPath = destinationSessionPath(destinationProfile, projectPath, sessionId);
	mkdirSync(dirname(destinationPath), { recursive: true });
	cpSync(sourcePath, destinationPath);

	const sourceCompanion = sourcePath.replace(/\.jsonl$/, "");
	const destinationCompanion = destinationPath.replace(/\.jsonl$/, "");
	if (existsSync(sourceCompanion)) {
		rmSync(destinationCompanion, { recursive: true, force: true });
		cpSync(sourceCompanion, destinationCompanion, { recursive: true });
	}
	return destinationPath;
}

async function assertSdkReadable({ sdk, profile, projectPath, sessionId, phrases }) {
	return withConfigDir(profile, async () => {
		const messages = await sdk.getSessionMessages(sessionId, { dir: projectPath });
		const serialized = JSON.stringify(messages);
		for (const phrase of phrases) {
			assert.match(serialized, new RegExp(phrase, "i"), `SDK session messages omitted ${phrase}`);
		}
		const sessions = await sdk.listSessions({ dir: projectPath });
		assert.ok(sessions.some((session) => session.sessionId === sessionId), "SDK listSessions omitted the copied session");
		return messages.length;
	});
}

function assertContains(text, phrases, label) {
	for (const phrase of phrases) {
		assert.match(text, new RegExp(phrase, "i"), `${label} omitted ${phrase}: ${text.slice(0, 500)}`);
	}
}

const oldSdk = await loadSdk(OLD_INSTALL);
const targetSdk = await loadSdk(TARGET_INSTALL);
const results = [];

try {
	// 1. Generate and resume a session entirely with the old SDK/binary.
	{
		const projectPath = join(runRoot, "old-generated");
		mkdirSync(projectPath);
		const phrase = `OLD-GENERATED-${randomUUID().slice(0, 8)}`;
		const generated = await runQuery({
			sdk: oldSdk,
			profile: OLD_PROFILE,
			prompt: `Remember the benign phrase ${phrase}. Reply exactly RECORDED.`,
			cwd: projectPath,
			expectedClaudeCode: "2.1.141",
		});
		assert.ok(generated.sessionId, "old query did not report a session ID");
		const resumed = await runQuery({
			sdk: oldSdk,
			profile: OLD_PROFILE,
			prompt: "Reply with exactly the phrase I asked you to remember.",
			cwd: projectPath,
			resume: generated.sessionId,
			expectedClaudeCode: "2.1.141",
		});
		assertContains(resumed.text, [phrase], "old generated-session resume");
		results.push(`PASS old-generated-resume session=${generated.sessionId.slice(0, 8)}`);
	}

	// 2. Resume cc-session-io synthetic history with the target SDK/binary.
	{
		const projectPath = join(runRoot, "target-synthetic");
		mkdirSync(projectPath);
		const sessionId = randomUUID();
		const phrase = `TARGET-SYNTHETIC-${randomUUID().slice(0, 8)}`;
		createSynthetic(TARGET_PROFILE, projectPath, sessionId, phrase, "phase6-target-synthetic");
		const apiMessages = await assertSdkReadable({
			sdk: targetSdk,
			profile: TARGET_PROFILE,
			projectPath,
			sessionId,
			phrases: [phrase],
		});
		const resumed = await runQuery({
			sdk: targetSdk,
			profile: TARGET_PROFILE,
			prompt: "Reply with exactly the synthetic history phrase.",
			cwd: projectPath,
			resume: sessionId,
			expectedClaudeCode: "2.1.218",
		});
		assertContains(resumed.text, [phrase], "target synthetic resume");
		results.push(`PASS target-synthetic-resume sdkMessages=${apiMessages}`);
	}

	// 3. Target appends records; old SDK APIs and binary read a copied transcript.
	{
		const projectPath = join(runRoot, "target-to-old");
		mkdirSync(projectPath);
		const sessionId = randomUUID();
		const basePhrase = `T2O-BASE-${randomUUID().slice(0, 8)}`;
		const appendPhrase = `T2O-APPEND-${randomUUID().slice(0, 8)}`;
		const sourcePath = createSynthetic(TARGET_PROFILE, projectPath, sessionId, basePhrase, "phase6-target-to-old");
		await runQuery({
			sdk: targetSdk,
			profile: TARGET_PROFILE,
			prompt: `The second benign phrase is ${appendPhrase}. Remember it and reply exactly RECORDED.`,
			cwd: projectPath,
			resume: sessionId,
			expectedClaudeCode: "2.1.218",
		});
		copyTranscript({ sourcePath, destinationProfile: OLD_PROFILE, projectPath, sessionId });
		const apiMessages = await assertSdkReadable({
			sdk: oldSdk,
			profile: OLD_PROFILE,
			projectPath,
			sessionId,
			phrases: [basePhrase, appendPhrase],
		});
		const resumed = await runQuery({
			sdk: oldSdk,
			profile: OLD_PROFILE,
			prompt: "Reply with both remembered phrases, separated by a comma.",
			cwd: projectPath,
			resume: sessionId,
			expectedClaudeCode: "2.1.141",
		});
		assertContains(resumed.text, [basePhrase, appendPhrase], "old read of target-appended transcript");
		results.push(`PASS target-to-old sdkMessages=${apiMessages} directResume=yes file=${basename(sourcePath)}`);
	}

	// 4. Old appends records; target SDK APIs and binary read a copied transcript.
	{
		const projectPath = join(runRoot, "old-to-target");
		mkdirSync(projectPath);
		const sessionId = randomUUID();
		const basePhrase = `O2T-BASE-${randomUUID().slice(0, 8)}`;
		const appendPhrase = `O2T-APPEND-${randomUUID().slice(0, 8)}`;
		const sourcePath = createSynthetic(OLD_PROFILE, projectPath, sessionId, basePhrase, "phase6-old-to-target");
		await runQuery({
			sdk: oldSdk,
			profile: OLD_PROFILE,
			prompt: `The second benign phrase is ${appendPhrase}. Remember it and reply exactly RECORDED.`,
			cwd: projectPath,
			resume: sessionId,
			expectedClaudeCode: "2.1.141",
		});
		copyTranscript({ sourcePath, destinationProfile: TARGET_PROFILE, projectPath, sessionId });
		const apiMessages = await assertSdkReadable({
			sdk: targetSdk,
			profile: TARGET_PROFILE,
			projectPath,
			sessionId,
			phrases: [basePhrase, appendPhrase],
		});
		const resumed = await runQuery({
			sdk: targetSdk,
			profile: TARGET_PROFILE,
			prompt: "Reply with both remembered phrases, separated by a comma.",
			cwd: projectPath,
			resume: sessionId,
			expectedClaudeCode: "2.1.218",
		});
		assertContains(resumed.text, [basePhrase, appendPhrase], "target read of old-appended transcript");
		results.push(`PASS old-to-target sdkMessages=${apiMessages} directResume=yes file=${basename(sourcePath)}`);
	}

	for (const result of results) console.log(result);
	console.log(`PASS Phase 6 direct/API matrix oldProfile=${OLD_PROFILE} targetProfile=${TARGET_PROFILE}`);
	console.log(`Evidence workspace: ${runRoot}`);
} catch (error) {
	console.error(`FAIL Phase 6 direct/API matrix: ${error.message}`);
	console.error(`Evidence workspace: ${runRoot}`);
	throw error;
}
