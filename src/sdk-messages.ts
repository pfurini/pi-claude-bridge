import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface ReducedToolUse {
	id: string;
	name: string;
	input?: Record<string, unknown>;
}

export interface SdkTerminalResult {
	subtype: string;
	successful: boolean;
	isError: boolean;
	text: string;
	errorText?: string;
}

export interface SdkMessageState {
	streamedText: string;
	assistantText: string;
	textDeltaCount: number;
	result?: SdkTerminalResult;
	sessionId?: string;
	unknownMessageTypes: string[];
}

export interface SdkMessageReduction {
	type: string;
	textDelta?: string;
	toolUseStarted?: ReducedToolUse;
	toolUsesCompleted?: ReducedToolUse[];
	result?: SdkTerminalResult;
	sessionId?: string;
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

export function resultErrorText(message: SDKMessage, failureLabel = "Claude Code query"): string {
	const result = message as SDKMessage & { subtype?: string; errors?: unknown; error?: unknown };
	if (Array.isArray(result.errors)) return result.errors.map(String).join("\n");
	if (typeof result.error === "string") return result.error;
	return `${failureLabel} failed: ${result.subtype ?? "unknown result"}`;
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
	};
	const subtype = result.subtype ?? "unknown";
	const successful = subtype === "success";
	const resultText = typeof result.result === "string" ? result.result : "";
	return {
		subtype,
		successful,
		isError: result.is_error === true,
		text: resultText || fallbackText,
		...(successful ? {} : { errorText: resultErrorText(message, failureLabel) }),
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
		const event = (message as SDKMessage & {
			event?: {
				type?: string;
				delta?: { type?: string; text?: unknown };
				content_block?: { type?: string; id?: unknown; name?: unknown };
			};
		}).event;
		if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
			const delta = typeof event.delta.text === "string" ? event.delta.text : "";
			state.streamedText += delta;
			state.textDeltaCount++;
			reduction.textDelta = delta;
		}
		if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
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
		const result = parseSdkResult(message, state.assistantText, options.failureLabel);
		if (result) {
			state.result = result;
			reduction.result = result;
		}
	} else if (type === "system") {
		const system = message as SDKMessage & { subtype?: string; session_id?: unknown };
		if (system.subtype === "init" && typeof system.session_id === "string") {
			state.sessionId = system.session_id;
			reduction.sessionId = system.session_id;
		}
	} else if (type === "rate_limit_event") {
		const info = (message as SDKMessage & { rate_limit_info?: Record<string, unknown> }).rate_limit_info;
		if (info && typeof info === "object") reduction.rateLimitInfo = info;
	} else if (type !== "user") {
		state.unknownMessageTypes.push(type);
		reduction.unknown = true;
	}

	return reduction;
}
