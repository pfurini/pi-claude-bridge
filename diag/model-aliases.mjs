#!/usr/bin/env node
// Resolve Claude Code's documented model aliases through an authenticated Agent
// SDK turn and record both system:init.model and result.modelUsage. Use
// subscription OAuth only. When Extra Usage is enabled, Fable and requests made
// after subscription limits are exhausted may consume metered credits.
//
//   env -u ANTHROPIC_API_KEY node diag/model-aliases.mjs pro on

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTDIR = join(ROOT, ".test-output", "context-size");
const ALIASES = ["fable", "opus", "sonnet", "haiku"];
const PER_CALL_MS = 120_000;
const PROMPT = 'Reply with just the word "yes".';

const plan = process.argv[2];
const extraUsage = process.argv[3];
if (
	!new Set(["pro", "max"]).has(plan) ||
	!new Set(["on", "off"]).has(extraUsage)
) {
	process.stderr.write("usage: node diag/model-aliases.mjs <pro|max> <on|off>\n");
	process.exit(2);
}

if (process.env.ANTHROPIC_API_KEY) {
	process.stderr.write("ANTHROPIC_API_KEY must be unset for subscription OAuth diagnostics\n");
	process.exit(2);
}

let pkg;
try {
	pkg = JSON.parse(
		readFileSync(
			join(ROOT, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
			"utf8",
		),
	);
} catch (error) {
	console.error(`failed to read Agent SDK metadata: ${error}`);
	process.exit(1);
}
mkdirSync(OUTDIR, { recursive: true });

async function probe(requestedAlias) {
	const cwd = mkdtempSync(join(tmpdir(), "model-alias-"));
	const abortController = new AbortController();
	const timer = setTimeout(() => abortController.abort(), PER_CALL_MS);
	let systemInit = null;
	let rateLimitEvent = null;
	let result = null;
	let error = null;

	try {
		for await (const message of query({
			prompt: PROMPT,
			options: {
				cwd,
				model: requestedAlias,
				settingSources: [],
				tools: [],
				strictMcpConfig: true,
				maxTurns: 1,
				persistSession: false,
				abortController,
			},
		})) {
			if (message.type === "system" && message.subtype === "init") {
				systemInit = {
					claudeCodeVersion: message.claude_code_version ?? null,
					model: message.model ?? null,
				};
			}
			if (message.type === "rate_limit_event")
				rateLimitEvent = message.rate_limit_info ?? null;
			if (message.type === "result") {
				result = message;
				break;
			}
		}
	} catch (caught) {
		error = caught?.message
			? `${caught.name}: ${caught.message}`
			: String(caught);
	} finally {
		clearTimeout(timer);
		rmSync(cwd, { recursive: true, force: true });
	}

	let status = result?.subtype ?? (error ? "error" : "no-result");
	if (result?.is_error) status = `error(is_error:${result.subtype})`;

	return {
		requestedAlias,
		systemInit,
		status,
		isError: result?.is_error ?? null,
		apiErrorStatus: result?.api_error_status ?? null,
		resultText: result?.result ?? null,
		terminalReason: result?.terminal_reason ?? null,
		modelUsage: result?.modelUsage ?? {},
		rateLimitEvent,
		error,
	};
}

const rows = [];
for (const alias of ALIASES) {
	process.stdout.write(`  ${alias} ... `);
	const row = await probe(alias);
	rows.push(row);
	const [servedModel, usage] = Object.entries(row.modelUsage)[0] ?? ["—", {}];
	process.stdout.write(
		`${row.status} init=${row.systemInit?.model ?? "—"} served=${servedModel}@${usage.contextWindow ?? "—"}\n`,
	);
}

const timestamp = new Date().toISOString();
const stamp = timestamp.replace(/[:.]/g, "-");
const report = {
	plan,
	extraUsage,
	timestamp,
	sdkVersion: pkg.version,
	claudeCodeVersion: pkg.claudeCodeVersion ?? null,
	apiKeySet: Boolean(process.env.ANTHROPIC_API_KEY),
	rows,
};
const prefix = `${plan}-extra-${extraUsage}-aliases-${stamp}`;
const jsonPath = join(OUTDIR, `${prefix}.json`);
const mdPath = join(OUTDIR, `${prefix}.md`);
const table = [
	"| requested alias | init model | served model | context | max out | status | Claude Code |",
	"|---|---|---|---|---|---|---|",
	...rows.map((row) => {
		const [servedModel, usage] = Object.entries(row.modelUsage)[0] ?? ["—", {}];
		return `| ${row.requestedAlias} | ${row.systemInit?.model ?? "—"} | ${servedModel} | ${usage.contextWindow ?? "—"} | ${usage.maxOutputTokens ?? "—"} | ${row.status} | ${row.systemInit?.claudeCodeVersion ?? "—"} |`;
	}),
].join("\n");

writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
	mdPath,
	`# Model aliases: ${plan}, Extra Usage ${extraUsage}\n\nSDK ${report.sdkVersion} (CC ${report.claudeCodeVersion}), ANTHROPIC_API_KEY=${report.apiKeySet}\n\n${table}\n`,
);
process.stdout.write(`\nsaved ${jsonPath}\n`);
process.stdout.write(`saved ${mdPath}\n\n`);
process.stdout.write(`${table}\n`);
