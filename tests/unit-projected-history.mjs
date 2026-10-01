import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "cc-session-io";
import { __test } from "../src/index.js";

it("replaces earlier imported content when Pi projects a same-length context edit", () => {
	const root = mkdtempSync(join(tmpdir(), "bridge-projected-history-"));
	const cwd = join(root, "workspace");
	const claudeConfigDir = join(root, "claude");
	const messages = [
		{ role: "user", content: "OLD_DATABASE_ENDPOINT", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "Acknowledged" }], timestamp: 2 },
		{ role: "user", content: "Continue", timestamp: 3 },
	];
	try {
		__test.resetSharedSession();
		const first = __test.syncSharedSession(messages, cwd, claudeConfigDir);
		const projected = [{ ...messages[0], content: "CURRENT_DATABASE_ENDPOINT" }, ...messages.slice(1)];
		const next = __test.syncSharedSession(projected, cwd, claudeConfigDir);
		assert.equal(next.sessionId, first.sessionId);
		const imported = JSON.stringify(openSession({ sessionId: next.sessionId, projectPath: cwd, claudeDir: claudeConfigDir }).messages);
		assert.ok(imported.includes("CURRENT_DATABASE_ENDPOINT"), "Claude Code must receive Pi's edited projection");
		assert.ok(!imported.includes("OLD_DATABASE_ENDPOINT"), "the replaced message must not remain in the resumed session");
	} finally {
		__test.resetSharedSession();
		rmSync(root, { recursive: true, force: true });
	}
});

function withFixture(run) {
	const root = mkdtempSync(join(tmpdir(), "bridge-history-contract-"));
	const cwd = join(root, "workspace");
	const profile = join(root, "claude");
	const messages = [
		{ role: "user", content: "REMOVE_OLD_PAIR", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "OLD_REPLY" }], timestamp: 2 },
		{ role: "user", content: "KEEP_CURRENT_PAIR", timestamp: 3 },
		{ role: "assistant", content: [{ type: "text", text: "CURRENT_REPLY" }], timestamp: 4 },
		{ role: "user", content: "Continue", timestamp: 5 },
	];
	const sync = (context, ownership = { piSessionId: "parent" }) => __test.syncSharedSession(context, cwd, profile, undefined, undefined, ownership);
	const stored = sessionId => JSON.stringify(openSession({ sessionId, projectPath: cwd, claudeDir: profile }).messages);
	try {
		__test.resetSharedSession();
		run({ messages, sync, stored });
	} finally {
		__test.resetSharedSession();
		rmSync(root, { recursive: true, force: true });
	}
}

it("rebuilds an omission in the same Pi session instead of treating it as a child", () => withFixture(({ messages, sync, stored }) => {
	const first = sync(messages);
	const next = sync(messages.slice(2));
	assert.equal(next.sessionId, first.sessionId);
	assert.equal(next.preserveSharedSession, undefined);
	assert.ok(!stored(next.sessionId).includes("REMOVE_OLD_PAIR"));
	assert.ok(stored(next.sessionId).includes("KEEP_CURRENT_PAIR"));
}));

it("imports child history separately without replacing an equally long parent", () => withFixture(({ messages, sync, stored }) => {
	const parent = sync(messages);
	const state = __test.getSharedSession("parent");
	const before = stored(parent.sessionId);
	const childMessages = [{ ...messages[0], content: "CHILD_ONLY" }, ...messages.slice(1)];
	const child = sync(childMessages, { piSessionId: "child" });
	assert.equal(child.preserveSharedSession, undefined);
	assert.notEqual(child.sessionId, parent.sessionId);
	assert.equal(__test.getSharedSession("parent"), state);
	assert.equal(__test.getSharedSession("child").sessionId, child.sessionId);
	assert.equal(stored(parent.sessionId), before);
	assert.ok(stored(child.sessionId).includes("CHILD_ONLY"));
}));

it("isolates a reentrant query even when the caller supplies the parent's session ID", () => withFixture(({ messages, sync }) => {
	const parent = sync(messages);
	const state = __test.getSharedSession("parent");
	const child = sync(messages, { piSessionId: "parent", preserveSharedSession: true });
	assert.equal(child.preserveSharedSession, true);
	assert.notEqual(child.sessionId, parent.sessionId);
	assert.equal(__test.getSharedSession("parent"), state);
}));

it("keeps request-only skill carry-forward content when rebuilding", () => withFixture(({ messages, sync, stored }) => {
	const carry = { role: "user", content: '<skill name="deploy">CARRY_FORWARD_RULE</skill>', timestamp: 0 };
	const initial = sync([carry, ...messages]);
	const edited = [{ ...carry, content: '<skill name="deploy">UPDATED_CARRY_RULE</skill>' }, ...messages];
	const next = sync(edited);
	assert.equal(next.sessionId, initial.sessionId);
	assert.ok(stored(next.sessionId).includes("UPDATED_CARRY_RULE"));
	assert.ok(!stored(next.sessionId).includes("CARRY_FORWARD_RULE"));
}));

it("does not trust a session that has no prefix snapshot", () => withFixture(({ messages, sync, stored }) => {
	const first = sync(messages);
	const state = __test.getSharedSession("parent");
	delete state.history;
	const edited = [{ ...messages[0], content: "REPLACED_WITHOUT_SNAPSHOT" }, ...messages.slice(1)];
	const next = sync(edited);
	assert.equal(next.sessionId, first.sessionId);
	assert.ok(stored(next.sessionId).includes("REPLACED_WITHOUT_SNAPSHOT"));
}));

it("retains unchanged prefixes when only timestamp or usage metadata differs", async () => {
	const { snapshotHistory, alignHistory } = await import("../src/session-history.js");
	const first = [{ role: "assistant", provider: "claude-bridge", content: [{ type: "text", text: "same" }], timestamp: 1 }];
	const second = [{ ...first[0], timestamp: 2, usage: { output: 9 } }];
	assert.deepEqual(snapshotHistory(first), snapshotHistory(second));
	assert.equal(alignHistory(undefined, snapshotHistory(second)), undefined);
	assert.equal(alignHistory(snapshotHistory(first), snapshotHistory(second)), 1);
	const details = {}; details.self = details;
	assert.doesNotThrow(() => snapshotHistory([{ role: "toolResult", toolCallId: "call", content: [], details, isError: false }]));
});

it("lets a trailing reminder drop out of the next projection, and nothing else", async () => {
	const { snapshotHistory, snapshotRequestHistory, alignHistory } = await import("../src/session-history.js");
	const prompt = { role: "user", content: "task", timestamp: 1 };
	const call = { role: "assistant", provider: "claude-bridge", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], timestamp: 2 };
	const result = { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 };
	const reminder = { role: "user", content: [{ type: "text", text: "<system-reminder>\nTASKS\n</system-reminder>" }], timestamp: 4 };
	const steer = { role: "user", content: "STEER", timestamp: 4 };
	const reply = { role: "assistant", provider: "claude-bridge", content: [{ type: "text", text: "done" }], timestamp: 5 };
	const recorded = [...snapshotRequestHistory([prompt, call, result, steer, reminder]), ...snapshotHistory([reply])];
	// The tasks hook's reminder is absent from the next projection; the persisted steer is present.
	assert.equal(alignHistory(recorded, snapshotHistory([prompt, call, result, steer, reply])), 5);
	assert.equal(alignHistory(recorded, snapshotHistory([prompt, call, result, steer, reminder, reply])), 6);
	// A trailing prompt or steer that a context edit omits is a divergence, as is a missing result.
	assert.equal(alignHistory(recorded, snapshotHistory([prompt, call, result, reply])), undefined);
	assert.equal(alignHistory(recorded, snapshotHistory([prompt, call, steer, reply])), undefined);
	assert.equal(alignHistory(snapshotRequestHistory([prompt, steer]), snapshotHistory([steer])), undefined);
});
