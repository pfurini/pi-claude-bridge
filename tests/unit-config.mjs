import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { loadConfig, normalizeAskClaudeDefaultMode } from "../src/config.js";
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
			const globalDir = join(home, ".pi", "agent");
			const projectDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "pro", strictMcpConfig: true, claudeConfigDir: "/global/claude" },
				askClaude: { enabled: true, defaultMode: "read" },
			}));
			writeFileSync(join(projectDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max", claudeConfigDir: "/project/claude" },
				askClaude: { enabled: false },
			}));

			assert.deepEqual(loadConfig(cwd), {
				provider: { plan: "max", strictMcpConfig: true, claudeConfigDir: "/project/claude" },
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
});
