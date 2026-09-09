/**
 * pi-fence hands the fenced Pi process a constructed environment: a masked
 * OAuth token (the sandbox proxy swaps in the real setup token on egress to
 * api.anthropic.com), the proxy coordinates, and the proxy's CA bundle. The
 * bridge builds Claude Code's child environment from the parent's —
 * `baseEnv: process.env` at every call site — so the fence path works only
 * while `claudeChildEnv` passes those names through untouched. A regression
 * here is silent: the child would try to leave the sandbox without the proxy
 * and its CA, and the failure would surface as an unreachable
 * api.anthropic.com, never as a thrown error.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { claudeChildEnv } from "../src/claude-config.js";
import {
	buildAskClaudeQueryOptions,
	buildIsolatedSummaryQueryOptions,
	buildProviderQueryOptions,
} from "../src/sdk-options.js";

// The variables pi-fence injects into the fenced process, with fixture values.
const fenceEnv = {
	CLAUDE_CODE_OAUTH_TOKEN: "masked-fence-oauth-token",
	HTTPS_PROXY: "http://127.0.0.1:3128",
	HTTP_PROXY: "http://127.0.0.1:3128",
	NO_PROXY: "localhost,127.0.0.1",
	NODE_EXTRA_CA_CERTS: "/fence/home/ca.pem",
	SSL_CERT_FILE: "/fence/home/ca.pem",
};

function assertFenceEnvSurvives(env, label) {
	for (const [name, value] of Object.entries(fenceEnv)) {
		assert.equal(env[name], value, `${label}: ${name} must survive verbatim`);
	}
}

describe("pi-fence environment passthrough", () => {
	it("claudeChildEnv carries the fence variables through verbatim", () => {
		const env = claudeChildEnv("/cfg", { PATH: "/test/bin", ...fenceEnv });
		assertFenceEnvSurvives(env, "claudeChildEnv");
		assert.equal(env.CLAUDE_CONFIG_DIR, "/cfg");
	});

	it("claudeChildEnv never reads process.env when a baseEnv is supplied", () => {
		const prior = process.env.PI_FENCE_TEST_LEAK;
		process.env.PI_FENCE_TEST_LEAK = "x";
		try {
			const env = claudeChildEnv("/cfg", { PATH: "/test/bin" });
			assert.equal("PI_FENCE_TEST_LEAK" in env, false);
		} finally {
			if (prior === undefined) delete process.env.PI_FENCE_TEST_LEAK;
			else process.env.PI_FENCE_TEST_LEAK = prior;
		}
	});

	it("extra can neither override CLAUDE_CONFIG_DIR nor drop the fence variables", () => {
		const env = claudeChildEnv("/cfg", { ...fenceEnv }, {
			CLAUDE_CONFIG_DIR: "/rogue",
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
		});
		assert.equal(env.CLAUDE_CONFIG_DIR, "/cfg");
		assertFenceEnvSurvives(env, "extra");
	});

	// Every query() call site feeds the builders baseEnv: process.env
	// (src/index.ts provider, AskClaude, and compaction-summary paths), so the
	// builders are the real spawn contract. The fence variables must survive
	// alongside the isolation extras each builder adds.
	const builders = {
		provider: (baseEnv) =>
			buildProviderQueryOptions({
				cwd: "/work/project",
				baseEnv,
				claudeConfigDir: "/cfg",
				cliModel: "claude-test",
				strictMcpConfigEnabled: true,
			}),
		askClaude: (baseEnv) =>
			buildAskClaudeQueryOptions({
				cwd: "/work/project",
				baseEnv,
				claudeConfigDir: "/cfg",
				cliModel: "claude-test",
				mode: "read",
			}),
		isolatedSummary: (baseEnv) =>
			buildIsolatedSummaryQueryOptions({
				cwd: "/work/project",
				baseEnv,
				claudeConfigDir: "/cfg",
				systemPrompt: "Summarize this context",
				cliModel: "claude-test",
			}),
	};

	for (const [name, build] of Object.entries(builders)) {
		it(`${name} query options keep the fence variables in options.env`, () => {
			const options = build({ PATH: "/test/bin", ...fenceEnv });
			assertFenceEnvSurvives(options.env, name);
			assert.equal(options.env.CLAUDE_CONFIG_DIR, "/cfg");
		});
	}
});
