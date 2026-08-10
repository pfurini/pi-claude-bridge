/**
 * Regression tests for syncSharedSession's session reuse decisions.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, deleteSession, getSessionPath, openSession } from "cc-session-io";

const { __test } = await import("../src/index.js");

// Prior history plus a current user turn. The trailing user message is the
// current turn (turnStart() excludes it from the priors), so the assistant
// message in between is what makes the priors non-empty and forces the
// REBUILD path these tests exercise — an all-user context is a clean start.
function contextMessages(suffix = "") {
	const now = Date.now();
	return [
		{ role: "user", content: `Remember isolated session ${suffix}`, timestamp: now },
		{ role: "assistant", content: [{ type: "text", text: `Acknowledged ${suffix}` }], timestamp: now + 1 },
		{ role: "user", content: `Continue isolated session ${suffix}`, timestamp: now + 2 },
	];
}

describe("syncSharedSession", () => {
	afterEach(() => {
		__test.resetSharedSession();
		__test.setPiUI(null);
	});

	// The branch this exercises is the guard that stops a reentrant subagent from
	// resuming — and then overwriting — the parent's session: a subagent's context
	// is shorter than the parent's cursor, so it starts fresh and the parent's
	// session is preserved. It was previously described here as the compact-summary
	// path, which cannot reach syncSharedSession at all, so the branch read as
	// covered for a case that never happens.
	it("starts a fresh session for a shorter context and preserves the parent's", () => {
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
			], cwd, join(cwd, "isolated-claude"));

			assert.equal(
				result.sessionId,
				null,
				"a context shorter than the cursor — a subagent, or AskClaude — must start a fresh Claude Code session instead of resuming the parent's",
			);
			assert.equal(
				result.preserveSharedSession,
				true,
				"the fresh session must not replace the parent's when it completes",
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
			const result = __test.syncSharedSession(contextMessages("first"), cwd, claudeConfigDir, undefined, "test-model");
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
			const first = __test.syncSharedSession(contextMessages("rebuild"), cwd, claudeConfigDir, undefined, "test-model");
			__test.setSharedSession({ ...__test.getSharedSession(), needsRebuild: true });
			const rebuilt = __test.syncSharedSession(contextMessages("rebuild"), cwd, claudeConfigDir, undefined, "test-model");
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
			const rotated = __test.syncSharedSession(contextMessages("abort"), cwd, claudeConfigDir, undefined, "test-model");
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
			const result = __test.syncSharedSession(contextMessages("ephemeral"), cwd, claudeConfigDir, undefined, "test-model");
			const jsonlPath = getSessionPath(result.sessionId, cwd, claudeConfigDir);
			assert.equal(existsSync(jsonlPath), true);
			__test.deleteEphemeralSession(result.sessionId, cwd, claudeConfigDir);
			assert.equal(existsSync(jsonlPath), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// The rebuilt file holds one line per record, and a carried `@file` expansion
	// is an `attachment` record — which `session.messages` filters out. Counting
	// messages told every user who at-mentioned a file before switching providers
	// that their session was corrupt, and asked them to open an issue about it.
	it("does not report a count mismatch when a rebuild carries an attachment", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const sessionId = randomUUID();
		const prompt = "Review @fixture.txt and remember it.";
		const notices = [];
		try {
			const seeded = createSession({ sessionId, projectPath: cwd });
			seeded.importMessages(
				[
					{ role: "user", content: prompt },
					{ role: "assistant", content: [{ type: "text", text: "Noted." }] },
				],
				{
					attachments: [{
						afterIndex: 0,
						attachment: {
							type: "file",
							filename: join(cwd, "fixture.txt"),
							content: { type: "text", file: { filePath: join(cwd, "fixture.txt"), content: "token" } },
						},
					}],
				},
			);
			seeded.save();

			__test.setSharedSession({ sessionId, cursor: 0, cwd });
			__test.setPiUI({ notify: (message) => notices.push(message) });
			__test.syncSharedSession([
				{ role: "user", content: prompt, timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "Noted." }], timestamp: Date.now() },
				{ role: "user", content: "Now what did it say?", timestamp: Date.now() },
			], cwd);

			assert.equal(
				openSession({ sessionId, projectPath: cwd }).attachments.length,
				1,
				"the rebuild did not carry the attachment, so this proves nothing about the count",
			);
			assert.deepEqual(notices, []);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// Regression: attachments must be read from the threaded claudeConfigDir, not
	// process.env.CLAUDE_CONFIG_DIR. Under config isolation the session lives in the
	// explicit profile; reading the process env looked in the wrong one and silently
	// dropped the carried @file across a rebuild. The env is pointed at a different,
	// empty profile here so the pre-fix behaviour would carry nothing.
	it("carries an attachment from the explicit profile, ignoring process.env.CLAUDE_CONFIG_DIR", () => {
		const root = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const cwd = join(root, "project");
		const claudeConfigDir = join(root, "isolated-claude");
		const sessionId = randomUUID();
		const prompt = "Review @fixture.txt and remember it.";
		const notices = [];
		const prevEnv = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = join(root, "process-env-claude");
		try {
			const seeded = createSession({ sessionId, projectPath: cwd, claudeDir: claudeConfigDir });
			seeded.importMessages(
				[
					{ role: "user", content: prompt },
					{ role: "assistant", content: [{ type: "text", text: "Noted." }] },
				],
				{
					attachments: [{
						afterIndex: 0,
						attachment: {
							type: "file",
							filename: join(cwd, "fixture.txt"),
							content: { type: "text", file: { filePath: join(cwd, "fixture.txt"), content: "token" } },
						},
					}],
				},
			);
			seeded.save();

			__test.setSharedSession({ sessionId, cursor: 0, cwd });
			__test.setPiUI({ notify: (message) => notices.push(message) });
			__test.syncSharedSession([
				{ role: "user", content: prompt, timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "Noted." }], timestamp: Date.now() },
				{ role: "user", content: "Now what did it say?", timestamp: Date.now() },
			], cwd, claudeConfigDir);

			assert.equal(
				openSession({ sessionId, projectPath: cwd, claudeDir: claudeConfigDir }).attachments.length,
				1,
				"the rebuild dropped the attachment — readCarriedAttachments read the wrong profile",
			);
			assert.deepEqual(notices, []);
		} finally {
			if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = prevEnv;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
