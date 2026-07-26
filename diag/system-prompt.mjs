#!/usr/bin/env node
// Capture the exact system prompt Claude Code assembles for each model, without
// spending any quota. A local stub stands in for the Anthropic API: it records
// the outgoing request body and answers 400, so the prompt is observed from our
// own traffic and no upstream call is ever made.
//
// Two harness modes are captured per model:
//   cli    — the bundled binary run with `-p` (the unmodified Claude Code prompt)
//   bridge — buildProviderQueryOptions() from src/sdk-options.ts (what pi gets)
//
//   env -u ANTHROPIC_API_KEY node --import tsx diag/system-prompt.mjs
//   env -u ANTHROPIC_API_KEY node --import tsx diag/system-prompt.mjs bridge
//
// Requires a working subscription login. Note that the capture deliberately does
// NOT set CLAUDE_CONFIG_DIR: on macOS an explicit config dir makes Claude Code
// read file credentials instead of the Keychain, which fails when the token in
// that directory is stale. settingSources is pinned to [] so CLAUDE.md and user
// settings cannot pollute the per-model diff.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProviderQueryOptions } from "../src/sdk-options.ts";
import { buildHarnessCorrections } from "../src/harness-prompt.ts";
import { MODEL_IDS_IN_ORDER, resolveClaudeCodeRuntimeModel } from "../src/models.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTDIR = join(ROOT, ".test-output", "system-prompts");
const BIN = join(ROOT, "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude");
const PORT = Number(process.env.SYSTEM_PROMPT_CAPTURE_PORT || 8787);
const PER_CALL_MS = 120_000;

const mode = process.argv[2] ?? "both";
// Optional substring filter, so a single model can be re-measured without paying
// for the whole matrix (each cli-mode spawn boots the ~257 MB native binary).
const only = process.argv[3];
const MODELS = only
	? MODEL_IDS_IN_ORDER.filter((id) => id.includes(only))
	: MODEL_IDS_IN_ORDER;
if (!new Set(["cli", "bridge", "both"]).has(mode) || MODELS.length === 0) {
	process.stderr.write("usage: node diag/system-prompt.mjs [cli|bridge|both] [model-substring]\n");
	process.exit(2);
}
if (process.env.ANTHROPIC_API_KEY) {
	process.stderr.write("ANTHROPIC_API_KEY must be unset for subscription OAuth diagnostics\n");
	process.exit(2);
}

mkdirSync(OUTDIR, { recursive: true });
const cwd = mkdtempSync(join(tmpdir(), "system-prompt-"));

// --- capture stub -----------------------------------------------------------

let captured = null;
const server = createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		const raw = Buffer.concat(chunks).toString("utf8");
		if (req.method === "POST" && raw.length > 1000 && !captured) captured = raw;
		res.writeHead(400, { "content-type": "application/json" });
		res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "capture-stub" } }));
	});
});
await new Promise((done) => server.listen(PORT, "127.0.0.1", done));

const captureEnv = {
	ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
	CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

// The prompt is the third system block; the first two are the billing header and
// the one-line harness identity.
function mainPromptOf(raw) {
	const body = JSON.parse(raw);
	const blocks = Array.isArray(body.system) ? body.system : [{ text: String(body.system ?? "") }];
	return {
		text: blocks.at(-1)?.text ?? "",
		identity: blocks.length > 1 ? blocks[blocks.length - 2].text : null,
		toolCount: (body.tools ?? []).length,
		toolNames: (body.tools ?? []).map((t) => t.name),
	};
}

function record(label, raw) {
	if (!raw) {
		console.log(`MISS ${label}`);
		return;
	}
	const { text, identity, toolCount, toolNames } = mainPromptOf(raw);
	writeFileSync(join(OUTDIR, `${label}.txt`), text);
	writeFileSync(
		join(OUTDIR, `${label}.meta.json`),
		JSON.stringify({ identity, chars: text.length, toolCount, toolNames }, null, 2),
	);
	console.log(`ok   ${label.padEnd(28)} ${String(text.length).padStart(6)} chars, ${toolCount} tools`);
}

// --- cli mode ---------------------------------------------------------------

if (mode === "cli" || mode === "both") {
	for (const id of MODELS) {
		captured = null;
		// Must be async: spawnSync would block the event loop, so the capture stub
		// above could never answer and the child would hang until its own timeout.
		await new Promise((done) => {
			const child = spawn(
				BIN,
				["--model", id, "-p", "hi", "--max-turns", "1", "--strict-mcp-config", "--setting-sources", ""],
				{ cwd, env: { ...process.env, ...captureEnv }, stdio: "ignore" },
			);
			const timer = setTimeout(() => child.kill("SIGKILL"), PER_CALL_MS);
			child.on("exit", () => {
				clearTimeout(timer);
				done();
			});
			child.on("error", () => {
				clearTimeout(timer);
				done();
			});
		});
		record(`${id}.cli`, captured);
	}
}

// --- bridge mode ------------------------------------------------------------

if (mode === "bridge" || mode === "both") {
	const settings = { plan: "max", longContextExtraUsage: false };
	for (const id of MODELS) {
		captured = null;
		const { cliModelId } = resolveClaudeCodeRuntimeModel(id, settings);
		// index.ts, not the option builder, assembles the append. Mirror the part of
		// it that is deterministic so the captured prompt matches what pi receives.
		// AGENTS.md and the skills block are deliberately left out: they depend on
		// live pi state and would make the per-model diff machine-specific.
		const options = buildProviderQueryOptions({
			cwd,
			baseEnv: { ...process.env, ...captureEnv },
			claudeConfigDir: join(process.env.HOME, ".claude"),
			cliModel: cliModelId,
			systemPromptAppend: buildHarnessCorrections({
				modelId: id,
				cliModelId,
				toolsAreMcpOnly: true,
			}),
			settingSources: [],
			strictMcpConfigEnabled: true,
		});
		delete options.env.CLAUDE_CONFIG_DIR; // see header note
		try {
			for await (const message of query({ prompt: "hi", options })) {
				if (message.type === "result") break;
			}
		} catch {
			// the stub always answers 400; the request is captured before that
		}
		record(`${id}.bridge`, captured);
	}
}

server.close();
rmSync(cwd, { recursive: true, force: true });
console.log(`\nwrote ${OUTDIR}`);
process.exit(0);
