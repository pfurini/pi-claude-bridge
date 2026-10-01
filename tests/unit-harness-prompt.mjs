import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHarnessCorrections } from "../src/harness-prompt.js";
import { MCP_TOOL_PREFIX } from "../src/skills.js";

describe("harness corrections", () => {
	it("names pi's MCP tool surface when the native inventory is empty", () => {
		const block = buildHarnessCorrections({
			modelId: "claude-sonnet-5",
			cliModelId: "claude-sonnet-5",
			toolsAreMcpOnly: true,
		});

		assert.ok(block);
		assert.ok(block.includes(MCP_TOOL_PREFIX));
		// The legacy-family preset names PowerShell and Claude Code's own tools when
		// the native inventory is empty; both have to be disclaimed.
		assert.ok(block.includes("PowerShell"));
		for (const tool of ["Read", "Edit", "Write", "Glob", "Grep", "Bash"]) {
			assert.ok(block.includes(tool), `should disclaim ${tool}`);
		}
	});

	it("corrects the model ID when a context-window suffix was requested", () => {
		const block = buildHarnessCorrections({
			modelId: "claude-sonnet-5",
			cliModelId: "claude-sonnet-5[1m]",
			toolsAreMcpOnly: true,
		});

		assert.ok(block.includes("Your exact model ID is `claude-sonnet-5`."));
		assert.ok(block.includes("`[1m]`"));
	});

	it("says nothing about the model ID when no suffix was applied", () => {
		const block = buildHarnessCorrections({
			modelId: "claude-opus-5",
			cliModelId: "claude-opus-5",
			toolsAreMcpOnly: true,
		});

		assert.ok(!block.includes("exact model ID"));
	});

	it("never disclaims native tools on a path that still has them", () => {
		const block = buildHarnessCorrections({
			modelId: "claude-sonnet-5",
			cliModelId: "claude-sonnet-5[1m]",
			toolsAreMcpOnly: false,
		});

		assert.ok(!block.includes(MCP_TOOL_PREFIX));
		assert.ok(!block.includes("are not available under those names"));
		assert.ok(block.includes("exact model ID"));
	});

	it("leaves the provider path's confirmation guidance intact", () => {
		const provider = buildHarnessCorrections({
			modelId: "claude-sonnet-5",
			cliModelId: "claude-sonnet-5[1m]",
			toolsAreMcpOnly: true,
		});

		assert.ok(!provider.includes("delegated sub-agent"));
		assert.ok(!provider.includes("operate more autonomously"));
	});

	it("does not describe an unrelated id divergence as a context-window suffix", () => {
		const block = buildHarnessCorrections({
			modelId: "claude-opus-5",
			cliModelId: "some-other-model",
			toolsAreMcpOnly: false,
		});

		assert.equal(block, undefined);
	});

	it("returns undefined when there is nothing to correct", () => {
		assert.equal(
			buildHarnessCorrections({
				modelId: "claude-opus-5",
				cliModelId: "claude-opus-5",
				toolsAreMcpOnly: false,
			}),
			undefined,
		);
	});

	// The block joins the cached prompt prefix on every request, so a regression that
	// let it grow unbounded would be paid for on each cache write. Both maxima are
	// checked against the largest provider block.
	it("stays small enough to be irrelevant against the preset", () => {
		const maxima = {
			provider: buildHarnessCorrections({
				modelId: "claude-sonnet-5",
				cliModelId: "claude-sonnet-5[1m]",
				toolsAreMcpOnly: true,
			}),
		};

		for (const [path, block] of Object.entries(maxima)) {
			assert.ok(
				block.length < 1500,
				`${path} corrections block grew to ${block.length} chars against a ~14K preset`,
			);
		}
	});
});
