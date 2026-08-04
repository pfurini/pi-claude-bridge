/**
 * Every Claude Code subprocess the bridge spawns has to be told to keep its hands
 * off state pi owns. These are silent when missing: CC compacts or writes memory
 * on its own, nothing throws, and the damage shows up in the user's ~/.claude
 * rather than in a test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { claudeIsolationEnv } from "../src/sdk-options.js";

describe("Claude Code child environment", () => {
	it("disables auto-compaction, claude.ai MCP servers, and auto-memory", () => {
		assert.deepEqual(claudeIsolationEnv(false), {
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
			CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
		});
	});

	it("keeps the base isolation when auto-memory is opted in", () => {
		assert.deepEqual(claudeIsolationEnv(true), {
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
		});
	});

	// Deliberately not asserted here: that every `query()` call site composes the
	// helper. The three spawn paths route through the builders in sdk-options.ts,
	// whose env output unit-sdk-options.mjs covers; a grep-shaped test of
	// index.ts would fail on innocent indirection and reads as coverage.
});
