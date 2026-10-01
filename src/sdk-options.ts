import type {
	EffortLevel,
	Options,
	SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeChildEnv } from "./claude-config.js";

export type CliDebugOptions = Pick<Options, "debug" | "debugFile" | "stderr">;

// Isolation switches shared by both spawn paths (provider and compaction).
// CLAUDE_CODE_DISABLE_AUTO_MEMORY=1: Claude Code's auto-memory section instructs
// the model to write memory files with the native Write tool, which neither path
// exposes (both send tools: []), so the instructions are unactionable. It is also the largest removable block in
// the preset prompt: on Claude Code 2.1.220 it accounts for roughly half of the
// legacy-family prompt (Sonnet 5: 26,762 -> 13,880 chars) and about a fifth of the
// new-family one (Opus 5: 9,287 -> 7,145). See diag/SYSTEM-PROMPTS.md.
//
// Auto-memory is additionally disabled through the SDK's flag-settings layer
// (settings.autoMemoryEnabled, the highest-priority settings tier), belt and
// braces with the env var. provider.autoMemoryEnabled=true opts back in and
// drops both; compaction summaries never opt in.
export const CLAUDE_ISOLATION_ENV_BASE = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
} as const;

export function claudeIsolationEnv(autoMemoryEnabled: boolean): Record<string, string> {
	return {
		...CLAUDE_ISOLATION_ENV_BASE,
		...(autoMemoryEnabled ? {} : { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }),
	};
}

// Pi owns context files on every spawn path, so Claude Code must not load its
// own on top: a project CLAUDE.md would arrive twice, and the user's
// ~/.claude/CLAUDE.md — a persona for a different harness, stamped "These
// instructions OVERRIDE any default behavior" — would outrank pi's AGENTS.md.
//
// Excludes rather than settingSources: the source gate that suppresses CLAUDE.md
// is the same one that reads settings.json, where Bedrock/Vertex users keep `env`
// and `apiKeyHelper`. Patterns match with picomatch against absolute
// paths; "**/CLAUDE.md" covers the user, ancestor, project and .claude/ copies,
// while rules need their own. Managed/policy memory is not excludable by design.
export const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/.claude/rules/**"];

export interface ProviderQueryOptionsInput {
	cwd: string;
	baseEnv: NodeJS.ProcessEnv;
	claudeConfigDir: string;
	cliModel: string;
	systemPromptAppend?: string;
	effort?: EffortLevel;
	settingSources?: SettingSource[];
	mcpServers?: Options["mcpServers"];
	resumeSessionId?: string | null;
	claudeExecutable?: string;
	strictMcpConfigEnabled: boolean;
	autoMemoryEnabled?: boolean;
	debugOptions?: CliDebugOptions;
}

export function buildProviderQueryOptions(
	input: ProviderQueryOptionsInput,
): Options {
	const extraArgs: Record<string, string | null> = { model: input.cliModel };
	if (input.effort) extraArgs["thinking-display"] = "summarized";
	const autoMemoryEnabled = input.autoMemoryEnabled ?? false;

	return {
		cwd: input.cwd,
		env: claudeChildEnv(input.claudeConfigDir, input.baseEnv, claudeIsolationEnv(autoMemoryEnabled)),
		// includeGitInstructions:false drops the gitStatus block from the preset.
		// That block is the trailing suffix of the cached system block, and a
		// git-state transition (new file, staging, commit) rewrites it — busting
		// the prompt cache for the whole conversation from there on (see
		// diag/probe-git-cache.mjs). The bridge re-invokes CC per turn, so this
		// hit on every transition. Cost here is nil: the setting also strips
		// CC's git-workflow guidance from its Bash tool prompt, but the provider
		// path runs CC with `tools: []`, so those definitions never ship.
		settings: {
			autoMemoryEnabled,
			claudeMdExcludes: CLAUDE_MD_EXCLUDES,
			includeGitInstructions: false,
		},
		tools: [],
		permissionMode: "bypassPermissions",
		allowDangerouslySkipPermissions: true,
		strictMcpConfig: input.strictMcpConfigEnabled,
		includePartialMessages: true,
		systemPrompt: {
			type: "preset",
			preset: "claude_code",
			append: input.systemPromptAppend || undefined,
		},
		extraArgs,
		...(input.effort ? { effort: input.effort } : {}),
		...(input.settingSources ? { settingSources: input.settingSources } : {}),
		...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
		...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
		...(input.claudeExecutable
			? { pathToClaudeCodeExecutable: input.claudeExecutable }
			: {}),
		...input.debugOptions,
	};
}

export interface IsolatedSummaryQueryOptionsInput {
	cwd: string;
	baseEnv: NodeJS.ProcessEnv;
	claudeConfigDir: string;
	systemPrompt: string;
	cliModel: string;
	effort?: EffortLevel;
	claudeExecutable?: string;
	debugOptions?: CliDebugOptions;
}

export function buildIsolatedSummaryQueryOptions(
	input: IsolatedSummaryQueryOptionsInput,
): Options {
	return {
		cwd: input.cwd,
		// Compaction never opts into auto-memory, regardless of provider config.
		env: claudeChildEnv(input.claudeConfigDir, input.baseEnv, claudeIsolationEnv(false)),
		settings: { autoMemoryEnabled: false, claudeMdExcludes: CLAUDE_MD_EXCLUDES },
		tools: [],
		strictMcpConfig: true,
		settingSources: [],
		skills: [],
		persistSession: false,
		systemPrompt: input.systemPrompt,
		model: input.cliModel,
		...(input.effort ? { effort: input.effort } : {}),
		maxTurns: 1,
		...(input.claudeExecutable
			? { pathToClaudeCodeExecutable: input.claudeExecutable }
			: {}),
		...input.debugOptions,
	};
}
