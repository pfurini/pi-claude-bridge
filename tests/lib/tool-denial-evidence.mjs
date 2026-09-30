// Check actual SDK tool-use IDs, not action-summary labels or model claims.
export function unexplainedToolRequests(frames, cliLog, forbiddenNames) {
	const forbidden = new Set(forbiddenNames.map(name => name.toLowerCase()));
	const requests = new Map();
	const results = new Map();
	const problems = [];
	for (const frame of frames) {
		const blocks = Array.isArray(frame.message?.content) ? frame.message.content : [];
		const streamed = frame.type === "stream_event" ? frame.event?.content_block : undefined;
		for (const block of [...blocks, ...(streamed ? [streamed] : [])]) {
			if (block.type === "tool_use" && forbidden.has(block.name?.toLowerCase())) {
				if (!block.id) { problems.push({ name: block.name, reason: "missing-tool-id" }); continue; }
				const previous = requests.get(block.id);
				if (previous && previous !== block.name) problems.push({ id: block.id, name: block.name, reason: "conflicting-tool-name" });
				requests.set(block.id, block.name);
			}
			if (block.type === "tool_result") {
				const matches = results.get(block.tool_use_id) ?? [];
				matches.push(block);
				results.set(block.tool_use_id, matches);
			}
		}
	}
	const unknown = new Map();
	for (const match of cliLog.matchAll(/^\d{4}-\d{2}-\d{2}T\S+ \[DEBUG\] Unknown tool ([^:\s]+): (\S+)\s*$/gm)) {
		unknown.set(match[2], match[1]);
	}
	for (const [id, name] of requests) {
		const replies = results.get(id) ?? [];
		if (replies.some(reply => reply.is_error !== true)) {
			problems.push({ id, name, reason: "successful-result" });
			continue;
		}
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const unavailable = new RegExp(`^(?:Error: )?No such tool(?: available)?: ${escaped}(?:[.!]|\\s*$)`);
		const denied = replies.some(reply => {
			const text = typeof reply.content === "string" ? reply.content : (reply.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
			return unavailable.test(text.trim().replace(/^<tool_use_error>/, "").replace(/<\/tool_use_error>$/, "").trim());
		});
		if (!denied && unknown.get(id) !== name) problems.push({ id, name, reason: "missing-denial" });
	}
	return problems;
}
