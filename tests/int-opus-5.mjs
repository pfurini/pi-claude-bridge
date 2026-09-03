#!/usr/bin/env node
// Authenticated Claude Opus 5 coverage on Agent SDK 0.3.259 / Claude Code 2.1.259.
//
// Two harnesses: one with the bridge as the provider (Opus 5 selected directly),
// one with an alternate provider driving the AskClaude tool.
//
// Cost discipline: every Opus 5 turn here is a single trivial turn. There is
// deliberately NO live effort="max" turn — that is the most expensive request the
// bridge can issue and it would only re-prove a mapping the unit tests compute.
// It lives in diag/context-size.mjs behind --effort-max as a one-off probe.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getSessionPath } from "cc-session-io";
import { defaultClaudeConfigDir } from "../src/claude-config.js";
import { createRpcHarness, requireEnv } from "./lib/rpc-harness.mjs";

const OTHER_PROVIDER = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_PROVIDER");
const OTHER_MODEL = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_MODEL");
const TIMEOUT = 240_000;
const OPUS_5 = "claude-opus-5";
const BRIDGE_OPUS_5 = `claude-bridge/${OPUS_5}`;
const TARGET_CLAUDE_CODE_VERSION = "2.1.259";
const ONE_M = 1_000_000;
const CONFIGURED_PROFILE = defaultClaudeConfigDir();
const NORMAL_PROFILE = join(homedir(), ".claude");

// The bridge resolves the Agent SDK's own bundled executable unless config sets
// provider.pathToClaudeCodeExecutable, so the SDK's declared claudeCodeVersion is
// the binary these turns ran against. The isolation case below asserts that no
// override was in effect, since a user's global config could set one. The live
// system:init assertion for that same binary runs offline in
// tests/unit-sdk-runtime-contract.mjs, which needs no credentials.
const bundledClaudeCodeVersion = JSON.parse(
	readFileSync(
		join(dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk")), "package.json"),
		"utf8",
	),
).claudeCodeVersion;

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-claude-bridge-opus-5-"));
const PROVIDER_CWD = join(TEST_ROOT, "provider");
const ASK_CWD = join(TEST_ROOT, "ask");
for (const cwd of [PROVIDER_CWD, ASK_CWD]) mkdirSync(join(cwd, ".pi"), { recursive: true });
writeFileSync(
	join(PROVIDER_CWD, ".pi", "claude-bridge.json"),
	JSON.stringify({ provider: { claudeConfigDir: CONFIGURED_PROFILE } }),
);
writeFileSync(
	join(ASK_CWD, ".pi", "claude-bridge.json"),
	JSON.stringify({ askClaude: { enabled: true, allowFullMode: true } }),
);

function providerQueryLines(debugLog) {
	return debugLog.split("\n").filter((line) => line.includes("provider: fresh query"));
}

function askClaudeLines(debugLog) {
	return debugLog.split("\n").filter((line) => line.includes("askClaude:"));
}

describe("Opus 5 as a bridge provider model", () => {
	// Own Pi agent directory: this suite changes the thinking level, which Pi
	// persists. Without isolation the run would rewrite the user's real settings
	// and inherit whatever level a previous run left behind.
	const providerAgentDir = mkdtempSync(join(tmpdir(), "opus-5-agent-"));
	writeFileSync(join(providerAgentDir, "settings.json"), JSON.stringify({}));

	const harness = createRpcHarness({
		name: "opus-5-provider",
		args: ["--model", BRIDGE_OPUS_5],
		cwd: PROVIDER_CWD,
		env: { PI_CODING_AGENT_DIR: providerAgentDir },
		claudeConfigDir: CONFIGURED_PROFILE,
		defaultTimeout: TIMEOUT,
	});
	const token = `OPUS5-${Math.random().toString(36).slice(2, 10)}`;

	before(async () => {
		// The harness preflights CONFIGURED_PROFILE's auth on start().
		await harness.startAndWait();
	});

	after(async () => {
		await harness.stop();
		rmSync(providerAgentDir, { recursive: true, force: true });
		console.log(`  RPC log: ${harness.RPC_LOG}`);
		console.log(`  Debug log: ${harness.DEBUG_LOG}`);
	});

	it("pins the bundled Claude Code build these turns ran against", () => {
		assert.equal(bundledClaudeCodeVersion, TARGET_CLAUDE_CODE_VERSION);
	});

	it("registers Opus 5 at 1M and exposes both top effort tiers", { timeout: TIMEOUT }, async () => {
		const { models } = await harness.send({ type: "get_available_models" });
		const registered = models.find((m) => m.provider === "claude-bridge" && m.id === OPUS_5);
		assert.ok(registered, `picker is missing ${BRIDGE_OPUS_5}: ${models.map((m) => `${m.provider}/${m.id}`).join(", ")}`);
		assert.equal(registered.contextWindow, ONE_M);
		assert.match(registered.name, /1M/);

		await harness.send({ type: "set_model", provider: "claude-bridge", modelId: OPUS_5 });
		const { levels } = await harness.send({ type: "get_available_thinking_levels" });
		// pi-ai >=0.82.1 gives Opus 5 { xhigh: "xhigh", max: "max" }, so both are
		// real opt-in levels rather than hidden aliases.
		for (const level of ["xhigh", "max"]) {
			assert.ok(levels.includes(level), `Opus 5 should offer ${level}, got ${levels.join(", ")}`);
		}
	});

	it("answers one turn, requests the bare id, and serves 1M", { timeout: TIMEOUT }, async () => {
		const text = await harness.promptAndWait(
			`Remember the exact token ${token}. Reply with exactly RECORDED.`,
			TIMEOUT,
		);
		assert.match(text, /RECORDED/);

		const debugLog = readFileSync(harness.DEBUG_LOG, "utf8");
		const queries = providerQueryLines(debugLog);
		assert.ok(queries.length > 0, "no provider fresh-query line in the debug log");
		// Bare id is the production request: 1M is native, no [1m] suffix.
		assert.ok(
			queries.some((line) => line.includes(`model=${OPUS_5} `)),
			`expected a bare ${OPUS_5} request:\n${queries.join("\n")}`,
		);
		assert.ok(
			!queries.some((line) => line.includes(`model=${OPUS_5}[1m]`)),
			`the bridge must not request the [1m] variant:\n${queries.join("\n")}`,
		);

		const served = debugLog.split("\n").find((line) => /result: served contextWindow=/.test(line));
		assert.ok(served, "no served-window diagnostic line");
		assert.match(served, new RegExp(`servedModel=${OPUS_5}\\b`));
		assert.match(served, new RegExp(`served contextWindow=${ONE_M}\\b`));
		assert.match(served, new RegExp(`registered=${ONE_M}\\b`));
	});

	it("resumes the same session on a second turn", { timeout: TIMEOUT }, async () => {
		const text = await harness.promptAndWait(
			"What exact token did I ask you to remember? Reply with only the token.",
			TIMEOUT,
		);
		assert.match(text, new RegExp(token));
		assert.match(readFileSync(harness.DEBUG_LOG, "utf8"), /syncResult: path=reuse sessionId=/);
	});

	it("sends SDK effort xhigh when pi asks for xhigh", { timeout: TIMEOUT }, async () => {
		// Scope the assertion to the lines this turn adds. Earlier turns in the
		// suite ran at whatever level Pi started with, and asserting over the whole
		// log would judge those too.
		const before = readFileSync(harness.DEBUG_LOG, "utf8").length;
		await harness.send({ type: "set_thinking_level", level: "xhigh" });
		const text = await harness.promptAndWait('Reply with just the word "yes".', TIMEOUT);
		assert.match(text, /yes/i);

		const efforts = providerQueryLines(readFileSync(harness.DEBUG_LOG, "utf8").slice(before))
			.filter((line) => line.includes(`model=${OPUS_5} `))
			.map((line) => line.match(/effort=(\S+)/)?.[1]);
		assert.ok(efforts.length > 0, "no Opus 5 provider turn was recorded for this case");
		// Opus 5 has a real xhigh tier, so pi xhigh must reach SDK xhigh and must
		// not escalate to max the way the old flat table did.
		assert.deepEqual(
			[...new Set(efforts)],
			["xhigh"],
			`expected only effort=xhigh on this turn, saw: ${efforts.join(", ")}`,
		);
	});

	it("recovers from an abort by rotating the shared session", { timeout: TIMEOUT }, async () => {
		// Abort on the first streamed token rather than after a fixed delay: Opus 5
		// finishes a short counting turn in a few seconds, so a sleep races the
		// completion and silently tests nothing.
		const idle = harness.waitForEvent("agent_end", TIMEOUT);
		const firstDelta = harness.waitForMatch(
			(msg) => msg.type === "message_update" && msg.assistantMessageEvent?.type === "text_delta",
			"first streamed token",
			TIMEOUT,
		);
		await harness.send({
			type: "prompt",
			message: "Count from 1 to 500, one number per line, with no other text.",
		});
		await firstDelta;
		await harness.send({ type: "abort" });
		await idle;

		const recovered = await harness.promptAndWait(
			`Reply with exactly the token ${token} and nothing else.`,
			TIMEOUT,
		);
		assert.match(recovered, new RegExp(token));

		const debugLog = readFileSync(harness.DEBUG_LOG, "utf8");
		// The bridge's own view is the authority that the abort raced correctly:
		// these two lines appear only on a real abort, never on a completed turn.
		assert.match(debugLog, /consumeQuery: for-await loop exited, wasAborted=true/);
		assert.match(debugLog, /provider: abort detected, marked sharedSession needsRebuild \+ forceRotate/);
		assert.match(debugLog, /syncResult: path=rebuild sessionId=[a-f0-9-]+ priors=\d+ rotated-post-abort/);
		// A killed child must not resume queued work: the recovery turn answers the
		// token question only, with no leftover counting output.
		assert.doesNotMatch(recovered, /\b4\d\d\b/);
	});

	// Last, so the assertion sees every session this suite produced — including
	// the post-abort rotation, which is the only path where the bridge itself
	// writes a JSONL rather than letting Claude Code create it.
	it("keeps Opus 5 sessions inside the isolated profile", { timeout: TIMEOUT }, async () => {
		const debugLog = readFileSync(harness.DEBUG_LOG, "utf8");
		assert.match(
			debugLog,
			new RegExp(`loadConfig:.*"claudeConfigDir":"${CONFIGURED_PROFILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
			`debug log did not report configured profile ${CONFIGURED_PROFILE}`,
		);
		// Premise of the bundled-version check at the top of this suite: an
		// executable override would mean these turns ran against another binary.
		assert.doesNotMatch(
			debugLog,
			/pathToClaudeCodeExecutable/,
			"an executable override was configured, so the bundled-version claim does not hold",
		);
		const sessionIds = new Set(
			[...debugLog.matchAll(/syncResult: path=\w+ sessionId=([a-f0-9-]{36})/g)].map((m) => m[1]),
		);
		assert.ok(sessionIds.size > 0, "no shared session was recorded");
		for (const sessionId of sessionIds) {
			assert.equal(
				existsSync(getSessionPath(sessionId, PROVIDER_CWD, NORMAL_PROFILE)),
				false,
				`session ${sessionId} leaked into the normal Claude profile`,
			);
		}
		assert.ok(
			[...sessionIds].some((id) => existsSync(getSessionPath(id, PROVIDER_CWD, CONFIGURED_PROFILE))),
			`no session JSONL under the configured isolated profile for ${[...sessionIds].join(", ")}`,
		);
	});
});

describe("Opus 5 through AskClaude", () => {
	const harness = createRpcHarness({
		name: "opus-5-askclaude",
		args: ["--model", `${OTHER_PROVIDER}/${OTHER_MODEL}`],
		cwd: ASK_CWD,
		claudeConfigDir: CONFIGURED_PROFILE,
		defaultTimeout: TIMEOUT,
	});

	function toolResultText(message) {
		return (message.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
	}

	async function invokeAskClaude(params) {
		const idle = harness.waitForEvent("agent_end", TIMEOUT);
		await harness.send({
			type: "prompt",
			message: `Call the AskClaude tool exactly once with these JSON arguments:\n${JSON.stringify(params)}\nDo not change, add, or omit any argument. Do not use another tool. After AskClaude returns, reply with exactly OUTER-DONE.`,
		}, TIMEOUT);
		const event = await idle;
		const result = [...(event.messages ?? [])].reverse()
			.find((m) => m.role === "toolResult" && m.toolName === "AskClaude");
		assert.ok(result, `no AskClaude tool result: ${JSON.stringify(event.messages ?? []).slice(0, 1000)}`);
		return toolResultText(result);
	}

	before(async () => {
		// The harness preflights CONFIGURED_PROFILE's auth on start().
		await harness.startAndWait();
	});

	after(async () => {
		await harness.stop();
		console.log(`  RPC log: ${harness.RPC_LOG}`);
		console.log(`  Debug log: ${harness.DEBUG_LOG}`);
	});

	it("accepts an explicit Opus 5 model at thinking xhigh", { timeout: TIMEOUT }, async () => {
		const marker = `ASK-OPUS5-${Math.random().toString(36).slice(2, 10)}`;
		const result = await invokeAskClaude({
			prompt: `Reply with exactly ${marker} and nothing else.`,
			mode: "none",
			model: OPUS_5,
			thinking: "xhigh",
			isolated: true,
		});
		assert.match(result, new RegExp(marker));

		const lines = askClaudeLines(readFileSync(harness.DEBUG_LOG, "utf8"))
			.filter((line) => line.includes(`model=${OPUS_5} `));
		assert.ok(lines.length > 0, "no AskClaude debug line for an explicit Opus 5 request");
		// Bare cliModel, and xhigh reaching the real SDK tier rather than max —
		// AskClaude now uses the same model-aware lookup as the provider path.
		assert.ok(lines.some((line) => line.includes(`cliModel=${OPUS_5} `)), `expected a bare cliModel:\n${lines.join("\n")}`);
		assert.ok(lines.some((line) => line.includes("effort=xhigh")), `expected effort=xhigh:\n${lines.join("\n")}`);
		assert.ok(!lines.some((line) => line.includes("effort=max")), `xhigh must not escalate to max:\n${lines.join("\n")}`);
	});

	it("defaults an omitted model to Opus 5", { timeout: TIMEOUT }, async () => {
		const marker = `ASK-DEFAULT-${Math.random().toString(36).slice(2, 10)}`;
		const result = await invokeAskClaude({
			prompt: `Reply with exactly ${marker} and nothing else.`,
			mode: "none",
			isolated: true,
		});
		assert.match(result, new RegExp(marker));

		// The default is the literal string "opus", which resolveModel now maps to
		// Opus 5 because it is the first opus entry in MODEL_IDS_IN_ORDER.
		const lines = askClaudeLines(readFileSync(harness.DEBUG_LOG, "utf8"));
		assert.ok(
			lines.some((line) => line.includes(`model=${OPUS_5} cliModel=${OPUS_5} `)),
			`omitted model should resolve to bare ${OPUS_5}:\n${lines.join("\n")}`,
		);
	});

	// Nested delegation is binary behaviour (2.1.219 restored a default maximum
	// subagent depth of three) and tool policy, neither of which depends on the
	// model. Run these on Haiku: Opus 5 would multiply the cost of a multi-level
	// delegation for no additional signal.
	it("completes nested delegation in full mode", { timeout: TIMEOUT }, async () => {
		const phrase = `NESTED-FULL-${Math.random().toString(36).slice(2, 10)}`;
		const fixture = join(ASK_CWD, "nested-full-fixture.txt");
		writeFileSync(fixture, phrase);

		const result = await invokeAskClaude({
			prompt: `This is an authenticated delegation regression test; the fixture holds no credentials. Use Task exactly once to launch a general-purpose subagent that reads ${fixture} and returns only the benign token it contains. Do not read the file yourself. Wait for the result, then reply with NESTED-OK: followed immediately by that token copied verbatim. Do not paraphrase, summarize, or substitute a placeholder for the token.`,
			mode: "full",
			model: "haiku",
			isolated: true,
		});

		assert.match(result, /NESTED-OK/);
		// The token can only be in the answer if delegation actually carried the
		// child's file read back to the parent.
		assert.match(result, new RegExp(phrase));
		assert.match(result, /\[Claude Code actions: [^\]]*Agent\(/);
	});

	it("denies mutation to read-mode children and grandchildren", { timeout: TIMEOUT }, async () => {
		const phrase = `NESTED-READ-${Math.random().toString(36).slice(2, 10)}`;
		const fixture = join(ASK_CWD, "nested-read-fixture.txt");
		const childTarget = join(ASK_CWD, "nested-read-child-must-not-exist.txt");
		const grandchildTarget = join(ASK_CWD, "nested-read-grandchild-must-not-exist.txt");
		writeFileSync(fixture, phrase);

		const result = await invokeAskClaude({
			prompt: `Read-mode policy probe. Use Task exactly once to launch a general-purpose subagent, and instruct that subagent to: (1) read ${fixture}; (2) attempt exactly once to create ${childTarget} with Write or Bash; (3) launch one further nested subagent that attempts exactly once to create ${grandchildTarget}. Do not substitute other tools for blocked ones and do not create the files yourself. Report the phrase and which write attempts were unavailable.`,
			mode: "read",
			model: "haiku",
			isolated: true,
		});

		// Read mode must not gain mutation capability through delegation depth.
		assert.ok(!existsSync(childTarget), "a read-mode child subagent created a file");
		assert.ok(!existsSync(grandchildTarget), "a read-mode grandchild subagent created a file");
		assert.doesNotMatch(result, /(?:\[Claude Code actions: |; )Bash\(/);
		assert.doesNotMatch(result, /(?:\[Claude Code actions: |; )Write\(/);
		assert.match(result, new RegExp(phrase));
	});
});

process.on("exit", () => {
	rmSync(TEST_ROOT, { recursive: true, force: true });
});
