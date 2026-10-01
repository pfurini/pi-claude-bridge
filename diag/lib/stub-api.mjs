// Scripted stand-in for the Anthropic Messages API, for probing how Claude Code
// reacts to responses that cannot be provoked on demand (a refusal, a context
// window exhausted mid-generation). Point ANTHROPIC_BASE_URL at `url`; nothing
// reaches the real API, so a probe costs no quota.
//
// CC authenticates against the stub with whatever credential its profile holds.
// The stub never records headers, so no credential material is written anywhere.
//
// Every answer is SSE, including to a `stream: false` request, so the stub cannot
// stand in for CC's non-streaming fallback.
//
//   const api = await startStubApi((body, n) => sseMessage({ text: "hi", stopReason: "end_turn" }));
//   ... ANTHROPIC_BASE_URL: api.url ...
//   api.requests   // every /v1/messages body, in arrival order
//   api.close()

import { createServer } from "node:http";

/** Usage shaped like the live API's: message_delta repeats the prompt fields. */
export const STUB_USAGE = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 7 };

const event = (name, obj) => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;

/** One complete SSE response: a text block, an optional tool_use block
 *  (`toolUse: { id, name, input }`), then the given stop. */
export function sseMessage({ id = "msg_stub", model = "claude-haiku-4-5-20251001", text = "", toolUse, stopReason = "end_turn", stopDetails = null, usage = STUB_USAGE }) {
	const { output_tokens, ...prompt } = usage;
	const tool = toolUse
		? event("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: toolUse.id, name: toolUse.name, input: {} } })
			+ event("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(toolUse.input ?? {}) } })
			+ event("content_block_stop", { type: "content_block_stop", index: 1 })
		: "";
	return event("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, stop_details: null, usage: { ...prompt, output_tokens: 1 } } })
		+ event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
		+ event("ping", { type: "ping" })
		+ event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })
		+ event("content_block_stop", { type: "content_block_stop", index: 0 })
		+ tool
		+ event("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null, stop_details: stopDetails }, usage: { ...prompt, output_tokens } })
		+ event("message_stop", { type: "message_stop" });
}

/** True for the request carrying CC's main preset prompt, as opposed to a side
 *  request (title, quota probe) that a probe should answer neutrally. */
export function isPresetRequest(body) {
	const system = Array.isArray(body.system) ? body.system.map((b) => b.text ?? "").join("\n") : String(body.system ?? "");
	return system.includes("You are an interactive agent");
}

/** Start the stub. `respond(body, n)` returns the SSE text for the n-th (0-based)
 *  /v1/messages request. Every other path answers 404. */
export function startStubApi(respond) {
	const requests = [];
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			if (req.method !== "POST" || !req.url.startsWith("/v1/messages") || req.url.startsWith("/v1/messages/count_tokens")) {
				res.writeHead(404).end();
				return;
			}
			let body;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				res.writeHead(400).end();
				return;
			}
			const n = requests.push(body) - 1;
			res.writeHead(200, { "content-type": "text/event-stream", "request-id": `req_stub_${n}` });
			res.end(respond(body, n));
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
		url: `http://127.0.0.1:${server.address().port}`,
		requests,
		close: () => new Promise((done) => server.close(done)),
	})));
}
