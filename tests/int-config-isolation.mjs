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
import { createRpcHarness, requireEnv } from "./lib/rpc-harness.mjs";

const OTHER_PROVIDER = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_PROVIDER");
const OTHER_MODEL = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_MODEL");
const TIMEOUT = 180_000;
const TEST_ROOT_PREFIX = join(tmpdir(), "pi-claude-bridge-config-isolation-");
const TEST_ROOT = mkdtempSync(TEST_ROOT_PREFIX);
const TEST_CWD = join(TEST_ROOT, "project");
const INHERITED_PROFILE = join(TEST_ROOT, "inherited-profile");
// Deliberately the default profile: credentials are scoped to the literal config-dir
// path (a symlink to an authenticated profile reads as logged out), so a second
// profile would need its own interactive `claude auth login` that CI cannot perform.
// This test therefore discriminates env-inheritance isolation (an inherited
// CLAUDE_CONFIG_DIR and the normal ~/.claude profile both stay untouched) and NOT the
// provider.claudeConfigDir plumbing: were that plumbing dropped entirely, sessions
// would still land here and every assertion below would still pass. That plumbing is
// covered at both ends by unit-config.mjs (config merge and fallback) and
// unit-sdk-options.mjs (claudeConfigDir reaching the child as CLAUDE_CONFIG_DIR).
// The project config written below is realistic but non-discriminating today.
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
	claudeConfigDir: CONFIGURED_PROFILE,
	defaultTimeout: TIMEOUT,
});

describe("authenticated Claude config isolation", () => {
	before(async () => {
		// The harness preflights CONFIGURED_PROFILE's auth on start().
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

	it("keeps seeded sessions and continuity out of the inherited and normal profiles", {
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
