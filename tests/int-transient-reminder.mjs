#!/usr/bin/env node
// The Pi fork's tasks `context` hook appends a reminder to one provider request only;
// Pi never persists it. Before the 2026-10-01 fix the bridge recorded the reminder as
// history, and the next tool-result delivery retired the live Claude Code query and
// rebuilt it under a recovery prompt (diag: query_restart_threshold in long sessions).
//
// One task stays in progress while the model runs single-command bash turns, so the
// reminder becomes due mid-turn (ACTIVE_REMINDER_INTERVAL = 2). The test asserts the
// reminder reached Claude Code as a steer, and that no query restarted.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultClaudeConfigDir } from "../src/claude-config.js";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 240_000;

const agentDir = mkdtempSync(join(tmpdir(), "bridge-transient-reminder-agent-"));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ startupNoticeShown: "test", provider: { usageEvents: false, claudeConfigDir: defaultClaudeConfigDir() } }));
const harness = createRpcHarness({
	name: "transient-reminder",
	args: ["--model", "claude-bridge/claude-haiku-4-5"],
	env: { PI_CODING_AGENT_DIR: agentDir },
	defaultTimeout: TIMEOUT,
});

describe("transient context-hook messages", () => {
	before(async () => { await harness.startAndWait(); });
	after(async () => { await harness.stop(); });

	it("keeps the live query when the tasks reminder rides on one delivery", { timeout: TIMEOUT }, async () => {
		const steps = ["one", "two", "three", "four", "five", "six"];
		const text = await harness.promptAndWait(
			"Do exactly this, one tool call per message, with no parallel calls:\n" +
			"1. Call TaskCreate with subject \"probe reminder\" and description \"live check\".\n" +
			"2. Call TaskUpdate to set that task's status to in_progress.\n" +
			steps.map((step, index) => `${index + 3}. Run the bash command \`echo step-${step}\`.`).join("\n") +
			"\nDo not call any task tool after step 2. When every command has run, reply with exactly ALL-DONE.",
			TIMEOUT,
		);
		const log = readFileSync(harness.DEBUG_LOG, "utf8");
		const steers = log.split("\n").filter((line) => line.includes("steer written to CC stdin"));
		assert.ok(steers.some((line) => line.includes("<system-reminder>")),
			`the tasks reminder never reached Claude Code, so this run proves nothing:\n${steers.join("\n")}`);
		assert.doesNotMatch(log, /provider: restarting query/, "a transient reminder retired the live query");
		assert.match(text, /ALL-DONE/);
		for (const step of steps) assert.match(log, new RegExp(`step-${step}`), `the model skipped step-${step}`);
	});
});
