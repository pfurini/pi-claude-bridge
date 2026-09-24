/** Reconstruct Pi's prompt and tools before the bridge's extractors and history importer consume a request. */
import {
	contentText,
	getCurrentSystemMessage,
	getCurrentTools,
	type Context,
	type SystemMessage,
} from "@earendil-works/pi-ai";
import { sanitizeSystemSection } from "./sanitize-prompt.js";

type BridgeContext = Context & { bridgeSystemMessage?: SystemMessage };

/** Built-in sections retain canonical order after replay. Custom sections retain their replay-relative position. */
const SECTION_RANK = new Map<string, number>([
	["preamble", 0], ["tools", 1], ["rules", 2], ["docs", 3], ["addendum", 4],
	["project_context", 5], ["skills", 6], ["cwd", 7],
]);

/**
 * The map's entries, stably sorted by canonical rank. A name absent from the rank table
 * inherits its replayed predecessor's rank, so an already-canonical replay remains
 * unchanged and custom sections retain their position.
 */
function stableRanked(sections: Map<string, string>, ranks: Map<string, number>): Map<string, string> {
	let predecessorRank = -1;
	const ranked = [...sections].map(([name, value]) => {
		const rank = ranks.get(name) ?? predecessorRank;
		predecessorRank = rank;
		return { name, value, rank };
	});
	ranked.sort((a, b) => a.rank - b.rank);
	return new Map(ranked.map(({ name, value }) => [name, value]));
}

/** Render replayed system state in the same section order as pi's prompt builder. */
function canonicalSystemPrompt(message: SystemMessage | undefined): string | undefined {
	if (!message) return undefined;
	const sections = new Map<string, string>(
		Object.entries(message.sections ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
	);
	const parts = [contentText(message.content), ...stableRanked(sections, SECTION_RANK).values()]
		.filter((part) => part.length > 0);
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Restore the prompt and tools fields expected by the bridge and remove prompt-state
 * messages from conversation history. Contexts without system messages are returned
 * unchanged because systemless one-off calls already use the bridge-compatible shape.
 */
export function toBridgeContext(context: Context): BridgeContext {
	if (!context.messages.some((message) => message.role === "system")) return context;
	const tools = getCurrentTools(context.messages);
	const system = getCurrentSystemMessage(context.messages);
	return {
		...context,
		bridgeSystemMessage: system,
		systemPrompt: canonicalSystemPrompt(system),
		tools: tools.length > 0 ? tools : undefined,
		messages: nonSystemMessages(context.messages),
	};
}

/** An empty effective replacement is authoritative; only absent prompt state permits a legacy fallback. */
export function effectiveInstructions(context: Context, options: { forwardPiContent: boolean; skillsForwarded: boolean }): { text: string } | undefined {
	const system = (context as BridgeContext).bridgeSystemMessage;
	// Legacy flat prompts do not identify authored sections; retain capture-only behavior when Pi forwarding is disabled.
	if (!system) return !options.forwardPiContent || context.systemPrompt === undefined ? undefined : { text: context.systemPrompt };
	const sections = new Map(Object.entries(system.sections ?? {}).filter((entry): entry is [string, string] => entry[1] !== null));
	const parts = [contentText(system.content)];
	for (const [name, value] of stableRanked(sections, SECTION_RANK)) {
		if (name === "project_context" && !options.forwardPiContent) continue;
		if (name === "skills" && !options.skillsForwarded) continue;
		const authored = sanitizeSystemSection(name, value);
		if (authored) parts.push(authored);
	}
	return { text: parts.filter(Boolean).join("\n\n") };
}

/** `messages` with every prompt-state system message removed from conversation history. */
export function nonSystemMessages<T extends { role: string }>(messages: readonly T[]): T[] {
	return messages.filter((message) => message.role !== "system");
}
