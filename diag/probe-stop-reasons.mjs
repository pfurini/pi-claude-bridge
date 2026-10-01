#!/usr/bin/env node
// Which messages Claude Code puts on the SDK stream when a response stops on
// `refusal` or `model_context_window_exceeded`, and what the bridge makes of them.
//
// Neither stop can be provoked on demand, so diag/lib/stub-api.mjs answers CC's
// /v1/messages with scripted SSE instead. Each scenario runs the real SDK
// `query()` with the bridge's buildProviderQueryOptions, and feeds the stream
// through the bridge's own consumeQuery. CLAUDE_BRIDGE_RECORD_STREAM records
// every SDK message, so the raw stream doubles as a replay fixture.
//
//   node --import tsx diag/probe-stop-reasons.mjs [scenario ...] [--out DIR]
//
// No request reaches the real API. CC still authenticates with the bridge's
// profile (CLAUDE_CONFIG_DIR, else ~/.pi/agent/claude) and sends that credential
// to the local stub, which never records headers.
//
// Output, per scenario, in DIR (default .test-output/stop-reasons):
//   <scenario>.raw.jsonl   the SDK messages, verbatim and unscrubbed
//   <scenario>.json        the timeline, the stub's request count, and the
//                          pi-side events and final message the bridge produced
// tests/lib/record-sdk-streams.mjs --from-raw scrubs a raw file into a fixture.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { isPresetRequest, sseMessage, startStubApi } from "./lib/stub-api.mjs";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");
const MODEL = "claude-haiku-4-5";

// Each scenario scripts the answer to CC's n-th preset request. Side requests
// get a neutral end_turn. The partial text is what a real refusal or overflow
// leaves streamed before the stop arrives.
const SCENARIOS = {
	"end-turn": () => ({ text: "CONTROL", stopReason: "end_turn" }),
	refusal: () => ({ text: "PARTIAL", stopReason: "refusal", stopDetails: { type: "refusal", category: null, explanation: null } }),
	// A refused response that already streamed a call to a served tool. CC runs the
	// call of a final refusal and goes on, so the third request answers normally.
	"refusal-tool": (n) => (n > 2 ? { text: "DONE", stopReason: "end_turn" } : {
		text: "PARTIAL",
		toolUse: { id: `toolu_stub_${n}`, name: `mcp__custom-tools__${TOOL}`, input: {} },
		stopReason: "refusal",
		stopDetails: { type: "refusal", category: null, explanation: null },
	}),
	"context-window": () => ({ text: "PARTIAL", stopReason: "model_context_window_exceeded" }),
	// Same apiError family as context-window; the reference for CC's max-output recovery.
	"max-tokens": () => ({ text: "PARTIAL", stopReason: "max_tokens" }),
};
// Scenarios that serve TOOL over MCP, through a bare server that records each tools/call
// and answers at once. The others serve nothing, as their fixtures were recorded.
const TOOL = "probe";
const SERVES_TOOL = new Set(["refusal-tool"]);
const MAX_PRESET_REQUESTS = 8;

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
if (outIndex !== -1 && !args[outIndex + 1]) throw new Error("--out needs a directory");
const OUT = resolve(outIndex === -1 ? join(ROOT, ".test-output", "stop-reasons") : args[outIndex + 1]);
const named = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out" && args[i - 1] !== "--child");

if (args.includes("--child")) {
	await runScenario(args[args.indexOf("--child") + 1]);
	process.exit(0);
}

// The parent runs each scenario in its own process: src/index.ts reads
// CLAUDE_BRIDGE_RECORD_STREAM once, at import.
mkdirSync(OUT, { recursive: true });
for (const name of named.length ? named : Object.keys(SCENARIOS)) {
	if (!SCENARIOS[name]) throw new Error(`unknown scenario "${name}"; known: ${Object.keys(SCENARIOS).join(", ")}`);
	const raw = join(OUT, `${name}.raw.jsonl`);
	rmSync(raw, { force: true });
	const code = await new Promise((done) => {
		const child = spawn(process.execPath, ["--import", "tsx", SELF, "--child", name, "--out", OUT], {
			cwd: ROOT,
			stdio: "inherit",
			env: {
				...process.env,
				CLAUDE_BRIDGE_RECORD_STREAM: raw,
				CLAUDE_BRIDGE_DEBUG: "1",
				CLAUDE_BRIDGE_DEBUG_PATH: join(OUT, `${name}.debug.log`),
				CLAUDE_BRIDGE_DIAG_PATH: join(OUT, `${name}.diag.log`),
			},
		});
		child.on("exit", (c) => done(c));
	});
	if (code !== 0) throw new Error(`${name}: probe exited ${code}`);
}
console.log(`\nwrote ${OUT}`);

async function runScenario(name) {
	const script = SCENARIOS[name];
	const { query } = await import("@anthropic-ai/claude-agent-sdk");
	const { buildProviderQueryOptions } = await import("../src/sdk-options.ts");
	const { defaultClaudeConfigDir } = await import("../src/claude-config.ts");
	const { QueryContext } = await import("../src/query-state.ts");
	const { makePromptStream, userMessage } = await import("../src/prompt-stream.ts");
	const { __test } = await import("../src/index.ts");

	const toolCalls = [];
	let preset = 0;
	const api = await startStubApi((body, n) => {
		const id = `msg_stub_${String(n).padStart(2, "0")}`;
		if (!isPresetRequest(body)) return sseMessage({ id, text: "OK", stopReason: "end_turn" });
		preset++;
		// A script CC never stops answering would loop until the heap runs out.
		if (preset > MAX_PRESET_REQUESTS) return sseMessage({ id, text: "PROBE LOOP CUT", stopReason: "end_turn" });
		return sseMessage({ id, ...script(preset) });
	});
	const cwd = mkdtempSync(join(tmpdir(), "probe-stop-reasons-"));
	const options = buildProviderQueryOptions({
		cwd,
		baseEnv: { ...process.env, ANTHROPIC_BASE_URL: api.url, CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1" },
		claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || defaultClaudeConfigDir(),
		cliModel: MODEL,
		settingSources: [],
		strictMcpConfigEnabled: true,
		...(SERVES_TOOL.has(name) ? { mcpServers: toolServer(toolCalls) } : {}),
	});
	options.persistSession = false;
	const toolMap = new Map(SERVES_TOOL.has(name) ? [[`mcp__custom-tools__${TOOL}`, TOOL]] : []);

	// The prompt streams through the bridge's own PromptStream, as in production.
	// A string prompt makes the SDK throw on an is_error result, which the
	// bridge never sees: consumeQuery ends the stream at the result instead.
	const promptStream = makePromptStream();
	void promptStream.push(userMessage([{ type: "text", text: "Say hi." }])).catch(() => {});
	// Tap the SDK stream so the timeline keeps arrival order, then hand each
	// message to the bridge exactly as production does.
	const timeline = [];
	async function* tapped() {
		for await (const message of query({ prompt: promptStream.stream, options })) {
			timeline.push(describe(message));
			yield message;
		}
	}
	const events = [];
	const c = new QueryContext();
	c.currentPiStream = { push: (e) => events.push(e), end: () => events.push({ type: "end" }) };
	c.promptStream = promptStream;
	c.beginQuery();
	const model = { api: "anthropic-messages", provider: "claude-bridge", id: MODEL, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	c.resetTurnState(model);
	// The provider's settlement, reduced to what reaches pi: a clean return
	// finalizes the last segment, and a throw (the SDK raises one after an
	// is_error result) ends it as an error, keeping a cause consumeQuery recorded.
	let sdkThrew;
	try {
		await __test.consumeQuery(tapped(), toolMap, model, () => false, c);
		__test.finalizeCurrentStream(c, c.turnOutput?.stopReason);
	} catch (error) {
		sdkThrew = error instanceof Error ? error.message : String(error);
		if (c.turnOutput) {
			c.turnOutput.stopReason = "error";
			c.turnOutput.errorMessage ??= sdkThrew;
		}
		c.currentPiStream?.push({ type: "error", reason: "error", error: c.turnOutput });
		c.currentPiStream?.end();
	} finally {
		promptStream.fail(new Error("query ended"));
		await api.close();
		rmSync(cwd, { recursive: true, force: true });
	}

	const out = c.turnOutput;
	const report = {
		scenario: name,
		stubRequests: api.requests.length,
		presetRequests: preset,
		sdkThrew,
		toolCalls,
		timeline,
		piEvents: events.map((e) => e.type + (e.delta ? `:${JSON.stringify(e.delta)}` : "")),
		piMessage: out && {
			stopReason: out.stopReason,
			errorMessage: out.errorMessage,
			content: out.content.map((b) => b.type === "text" ? { text: b.text } : { type: b.type }),
			usage: { input: out.usage.input, output: out.usage.output, cacheRead: out.usage.cacheRead, cacheWrite: out.usage.cacheWrite },
		},
		queryTokenTotal: c.queryTokenTotal(),
	};
	writeFileSync(join(OUT, `${name}.json`), JSON.stringify(report, null, 2));
	console.log(`\n=== ${name}: ${api.requests.length} stub requests (${preset} preset)`);
	for (const line of timeline) console.log(`  ${line}`);
	console.log(`  pi events: ${report.piEvents.filter((e) => !e.includes("_delta")).join(" ")}`);
	console.log(`  pi: ${JSON.stringify(report.piMessage)}`);
	if (SERVES_TOOL.has(name)) console.log(`  MCP tools/call received: ${toolCalls.length}`);
}

/** A bare MCP server serving TOOL, recording each tools/call into `calls`. Not
 *  src/mcp-server.ts, whose handler would park until Pi delivered a result. */
function toolServer(calls) {
	const server = new McpServer({ name: "custom-tools", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: [{ name: TOOL, description: "Returns a value.", inputSchema: { type: "object", properties: {} } }],
	}));
	server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
		calls.push({ name: request.params.name, meta: request.params._meta ?? null });
		return { content: [{ type: "text", text: "VALUE" }] };
	});
	return { "custom-tools": { type: "sdk", name: "custom-tools", instance: server } };
}
function describe(m) {
	const clip = (s, n = 90) => (typeof s === "string" ? JSON.stringify(s.length > n ? `${s.slice(0, n)}…` : s) : String(s));
	if (m.type === "stream_event") {
		const e = m.event;
		if (e.type === "message_start") return `stream_event message_start id=${e.message?.id}`;
		if (e.type === "message_delta") return `stream_event message_delta stop_reason=${e.delta?.stop_reason} usage.in=${e.usage?.input_tokens}`;
		if (e.type === "content_block_delta") return `stream_event content_block_delta ${clip(e.delta?.text ?? e.delta?.type)}`;
		return `stream_event ${e.type}`;
	}
	if (m.type === "assistant") {
		const msg = m.message ?? {};
		const text = (msg.content ?? []).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("|");
		return `assistant id=${msg.id} model=${msg.model} error=${m.error ?? "-"} stop_reason=${msg.stop_reason ?? null} usage.in=${msg.usage?.input_tokens} text=${clip(text)}`;
	}
	if (m.type === "result") {
		return `result subtype=${m.subtype} is_error=${m.is_error} stop_reason=${m.stop_reason ?? null} terminal_reason=${m.terminal_reason ?? "-"} usage.in=${m.usage?.input_tokens} result=${clip(m.result)}`;
	}
	if (m.type === "system") return `system ${m.subtype}${m.subtype === "status" ? ` ${m.status}` : ""}${m.content ? ` ${clip(m.content)}` : ""}`;
	return m.type;
}
