import type {
	EffortLevel,
	Options,
	SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeChildEnv } from "./claude-config.js";

export type CliDebugOptions = Pick<Options, "debug" | "debugFile" | "stderr">;

export type AskClaudeMode = "full" | "read" | "none";

// AskClaude cannot satisfy interactive or delayed workflows through Pi's tool call.
// RemoteTrigger is retained for wire-name compatibility even though the targeted
// Claude Code release does not expose it in the default SDK inventory (confirmed
// on 2.1.220).
const ASKCLAUDE_UNSUPPORTED_INTERACTIVE_TOOLS = [
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"ToolSearch",
	"ScheduleWakeup",
	"RemoteTrigger",
];

// None mode must block both the current Task/Workflow family and transitional
// delegation names. Read and full modes intentionally retain delegation access.
const ASKCLAUDE_DELEGATION_TOOLS = [
	"Agent",
	"Task",
	"TaskCreate",
	"TaskGet",
	"TaskList",
	"TaskOutput",
	"TaskStop",
	"TaskUpdate",
	"Workflow",
	"ReportFindings",
	"SendMessage",
];

const ASKCLAUDE_READ_RESTRICTIONS = [
	"Write",
	"Edit",
	"Bash",
	"NotebookEdit",
	"EnterWorktree",
	"ExitWorktree",
	"CronCreate",
	"CronDelete",
	"TeamCreate",
	"TeamDelete",
];

export interface AskClaudeToolPolicy {
	allowedTools: string[];
	disallowedTools: string[];
	skills?: Options["skills"];
}

export function getAskClaudeToolPolicy(mode: unknown): AskClaudeToolPolicy {
	const effectiveMode: AskClaudeMode =
		mode === "full" || mode === "none" || mode === "read" ? mode : "read";
	if (effectiveMode === "none") {
		return {
			allowedTools: [],
			disallowedTools: [
				...ASKCLAUDE_UNSUPPORTED_INTERACTIVE_TOOLS,
				"Read",
				"Write",
				"Edit",
				"Glob",
				"Grep",
				"Bash",
				...ASKCLAUDE_DELEGATION_TOOLS,
				"NotebookEdit",
				"EnterWorktree",
				"ExitWorktree",
				"CronCreate",
				"CronDelete",
				"TeamCreate",
				"TeamDelete",
				"WebFetch",
				"WebSearch",
				"Skill",
			],
			skills: [],
		};
	}
	return {
		allowedTools: ["Read", "Grep", "Glob"],
		disallowedTools: [
			...ASKCLAUDE_UNSUPPORTED_INTERACTIVE_TOOLS,
			...(effectiveMode === "read" ? ASKCLAUDE_READ_RESTRICTIONS : []),
		],
	};
}

export function getAskClaudeDisallowedTools(mode: AskClaudeMode): string[] {
	return getAskClaudeToolPolicy(mode).disallowedTools;
}

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
	debugOptions?: CliDebugOptions;
}

export function buildProviderQueryOptions(
	input: ProviderQueryOptionsInput,
): Options {
	const extraArgs: Record<string, string | null> = { model: input.cliModel };
	if (input.effort) extraArgs["thinking-display"] = "summarized";

	return {
		cwd: input.cwd,
		env: claudeChildEnv(input.claudeConfigDir, input.baseEnv, {
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
		}),
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

export interface AskClaudeQueryOptionsInput {
	cwd: string;
	baseEnv: NodeJS.ProcessEnv;
	claudeConfigDir: string;
	cliModel: string;
	mode: AskClaudeMode;
	effort?: EffortLevel;
	skillsBlock?: string;
	settingSources?: SettingSource[];
	resumeSessionId?: string | null;
	isolated?: boolean;
	claudeExecutable?: string;
	debugOptions?: CliDebugOptions;
}

export function buildAskClaudeQueryOptions(
	input: AskClaudeQueryOptionsInput,
): Options {
	const extraArgs: Record<string, string | null> = { model: input.cliModel };
	if (input.effort) extraArgs["thinking-display"] = "summarized";
	const policy = getAskClaudeToolPolicy(input.mode);

	return {
		cwd: input.cwd,
		env: claudeChildEnv(input.claudeConfigDir, input.baseEnv, {
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
		}),
		permissionMode: "bypassPermissions",
		allowDangerouslySkipPermissions: true,
		strictMcpConfig: true,
		includePartialMessages: true,
		...(policy.allowedTools.length
			? { allowedTools: policy.allowedTools }
			: {}),
		...(policy.disallowedTools.length
			? { disallowedTools: policy.disallowedTools }
			: {}),
		...(policy.skills !== undefined ? { skills: policy.skills } : {}),
		...(input.effort ? { effort: input.effort } : {}),
		systemPrompt: input.skillsBlock
			? { type: "preset", preset: "claude_code", append: input.skillsBlock }
			: undefined,
		settingSources: input.settingSources ?? ["user", "project"],
		extraArgs,
		...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
		...(input.isolated ? { persistSession: false } : {}),
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
	claudeExecutable?: string;
	debugOptions?: CliDebugOptions;
}

export function buildIsolatedSummaryQueryOptions(
	input: IsolatedSummaryQueryOptionsInput,
): Options {
	return {
		cwd: input.cwd,
		env: claudeChildEnv(input.claudeConfigDir, input.baseEnv, {
			DISABLE_AUTO_COMPACT: "1",
			CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
		}),
		tools: [],
		strictMcpConfig: true,
		settingSources: [],
		skills: [],
		persistSession: false,
		systemPrompt: input.systemPrompt,
		model: input.cliModel,
		maxTurns: 1,
		...(input.claudeExecutable
			? { pathToClaudeCodeExecutable: input.claudeExecutable }
			: {}),
		...input.debugOptions,
	};
}
