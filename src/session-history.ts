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
 * A reminder a Pi `context` hook adds to one request only. The fork's tasks reminder
 * (`fork-builtins/tasks/reminder.ts`) wraps the whole message in system-reminder tags, as Claude
 * Code's own todo reminders do. Only this shape counts: a projection can also omit a persisted
 * prompt (a context edit), and that omission must still rebuild.
 */
function isTransientReminder(message: Context["messages"][number]): boolean {
	if (message.role !== "user") return false;
	const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
	if (!blocks.every(block => block.type === "text")) return false;
	const text = blocks.map(block => (block as { text: string }).text).join("").trim();
	return text.startsWith("<system-reminder>") && text.endsWith("</system-reminder>");
}

/**
 * A request's history, with its trailing reminders marked transient: the next projection omits
 * them, and every other difference still counts.
 */
export function snapshotRequestHistory(messages: Context["messages"]): string[] {
	const history = messages.filter(message => message.role !== "system");
	const snapshot = snapshotHistory(history);
	for (let index = history.length - 1; index >= 0 && history[index].role === "user"; index--) {
		if (isTransientReminder(history[index])) snapshot[index] = TRANSIENT + snapshot[index];
	}
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
