/**
 * Regression tests for syncSharedSession's session reuse decisions.
 */
import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionPath } from "cc-session-io";

const debugDir = mkdtempSync(join(tmpdir(), "sync-shared-session-debug-"));
process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(debugDir, "claude-bridge.log");

const { __test } = await import("../src/index.js");

function contextMessages(suffix = "") {
	const now = Date.now();
	return [
		{ role: "user", content: `Remember isolated session ${suffix}`, timestamp: now },
		{ role: "user", content: `Continue isolated session ${suffix}`, timestamp: now + 1 },
	];
}

describe("syncSharedSession", () => {
	after(() => {
		rmSync(debugDir, { recursive: true, force: true });
	});

	afterEach(() => {
		__test.resetSharedSession();
	});

	it("does not reuse a cached main session for a shorter synthetic compact context", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		try {
			const mainSession = {
				sessionId: "11111111-1111-4111-8111-111111111111",
				cursor: 42,
				cwd,
			};
			__test.setSharedSession(mainSession);

			const result = __test.syncSharedSession([
				{
					role: "user",
					content: "Summarize this conversation.",
					timestamp: Date.now(),
				},
			], cwd, undefined, undefined, join(cwd, "isolated-claude"));

			assert.equal(
				result.sessionId,
				null,
				"synthetic compact contexts have no prior messages and must start a fresh Claude Code session instead of resuming the main session",
			);
			assert.equal(
				result.preserveSharedSession,
				true,
				"the fresh synthetic Claude Code session must not replace the cached main session when it completes",
			);
			assert.deepEqual(__test.getSharedSession(), mainSession);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("creates the first seeded session beneath the explicit profile", () => {
		const root = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const cwd = join(root, "project");
		const claudeConfigDir = join(root, "isolated-claude");
		try {
			const result = __test.syncSharedSession(contextMessages("first"), cwd, undefined, "test-model", claudeConfigDir);
			const jsonlPath = getSessionPath(result.sessionId, cwd, claudeConfigDir);
			assert.equal(existsSync(jsonlPath), true);
			assert.equal(jsonlPath.startsWith(claudeConfigDir), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rebuilds in the explicit profile while preserving the session ID", () => {
		const root = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const cwd = join(root, "project");
		const claudeConfigDir = join(root, "isolated-claude");
		try {
			const first = __test.syncSharedSession(contextMessages("rebuild"), cwd, undefined, "test-model", claudeConfigDir);
			__test.setSharedSession({ ...__test.getSharedSession(), needsRebuild: true });
			const rebuilt = __test.syncSharedSession(contextMessages("rebuild"), cwd, undefined, "test-model", claudeConfigDir);
			assert.equal(rebuilt.sessionId, first.sessionId);
			assert.equal(existsSync(getSessionPath(rebuilt.sessionId, cwd, claudeConfigDir)), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rotates post-abort sessions inside the explicit profile", () => {
		const root = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const cwd = join(root, "project");
		const claudeConfigDir = join(root, "isolated-claude");
		const previousSessionId = "22222222-2222-4222-8222-222222222222";
		try {
			__test.setSharedSession({
				sessionId: previousSessionId,
				cursor: 1,
				cwd,
				needsRebuild: true,
				forceRotate: true,
			});
			const rotated = __test.syncSharedSession(contextMessages("abort"), cwd, undefined, "test-model", claudeConfigDir);
			assert.notEqual(rotated.sessionId, previousSessionId);
			assert.equal(existsSync(getSessionPath(rotated.sessionId, cwd, claudeConfigDir)), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("deletes ephemeral synthetic sessions from the explicit profile", () => {
		const root = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const cwd = join(root, "project");
		const claudeConfigDir = join(root, "isolated-claude");
		try {
			const result = __test.syncSharedSession(contextMessages("ephemeral"), cwd, undefined, "test-model", claudeConfigDir);
			const jsonlPath = getSessionPath(result.sessionId, cwd, claudeConfigDir);
			assert.equal(existsSync(jsonlPath), true);
			__test.deleteEphemeralSession(result.sessionId, cwd, claudeConfigDir);
			assert.equal(existsSync(jsonlPath), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
