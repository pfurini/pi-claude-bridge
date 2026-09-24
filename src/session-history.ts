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

/** Compare effective declarations without treating tool order or object key order as a policy change. */
export function snapshotTools(tools: readonly Tool[]): string {
	return fingerprint(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
		.sort((a, b) => a.name.localeCompare(b.name)));
}

/** Missing snapshots cannot establish that the session represents the incoming projection. */
export function matchesHistoryPrefix(snapshot: readonly string[] | undefined, incoming: readonly string[], length: number): boolean {
	return snapshot !== undefined && snapshot.length >= length && incoming.length >= length
		&& snapshot.slice(0, length).every((value, index) => value === incoming[index]);
}
