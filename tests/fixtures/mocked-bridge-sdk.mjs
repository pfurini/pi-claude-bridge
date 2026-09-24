import { randomUUID } from "node:crypto";

// The mock exposes real MCP handlers while leaving tool execution to the test's Pi-side driver.
export function query(input) {
	const state = globalThis[Symbol.for("claude-bridge:built-contract-probe")];
	const ordinal = state.queries.push(input);
	const plan = state.plans?.shift() ?? {};
	state.onQuery?.(input);
	if (plan.failStart) throw new Error("MOCK_START_FAILURE");
	const session_id = input.options.resume ?? randomUUID();
	const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...plan.usage };
	const event = event => ({ type: "stream_event", session_id, event });
	let finish;
	const control = { closed: false, started: false, sessionId: session_id, prompts: [], done: new Promise(resolve => { finish = resolve; }) };
	(state.controls ??= []).push(control);
	return {
		close() { control.closed = true; if (!control.started) finish(); },
		async interrupt() {},
		async *[Symbol.asyncIterator]() {
			control.started = true;
			try {
				if (state.pauseNext) {
					state.pauseNext = false;
					await new Promise(resolve => { state.release = resolve; state.onPaused?.(); });
				}
				if (typeof input.prompt === "string") {
					state.prompts.push(input.prompt);
					control.prompts.push(input.prompt);
				} else {
					let first;
					const ready = new Promise(resolve => { first = resolve; });
					void (async () => {
						for await (const message of input.prompt) {
							state.prompts.push(message.message.content);
							control.prompts.push(message.message.content);
							first();
						}
					})().catch(() => first());
					await ready;
				}
				yield { type: "system", subtype: "init", session_id, claude_code_version: "mock-transport", tools: [] };
				if (plan.tool) {
					const id = `tool_${ordinal}`;
					const server = Object.values(input.options.mcpServers)[0].instance;
					const result = server.handlers.get("tools/call")({ params: { name: plan.tool, _meta: { "claudecode/toolUseId": id } } });
					yield event({ type: "message_start", message: { id: `msg_tool_${ordinal}`, usage } });
					yield event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: `mcp__custom-tools__${plan.tool}`, input: plan.arguments ?? {} } });
					yield event({ type: "content_block_stop", index: 0 });
					yield event({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage });
					yield event({ type: "message_stop" });
					control.toolResult = await result;
					control.closedWhenResult = control.closed;
				}
				if (plan.lateFinish) await plan.lateFinish;
				if (plan.failFinish) throw new Error("MOCK_LATE_FAILURE");
				const id = `msg_final_${ordinal}`;
				const text = plan.reply ?? "MOCK_BRIDGE_REPLY";
				yield event({ type: "message_start", message: { id, usage } });
				yield event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
				yield event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
				yield event({ type: "content_block_stop", index: 0 });
				yield event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage });
				yield event({ type: "message_stop" });
				yield { type: "assistant", session_id, message: { id, content: [{ type: "text", text }], usage } };
				yield { type: "result", subtype: "success", session_id, is_error: false, result: text, usage, total_cost_usd: 0, ...plan.result };
				if (plan.failAfterResult) throw new Error("MOCK_AFTER_RESULT");
			} finally { finish(); }
		},
	};
}
