import type { EffortLevel, Options, SettingSource } from "@anthropic-ai/claude-agent-sdk";

export type CliDebugOptions = Pick<Options, "debug" | "debugFile" | "stderr">;

export interface ProviderQueryOptionsInput {
	cwd: string;
	baseEnv: NodeJS.ProcessEnv;
	cliModel: string;
	systemPromptAppend?: string;
	effort?: EffortLevel;
	settingSources?: SettingSource[];
	mcpServers?: Options["mcpServers"];
	resumeSessionId?: string | null;
	claudeExecutable?: string;
	strictMcpConfigEnabled: boolean;
	debugOptions?: CliDebugOptions;
}

export function buildProviderQueryOptions(input: ProviderQueryOptionsInput): Options {
	const extraArgs: Record<string, string | null> = { model: input.cliModel };
	if (input.strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
	if (input.effort) extraArgs["thinking-display"] = "summarized";

	return {
		cwd: input.cwd,
		env: {
			...input.baseEnv,
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
		},
		tools: [],
		permissionMode: "bypassPermissions",
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
		...(input.claudeExecutable ? { pathToClaudeCodeExecutable: input.claudeExecutable } : {}),
		...input.debugOptions,
	};
}

export interface AskClaudeQueryOptionsInput {
	cwd: string;
	baseEnv: NodeJS.ProcessEnv;
	cliModel: string;
	disallowedTools: string[];
	effort?: EffortLevel;
	skillsBlock?: string;
	resumeSessionId?: string | null;
	isolated?: boolean;
	claudeExecutable?: string;
	debugOptions?: CliDebugOptions;
}

export function buildAskClaudeQueryOptions(input: AskClaudeQueryOptionsInput): Options {
	const extraArgs: Record<string, string | null> = {
		"strict-mcp-config": null,
		model: input.cliModel,
	};
	if (input.effort) extraArgs["thinking-display"] = "summarized";

	return {
		cwd: input.cwd,
		env: {
			...input.baseEnv,
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
		},
		permissionMode: "bypassPermissions",
		...(input.disallowedTools.length ? { disallowedTools: input.disallowedTools } : {}),
		...(input.effort ? { effort: input.effort } : {}),
		systemPrompt: input.skillsBlock
			? { type: "preset", preset: "claude_code", append: input.skillsBlock }
			: undefined,
		settingSources: ["user", "project"],
		extraArgs,
		...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
		...(input.isolated ? { persistSession: false } : {}),
		...(input.claudeExecutable ? { pathToClaudeCodeExecutable: input.claudeExecutable } : {}),
		...input.debugOptions,
	};
}

export interface IsolatedSummaryQueryOptionsInput {
	cwd: string;
	baseEnv: NodeJS.ProcessEnv;
	systemPrompt: string;
	cliModel: string;
	claudeExecutable?: string;
	debugOptions?: CliDebugOptions;
}

export function buildIsolatedSummaryQueryOptions(input: IsolatedSummaryQueryOptionsInput): Options {
	return {
		cwd: input.cwd,
		env: {
			...input.baseEnv,
			DISABLE_AUTO_COMPACT: "1",
			CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
		},
		tools: [],
		strictMcpConfig: true,
		settingSources: [],
		skills: [],
		persistSession: false,
		systemPrompt: input.systemPrompt,
		model: input.cliModel,
		maxTurns: 1,
		...(input.claudeExecutable ? { pathToClaudeCodeExecutable: input.claudeExecutable } : {}),
		...input.debugOptions,
	};
}
