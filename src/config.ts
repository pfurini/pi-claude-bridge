// User-facing extension config. Loaded once at extension registration from
// ~/.pi/agent/claude-bridge.json and the project Pi config directory, project
// overriding global. Missing or unparseable files are ignored (error to
// console.error, empty object returned) so the extension always starts.

import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
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
		settingSources?: SettingSource[];
		strictMcpConfig?: boolean;
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

// loadConfig runs at activation and again on every compaction, so an invalid value
// would otherwise reprint its warning over the TUI on each call.
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

export function loadConfig(cwd: string): Config {
	const global = tryParseJson(join(homedir(), ".pi", "agent", "claude-bridge.json"));
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
