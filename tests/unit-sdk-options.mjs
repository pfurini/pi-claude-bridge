import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildIsolatedSummaryQueryOptions,
	buildProviderQueryOptions,
} from "../src/sdk-options.js";
import { claudeChildEnv, defaultClaudeConfigDir } from "../src/claude-config.js";

const claudeConfigDir = "/isolated/claude";
const baseEnv = { PATH: "/test/bin", KEEP_ME: "yes", CLAUDE_CONFIG_DIR: "/inherited/claude" };

describe("Claude child environment", () => {
	it("resolves the default profile below Pi's agent directory", () => {
		assert.equal(defaultClaudeConfigDir("/home/test"), "/home/test/.pi/agent/claude");
	});

	it("preserves inherited and extra variables while enforcing isolation", () => {
		const env = claudeChildEnv(claudeConfigDir, baseEnv, { EXTRA_VAR: "present" });
		assert.equal(env.PATH, "/test/bin");
		assert.equal(env.KEEP_ME, "yes");
		assert.equal(env.EXTRA_VAR, "present");
		assert.equal(env.CLAUDE_CONFIG_DIR, claudeConfigDir);
		assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
	});
});

describe("provider SDK options", () => {
	it("preserves the provider query invariants", () => {
		const mcpServers = { pi: { command: "node", args: ["server.mjs"] } };
		const options = buildProviderQueryOptions({
			cwd: "/work/project",
			baseEnv,
			claudeConfigDir,
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
		assert.equal(options.allowDangerouslySkipPermissions, true);
		assert.equal(options.strictMcpConfig, true);
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
		assert.equal(options.env.CLAUDE_CONFIG_DIR, claudeConfigDir);
		assert.equal(options.env.ENABLE_CLAUDEAI_MCP_SERVERS, "0");
		assert.equal(options.env.DISABLE_AUTO_COMPACT, "1");
		assert.equal(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
		assert.equal(options.extraArgs.model, "claude-test[1m]");
		assert.equal("strict-mcp-config" in options.extraArgs, false);
		assert.equal(options.extraArgs["thinking-display"], "summarized");
		assert.equal(options.debug, true);
	});

	it("omits optional provider settings without changing isolation defaults", () => {
		const options = buildProviderQueryOptions({
			cwd: "/work/project",
			baseEnv,
			claudeConfigDir,
			cliModel: "claude-test",
			strictMcpConfigEnabled: false,
		});

		assert.equal("settingSources" in options, false);
		assert.equal("mcpServers" in options, false);
		assert.equal("resume" in options, false);
		assert.equal("effort" in options, false);
		assert.equal(options.strictMcpConfig, false);
		assert.equal("strict-mcp-config" in options.extraArgs, false);
		assert.equal(options.systemPrompt.append, undefined);
		assert.equal(options.env.ENABLE_CLAUDEAI_MCP_SERVERS, "0");
		assert.equal(options.env.DISABLE_AUTO_COMPACT, "1");
		assert.equal(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
	});
});

// Auto-memory used to be set on the compaction path only, so the provider prompt
// still carried a large memory section instructing the model to use a native Write
// tool it does not have. Assert both spawn paths together so they cannot drift apart.
describe("Claude Code auto-memory isolation", () => {
	const builders = {
		provider: () =>
			buildProviderQueryOptions({
				cwd: "/work/project",
				baseEnv,
				claudeConfigDir,
				cliModel: "claude-test",
				strictMcpConfigEnabled: true,
			}),
		isolatedSummary: () =>
			buildIsolatedSummaryQueryOptions({
				cwd: "/work/project",
				baseEnv,
				claudeConfigDir,
				systemPrompt: "Summarize this context",
				cliModel: "claude-test",
			}),
	};

	for (const [name, build] of Object.entries(builders)) {
		it(`disables auto-memory on the ${name} path`, () => {
			assert.equal(build().env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
		});
	}
});

describe("isolated compaction SDK options", () => {
	it("preserves resolved effort for standalone requests and omits missing mappings", () => {
		const input = { cwd: "/work/project", baseEnv, claudeConfigDir, systemPrompt: "Classify inventory", cliModel: "claude-test" };
		assert.equal(buildIsolatedSummaryQueryOptions({ ...input, effort: "max" }).effort, "max");
		assert.ok(!("effort" in buildIsolatedSummaryQueryOptions(input)));
	});
	it("disables tools, settings, skills, persistence, and auto-memory", () => {
		const options = buildIsolatedSummaryQueryOptions({
			cwd: "/work/project",
			baseEnv,
			claudeConfigDir,
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
		assert.equal(options.env.CLAUDE_CONFIG_DIR, claudeConfigDir);
		assert.equal(options.env.DISABLE_AUTO_COMPACT, "1");
		assert.equal(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
	});
});
