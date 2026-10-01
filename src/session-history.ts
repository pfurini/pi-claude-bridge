import { createHash } from "node:crypto";
import type { Context, Tool } from "@earendil-works/pi-ai";

function fingerprint(value: unknown): string {
	const serialized = JSON.stringify(value, (_key, item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return item;
		return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
	});
	return createHash("sha256").update(serialized).digest("hex");
}

/** Hash replayable content, excluding accounting, display details, and transient stream indexes. */
export function snapshotHistory(messages: Context["messages"]): string[] {
	return messages.filter(message => message.role !== "system").map(message => {
		const content = typeof message.content === "string" ? message.content : message.content.map(block => {
			switch (block.type) {
				case "text": return { type: block.type, text: block.text };
				case "image": return { type: block.type, data: block.data, mimeType: block.mimeType };
				case "thinking": return { type: block.type, thinking: block.thinking, thinkingSignature: block.thinkingSignature };
				case "toolCall": return { type: block.type, id: block.id, name: block.name, arguments: block.arguments };
				default: return block;
			}
		});
		return fingerprint({
			role: message.role, content,
			...(message.role === "assistant" ? { provider: message.provider } : {}),
			...(message.role === "toolResult" ? { toolCallId: message.toolCallId, isError: message.isError } : {}),
		});
	});
}

/** Marks a snapshot entry that a later projection may omit. */
const TRANSIENT = "~";

/**
 * A request's history, with its trailing user messages marked transient. A Pi `context` hook may
 * add messages to one request only (the fork's tasks reminder appends one), so the next projection
 * can omit them. Persisted prompts and steers reappear and still match.
 */
export function snapshotRequestHistory(messages: Context["messages"]): string[] {
	const snapshot = snapshotHistory(messages);
	const roles = messages.filter(message => message.role !== "system").map(message => message.role);
	for (let index = roles.length - 1; index >= 0 && roles[index] === "user"; index--) snapshot[index] = TRANSIENT + snapshot[index];
	return snapshot;
}

/** Compare effective declarations without treating tool order or object key order as a policy change. */
export function snapshotTools(tools: readonly Tool[]): string {
	return fingerprint(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
		.sort((a, b) => a.name.localeCompare(b.name)));
}

/**
 * How many `incoming` entries the recorded snapshot accounts for, in order. A recorded transient
 * entry the incoming projection omits is skipped; any other difference is a divergence (undefined).
 * Missing snapshots cannot establish that the session represents the incoming projection.
 */
export function alignHistory(recorded: readonly string[] | undefined, incoming: readonly string[]): number | undefined {
	if (recorded === undefined) return undefined;
	const bare = (entry: string) => entry.startsWith(TRANSIENT) ? entry.slice(TRANSIENT.length) : entry;
	let matched = 0;
	for (const entry of recorded) {
		if (matched < incoming.length && bare(incoming[matched]) === bare(entry)) matched++;
		else if (!entry.startsWith(TRANSIENT)) return undefined;
	}
	return matched;
}
