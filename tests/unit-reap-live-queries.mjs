/**
 * Reaping parked Claude Code children on host session_shutdown.
 *
 * The bug: clearSession() nulls sharedSession and the ACTIVE_STREAM_SIMPLE_KEY
 * global but never touches activeQueryContexts, so a child parked at a tool
 * boundary under a SETTLED run survives host teardown (CC has no parent-death
 * watchdog, so it reparents and keeps billing). reapLiveQueries() closes that hole
 * by killing every live query still in the set on the owner's session_shutdown.
 *
 * These drive the pure reaper (and its owner-gate seam) directly, with real
 * QueryContexts and spy query handles — no extension activation, no CC spawn.
 *
 * KNOWN GAP (accepted): the handler wiring in index.ts (session_shutdown →
 * reapLiveQueriesIfOwner(isProviderOwner, activeQueryContexts, ...) before
 * clearSession) is not exercised here — activating the full extension needs a
 * stubbed ExtensionAPI plus the module's load-time side effects, which is what
 * the optional int test (int-shutdown-reaps-parked-subagent, not yet written)
 * would cover with a parked subagent child and a real host shutdown.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext, reapLiveQueries, reapLiveQueriesIfOwner } from "../src/query-state.js";

// A stand-in for the SDK query() handle the reaper drives. interrupt() returns a
// rejected promise the reaper is expected to swallow (interrupt alone can leave
// the API call running, so it must not be awaited before close()).
function spyQuery() {
	const calls = { interrupt: 0, close: 0 };
	return {
		calls,
		interrupt() { calls.interrupt++; return Promise.reject(new Error("interrupted")); },
		close() { calls.close++; },
	};
}

// A real QueryContext wired with a spy query handle, a spy prompt stream, and one
// parked MCP handler so we can observe releasePendingToolCalls firing.
function parkedContext({ failThrows = false } = {}) {
	const c = new QueryContext();
	const q = spyQuery();
	c.activeQuery = q;
	const promptStreamCalls = { fail: 0 };
	c.promptStream = {
		fail() {
			promptStreamCalls.fail++;
			if (failThrows) throw new Error("prompt stream fail blew up");
		},
	};
	let released = null;
	c.pendingToolCalls.set("toolu_1", { toolName: "alpha", resolve: (r) => { released = r; } });
	return { c, q, promptStreamCalls, get released() { return released; } };
}

describe("reapLiveQueries: kill parked children on host teardown", () => {
	it("interrupts, closes, drains, and empties the set", () => {
		const contexts = new Set();
		const a = parkedContext();
		const b = parkedContext();
		contexts.add(a.c);
		contexts.add(b.c);

		reapLiveQueries(contexts, "session_shutdown");

		for (const { q, promptStreamCalls, c, released } of [a, b]) {
			assert.equal(q.calls.interrupt, 1, "interrupt must fire once");
			assert.equal(q.calls.close, 1, "close must fire once");
			assert.equal(promptStreamCalls.fail, 1, "the parked prompt stream must be failed");
			assert.equal(c.pendingToolCalls.size, 0, "parked MCP handlers must be released");
			assert.equal(released?.content?.[0]?.text, "session_shutdown", "handler is answered with the reason");
			assert.equal(c.activeQuery, null, "activeQuery must be cleared");
		}
		assert.equal(contexts.size, 0, "every reaped context must leave the set");
	});

	it("does not require a prompt stream", () => {
		const contexts = new Set();
		const c = new QueryContext();
		const q = spyQuery();
		c.activeQuery = q;
		c.promptStream = null;
		contexts.add(c);

		reapLiveQueries(contexts, "session_shutdown");

		assert.equal(q.calls.interrupt, 1);
		assert.equal(q.calls.close, 1);
		assert.equal(c.activeQuery, null);
		assert.equal(contexts.size, 0);
	});

	it("a throwing drain does not spare that context's child, nor stop the others", () => {
		const contexts = new Set();
		const bad = parkedContext({ failThrows: true }); // throws inside drainForAbort
		const good = parkedContext();
		contexts.add(bad.c); // iterated first (insertion order)
		contexts.add(good.c);

		reapLiveQueries(contexts, "session_shutdown");

		// Draining is best-effort; the kill is not. The context whose drain threw
		// must STILL be interrupted, closed, cleared, and removed — a context
		// skipped on a drain failure is exactly the orphaned child this reaper
		// exists to prevent.
		assert.equal(bad.q.calls.interrupt, 1, "the throwing context must still be interrupted");
		assert.equal(bad.q.calls.close, 1, "the throwing context must still be closed");
		assert.equal(bad.c.activeQuery, null, "the throwing context's activeQuery is cleared");
		assert.equal(contexts.has(bad.c), false, "the throwing context is removed from the set");

		// And the later context is fully reaped despite the earlier throw.
		assert.equal(good.q.calls.interrupt, 1, "the later context must still be interrupted");
		assert.equal(good.q.calls.close, 1, "the later context must still be closed");
		assert.equal(good.c.activeQuery, null);
		assert.equal(contexts.has(good.c), false, "the good context is removed");
		assert.equal(contexts.size, 0, "the set is emptied even with a throwing drain");
	});
});

describe("reapLiveQueriesIfOwner: the ownership gate seam", () => {
	it("is a no-op for a non-owner session", () => {
		const contexts = new Set();
		const a = parkedContext();
		contexts.add(a.c);

		reapLiveQueriesIfOwner(false, contexts, "session_shutdown");

		assert.equal(a.q.calls.interrupt, 0, "a non-owner must not touch live queries");
		assert.equal(a.q.calls.close, 0);
		assert.equal(a.c.activeQuery, a.q, "activeQuery is untouched");
		assert.equal(contexts.size, 1, "the set is left intact");
	});

	it("reaps for the owner session", () => {
		const contexts = new Set();
		const a = parkedContext();
		contexts.add(a.c);

		reapLiveQueriesIfOwner(true, contexts, "session_shutdown");

		assert.equal(a.q.calls.interrupt, 1);
		assert.equal(a.q.calls.close, 1);
		assert.equal(contexts.size, 0);
	});
});
