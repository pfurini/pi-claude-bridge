#!/usr/bin/env node
// Live contracts for pi's versioned skill-listing system as seen through the
// bridge (plans/skill-listing-contract.md, AC12-AC15). These pin *pi* behavior
// the bridge depends on — listing delivery, ephemeral frontmatter overrides,
// cross-provider rebuild — the way tests/int-cc-contracts.mjs pins CC/SDK
// behavior. They spend quota, so they run last.
//
// Each turn is a real `pi -p` spawn with the bridge extension loaded and a
// fixture skill via --skill (never installed — see tests/fixtures/skills/).
// Assertions key off the bridge's own debug log, one file per spawn.
//
// Requires: pi CLI (the fork) on PATH, Claude Code authenticated. Must run
// OUTSIDE the sandbox — CC persists session state under its config dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertClaudeAuthenticated } from "./lib/claude-auth.mjs";
// Side-effect import: loads .env.test and probes Claude Code's config dir for
// writability up front, so a sandboxed run fails with a clear message.
import "./lib/rpc-harness.mjs";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOGDIR = resolve(DIR, ".test-output");
mkdirSync(LOGDIR, { recursive: true });

const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";
const FIXTURES = resolve(DIR, "tests/fixtures/skills");
const TIMEOUT = 180_000;

assertClaudeAuthenticated();

// Strip any local node_modules from PATH so `pi` resolves to the globally
// installed fork, same as the RPC harness.
const CLEAN_PATH = process.env.PATH.split(":")
	.filter((p) => !p.includes("node_modules"))
	.join(":");

/**
 * Run one `pi -p` turn with the bridge extension and return stdout plus the
 * bridge debug log written for exactly this spawn.
 */
function runTurn({
	name,
	skill,
	prompt,
	sessionId,
	tools,
	model = BRIDGE_MODEL,
}) {
	const debugLogPath = resolve(
		LOGDIR,
		`${name}-${randomUUID().slice(0, 8)}-debug.log`,
	);
	const args = [
		"-ne",
		"-e",
		DIR,
		"--skill",
		resolve(FIXTURES, skill),
		"--model",
		model,
	];
	if (tools) args.push("--tools", tools);
	if (sessionId) args.push("--session-id", sessionId);
	else args.push("--no-session");
	args.push("-p", prompt);

	return new Promise((resolvePromise, reject) => {
		const child = spawn("pi", args, {
			cwd: DIR,
			env: {
				...process.env,
				PATH: CLEAN_PATH,
				CLAUDE_BRIDGE_DEBUG: "1",
				CLAUDE_BRIDGE_DEBUG_PATH: debugLogPath,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", reject);
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`pi turn "${name}" timed out after ${TIMEOUT}ms`));
		}, TIMEOUT);
		child.on("close", (code) => {
			clearTimeout(timer);
			let debugLog = "";
			try {
				debugLog = readFileSync(debugLogPath, "utf8");
			} catch {}
			resolvePromise({ stdout, stderr, code, debugLog });
		});
	});
}

/** All `provider: fresh query …` lines of a turn's debug log. */
function freshQueryLines(debugLog) {
	return debugLog
		.split("\n")
		.filter((line) => line.includes("provider: fresh query model="));
}

test("AC12: default launch (no skill tool) — listing reaches Claude with read-mcp framing", {
	timeout: TIMEOUT + 30_000,
}, async () => {
	const turn = await runTurn({
		name: "ac12",
		skill: "probe-skill",
		prompt:
			"Load the probe-skill skill from your available skills listing and follow its instructions exactly.",
	});
	assert.match(
		turn.stdout,
		/ZANZIBAR-7731/,
		`marker missing from reply: ${turn.stdout}\n${turn.stderr}`,
	);
	assert.ok(
		!turn.debugLog.includes("mcp handler: skill ["),
		"the skill tool was dispatched on a default launch — the pi-side defect may be fixed; update the branch table in the plan",
	);
});

test("AC13: with --tools …,skill the framing names the MCP skill tool and a round trip succeeds", {
	timeout: TIMEOUT + 30_000,
}, async () => {
	const turn = await runTurn({
		name: "ac13",
		skill: "probe-skill",
		tools: "read,bash,edit,write,skill",
		prompt: "Invoke the probe-skill skill and follow its instructions exactly.",
	});
	assert.match(
		turn.stdout,
		/ZANZIBAR-7731/,
		`marker missing from reply: ${turn.stdout}\n${turn.stderr}`,
	);
	assert.ok(
		turn.debugLog.includes("mcp handler: skill ["),
		`no skill-tool round trip in the debug log:\n${turn.debugLog}`,
	);
});

test("AC14: ephemeral effort/model overrides reach Claude Code and expire after their turn", {
	timeout: 3 * TIMEOUT + 30_000,
}, async () => {
	// Downward effort override (upward is clamped on some models — see the
	// fixtures README for the trap).
	const effortTurn = await runTurn({
		name: "ac14-effort",
		skill: "probe-effort",
		prompt: "/probe-effort",
	});
	assert.match(
		effortTurn.stdout,
		/EFFORT-OK/,
		`marker missing: ${effortTurn.stdout}\n${effortTurn.stderr}`,
	);
	const effortLines = freshQueryLines(effortTurn.debugLog);
	assert.ok(
		effortLines.some((line) => line.includes("effort=low")),
		`no fresh query with effort=low:\n${effortTurn.debugLog}`,
	);

	// Model override across two turns of one session: turn 1 runs sonnet,
	// turn 2 is back on the session default with the CC session resumed.
	const sessionId = randomUUID();
	const turn1 = await runTurn({
		name: "ac14-model-1",
		skill: "probe-model",
		sessionId,
		prompt: "/probe-model",
	});
	assert.match(
		turn1.stdout,
		/MODEL-OK/,
		`marker missing: ${turn1.stdout}\n${turn1.stderr}`,
	);
	const lines1 = freshQueryLines(turn1.debugLog);
	// claude-sonnet-5 is long-context, so the id carries a [1m] suffix —
	// substring match, never equality (fixtures README).
	assert.ok(
		lines1.some((line) => line.includes("model=claude-sonnet-5")),
		`turn 1 did not run the override model:\n${turn1.debugLog}`,
	);

	const turn2 = await runTurn({
		name: "ac14-model-2",
		skill: "probe-model",
		sessionId,
		prompt: "Reply with just: OK",
	});
	const lines2 = freshQueryLines(turn2.debugLog);
	assert.ok(
		lines2.length > 0,
		`turn 2 produced no fresh query line:\n${turn2.debugLog}`,
	);
	assert.ok(
		lines2.some((line) => line.includes("model=claude-haiku-4-5")),
		`turn 2 did not return to the session default (override leaked?):\n${lines2.join("\n")}`,
	);
	assert.ok(
		lines2.every((line) => !line.includes("resume=none")),
		`turn 2 did not resume the CC session:\n${lines2.join("\n")}`,
	);
});

test("AC15: a skill naming a non-bridge provider routes off-bridge, and the next bridge turn rebuilds", {
	timeout: 2 * TIMEOUT + 30_000,
}, async (t) => {
	const sessionId = randomUUID();
	const turn1 = await runTurn({
		name: "ac15-xprov-1",
		skill: "probe-xprovider",
		sessionId,
		prompt: "/probe-xprovider",
	});
	if (
		/not logged in|could not resolve authentication|no models? found|unknown model|please run \/login/i.test(
			turn1.stdout + turn1.stderr,
		)
	) {
		t.skip(
			"no authenticated non-bridge provider for gpt-5.4-mini in this environment",
		);
		return;
	}
	assert.match(
		turn1.stdout,
		/XPROV-MARKER-4412/,
		`foreign-provider turn failed for a non-auth reason: ${turn1.stdout}\n${turn1.stderr}`,
	);
	assert.equal(
		freshQueryLines(turn1.debugLog).length,
		0,
		`turn 1 reached the bridge despite model: gpt-5.4-mini:\n${turn1.debugLog}`,
	);

	const turn2 = await runTurn({
		name: "ac15-xprov-2",
		skill: "probe-xprovider",
		sessionId,
		prompt:
			"What marker did the previous turn's probe reply with? Reply with just the marker.",
	});
	assert.match(
		turn2.stdout,
		/XPROV-MARKER-4412/,
		`turn 2 did not recall the foreign turn's marker: ${turn2.stdout}\n${turn2.stderr}`,
	);
	assert.ok(
		turn2.debugLog.includes("syncResult: path=rebuild"),
		`turn 2 did not take the rebuild path after a foreign-provider turn:\n${turn2.debugLog}`,
	);
});
