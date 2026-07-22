import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildAskClaudeQueryOptions,
	buildIsolatedSummaryQueryOptions,
	buildProviderQueryOptions,
} from "../src/sdk-options.js";

const baseEnv = { PATH: "/test/bin", KEEP_ME: "yes" };

describe("provider SDK options", () => {
	it("preserves the provider query invariants", () => {
		const mcpServers = { pi: { command: "node", args: ["server.mjs"] } };
		const options = buildProviderQueryOptions({
			cwd: "/work/project",
			baseEnv,
			cliModel: "claude-test[1m]",
			systemPromptAppend: "project instructions",
			effort: "high",
			settingSources: ["user", "project"],
			mcpServers,
			resumeSessionId: "session-1",
			claudeExecutable: "/opt/claude",
			strictMcpConfigEnabled: true,
			debugOptions: { debug: true, debugFile: "/tmp/claude.log" },
		});

		assert.equal(options.cwd, "/work/project");
		assert.deepEqual(options.tools, []);
		assert.equal(options.permissionMode, "bypassPermissions");
		assert.equal(options.includePartialMessages, true);
		assert.deepEqual(options.systemPrompt, {
			type: "preset",
			preset: "claude_code",
			append: "project instructions",
		});
		assert.equal(options.effort, "high");
		assert.deepEqual(options.settingSources, ["user", "project"]);
		assert.strictEqual(options.mcpServers, mcpServers);
		assert.equal(options.resume, "session-1");
		assert.equal(options.pathToClaudeCodeExecutable, "/opt/claude");
		assert.equal(options.env.KEEP_ME, "yes");
		assert.equal(options.env.ENABLE_CLAUDEAI_MCP_SERVERS, "0");
		assert.equal(options.env.DISABLE_AUTO_COMPACT, "1");
		assert.equal(options.extraArgs.model, "claude-test[1m]");
		assert.equal(options.extraArgs["strict-mcp-config"], null);
		assert.equal(options.extraArgs["thinking-display"], "summarized");
		assert.equal(options.debug, true);
	});

	it("omits optional provider settings without changing isolation defaults", () => {
		const options = buildProviderQueryOptions({
			cwd: "/work/project",
			baseEnv,
			cliModel: "claude-test",
			strictMcpConfigEnabled: false,
		});

		assert.equal("settingSources" in options, false);
		assert.equal("mcpServers" in options, false);
		assert.equal("resume" in options, false);
		assert.equal("effort" in options, false);
		assert.equal("strict-mcp-config" in options.extraArgs, false);
		assert.equal(options.systemPrompt.append, undefined);
	});
});

describe("AskClaude SDK options", () => {
	it("preserves mode restrictions, skills, and isolated-session settings", () => {
		const blocked = ["Write", "Bash"];
		const options = buildAskClaudeQueryOptions({
			cwd: "/work/project",
			baseEnv,
			cliModel: "claude-opus-test",
			disallowedTools: blocked,
			effort: "medium",
			skillsBlock: "available skills",
			resumeSessionId: "session-2",
			isolated: true,
			claudeExecutable: "/opt/claude",
		});

		assert.deepEqual(options.disallowedTools, blocked);
		assert.equal(options.permissionMode, "bypassPermissions");
		assert.equal(options.effort, "medium");
		assert.deepEqual(options.systemPrompt, {
			type: "preset",
			preset: "claude_code",
			append: "available skills",
		});
		assert.deepEqual(options.settingSources, ["user", "project"]);
		assert.equal(options.resume, "session-2");
		assert.equal(options.persistSession, false);
		assert.equal(options.pathToClaudeCodeExecutable, "/opt/claude");
		assert.equal(options.extraArgs.model, "claude-opus-test");
		assert.equal(options.extraArgs["strict-mcp-config"], null);
		assert.equal(options.extraArgs["thinking-display"], "summarized");
		assert.equal(options.env.KEEP_ME, "yes");
		assert.equal(options.env.ENABLE_CLAUDEAI_MCP_SERVERS, "0");
		assert.equal(options.env.DISABLE_AUTO_COMPACT, "1");
	});
});

describe("isolated compaction SDK options", () => {
	it("disables tools, settings, skills, persistence, and auto-memory", () => {
		const options = buildIsolatedSummaryQueryOptions({
			cwd: "/work/project",
			baseEnv,
			systemPrompt: "Summarize this context",
			cliModel: "claude-summary-test",
			claudeExecutable: "/opt/claude",
		});

		assert.deepEqual(options.tools, []);
		assert.equal(options.strictMcpConfig, true);
		assert.deepEqual(options.settingSources, []);
		assert.deepEqual(options.skills, []);
		assert.equal(options.persistSession, false);
		assert.equal(options.systemPrompt, "Summarize this context");
		assert.equal(options.model, "claude-summary-test");
		assert.equal(options.maxTurns, 1);
		assert.equal(options.pathToClaudeCodeExecutable, "/opt/claude");
		assert.equal(options.env.KEEP_ME, "yes");
		assert.equal(options.env.DISABLE_AUTO_COMPACT, "1");
		assert.equal(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
	});
});
