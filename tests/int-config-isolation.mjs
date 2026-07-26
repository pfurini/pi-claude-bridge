#!/usr/bin/env node

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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionPath } from "cc-session-io";
import { defaultClaudeConfigDir } from "../src/claude-config.js";
import { assertClaudeAuthenticated } from "./lib/claude-auth.mjs";
import { createRpcHarness, requireEnv } from "./lib/rpc-harness.mjs";

const OTHER_PROVIDER = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_PROVIDER");
const OTHER_MODEL = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_MODEL");
const TIMEOUT = 180_000;
const TEST_ROOT_PREFIX = join(tmpdir(), "pi-claude-bridge-config-isolation-");
const TEST_ROOT = mkdtempSync(TEST_ROOT_PREFIX);
const TEST_CWD = join(TEST_ROOT, "project");
const INHERITED_PROFILE = join(TEST_ROOT, "inherited-profile");
const CONFIGURED_PROFILE = defaultClaudeConfigDir();
const NORMAL_PROFILE = join(homedir(), ".claude");

mkdirSync(join(TEST_CWD, ".pi"), { recursive: true });
writeFileSync(
	join(TEST_CWD, ".pi", "claude-bridge.json"),
	JSON.stringify({ provider: { claudeConfigDir: CONFIGURED_PROFILE } }),
);

const harness = createRpcHarness({
	name: "config-isolation",
	args: ["--model", `${OTHER_PROVIDER}/${OTHER_MODEL}`],
	cwd: TEST_CWD,
	env: { CLAUDE_CONFIG_DIR: INHERITED_PROFILE },
	defaultTimeout: TIMEOUT,
});

describe("authenticated Claude config isolation", () => {
	before(async () => {
		assertClaudeAuthenticated(CONFIGURED_PROFILE);
		await harness.startAndWait();
	});

	after(async () => {
		await harness.stop();
		if (
			TEST_ROOT.startsWith(TEST_ROOT_PREFIX) &&
			TEST_ROOT.length > TEST_ROOT_PREFIX.length
		) {
			rmSync(TEST_ROOT, { recursive: true, force: true });
		}
		console.log(`  RPC log: ${harness.RPC_LOG}`);
		console.log(`  Debug log: ${harness.DEBUG_LOG}`);
	});

	it("uses the configured profile for seeded sessions and continuity", {
		timeout: TIMEOUT,
	}, async () => {
		const token = `isolation-${Math.random().toString(36).slice(2, 10)}`;
		await harness.promptAndWait(
			`Remember the exact token ${token}. Reply with exactly RECORDED.`,
			TIMEOUT,
		);

		await harness.send({
			type: "set_model",
			provider: "claude-bridge",
			modelId: "claude-haiku-4-5",
		});
		const first = await harness.promptAndWait(
			"What exact token did I ask you to remember? Reply with only the token.",
			TIMEOUT,
		);
		assert.match(first, new RegExp(token));

		const second = await harness.promptAndWait(
			"Repeat that exact token once more and nothing else.",
			TIMEOUT,
		);
		assert.match(second, new RegExp(token));

		const debugLog = readFileSync(harness.DEBUG_LOG, "utf8");
		assert.ok(
			debugLog.includes(`claudeConfigDir=${CONFIGURED_PROFILE}`),
			`debug log did not report configured profile ${CONFIGURED_PROFILE}`,
		);
		const seeded = debugLog.match(
			/syncResult: path=rebuild sessionId=([a-f0-9-]+) priors=\d+ first/,
		);
		assert.ok(
			seeded,
			"expected the provider switch to seed a shared Claude session",
		);
		const sessionId = seeded[1];
		const configuredPath = getSessionPath(
			sessionId,
			TEST_CWD,
			CONFIGURED_PROFILE,
		);
		const inheritedPath = getSessionPath(
			sessionId,
			TEST_CWD,
			INHERITED_PROFILE,
		);
		const normalPath = getSessionPath(sessionId, TEST_CWD, NORMAL_PROFILE);

		assert.equal(
			existsSync(configuredPath),
			true,
			`missing configured session ${configuredPath}`,
		);
		assert.equal(
			existsSync(inheritedPath),
			false,
			`inherited profile was used: ${inheritedPath}`,
		);
		assert.equal(
			existsSync(normalPath),
			false,
			`normal Claude profile was used: ${normalPath}`,
		);
		assert.match(debugLog, /syncResult: path=reuse sessionId=/);
	});
});
