import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readFileSync } from "node:fs";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { claudeCodeSettings, loadConfig, markStartupNoticeShown, normalizeAskClaudeDefaultMode } from "../src/config.js";
import { defaultClaudeConfigDir } from "../src/claude-config.js";

function withTempHome(fn) {
	const oldHome = process.env.HOME;
	const home = mkdtempSync(join(tmpdir(), "claude-bridge-home-"));
	try {
		process.env.HOME = home;
		return fn(home);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		rmSync(home, { recursive: true, force: true });
	}
}

describe("claudeCodeSettings", () => {
	it("disables auto-memory by default", () => {
		assert.deepEqual(claudeCodeSettings(), { autoMemoryEnabled: false });
	});

	it("allows auto-memory to be enabled", () => {
		assert.deepEqual(claudeCodeSettings({ autoMemoryEnabled: true }), { autoMemoryEnabled: true });
	});
});

describe("loadConfig", () => {
	it("loads project config from Pi's configured project directory", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const configDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max" },
				askClaude: { enabled: false },
			}));

			assert.deepEqual(loadConfig(cwd), {
				startupNoticeShown: undefined,
				provider: { plan: "max", claudeConfigDir: defaultClaudeConfigDir(home) },
				askClaude: { enabled: false },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("merges project config over global config", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const globalDir = getAgentDir();
			const projectDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "pro", strictMcpConfig: true, claudeConfigDir: "/global/claude" },
				askClaude: { enabled: true, defaultMode: "read" },
			}));
			writeFileSync(join(projectDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max", claudeConfigDir: "/project/claude", autoMemoryEnabled: true },
				askClaude: { enabled: false },
			}));

			assert.deepEqual(loadConfig(cwd), {
				startupNoticeShown: undefined,
				provider: { plan: "max", strictMcpConfig: true, claudeConfigDir: "/project/claude", autoMemoryEnabled: true },
				askClaude: { enabled: false, defaultMode: "read" },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("normalizes an invalid default mode to read with one clear warning", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		const warnings = [];
		const originalWarn = console.warn;
		try {
			const configDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "claude-bridge.json"), JSON.stringify({
				askClaude: { defaultMode: "typo", description: "do not log me" },
			}));
			console.warn = (...args) => warnings.push(args.join(" "));

			assert.equal(loadConfig(cwd).askClaude.defaultMode, "read");
			assert.deepEqual(warnings, [
				'claude-bridge: invalid askClaude.defaultMode "typo"; using "read"',
			]);
			assert.doesNotMatch(warnings[0], /do not log me/);
		} finally {
			console.warn = originalWarn;
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("makes allowFullMode false override a merged full default", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		const warnings = [];
		const originalWarn = console.warn;
		try {
			const globalDir = join(home, ".pi", "agent");
			const projectDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "claude-bridge.json"), JSON.stringify({
				askClaude: { defaultMode: "full" },
			}));
			writeFileSync(join(projectDir, "claude-bridge.json"), JSON.stringify({
				askClaude: { allowFullMode: false },
			}));
			console.warn = (...args) => warnings.push(args.join(" "));

			const config = loadConfig(cwd);
			assert.equal(config.askClaude.defaultMode, "read");
			assert.equal(config.askClaude.allowFullMode, false);
			assert.deepEqual(warnings, [
				'claude-bridge: askClaude.defaultMode "full" is disabled by allowFullMode=false; using "read"',
			]);
		} finally {
			console.warn = originalWarn;
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("markStartupNoticeShown records today's date without dropping existing settings", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const globalDir = getAgentDir();
			mkdirSync(globalDir, { recursive: true });
			const path = join(globalDir, "claude-bridge.json");
			writeFileSync(path, JSON.stringify({
				askClaude: { enabled: false },
				provider: { strictMcpConfig: false },
			}));

			assert.equal(markStartupNoticeShown(), path);
			const written = JSON.parse(readFileSync(path, "utf-8"));
			assert.match(written.startupNoticeShown, /^\d{4}-\d{2}-\d{2}$/);
			assert.deepEqual(written.askClaude, { enabled: false });
			assert.deepEqual(written.provider, { strictMcpConfig: false });
			assert.equal(loadConfig(cwd).startupNoticeShown, written.startupNoticeShown);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("markStartupNoticeShown creates the config when there is none", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			assert.equal(loadConfig(cwd).startupNoticeShown, undefined);
			markStartupNoticeShown();
			assert.match(loadConfig(cwd).startupNoticeShown, /^\d{4}-\d{2}-\d{2}$/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("ignores inherited CLAUDE_CONFIG_DIR and uses the isolated default", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		const previous = process.env.CLAUDE_CONFIG_DIR;
		try {
			process.env.CLAUDE_CONFIG_DIR = "/inherited/claude";
			const effective = loadConfig(cwd).provider.claudeConfigDir;
			assert.equal(effective, defaultClaudeConfigDir(home));
			assert.equal(isAbsolute(effective), true);
		} finally {
			if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = previous;
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("warns and falls back for invalid Claude config directories", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		const warnings = [];
		const originalWarn = console.warn;
		try {
			const configDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(configDir, { recursive: true });
			console.warn = (...args) => warnings.push(args.join(" "));
			for (const value of ["relative/profile", 42]) {
				writeFileSync(join(configDir, "claude-bridge.json"), JSON.stringify({
					provider: { claudeConfigDir: value },
				}));
				assert.equal(loadConfig(cwd).provider.claudeConfigDir, defaultClaudeConfigDir(home));
			}
			assert.equal(warnings.length, 2);
			assert.match(warnings[0], /invalid provider\.claudeConfigDir "relative\/profile"/);
			assert.match(warnings[1], /invalid provider\.claudeConfigDir 42/);
		} finally {
			console.warn = originalWarn;
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("falls back to a valid global profile when the project override is invalid", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		const warnings = [];
		const originalWarn = console.warn;
		try {
			const globalDir = join(home, ".pi", "agent");
			const projectDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "claude-bridge.json"), JSON.stringify({
				provider: { claudeConfigDir: "/global/authenticated-profile" },
			}));
			writeFileSync(join(projectDir, "claude-bridge.json"), JSON.stringify({
				provider: { claudeConfigDir: "typo-relative/profile" },
			}));
			console.warn = (...args) => warnings.push(args.join(" "));

			const effective = loadConfig(cwd).provider.claudeConfigDir;
			assert.equal(
				effective,
				"/global/authenticated-profile",
				"a bad project override must not discard a valid global profile for the built-in default",
			);
			assert.notEqual(effective, defaultClaudeConfigDir(home));
			assert.equal(warnings.length, 1);
			assert.match(
				warnings[0],
				/invalid provider\.claudeConfigDir "typo-relative\/profile"; using \/global\/authenticated-profile/,
			);
		} finally {
			console.warn = originalWarn;
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("warns once when repeated loads hit the same invalid config directory", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		const warnings = [];
		const originalWarn = console.warn;
		try {
			const projectDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(projectDir, "claude-bridge.json"), JSON.stringify({
				provider: { claudeConfigDir: "repeated-relative/profile" },
			}));
			console.warn = (...args) => warnings.push(args.join(" "));

			for (let i = 0; i < 3; i++) {
				assert.equal(loadConfig(cwd).provider.claudeConfigDir, defaultClaudeConfigDir(home));
			}
			assert.equal(
				warnings.length,
				1,
				"activation plus each compaction reloads config; the warning must not reprint over the TUI",
			);
		} finally {
			console.warn = originalWarn;
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("preserves valid modes and leaves an unset mode for the caller default", () => {
		assert.equal(normalizeAskClaudeDefaultMode(undefined), undefined);
		assert.equal(normalizeAskClaudeDefaultMode("read"), "read");
		assert.equal(normalizeAskClaudeDefaultMode("none"), "none");
		assert.equal(normalizeAskClaudeDefaultMode("full", true), "full");
	});

	it("resolves global config via PI_CODING_AGENT_DIR override, not hardcoded ~/.pi/agent", () => withTempHome((home) => {
		const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		const oldEnv = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max" },
			}));

			assert.deepEqual(loadConfig(cwd), {
				startupNoticeShown: undefined,
				provider: { plan: "max", claudeConfigDir: defaultClaudeConfigDir(home) },
				askClaude: {},
			});
		} finally {
			if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldEnv;
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	}));
});
