import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface ReducedToolUse {
	id: string;
	name: string;
	input?: Record<string, unknown>;
}

export interface SdkSystemInit {
	sessionId: string;
	claudeCodeVersion?: string;
	tools: string[];
	mcpServers: Array<{ name: string; status: string }>;
}

export interface SdkTerminalResult {
	subtype: string;
	successful: boolean;
	isError: boolean;
	text: string;
	errorText?: string;
	terminalReason?: string;
	sessionId?: string;
}

export interface SdkMessageState {
	streamedText: string;
	assistantText: string;
	textDeltaCount: number;
	result?: SdkTerminalResult;
	sessionId?: string;
	systemInit?: SdkSystemInit;
	unknownMessageTypes: string[];
}

export interface SdkMessageReduction {
	type: string;
	textDelta?: string;
	toolUseStarted?: ReducedToolUse;
	toolUsesCompleted?: ReducedToolUse[];
	result?: SdkTerminalResult;
	sessionId?: string;
	systemInit?: SdkSystemInit;
	rateLimitInfo?: Record<string, unknown>;
	unknown?: boolean;
}

export function createSdkMessageState(): SdkMessageState {
	return {
		streamedText: "",
		assistantText: "",
		textDeltaCount: 0,
		unknownMessageTypes: [],
	};
}

export function parseSdkSystemInit(
	message: SDKMessage,
): SdkSystemInit | undefined {
	if (message.type !== "system") return undefined;
	const system = message as SDKMessage & {
		subtype?: string;
		session_id?: unknown;
		claude_code_version?: unknown;
		tools?: unknown;
		mcp_servers?: unknown;
	};
	if (system.subtype !== "init" || typeof system.session_id !== "string") {
		return undefined;
	}

	const tools = Array.isArray(system.tools)
		? system.tools.filter((tool): tool is string => typeof tool === "string")
		: [];
	const mcpServers = Array.isArray(system.mcp_servers)
		? system.mcp_servers.flatMap((server) => {
			if (!server || typeof server !== "object") return [];
			const { name, status } = server as { name?: unknown; status?: unknown };
			return typeof name === "string" && typeof status === "string"
				? [{ name, status }]
				: [];
		})
		: [];

	return {
		sessionId: system.session_id,
		...(typeof system.claude_code_version === "string"
			? { claudeCodeVersion: system.claude_code_version }
			: {}),
		tools,
		mcpServers,
	};
}

export function resultErrorText(
	message: SDKMessage,
	failureLabel = "Claude Code query",
): string {
	const result = message as SDKMessage & {
		subtype?: string;
		is_error?: boolean;
		result?: unknown;
		errors?: unknown;
		error?: unknown;
		terminal_reason?: unknown;
		session_id?: unknown;
	};
	let errorText: string;
	if (Array.isArray(result.errors) && result.errors.length > 0) {
		errorText = result.errors.map(String).join("\n");
	} else if (typeof result.error === "string" && result.error) {
		errorText = result.error;
	} else if (
		result.is_error === true &&
		typeof result.result === "string" &&
		result.result
	) {
		errorText = result.result;
	} else {
		errorText = `${failureLabel} failed: ${result.subtype ?? "unknown result"}`;
	}

	const context: string[] = [];
	if (typeof result.terminal_reason === "string") {
		context.push(`terminal_reason=${result.terminal_reason}`);
	}
	if (typeof result.session_id === "string") {
		context.push(`session_id=${result.session_id}`);
	}
	return context.length > 0 ? `${errorText} (${context.join(", ")})` : errorText;
}

export function parseSdkResult(
	message: SDKMessage,
	fallbackText = "",
	failureLabel = "Claude Code query",
): SdkTerminalResult | undefined {
	if (message.type !== "result") return undefined;
	const result = message as SDKMessage & {
		subtype?: string;
		is_error?: boolean;
		result?: unknown;
		terminal_reason?: unknown;
		session_id?: unknown;
	};
	const subtype = result.subtype ?? "unknown";
	const isError = result.is_error === true;
	const successful = subtype === "success" && !isError;
	const resultText = typeof result.result === "string" ? result.result : "";
	return {
		subtype,
		successful,
		isError,
		text: resultText || fallbackText,
		...(!successful
			? { errorText: resultErrorText(message, failureLabel) }
			: {}),
		...(typeof result.terminal_reason === "string"
			? { terminalReason: result.terminal_reason }
			: {}),
		...(typeof result.session_id === "string"
			? { sessionId: result.session_id }
			: {}),
	};
}

export function reduceSdkMessage(
	state: SdkMessageState,
	message: SDKMessage,
	options: { failureLabel?: string } = {},
): SdkMessageReduction {
	const type = String((message as { type?: unknown }).type ?? "unknown");
	const reduction: SdkMessageReduction = { type };

	if (type === "stream_event") {
		const event = (
			message as SDKMessage & {
				event?: {
					type?: string;
					delta?: { type?: string; text?: unknown };
					content_block?: { type?: string; id?: unknown; name?: unknown };
				};
			}
		).event;
		if (
			event?.type === "content_block_delta" &&
			event.delta?.type === "text_delta"
		) {
			const delta =
				typeof event.delta.text === "string" ? event.delta.text : "";
			state.streamedText += delta;
			state.textDeltaCount++;
			reduction.textDelta = delta;
		}
		if (
			event?.type === "content_block_start" &&
			event.content_block?.type === "tool_use"
		) {
			reduction.toolUseStarted = {
				id: String(event.content_block.id),
				name: String(event.content_block.name),
			};
		}
	} else if (type === "assistant") {
		const completed: ReducedToolUse[] = [];
		const assistant = message as SDKMessage & {
			message?: {
				content?: Array<{
					type?: string;
					text?: unknown;
					id?: unknown;
					name?: unknown;
					input?: Record<string, unknown>;
				}>;
			};
		};
		for (const block of assistant.message?.content ?? []) {
			if (block.type === "text" && typeof block.text === "string") {
				state.assistantText += block.text;
			} else if (block.type === "tool_use") {
				completed.push({
					id: String(block.id),
					name: String(block.name),
					input: block.input as Record<string, unknown> | undefined,
				});
			}
		}
		if (completed.length > 0) reduction.toolUsesCompleted = completed;
	} else if (type === "result") {
		const result = parseSdkResult(
			message,
			state.assistantText,
			options.failureLabel,
		);
		if (result) {
			state.result = result;
			reduction.result = result;
			if (result.sessionId) {
				state.sessionId = result.sessionId;
				reduction.sessionId = result.sessionId;
			}
		}
	} else if (type === "system") {
		const systemInit = parseSdkSystemInit(message);
		if (systemInit) {
			state.sessionId = systemInit.sessionId;
			state.systemInit = systemInit;
			reduction.sessionId = systemInit.sessionId;
			reduction.systemInit = systemInit;
		}
	} else if (type === "rate_limit_event") {
		const info = (
			message as SDKMessage & { rate_limit_info?: Record<string, unknown> }
		).rate_limit_info;
		if (info && typeof info === "object") reduction.rateLimitInfo = info;
	} else if (type !== "user") {
		state.unknownMessageTypes.push(type);
		reduction.unknown = true;
	}

	return reduction;
}
