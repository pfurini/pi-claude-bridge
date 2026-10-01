import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readFileSync } from "node:fs";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { claudeCodeSettings, loadConfig, loadDirs, markStartupNoticeShown, sessionAgentDir } from "../src/config.js";
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

describe("fork config directories", () => {
	it("uses explicit factory directories instead of process defaults", () => {
		const pi = { cwd: "/fork/project", agentDir: "/fork/profile" };
		assert.deepEqual(loadDirs(pi), pi);
	});

	it("uses each session's explicit agent directory", () => {
		const parent = { cwd: "/fork/project", agentDir: "/fork/parent-profile" };
		const child = { cwd: parent.cwd, agentDir: "/fork/child-profile" };
		assert.equal(sessionAgentDir(parent), parent.agentDir);
		assert.equal(sessionAgentDir(child), child.agentDir);
		assert.deepEqual(loadDirs(child), child);
	});

	it("loads config from the explicit fork profile", () => withTempHome((home) => {
		const pi = { cwd: join(home, "project"), agentDir: join(home, "fork-profile") };
		const ctx = { cwd: pi.cwd, agentDir: pi.agentDir };
		mkdirSync(pi.agentDir, { recursive: true });
		writeFileSync(join(pi.agentDir, "claude-bridge.json"), JSON.stringify({
			provider: { plan: "max" },
		}));

		const dirs = loadDirs(pi);
		assert.equal(loadConfig(dirs.cwd, dirs.agentDir).provider.plan, "max");
		assert.equal(loadConfig(ctx.cwd, sessionAgentDir(ctx)).provider.plan, "max");
	}));
});

describe("loadConfig", () => {
	it("loads project config from Pi's configured project directory", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const configDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max" },
			}));

			assert.deepEqual(loadConfig(cwd), {
				startupNoticeShown: undefined,
				provider: { plan: "max", claudeConfigDir: defaultClaudeConfigDir(home) },
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
			}));
			writeFileSync(join(projectDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max", claudeConfigDir: "/project/claude", autoMemoryEnabled: true },
			}));

			assert.deepEqual(loadConfig(cwd), {
				startupNoticeShown: undefined,
				// claudeConfigDir is global-only: a project file may not pick the credentials profile.
				provider: { plan: "max", strictMcpConfig: true, claudeConfigDir: "/global/claude", autoMemoryEnabled: true },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("markStartupNoticeShown records today's date without dropping existing settings", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const globalDir = getAgentDir();
			mkdirSync(globalDir, { recursive: true });
			const path = join(globalDir, "claude-bridge.json");
			// A key this version no longer reads (AskClaude was removed) must survive the write.
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

	it("markStartupNoticeShown leaves an unparseable config untouched", () => withTempHome(() => {
		const globalDir = getAgentDir();
		mkdirSync(globalDir, { recursive: true });
		const path = join(globalDir, "claude-bridge.json");
		const malformed = '{ "askClaude": { "enabled": true }, }';
		writeFileSync(path, malformed);

		markStartupNoticeShown();
		assert.equal(readFileSync(path, "utf-8"), malformed, "a typo must not cost the user their config");
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
			const configDir = join(home, ".pi", "agent");
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

	it("ignores the keys that choose what runs, with one warning each", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		const warnings = [];
		const originalWarn = console.warn;
		try {
			const globalDir = join(home, ".pi", "agent");
			const projectDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "claude-bridge.json"), JSON.stringify({
				provider: { claudeConfigDir: "/global/authenticated-profile", settingSources: [] },
			}));
			writeFileSync(join(projectDir, "claude-bridge.json"), JSON.stringify({
				provider: {
					claudeConfigDir: "/repo/profile",
					pathToClaudeCodeExecutable: "./tools/claude.js",
					settingSources: ["project"],
					strictMcpConfig: false,
					appendSystemPrompt: false,
				},
			}));
			console.warn = (...args) => warnings.push(args.join(" "));

			for (let i = 0; i < 2; i++) {
				const provider = loadConfig(cwd).provider;
				assert.equal(provider.claudeConfigDir, "/global/authenticated-profile");
				assert.equal(provider.pathToClaudeCodeExecutable, undefined);
				assert.deepEqual(provider.settingSources, []);
				assert.equal(provider.strictMcpConfig, undefined);
				// Prompt-level keys stay project-overridable.
				assert.equal(provider.appendSystemPrompt, false);
			}
			assert.deepEqual(warnings.map((warning) => warning.match(/provider\.(\w+)/)[1]).sort(),
				["claudeConfigDir", "pathToClaudeCodeExecutable", "settingSources", "strictMcpConfig"]);
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
			const globalDir = join(home, ".pi", "agent");
			mkdirSync(globalDir, { recursive: true });
			writeFileSync(join(globalDir, "claude-bridge.json"), JSON.stringify({
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
			});
		} finally {
			if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldEnv;
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	}));
});
