// User-facing extension config. Loaded from an agent dir
// (e.g. ~/.pi/agent/claude-bridge.json) and the project Pi config directory,
// project overriding global. Missing or unparseable files are ignored (error
// to console.error, empty object returned) so the extension always starts.
//
// Loaded twice: once at extension load, from loadDirs(), and again on
// session_start against the dirs ctx reports. See loadDirs() and
// sessionAgentDir() for why the two can disagree.

import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";
import { defaultClaudeConfigDir } from "./claude-config.js";

export interface Config {
	askClaude?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		defaultMode?: "full" | "read" | "none";
		defaultIsolated?: boolean;
		allowFullMode?: boolean;
		appendSkills?: boolean;
	};
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		appendSystemPrompt?: boolean;
		// Which Claude Code settings tiers the spawned binary may load. DEFAULT [].
		// Pi owns rules and context: with the default, Claude Code reads no
		// settings.json of any tier and no CLAUDE.md of its own - project rules
		// reach it only through pi's forwarded context block. Opting in re-enables
		// Claude-Code-native behaviour explicitly (e.g. ["user","project","local"]).
		// Independent of appendSystemPrompt by design: a prompt flag must never
		// silently change which settings files load.
		settingSources?: SettingSource[];
		strictMcpConfig?: boolean;
		// Models that receive the bridge's steering rules (engineering-discipline
		// system prompt block). Default: the models the rules were validated on
		// (see steering.ts). Set to false or [] to disable, or list model ids to
		// extend - extending to unvalidated models is at your own risk.
		steeringModels?: string[] | false;
		pathToClaudeCodeExecutable?: string;
		claudeConfigDir?: string;
		// Subscription plan tier. Setting to "max" makes Fable 5 available and enables
		// Opus 4.6 at 1M context.
		plan?: "pro" | "max";
		// Set to true to opt into metered usage ("Extra Usage" in Anthropic billing).
		// Enables Fable 5 on Pro, Sonnet 4.6 [1m] on every plan, and Opus 4.6
		// [1m] on Pro.
		longContextExtraUsage?: boolean;
	};
}

export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function normalizeAskClaudeDefaultMode(
	defaultMode: unknown,
	allowFullMode?: unknown,
): "full" | "read" | "none" | undefined {
	if (defaultMode === undefined) return undefined;
	if (defaultMode !== "full" && defaultMode !== "read" && defaultMode !== "none") {
		console.warn(
			`claude-bridge: invalid askClaude.defaultMode ${JSON.stringify(defaultMode)}; using "read"`,
		);
		return "read";
	}
	if (defaultMode === "full" && allowFullMode === false) {
		console.warn(
			'claude-bridge: askClaude.defaultMode "full" is disabled by allowFullMode=false; using "read"',
		);
		return "read";
	}
	return defaultMode;
}

// loadConfig runs at extension load and again on session_start, so an invalid
// value would otherwise reprint its warning over the TUI on each call.
const warnedClaudeConfigDirs = new Set<string>();

export function normalizeClaudeConfigDir(
	value: unknown,
	fallback: string = defaultClaudeConfigDir(),
): string {
	if (value === undefined) return fallback;
	if (typeof value === "string" && value.length > 0 && isAbsolute(value)) {
		return value;
	}
	const warning =
		`claude-bridge: invalid provider.claudeConfigDir ${JSON.stringify(value)}; using ${fallback}`;
	if (!warnedClaudeConfigDirs.has(warning)) {
		warnedClaudeConfigDirs.add(warning);
		console.warn(warning);
	}
	return fallback;
}

// The agent dir backing a session. pi.createAgentSession({ agentDir }) lets a
// harness isolate a run under its own dir, and only ctx reports it; getAgentDir()
// is process-wide and would hand that run the operator's personal profile.
// ctx.agentDir is absent on pi builds that predate it, hence the fallback.
export function sessionAgentDir(ctx: ExtensionContext): string {
	return (ctx as ExtensionContext & { agentDir?: string }).agentDir ?? getAgentDir();
}

// The same dirs at extension load, where the factory registers models and the
// AskClaude tool. Those registrations are flushed before any event fires, so
// session_start is too late to correct them. pi.cwd/pi.agentDir are absent on
// pi builds that predate them (including published 0.82.1), where the process
// dirs were the only option.
//
// Where they are present, these are still the dirs of whichever session first
// loaded this module: pi keys its extension-module cache on the cwd alone, so a
// second same-cwd session re-runs the factory with its own dirs against shared
// module state. See providerOwnerClaimed in index.ts for who wins.
export function loadDirs(pi: ExtensionAPI): { cwd: string; agentDir: string } {
	const api = pi as ExtensionAPI & { cwd?: string; agentDir?: string };
	return { cwd: api.cwd ?? process.cwd(), agentDir: api.agentDir ?? getAgentDir() };
}

export function loadConfig(cwd: string, agentDir: string = getAgentDir()): Config {
	const global = tryParseJson(join(agentDir, "claude-bridge.json"));
	const project = tryParseJson(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"));
	const askClaude = { ...global.askClaude, ...project.askClaude } as NonNullable<Config["askClaude"]> & {
		defaultMode?: unknown;
	};
	const defaultMode = normalizeAskClaudeDefaultMode(
		askClaude.defaultMode,
		askClaude.allowFullMode,
	);
	if (defaultMode !== undefined) askClaude.defaultMode = defaultMode;

	const provider = { ...global.provider, ...project.provider } as NonNullable<Config["provider"]> & {
		claudeConfigDir?: unknown;
	};
	// Validate each source on its own rather than the merged value, so an invalid
	// project override falls back to a still-valid global setting (an authenticated
	// profile) instead of all the way to the built-in default.
	const globalClaudeConfigDir = normalizeClaudeConfigDir(global.provider?.claudeConfigDir);
	provider.claudeConfigDir = normalizeClaudeConfigDir(
		project.provider?.claudeConfigDir,
		globalClaudeConfigDir,
	);
	return {
		askClaude: askClaude as NonNullable<Config["askClaude"]>,
		provider: provider as NonNullable<Config["provider"]>,
	};
}
