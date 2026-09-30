import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, getSessionPath, openSession } from "cc-session-io";
import { __test } from "../src/index.js";

const messages = [
	{ role: "user", content: "Review @fixture.txt", timestamp: 1 },
	{ role: "assistant", content: [{ type: "text", text: "Noted." }], timestamp: 2 },
	{ role: "user", content: "Continue", timestamp: 3 },
];
function fixture(run) {
	const root = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
	const cwd = join(root, "project"), profile = join(root, "claude");
	const sync = (history = messages, ownership = {}) => __test.syncSharedSession(history, cwd, profile, undefined, "test-model", ownership);
	const path = id => getSessionPath(id, cwd, profile);
	try { __test.resetSharedSession(); run({ root, cwd, profile, sync, path }); }
	finally { __test.resetSharedSession(); __test.setPiUI(null); rmSync(root, { recursive: true, force: true }); }
}

it("takes a clean start when prompt state precedes the first user", () => fixture(({ sync }) => {
	const result = sync([{ role: "system", content: "Instructions", timestamp: 0 }, messages[0]]);
	assert.equal(result.sessionId, null);
	assert.equal(result.preserveSharedSession, undefined);
	assert.equal(__test.getSharedSession(), null);
}));

it("ignores system messages in cursor arithmetic and reuses a valid accounting baseline", () => fixture(({ sync, path }) => {
	const first = sync();
	assert.ok(first.accounting.snapshot, "a fresh import supplies a zero cumulative baseline");
	const before = readFileSync(path(first.sessionId), "utf8");
	const next = sync([...messages.slice(0, 2), { role: "system", content: "", toolsAdded: [], timestamp: 2 }, messages[2]]);
	assert.equal(next.sessionId, first.sessionId);
	assert.equal(next.accounting, first.accounting, "reuse retains the accounting epoch rather than rebuilding at the same ID");
	assert.equal(__test.getSharedSession().cursor, 2);
	assert.equal(readFileSync(path(first.sessionId), "utf8"), before);
}));

it("rebuilds when the accounting baseline is missing", () => fixture(({ sync }) => {
	const first = sync();
	delete first.accounting.snapshot;
	const next = sync();
	assert.equal(next.sessionId, first.sessionId);
	assert.notEqual(next.accounting, first.accounting);
}));

it("preserves an anonymous mirror when a shorter caller starts clean", () => fixture(({ sync }) => {
	sync();
	const parent = __test.getSharedSession();
	const child = sync([messages[0]]);
	assert.equal(child.sessionId, null);
	assert.equal(child.preserveSharedSession, true);
	assert.equal(__test.getSharedSession(), parent);
}));

it("creates and rebuilds sessions beneath the explicit disposable profile", () => fixture(({ sync, path, profile }) => {
	const first = sync();
	assert.ok(path(first.sessionId).startsWith(profile));
	assert.ok(existsSync(path(first.sessionId)));
	__test.getSharedSession().needsRebuild = true;
	assert.equal(sync().sessionId, first.sessionId);
	assert.ok(existsSync(path(first.sessionId)));
}));

it("rotates post-abort sessions inside the explicit profile", () => fixture(({ sync, path }) => {
	const first = sync();
	Object.assign(__test.getSharedSession(), { needsRebuild: true, forceRotate: true });
	const next = sync();
	assert.notEqual(next.sessionId, first.sessionId);
	assert.ok(existsSync(path(next.sessionId)));
}));

it("deletes ephemeral synthetic sessions from the explicit profile", () => fixture(({ sync, path, cwd, profile }) => {
	const result = sync(messages, { preserveSharedSession: true });
	assert.ok(existsSync(path(result.sessionId)));
	__test.deleteEphemeralSession(result.sessionId, cwd, profile);
	assert.equal(existsSync(path(result.sessionId)), false);
}));

for (const foreignEnv of [false, true]) {
	it(`carries attachments without count warnings${foreignEnv ? " despite a foreign environment profile" : ""}`, () => fixture(({ root, sync, cwd, profile }) => {
		const first = sync();
		const session = createSession({ sessionId: first.sessionId, projectPath: cwd, claudeDir: profile });
		session.importMessages(messages.slice(0, 2), { attachments: [{ afterIndex: 0, attachment: {
			type: "file", filename: join(cwd, "fixture.txt"),
			content: { type: "text", file: { filePath: join(cwd, "fixture.txt"), content: "token" } },
		} }] });
		session.save();
		const notices = [];
		__test.setPiUI({ notify: message => notices.push(message) });
		__test.getSharedSession().needsRebuild = true;
		const previous = process.env.CLAUDE_CONFIG_DIR;
		try {
			if (foreignEnv) process.env.CLAUDE_CONFIG_DIR = join(root, "foreign-profile");
			sync();
			assert.equal(openSession({ sessionId: first.sessionId, projectPath: cwd, claudeDir: profile }).attachments.length, 1);
			assert.deepEqual(notices, []);
		} finally {
			if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = previous;
		}
	}));
}
