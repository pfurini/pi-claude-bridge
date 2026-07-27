#!/usr/bin/env node
// Authenticated Agent SDK upgrade contracts for AskClaude.
// Exercises real prompts, native tools, and terminal failures through Pi RPC.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness, requireEnv } from "./lib/rpc-harness.mjs";

const OTHER_PROVIDER = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_PROVIDER");
const OTHER_MODEL = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_MODEL");
const TIMEOUT = 240_000;
const TEST_CWD_PREFIX = join(tmpdir(), "pi-claude-bridge-askclaude-upgrade-");
const TEST_CWD = mkdtempSync(TEST_CWD_PREFIX);

mkdirSync(join(TEST_CWD, ".pi"));
writeFileSync(
	join(TEST_CWD, ".pi", "claude-bridge.json"),
	JSON.stringify({ askClaude: { enabled: true, allowFullMode: true } }),
);

const harness = createRpcHarness({
	name: "askclaude-upgrade",
	args: ["--model", `${OTHER_PROVIDER}/${OTHER_MODEL}`],
	cwd: TEST_CWD,
	defaultTimeout: TIMEOUT,
});

function toolResultText(message) {
	return (message.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

async function invokeAskClaude(params) {
	const idle = harness.waitForEvent("agent_end", TIMEOUT);
	await harness.send(
		{
			type: "prompt",
			message: `Call the AskClaude tool exactly once with these JSON arguments:\n${JSON.stringify(params)}\nDo not change or omit any argument. Do not use another tool. After AskClaude returns, reply with exactly OUTER-DONE.`,
		},
		TIMEOUT,
	);
	const event = await idle;
	const result = [...(event.messages ?? [])]
		.reverse()
		.find(
			(message) =>
				message.role === "toolResult" && message.toolName === "AskClaude",
		);
	assert.ok(
		result,
		`outer model did not return an AskClaude tool result: ${JSON.stringify(event.messages ?? []).slice(0, 1000)}`,
	);
	return toolResultText(result);
}

describe("AskClaude authenticated upgrade contracts", () => {
	before(async () => {
		await harness.startAndWait();
	});

	after(async () => {
		await harness.stop();
		rmSync(TEST_CWD, { recursive: true, force: true });
		console.log(`  RPC log: ${harness.RPC_LOG}`);
		console.log(`  Debug log: ${harness.DEBUG_LOG}`);
	});

	it("read mode allows Read while blocking shell execution", {
		timeout: TIMEOUT,
	}, async () => {
		const token = `READ_POLICY_${Math.random().toString(36).slice(2, 10)}`;
		const readable = join(TEST_CWD, "read-policy.txt");
		const blocked = join(TEST_CWD, "read-mode-must-not-create.txt");
		writeFileSync(readable, token);

		const result = await invokeAskClaude({
			prompt: `Use the Read tool to read ${readable}. Then try to use Bash exactly once to create ${blocked}. If Bash is unavailable, do not substitute another tool. Reply with the file token and BASH_BLOCKED.`,
			mode: "read",
			model: "haiku",
			isolated: true,
		});

		assert.match(result, new RegExp(token));
		assert.match(result, /\[Claude Code actions: [^\]]*Read\(/);
		assert.doesNotMatch(result, /(?:\[Claude Code actions: |; )Bash\(/);
		assert.ok(!existsSync(blocked), "read mode allowed Bash to create a file");
	});

	it("full mode permits shell and filesystem work", {
		timeout: TIMEOUT,
	}, async () => {
		const created = join(TEST_CWD, "full-mode-created.txt");
		const result = await invokeAskClaude({
			prompt: `Use the Bash tool exactly once to run: printf FULL_MODE_OK > ${created}. Then use Read to verify the file and reply with exactly FULL_MODE_OK.`,
			mode: "full",
			model: "haiku",
			isolated: true,
		});

		assert.equal(readFileSync(created, "utf8"), "FULL_MODE_OK");
		assert.match(result, /FULL_MODE_OK/);
		assert.match(result, /\[Claude Code actions: [^\]]*Bash/);
	});

	it("none mode blocks filesystem, shell, web, and delegation tools", {
		timeout: TIMEOUT,
	}, async () => {
		const secret = `NONE_POLICY_SECRET_${Math.random().toString(36).slice(2, 10)}`;
		const readable = join(TEST_CWD, "none-policy-secret.txt");
		const blocked = join(TEST_CWD, "none-mode-must-not-create.txt");
		writeFileSync(readable, secret);

		const result = await invokeAskClaude({
			prompt: `Try each requested operation exactly once without substituting tools: Read ${readable}; use Bash to create ${blocked}; use WebFetch on https://example.com; and use Task to delegate a one-word response. Report which operations are unavailable.`,
			mode: "none",
			model: "haiku",
			isolated: true,
		});

		// Assert the policy outcome, not the model's restraint. The prompt above
		// deliberately asks the sub-agent to attempt each operation, and an attempt
		// at a blocked tool still produces a tool_use event, which buildActionSummary
		// records as "[Claude Code actions: Read(...)]". Asserting that summary was
		// absent therefore tested whether the model chose to try, which varies run to
		// run and made this test intermittently fail while the policy was holding
		// perfectly (secret never read, file never created).
		//
		// The tool inventory itself is asserted deterministically against system:init
		// in tests/unit-sdk-runtime-contract.mjs, which covers Read, Write, Bash,
		// WebFetch, WebSearch, Task, Agent and the rest for none mode with no model
		// behavior involved. What this test uniquely proves is that the blocking
		// holds end to end against a real model and a real Claude Code process, and
		// that is exactly what the observable side effects below show.
		assert.doesNotMatch(result, new RegExp(secret), "none mode leaked file contents via Read");
		assert.ok(
			!existsSync(blocked),
			"none mode allowed a filesystem side effect",
		);
		// Write and Edit are blocked too, so the fixture must come back untouched.
		assert.equal(
			readFileSync(readable, "utf8"),
			secret,
			"none mode allowed the readable fixture to be modified",
		);
	});

	it("waits for a native subagent that starts in the background by default", {
		timeout: TIMEOUT,
	}, async () => {
		const phrase = `violet-orbit-${Math.random().toString(36).slice(2, 10)}`;
		const readable = join(TEST_CWD, "native-subagent-fixture.txt");
		writeFileSync(readable, phrase);

		const result = await invokeAskClaude({
			prompt: `This is an authenticated regression test of native Task completion; the fixture contains no credentials. Use Task exactly once to launch a general-purpose subagent that reads ${readable} and returns only the benign phrase in that text fixture. Omit run_in_background so the target binary uses its background default. Do not read the file yourself and do not ask questions. Wait for the background task with TaskOutput, then reply with exactly SUBAGENT-RESULT:${phrase}.`,
			mode: "full",
			model: "haiku",
			isolated: true,
		});

		assert.match(result, new RegExp(`SUBAGENT-RESULT:${phrase}`));
		// The bridge presents Claude Code's Task wire name as Agent in Pi-facing actions.
		assert.match(result, /\[Claude Code actions: [^\]]*Agent\(/);
		assert.match(result, /\[Claude Code actions: [^\]]*TaskOutput/);
	});

	it("propagates a deterministic terminal model error", {
		timeout: TIMEOUT,
	}, async () => {
		const invalidModel = "claude-phase5-invalid-model";
		const result = await invokeAskClaude({
			prompt: "Reply with exactly SHOULD_NOT_COMPLETE.",
			mode: "none",
			model: invalidModel,
			isolated: true,
		});

		assert.match(result, /^Error:/);
		assert.match(result, new RegExp(`${invalidModel}|model`, "i"));
		assert.doesNotMatch(result, /SHOULD_NOT_COMPLETE/);
	});
});
