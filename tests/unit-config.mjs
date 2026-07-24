import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { loadConfig, normalizeAskClaudeDefaultMode } from "../src/config.js";

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
	it("loads project config from Pi's configured project directory", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const configDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max" },
				askClaude: { enabled: false },
			}));

			assert.deepEqual(loadConfig(cwd), {
				provider: { plan: "max" },
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
				provider: { plan: "pro", strictMcpConfig: true },
				askClaude: { enabled: true, defaultMode: "read" },
			}));
			writeFileSync(join(projectDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max" },
				askClaude: { enabled: false },
			}));

			assert.deepEqual(loadConfig(cwd), {
				provider: { plan: "max", strictMcpConfig: true },
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

	it("preserves valid modes and leaves an unset mode for the caller default", () => {
		assert.equal(normalizeAskClaudeDefaultMode(undefined), undefined);
		assert.equal(normalizeAskClaudeDefaultMode("read"), "read");
		assert.equal(normalizeAskClaudeDefaultMode("none"), "none");
		assert.equal(normalizeAskClaudeDefaultMode("full", true), "full");
	});
});
