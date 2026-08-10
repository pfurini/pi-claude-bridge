#!/usr/bin/env node
// Regression for subagents on claude-bridge models 400ing with "You're out of
// extra usage": pi-subagents' `prompt_mode: "append"` (the default for
// built-in agents) embeds the parent's entire pi system prompt -- including
// pi's own `buildSystemPrompt` skeleton -- into the subagent's forwarded
// system prompt, and Claude Code's OAuth enforcement routes any request whose
// system prompt carries that skeleton to metered usage. See
// plans/subagent-prompt-sanitize.md for the root-cause writeup.
//
// This only reproduces when the SUBAGENT session itself loads the bridge
// extension (a real agent dir with `packages` in settings.json), which is why
// this test seeds settings.json with `packages: [DIR]` rather than relying on
// the harness's own `-e DIR` flag (that only loads the bridge for the parent
// CLI process; a subagent session without the bridge bound never captures a
// customPrompt at all).
//
// The success assertion is end-to-end but rides on Anthropic's *current*
// enforcement of this signature, which the bridge does not control and could
// change independently. The debug-marker assertion (sanitizeHarnessPrompt
// stripped harness boilerplate) is the durable pin of bridge behavior and
// holds regardless of what Anthropic does with the resulting request.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PARENT_MODEL = "claude-bridge/claude-haiku-4-5";
const SUBAGENT_MODEL = "claude-bridge/claude-fable-5";
const TEST_TIMEOUT = 240_000;
const SUBAGENTS_SOURCE = "npm:@tintinweb/pi-subagents@0.14.3";
const SANITIZE_MARKER =
	/provider: sanitizeHarnessPrompt stripped harness boilerplate/;

const testAgentDir = mkdtempSync(join(tmpdir(), "subagent-fable-plan-agent-"));
writeFileSync(
	join(testAgentDir, "claude-bridge.json"),
	JSON.stringify({ provider: { plan: "max" } }),
);
// packages (not the harness's own `-e DIR`) is what makes the *subagent*
// session bind the bridge — the condition that distinguishes this repro from
// a passing temp-agent-dir run with no packages configured.
writeFileSync(
	join(testAgentDir, "settings.json"),
	JSON.stringify({ packages: [DIR] }),
);

const harness = createRpcHarness({
	name: "subagent-fable-plan",
	args: ["-e", SUBAGENTS_SOURCE, "--model", PARENT_MODEL],
	env: { PI_CODING_AGENT_DIR: testAgentDir },
	defaultTimeout: TEST_TIMEOUT,
});
const { startAndWait, stop, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

await startAndWait(5000);
try {
	const text = await promptAndWait(
		`Use the Agent tool exactly once.

Call it with:
- subagent_type: general-purpose
- description: fable plan subagent
- model: ${SUBAGENT_MODEL}
- max_turns: 2
- prompt: Reply with exactly the word ok and nothing else.

After the Agent tool returns, reply with exactly: DONE <the agent's reply or error>`,
		TEST_TIMEOUT,
	);

	if (!/^DONE\b/.test(text.trim())) {
		throw new Error(
			`parent did not report Agent completion. Text: ${text.slice(0, 500)}`,
		);
	}
	if (/out of extra usage|API Error: 400/i.test(text)) {
		throw new Error(
			`subagent call failed with an extra-usage/400 error: ${text.slice(0, 500)}`,
		);
	}

	const log = readFileSync(DEBUG_LOG, "utf8");
	if (!SANITIZE_MARKER.test(log)) {
		throw new Error(
			`debug log never showed the sanitizer's strip marker (${SANITIZE_MARKER}).\n\nExcerpt:\n${log.slice(-3000)}`,
		);
	}

	console.log("PASS");
} catch (err) {
	process.exitCode = 1;
	console.log(`FAIL: ${err.message}\n${err.stack}`);
	console.log(`  RPC log:    ${RPC_LOG}`);
	console.log(`  Debug log:  ${DEBUG_LOG}`);
	try {
		console.log(
			`  Debug tail:\n${readFileSync(DEBUG_LOG, "utf8").slice(-6000)}`,
		);
	} catch {}
} finally {
	await stop();
	rmSync(testAgentDir, { recursive: true, force: true });
}
