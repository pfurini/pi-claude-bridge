import { calculateCost, StringEnum, type AssistantMessage, type AssistantMessageEventStream, type Context, type ImageContent, type Model, type SimpleStreamOptions, type TextContent, type Tool, type Usage, type UserMessage } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { buildSessionContext, compact, generateBranchSummary, keyHint, type BranchSummaryResult, type CompactionEntry, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { query, type SDKMessage, type SDKRateLimitInfo, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { createSession, deleteSession, openSession, repairToolPairing } from "cc-session-io";
import { appendFileSync, mkdirSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { PROVIDER_ID, messageContentToText, convertPiMessages } from "./convert.js";
import { applyLongContext, ASK_CLAUDE_THINKING_LEVELS, assertClaudeCodeModelAvailable, buildModels, claudeCodeModelId, type LongContextSettings, reportMissingModelIds, resolveEffort, resolveModel as _resolveModel } from "./models.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, extractSkillsBlock } from "./skills.js";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.js";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.js";
import { QueryContext, ctx, drainForAbort, reapLiveQueriesIfOwner } from "./query-state.js";
import { loadConfig, loadDirs, markStartupNoticeShown, sessionAgentDir, type Config } from "./config.js";
import { defaultClaudeConfigDir } from "./claude-config.js";
import { extractProjectContextBlock } from "./project-context.js";
import { sanitizeHarnessPrompt } from "./sanitize-prompt.js";
import { steeringAppendFor } from "./steering.js";
import { makePromptStream, userMessage } from "./prompt-stream.js";
import { collectCarriedAttachments, placeCarriedAttachments, type CarriedAttachment } from "./attachments.js";
import { createToolServer } from "./mcp-server.js";
import { buildAskClaudeQueryOptions, buildIsolatedSummaryQueryOptions, buildProviderQueryOptions, getAskClaudeDisallowedTools } from "./sdk-options.js";
import { buildHarnessCorrections } from "./harness-prompt.js";
import { createSdkMessageState, parseSdkResult, parseSdkSystemInit, rateLimitResetDate, rateLimitUtilizationPercent, reduceSdkMessage, type SdkTerminalResult } from "./sdk-messages.js";
import { buildActionSummary, formatUsageLine, type ToolCallState } from "./askclaude-ui.js";

// Compat (#2): use factory if available (pi-ai ≥0.66), else fall back to constructor (gsd-pi etc.)
const _piAi = piAi as any;
const newAssistantMessageEventStream: () => AssistantMessageEventStream =
	typeof _piAi.createAssistantMessageEventStream === "function"
		? _piAi.createAssistantMessageEventStream
		: () => new _piAi.AssistantMessageEventStream();

// --- Debug logging ---
// CLAUDE_BRIDGE_DEBUG=1 enables debug logging to ~/.pi/agent/claude-bridge.log

const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";
const DEBUG_LOG_PATH = process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(homedir(), ".pi", "agent", "claude-bridge.log");
// Redirectable so the unit suite's diagDump entries land in a throwaway dir
// instead of the real ~/.pi/agent/claude-bridge-diag.log. Explicit override wins;
// otherwise it tracks the debug log's directory (which setup.mjs already points at
// a temp dir), so setting CLAUDE_BRIDGE_DEBUG_PATH redirects both together.
const DIAG_LOG_PATH = process.env.CLAUDE_BRIDGE_DIAG_PATH || join(dirname(DEBUG_LOG_PATH), "claude-bridge-diag.log");

// CLAUDE_BRIDGE_RECORD_STREAM=<path> appends every SDK message consumeQuery sees,
// one JSON object per line. Used by tests/lib/record-sdk-streams.mjs to capture
// replay fixtures, so unit tests assert against message shapes Claude Code really
// emitted rather than ones we imagined.
const RECORD_STREAM_PATH = process.env.CLAUDE_BRIDGE_RECORD_STREAM;

// Ensure log directories exist when debug is enabled
if (DEBUG) {
	try {
		mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
		mkdirSync(dirname(DIAG_LOG_PATH), { recursive: true });
	} catch {
		// If directory creation fails, debug functions will throw on first use
	}
}

// Unique per module evaluation — confirms whether subagents share module state
const moduleInstanceId = Math.random().toString(36).slice(2, 8);

function debug(...args: unknown[]) {
	if (!DEBUG) return;
	const ts = new Date().toISOString();
	const fmt = (a: unknown): string => {
		if (typeof a === "string") return a;
		if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? "\n" + a.stack : ""}`;
		return JSON.stringify(a);
	};
	const msg = args.map(fmt).join(" ");
	appendFileSync(DEBUG_LOG_PATH, `[${ts}] [${moduleInstanceId}] ${msg}\n`);
}

// Per-query CLI debug capture. When CLAUDE_BRIDGE_DEBUG=1, ask the Claude Code
// CLI subprocess to write its own debug log to a file we choose, and also
// forward its stderr into our debug stream. Drops straight into the real SDK's
// Options — see @anthropic-ai/claude-agent-sdk sdk.d.ts:1245 (debug, debugFile,
// stderr). Without this, CC's internal view of the world is invisible to us
// and "No conversation found" / empty-error reports are unactionable.
let nextCliDebugSeq = 1;
function makeCliDebugOptions(tag: string): { debug?: boolean; debugFile?: string; stderr?: (data: string) => void } {
	if (!DEBUG) return {};
	const seq = nextCliDebugSeq++;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logDir = join(dirname(DEBUG_LOG_PATH), "cc-cli-logs");
	try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
	const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
	debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
	return {
		debug: true,
		debugFile,
		stderr: (data: string) => {
			for (const line of data.split(/\r?\n/)) {
				if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
			}
		},
	};
}

/** Unconditional diagnostic dump — for "should never happen" paths */
function diagDump(label: string, data: Record<string, unknown>) {
	const ts = new Date().toISOString();
	const entry = { ts, moduleInstanceId, label, ...data };
	appendFileSync(DIAG_LOG_PATH, JSON.stringify(entry) + "\n");
	debug(`DIAG: ${label} (see ${DIAG_LOG_PATH})`);
}

// --- Constants ---

// Global key to prevent re-registration of the provider across module reloads.
//
// Extensions like pi-subagents spawn a subagent and it loads this module
// again. Without this guard, the subagent's call to registerProvider() would
// overwrite the parent's `streamSimple` function reference in the shared
// ModelRegistry. When the parent later delivers a tool result, it would call
// the subagent's `streamSimple` (which has empty state) instead of its own.
//
// By storing the active streamSimple in a Symbol.for() global (shared across all
// module instances), we ensure only the FIRST instance to register takes effect.
// Subsequent instances wrap the stored function instead of overwriting it.
//
// On session_shutdown (including /reload), clearSession() resets this so a fresh
// registration can occur for the next session.
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

// Claude Code's own builtin tools, for the AskClaude path where CC really runs
// them. The provider path never sees these — it starts CC with `tools: []`.
const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read", write: "write", edit: "edit", bash: "bash",
};

// MODELS is buildModels(getModels("anthropic")) — projection kept in models.js.
// The catalog comes from whatever pi-ai the host pi installed, which may predate
// the ids the bridge registers, so report the gap once per module load. Subagents
// reload this module (see ACTIVE_STREAM_SIMPLE_KEY) and will re-emit it.
const PI_AI_MODELS = getModels("anthropic");
const MODELS = buildModels(PI_AI_MODELS);
reportMissingModelIds(PI_AI_MODELS);
// Read fresh on every request, so session_start re-applies them from the dirs
// ctx reports. Only the closure that registered the provider may do that; see
// the session_start handler.
let providerSettings: NonNullable<Config["provider"]> = {};
let effectiveClaudeConfigDir = defaultClaudeConfigDir();
// Load-time only, unlike the three above. applyLongContext() bakes these into
// the model list pi registers, and pi flushes registrations before the first
// event fires, so session_start cannot correct them. Re-reading them per
// session would let a request ask for a 1M window on a model registered at
// 200K, or refuse a Fable model that pi still lists in the picker.
let longContextSettings: LongContextSettings = { plan: "pro", longContextExtraUsage: false };

function resolveModel(input: string) {
	return _resolveModel(MODELS, input);
}

// --- Error handling ---

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try { return JSON.stringify(err); } catch {}
	}
	return String(err);
}


// --- Session persistence ---

interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
	// Force the next syncSharedSession call down the REBUILD path. Set when
	// pi has mutated its messages array out from under us (compact, tree
	// navigation) or after an abort left the JSONL in an indeterminate state.
	// REBUILD wipes and rewrites the file to match pi's current history.
	needsRebuild?: boolean;
	// Set ONLY after an abort. The killed CC subprocess may still be flushing
	// a late "[Request interrupted by user]" record to the session JSONL.
	// Reusing the same sessionId/path would race that orphan write into our
	// fresh file and break CC's parent-uuid chain on the next resume. When
	// this flag is set, REBUILD takes a fresh UUID and skips deleteSession
	// so the orphan writes land on a dead inode. Compact/tree do NOT set
	// this — there's no concurrent CC writer during those events, so
	// in-place rebuild (preserve UUID, deleteSession + createSession) is safe.
	forceRotate?: boolean;
}

/**
 * Claude Code's `@file` expansions from the session about to be replaced.
 *
 * Must be called before `deleteSession`, which wipes the file they live in —
 * reading after it yields nothing, with no error to notice.
 */
function readCarriedAttachments(sessionId: string, cwd: string, claudeConfigDir: string): CarriedAttachment[] {
	try {
		const previous = openSession({ sessionId, projectPath: cwd, claudeDir: claudeConfigDir });
		return collectCarriedAttachments(previous.records);
	} catch (error) {
		// A post-abort rebuild reads a file the killed CC subprocess may have been
		// midway through writing, and cc-session-io parses each line with a bare
		// JSON.parse, so a truncated last line throws. Throwing here would turn a
		// lost attachment into a failed turn; carrying none is exactly what happened
		// before this existed, so the failure mode is bounded by the status quo.
		debug(`WARNING: could not read attachments from session ${sessionId.slice(0, 8)}:`, error);
		return [];
	}
}

let sharedSession: SessionState | null = null;

// Convert pi messages to Anthropic API format for session import.
// Lossy: only text, thinking and toolCall blocks survive, and thinking only when
// Claude Code itself minted the signature. An assistant message whose blocks all
// filter out keeps its slot with a placeholder, since dropping it can create a
// tool_result with no preceding tool_use. A turn aborted before anything streamed
// is dropped instead — it never had content, and inventing one diverges from the
// prefix Claude Code cached.
function convertAndImportMessages(
	session: ReturnType<typeof createSession>,
	messages: Context["messages"],
	customToolNameToSdk?: Map<string, string>,
	carried?: readonly CarriedAttachment[],
): void {
	const { anthropicMessages, sanitizedIds, dropped } = convertPiMessages(messages, customToolNameToSdk);

	debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
	debug(`convertAndImportMessages: imported roles:`, anthropicMessages.map((m, i) => {
		const c = m.content;
		if (typeof c === "string") return `[${i}]${m.role}:text`;
		if (Array.isArray(c)) return `[${i}]${m.role}:${(c).map((b) => b.type).join("+")}`;
		return `[${i}]${m.role}:?`;
	}).join(" "));
	// The roles line above shows only what survived, so a stripped block is
	// indistinguishable there from one that never existed. Name the losses.
	const droppedParts = [
		dropped.thinking ? `${dropped.thinking} thinking (${[...dropped.providers].sort().join(", ")})` : "",
		dropped.abortedTurns ? `${dropped.abortedTurns} aborted turn(s)` : "",
		...[...dropped.other].map(([type, n]) => `${n} ${type}`),
	].filter(Boolean);
	if (droppedParts.length > 0) {
		debug(`convertAndImportMessages: dropped ${droppedParts.join(", ")}`);
	}
	if (sanitizedIds.size > 0) {
		debug(`convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
			[...sanitizedIds.entries()].map(([orig, clean]) => orig === clean ? orig : `${orig}→${clean}`).join(", "));
	}
	// Pre-repair for debug logging; importMessages also repairs internally (idempotent).
	const repaired = repairToolPairing(anthropicMessages);
	if (repaired.length !== anthropicMessages.length) {
		debug(`convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`);
	}
	// Placement runs against the repaired array because that is the index space
	// importMessages reads. Attachments are links in CC's uuid chain, so they have
	// to be written in order with the messages, not appended afterwards.
	const placed = carried?.length
		? placeCarriedAttachments(carried, repaired as unknown as { role: string; content: unknown }[])
		: undefined;
	if (placed?.skipped.length) {
		debug(`convertAndImportMessages: dropped ${placed.skipped.length} carried attachment(s): ${placed.skipped.join("; ")}`);
	}
	if (placed?.attachments.length) {
		debug(`convertAndImportMessages: carrying ${placed.attachments.length} attachment(s) across the rebuild`);
	}
	if (repaired.length) {
		session.importMessages(repaired, placed?.attachments.length ? { attachments: placed.attachments } : undefined);
	}
}

// Pi doesn't pass tool results directly — it appends them to the context and calls
// the provider again. Thin wrapper over extract-tool-results.js that adds per-turn
// debug logging at the extraction boundary.
function extractAllToolResults(context: Context): McpResult[] {
	const { results, stopIdx } = _extractAllToolResults(context.messages as unknown as Array<{ role: string; [key: string]: unknown }>);
	debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`);
	debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
	for (let r = 0; r < results.length; r++) {
		debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
	}
	return results;
}

/** Index of the first message of the current user turn — the trailing run of
 *  user messages that has not been written into the Claude Code session yet.
 *  Equals messages.length when the last message is not a user message.
 *
 *  Single source of truth for the history/prompt split: everything before this
 *  index is replayed as session history, everything from it onward becomes the
 *  prompt. Deriving both halves from one index is what keeps a message from
 *  landing in both — an extension appending a display-only user message after
 *  the real one (see issue #34) makes the turn longer than one message. */
function turnStart(messages: Context["messages"]): number {
	let i = messages.length;
	while (i > 0 && messages[i - 1].role === "user") i--;
	return i;
}

/** Extract the current user turn as a prompt string. Returns null if the last message is not a user message. */
function extractUserPrompt(messages: Context["messages"]): string | null {
	const turn = messages.slice(turnStart(messages)) as UserMessage[];
	if (turn.length === 0) return null;
	// Drop empties before joining so an all-empty turn still yields "" and trips
	// the caller's empty-prompt guard rather than sending bare newlines.
	return turn
		.map((m) => (typeof m.content === "string" ? m.content : messageContentToText(m.content)))
		.filter((text) => text)
		.join("\n");
}

/** Extract the current user turn as ContentBlockParam[] (preserving images).
 *  Returns null if no images — caller should fall back to string prompt. */
function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const turn = messages.slice(turnStart(messages)) as UserMessage[];
	if (turn.length === 0) return null;

	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const message of turn) {
		const content: (TextContent | ImageContent)[] = typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content;
		// Off-type content violates UserMessage's contract, so fail rather than
		// degrade — but name the shape, since the cause is almost always another
		// extension appending a malformed message, not this file.
		if (!Array.isArray(content)) {
			throw new Error(
				`extractUserPromptBlocks: user message content must be a string or block array, got ${typeof content} — likely a malformed message from another extension`,
			);
		}
		for (const block of content) {
			if (block.type === "text" && block.text) {
				blocks.push({ type: "text", text: block.text });
			} else if (block.type === "image") {
				// Guard before logging: data-less image blocks do occur, and reading
				// .length off the missing field in the debug template would throw
				// before this check ever runs (template args evaluate unconditionally).
				if (!block.data || !block.mimeType) {
					debug(`image block missing data or mimeType, skipping: keys=${Object.keys(block).join(",")}`);
					continue;
				}
				debug(`image block: mimeType=${block.mimeType}, data length=${block.data.length}`);
				hasImage = true;
				blocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: block.mimeType as Base64ImageSource["media_type"],
						data: block.data,
					},
				});
			}
		}
	}
	debug(`extractUserPromptBlocks: ${turn.length} msgs in turn, ${blocks.length} blocks, types=${blocks.map((b) => b.type).join(",")}`);
	return hasImage ? blocks : null;
}

function newAssistantOutput(model: Model<any>, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string, usage?: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function extractIsolatedSummaryPrompt(messages: Context["messages"]): string {
	if (messages.length !== 1 || messages[0].role !== "user") {
		throw new Error(
			`isolatedStreamFn: expected exactly 1 user message, got ${messages.length} ` +
			`(${messages.map((m) => m.role).join(",")})`,
		);
	}
	const promptText = extractUserPrompt(messages);
	if (!promptText) throw new Error("isolatedStreamFn: summarization prompt is empty");
	return promptText;
}

/** Failure text for an SDK result, or undefined when it succeeded. CC reports API failures
 *  (429 capacity, overload, prompt-too-long) with `is_error` on an otherwise success-shaped
 *  result; the dedicated error subtypes carry `errors` instead. Same semantics as
 *  sdk-messages' parseSdkResult failure path, but callable on its own where only the
 *  error text is needed (the above-guard failure recording in consumeQuery). */
function resultErrorText(message: SDKMessage): string | undefined {
	const result = message as SDKMessage & { subtype?: string; is_error?: boolean; result?: string; errors?: unknown; error?: unknown };
	if (result.subtype === "success") return result.is_error ? result.result || "Claude Code reported an error" : undefined;
	if (Array.isArray(result.errors) && result.errors.length) return result.errors.map(String).join("\n");
	if (typeof result.error === "string") return result.error;
	return `Claude Code failed: ${result.subtype ?? "unknown result"}`;
}

function isolatedStreamFn(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = newAssistantMessageEventStream();
	void runIsolatedSummary(model, context, options, stream);
	return stream;
}

async function runIsolatedSummary(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	let sdkQuery: ReturnType<typeof query> | undefined;
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		try { sdkQuery?.close(); } catch {}
	};

	try {
		const promptText = extractIsolatedSummaryPrompt(context.messages);
		const cwd = resolveCwd(options);
		// Session-time settings, like the provider and askClaude spawn paths, re-applied
		// on session_start. Reloading config for this cwd would take the executable from
		// one source and the profile (effectiveClaudeConfigDir) from another, so a
		// per-project override could split settings and sessions across two profiles.
		const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;
		const cliModel = claudeCodeModelId(model, longContextSettings);
		debug(`compact summary: spawn model=${cliModel} registeredModel=${model.id} promptLen=${promptText.length}`);

		sdkQuery = query({
			prompt: promptText,
			options: buildIsolatedSummaryQueryOptions({
				cwd,
				baseEnv: process.env,
				claudeConfigDir: effectiveClaudeConfigDir,
				systemPrompt: context.systemPrompt,
				cliModel,
				claudeExecutable,
				debugOptions: makeCliDebugOptions("compact-summary"),
			}),
		});
		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		const messageState = createSdkMessageState();
		let firstEventLogged = false;
		let summaryUsage: Usage | undefined;

		for await (const message of sdkQuery) {
			if (!firstEventLogged) {
				debug(`compact summary: first event type=${message.type}`);
				firstEventLogged = true;
			}
			if (wasAborted) break;

			const reduced = reduceSdkMessage(messageState, message, { failureLabel: "Claude Code summary" });
			if (reduced.result) {
				logServedContextWindow("compact summary", message, model);
				// Attribute the summarization's own token/cost spend to the summary
				// message. Verified in the fork: generateSummary returns the assistant
				// message's usage (compaction.ts:685), which flows into the
				// CompactionEntry.usage the summary is built with (compaction.ts:916),
				// so it surfaces in the /usage "Tools/summaries" bucket instead of being
				// silently discarded.
				summaryUsage = resultFrameToPiUsage(message);
				debug(`compact summary: usage in=${summaryUsage.input} out=${summaryUsage.output} cacheRead=${summaryUsage.cacheRead} cacheWrite=${summaryUsage.cacheWrite} cost=${summaryUsage.cost.total}`);
			}
		}

		if (wasAborted) {
			const output = newAssistantOutput(model, "", "aborted", "Operation aborted");
			debug("compact summary: aborted");
			stream.push({ type: "error", reason: "aborted", error: output });
			stream.end();
			return;
		}

		if (messageState.result && !messageState.result.successful) {
			debugTerminalFailure("compact summary", messageState.result);
		}
		const text = messageState.result?.successful ? messageState.result.text : messageState.assistantText;
		const errorText = messageState.result?.successful ? undefined : messageState.result?.errorText;
		if (errorText || !text.trim()) {
			const msg = errorText ?? "Claude Code summary returned empty text";
			debug(`compact summary: error ${msg}`);
			stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
			stream.end();
			return;
		}

		debug(`compact summary: done textLen=${text.length}`);
		stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, text, "stop", undefined, summaryUsage) });
		stream.end();
	} catch (err) {
		const msg = errorMessage(err);
		debug("runIsolatedSummary threw; pushing terminal error", err);
		stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
		stream.end();
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		try { sdkQuery?.close(); } catch {}
	}
}

function reinjectPriorCompactionFileOps(branchEntries: Array<{ type: string; details?: unknown }>, preparation: { fileOps: { read: Set<string>; edited: Set<string> } }): void {
	const prior = [...branchEntries]
		.reverse()
		.find((entry): entry is CompactionEntry => entry.type === "compaction");
	const details = prior?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
	if (!Array.isArray(details?.readFiles) || !Array.isArray(details?.modifiedFiles)) return;
	for (const file of details.readFiles) preparation.fileOps.read.add(String(file));
	for (const file of details.modifiedFiles) preparation.fileOps.edited.add(String(file));
	debug(`compact takeover: re-injected prior file ops read=${details.readFiles.length} modified=${details.modifiedFiles.length}`);
}

interface SyncResult {
	sessionId: string | null;
	preserveSharedSession?: boolean;
}

/**
 * Ensure the shared session has all messages up to (but not including) the last user message.
 * Returns session ID to resume from, or null if no resume needed.
 */
// Read the session file we just wrote and sanity-check it. Warns instead of
// throwing — CC may be more tolerant than our checks, so a false positive
// shouldn't block the user. Pure logic is in session-verify.js; this wrapper
// fans each warning out to debug log + piUI notify + diagDump.
function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
	cwd: string,
	claudeConfigDir: string,
): void {
	const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
	for (const msg of warnings) {
		debug(`WARNING session verify: ${msg}`);
		piUI?.notify(
			`Session file issue: ${msg}\n` +
			`cwd=${cwd} realpath=${safeRealpath(cwd)} claudeConfigDir=${claudeConfigDir}\n` +
			`Please copy and paste this message into a new issue at https://github.com/elidickinson/pi-claude-bridge/issues/new` +
			(DEBUG ? ` and attach ${DEBUG_LOG_PATH}` : ` (rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log)`),
			"warning",
		);
		diagDump("session_verify_fail", { msg, jsonlPath, cwd, realpath: safeRealpath(cwd), claudeConfigDir });
	}
}

function safeRealpath(p: string): string {
	try { return realpathSync(p); } catch (e) { return `<failed: ${(e as Error).message}>`; }
}

// Diagnostic snapshot of where a session file was just written. Catches the
// class of bugs where pi writes to ~/.claude/projects/<X> but CC SDK reads
// from ~/.claude/projects/<Y> (symlinks, CLAUDE_CONFIG_DIR, hash mismatch).
function debugSessionPaths(label: string, cwd: string, jsonlPath: string, claudeConfigDir: string): void {
	const realCwd = safeRealpath(cwd);
	let fileSize: number | null = null;
	let fileExists = false;
	try {
		const st = statSync(jsonlPath);
		fileExists = true;
		fileSize = st.size;
	} catch { /* file may not exist yet */ }
	debug(`${label}: cwd=${cwd}`);
	if (realCwd !== cwd) debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`);
	debug(`${label}: jsonlPath=${jsonlPath}`);
	debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
	debug(`${label}: claudeConfigDir=${claudeConfigDir} HOME=${process.env.HOME ?? "(unset)"}`);
}

function deleteEphemeralSession(sessionId: string, cwd: string, claudeConfigDir: string): void {
	deleteSession(sessionId, cwd, claudeConfigDir);
}

// Two semantic paths:
//   REUSE — pi's history is in sync with the existing sharedSession (or drifted
//     only by the trailing final-assistant message that pi appends after
//     streamSimple returns, which CC's own persisted session already has).
//     Returns the existing sessionId. Keeps CC's prompt cache warm.
//   REBUILD — no session yet, or pi's history has diverged (non-trailing
//     missed messages, e.g. another provider took a turn). Wipes the existing
//     session file (if any) and writes a fresh one containing all prior
//     messages, reusing the same sessionId across rebuilds so UUIDs stay
//     stable for the lifetime of pi's session.
//
// Why a full rebuild rather than patching:
//   Injecting deltas into an existing session creates a branch that CC's
//   --resume doesn't follow (documented attempt prior to this). A complete
//   overwrite at the same path is simpler and correct.
//
// Why reuse the sessionId across rebuilds:
//   CC re-reads the JSONL on every --resume call — no in-process UUID
//   caching. Validated in tests/exp-session-clear.mjs, including the case
//   where CC had appended its own tool_use/tool_result records between
//   rebuilds. Preserving the UUID means stable log correlation across
//   provider switches and no orphaned session files.
//
// Log strings still say "Case 1/2/3/4" so existing diagnostics (int-cache.sh,
// int-session-resume.mjs) keep grepping the same anchors.
function syncSharedSession(
	messages: Context["messages"],
	cwd: string,
	// Required, and positioned before the optional arguments, so a new call site cannot
	// silently fall back to the default profile while the Claude child reads from the
	// user's provider.claudeConfigDir override.
	claudeConfigDir: string,
	customToolNameToSdk?: Map<string, string>,
	modelId?: string,
): SyncResult {
	const priorMessages = messages.slice(0, turnStart(messages)); // everything before the current user turn

	// REUSE path
	//
	// Guard on priorMessages.length >= cursor: a shorter incoming context cannot
	// be a continuation of the cached session. This is the general invariant for
	// pi-side history rewrites such as /compact and session_tree: without it,
	// missed = [].slice(cursor) can falsely hit REUSE and resume an unrelated
	// longer CC session. See issue #25.
	if (sharedSession && !sharedSession.needsRebuild && priorMessages.length >= sharedSession.cursor) {
		const missed = priorMessages.slice(sharedSession.cursor);
		const trailingAssistantOnly =
			missed.length === 1 && (missed[0] as { role?: string }).role === "assistant";
		if (missed.length === 0 || trailingAssistantOnly) {
			if (trailingAssistantOnly) {
				sharedSession = { ...sharedSession, cursor: priorMessages.length, cwd };
			}
			debug(`Case 3: ${trailingAssistantOnly ? "advanced cursor past trailing assistant, " : ""}resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
			debug(`syncResult: path=reuse sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`);
			return { sessionId: sharedSession.sessionId };
		}
	}
	// This is what keeps a reentrant subagent from taking over the parent's
	// session: a subagent starts with priors of its own, shorter than the parent's
	// cursor, so it lands here, gets a fresh session, and the ephemeral session it
	// captures is deleted once its query completes (see preserveSharedSession in
	// the completion handler). Remove this branch and a subagent resumes — then
	// overwrites — the parent's session. The non-isolated AskClaude path reaches it
	// the same way.
	//
	// It is NOT, despite an earlier comment here, the isolated compact-summary
	// path: runIsolatedSummary never calls syncSharedSession at all.
	//
	// Only reachable when needsRebuild is false — user-facing history rewrites
	// (/compact, session_tree, /new, fork) always set needsRebuild or clear
	// sharedSession before the next syncSharedSession call.
	if (sharedSession && !sharedSession.needsRebuild && priorMessages.length < sharedSession.cursor) {
		debug(`Case 1 synthetic: clean start for shorter context, preserving shared session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
		debug(`syncResult: path=clean-start preserve-shared sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`);
		return { sessionId: null, preserveSharedSession: true };
	}

	// REBUILD path
	if (priorMessages.length === 0) {
		debug(`Case 1: clean start, ${messages.length} total messages`);
		debug(`syncResult: path=clean-start`);
		return { sessionId: null };
	}
	const previousSessionId = sharedSession?.sessionId;
	const previousCursor = sharedSession?.cursor ?? 0;
	// preserveId: rebuild in place (deleteSession + createSession with the
	// existing UUID), so prompt-cache UUIDs stay stable for log correlation
	// and for any tools that key off them. Skipped only when there's a
	// concurrent writer we shouldn't race — see forceRotate docs above.
	const preserveId = previousSessionId !== undefined && !sharedSession?.forceRotate;
	// Before deleteSession — it wipes the file these live in.
	const carried = previousSessionId !== undefined ? readCarriedAttachments(previousSessionId, cwd, claudeConfigDir) : [];
	if (preserveId) {
		// Wipe prior jsonl + companion dir (no-op if nothing to wipe).
		deleteSession(previousSessionId!, cwd, claudeConfigDir);
	}
	const session = createSession({
		projectPath: cwd,
		claudeDir: claudeConfigDir,
		...(preserveId ? { sessionId: previousSessionId } : {}),
		...(modelId ? { model: modelId } : {}),
	});
	convertAndImportMessages(session, priorMessages, customToolNameToSdk, carried);
	session.save();
	// records, not messages: `messages` filters out the attachment records that
	// carrying an `@file` expansion across a rebuild writes into the same file.
	verifyWrittenSession(session.jsonlPath, session.sessionId, session.records.length, cwd, claudeConfigDir);
	sharedSession = { sessionId: session.sessionId, cursor: priorMessages.length, cwd };
	if (previousSessionId === undefined) {
		debug(`Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.records.length} records`);
	} else if (preserveId) {
		const missedCount = priorMessages.length - previousCursor;
		debug(`Case 4: ${missedCount} missed messages, ${priorMessages.length} total → rewrote session ${session.sessionId.slice(0, 8)} (same id), ${session.records.length} records`);
	} else {
		debug(`Case 4 post-abort: ${priorMessages.length} total → new session ${session.sessionId.slice(0, 8)} (was ${previousSessionId.slice(0, 8)}, rotated to avoid race with orphan writer), ${session.records.length} records`);
	}
	debugSessionPaths(`${session.sessionId.slice(0, 8)}`, cwd, session.jsonlPath, claudeConfigDir);
	debug(`syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`);
	return { sessionId: session.sessionId };
}

// @internal
export const __test = {
	resetSharedSession() {
		sharedSession = null;
	},
	setSharedSession(state: SessionState | null) {
		sharedSession = state;
	},
	getSharedSession() {
		return sharedSession;
	},
	setPiUI(ui: ExtensionUIContext | null) {
		piUI = ui;
	},
	syncSharedSession,
	deleteEphemeralSession,
	extractUserPromptBlocks,
	updateUsage,
	resultFrameToPiUsage,
	consumeQuery,
	finalizeCurrentStream,
	resultErrorText,
	deliverToolResults,
	drainForAbort,
	buildMcpServers,
	branchSummaryOutcome,
};

// --- Provider helpers: tool name mapping ---

// AskClaude path: CC runs its own tools, so builtin names are real.
function mapToolName(name: string): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	if (normalized.startsWith(MCP_TOOL_PREFIX)) return name.slice(MCP_TOOL_PREFIX.length);
	return name;
}

// Provider path: the query runs with `tools: []`, so the only tools CC can
// legitimately call are the pi tools we serve over MCP. Any other name is the
// model hallucinating a builtin (`bash`, `Bash`, `Edit`, an MCP server we don't
// serve). CC answers those itself with "No such tool available" and retries
// inside the same query, never dispatching them to our MCP server — so a tool
// call under such a name must not reach pi. Forwarding one ran a tool CC never
// dispatched (real side effects) and, because the retry carries a fresh
// tool_use id, left the handler for the retry with no result to release it:
// pi's result arrived keyed to the dead id, and both sides deadlocked.
function piToolNameFor(name: string, customToolNameToPi: Map<string, string>): string | undefined {
	return customToolNameToPi.get(name) ?? customToolNameToPi.get(name.toLowerCase());
}

// Renames for Claude Code SDK param names that differ from pi's native names.
// Keys not listed here pass through unchanged, so new pi params work automatically.
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read:  { file_path: "path" },
	write: { file_path: "path" },
	edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

// Maps SDK tool args to pi tool args via key renaming + pass-through.
// Pi's own prepareArguments hooks handle any structural transforms (e.g. edit oldText/newText → edits[]).
function mapToolArgs(
	toolName: string, args: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value; // first alias wins
	}
	// Pi bash has no default timeout; add a safety default
	if (toolName.toLowerCase() === "bash" && result.timeout == null) {
		result.timeout = 120;
	}
	return result;
}

// --- Query state ---
// QueryContext lives in query-state.js so tests can import it without
// activating the extension.

// Global (not query state):
let piUI: ExtensionUIContext | null = null;
let piMode: ExtensionContext["mode"] | null = null;
// The user's own system prompt customisation (`--system-prompt`,
// `--append-system-prompt`), captured from before_agent_start. pi's assembled
// `context.systemPrompt` can't be forwarded wholesale — it describes pi's tools
// and harness and would fight Claude Code's own preset — but the user's text is
// theirs and has to reach the model, so it is kept separately.
let userSystemPrompt: { custom?: string; append?: string } = {};
const activeQueryContexts = new Set<QueryContext>();

// Defaults that silently cost the user something (no Opus 1M on Max, no
// AskClaude tool) are announced once. Deferred to the first bridge query rather
// than session_start: the notice persists a flag to the global config, and
// firing it on startup would write that file for every pi session that merely
// has this extension installed. One message, because consecutive info notifies
// overwrite each other in the TUI.
let pendingNotices: string[] = [];
// The agent dir the applied config came from, so the notice flag lands in the
// session's profile rather than the process-wide one (isolation, like
// effectiveClaudeConfigDir above). Undefined until a config is applied, which
// makes markStartupNoticeShown fall back to getAgentDir().
let effectiveAgentDir: string | undefined;

function showStartupNoticeOnce(): void {
	// `hasUI` is true in RPC mode too — it means dialogs are possible, not that a
	// human is watching. Only a terminal user can act on this.
	if (pendingNotices.length === 0 || piMode !== "tui") return;
	const notices = pendingNotices;
	pendingNotices = [];
	const path = markStartupNoticeShown(effectiveAgentDir);
	// pi wraps the whole notify string in the theme's dim foreground; the inner reset
	// drops back to the terminal default rather than dim, which is fine here.
	const title = `\x1b[33mWelcome to pi-claude-bridge\x1b[39m — settings live in ${path}`;
	const bullets = [...notices, "This message only appears once. See README.md for more."].map((n) => `• ${n}`);
	piUI?.notify([title, ...bullets, "─".repeat(64)].join("\n"), "info");
}

/** Whatever a settled session left behind, named in one greppable line.
 *
 *  Every one of these should be empty once the last turn ends, and each is a leak
 *  that costs something real: a retained context routes a later orphaned tool result
 *  into the delivery path and returns a stream nobody ends; a pending tool call is an
 *  MCP handler Claude Code is still waiting on; a live prompt stream is an unresolved
 *  ack. The activeQueryContexts leak was present on every single happy-path run and
 *  no test noticed, because nothing asserted that anything ends clean — so assert it
 *  where the real sessions are, and let diag/audit-warnings.mjs scan for it. */
function reportLeaks(label: string): void {
	const pendingCalls = [...activeQueryContexts].reduce((n, c) => n + c.pendingToolCalls.size, 0);
	const liveStreams = [...activeQueryContexts].filter((c) => c.promptStream !== null).length;
	if (activeQueryContexts.size === 0 && pendingCalls === 0 && liveStreams === 0) return;
	debug(
		`WARNING: ${label} left state behind — contexts=${activeQueryContexts.size} `
		+ `pendingToolCalls=${pendingCalls} promptStreams=${liveStreams}`,
	);
}

/** What pi's branch summary means for the navigation it was asked for.
 *
 *  Cancelling on failure matches pi's own path, which rethrows a summary error out
 *  of the navigation rather than moving without one. Separated from the event
 *  handler so this decision is testable without a Claude Code subprocess — driving
 *  `generateBranchSummary` itself would only be testing pi. */
function branchSummaryOutcome(result: BranchSummaryResult): { cancel: true } | { summary: { summary: string; details: unknown; usage?: BranchSummaryResult["usage"] } } {
	if (result.aborted) return { cancel: true };
	if (result.error) throw new Error(result.error);
	debug(`session_before_tree: takeover complete summaryLen=${result.summary?.length ?? 0}`);
	return {
		summary: {
			summary: result.summary ?? "",
			details: { readFiles: result.readFiles ?? [], modifiedFiles: result.modifiedFiles ?? [] },
			usage: result.usage,
		},
	};
}

function contextForToolResults(results: McpResult[]): QueryContext | undefined {
	for (const result of results) {
		const id = result.toolCallId;
		if (!id) continue;
		for (const queryCtx of activeQueryContexts) {
			if (queryCtx.pendingToolCalls.has(id) || queryCtx.pendingResults.has(id) || queryCtx.turnToolCallIds.includes(id)) {
				return queryCtx;
			}
		}
	}
	return undefined;
}

function resolveMcpTools(context: Context, excludeToolName?: string): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		if (tool.name === excludeToolName) continue;
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

// Creates an MCP server that bridges pi tools to the SDK. Each tool handler
// blocks on a Promise until pi delivers the tool result via streamSimple.
// Handlers receive their toolCallId from Claude's tools/call _meta, so results
// are matched by ID end to end.
//
// The handler and pi's result can arrive in either order, hence the two maps:
// a result that lands first waits in `pendingResults` for the handler to claim
// it, and a handler that runs first parks its resolver in `pendingToolCalls`.
// Handlers close over the captured `queryCtx`, ensuring they operate on the
// correct query's state while multiple queries run concurrently.
function buildMcpServers(tools: Tool[], queryCtx: QueryContext): Record<string, ReturnType<typeof createToolServer>> | undefined {
	if (!tools.length) return undefined;
	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
		handler: async (toolCallId: string) => {
			if (queryCtx.pendingResults.has(toolCallId)) {
				const result = queryCtx.pendingResults.get(toolCallId)!;
				queryCtx.pendingResults.delete(toolCallId);
				debug(`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`);
				return result;
			}
			debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
			return new Promise<McpResult>((resolve) => {
				queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
			});
		},
	}));
	return { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, mcpTools) };
}

// --- Usage helpers ---

function updateUsage(
	output: AssistantMessage,
	usage: Record<string, number | undefined> & { output_tokens_details?: { thinking_tokens?: number } },
	model: Model<any>,
	c: QueryContext = ctx(),
): void {
	// The live response's values are assignments (message_start then
	// message_delta refine the same response); the turn's reported usage is the
	// sum of completed responses plus the live one. See QueryContext.usageBase.
	if (usage.input_tokens != null) c.usageLive.input = usage.input_tokens;
	if (usage.output_tokens != null) c.usageLive.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) c.usageLive.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) c.usageLive.cacheWrite = usage.cache_creation_input_tokens;
	// Reasoning/thinking tokens are a subset of output_tokens, carried under
	// output_tokens_details.thinking_tokens (the top-level reasoning_tokens/
	// thinking_tokens fields never appear — 0 of 14,994 logged usage lines). Fold
	// through the same base+live pair so it sums across the turn's responses rather
	// than reporting only the last one.
	const thinkingTokens = (usage.output_tokens_details as { thinking_tokens?: number } | undefined)?.thinking_tokens;
	if (thinkingTokens != null) {
		c.usageLive.reasoning = thinkingTokens;
		c.turnSawReasoning = true;
	}
	output.usage.input = c.usageBase.input + c.usageLive.input;
	output.usage.output = c.usageBase.output + c.usageLive.output;
	output.usage.cacheRead = c.usageBase.cacheRead + c.usageLive.cacheRead;
	output.usage.cacheWrite = c.usageBase.cacheWrite + c.usageLive.cacheWrite;
	// Subset of output_tokens: informational only, never added to totalTokens.
	const reasoning = c.usageBase.reasoning + c.usageLive.reasoning;
	if (c.turnSawReasoning) output.usage.reasoning = reasoning;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
	const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
	const cachePct = promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * 100) : 0;
	const reasoningText = c.turnSawReasoning ? ` reasoning=${reasoning}` : "";
	debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id}`);
}

type TokenTotals = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** result.usage's four billable token fields, or undefined if the frame carried none. */
function resultUsageTokens(message: SDKMessage): TokenTotals | undefined {
	const raw = (message as SDKMessage & { usage?: Record<string, number | undefined> }).usage;
	if (!raw) return undefined;
	return {
		input: raw.input_tokens ?? 0,
		output: raw.output_tokens ?? 0,
		cacheRead: raw.cache_read_input_tokens ?? 0,
		cacheWrite: raw.cache_creation_input_tokens ?? 0,
	};
}

/** Cross-check the sum of `modelUsage`'s per-model token totals against
 *  `result.usage` (log-only). They should match; a divergence would reveal a
 *  CC-internal side-model call that `result.usage` (top-level loop only) omits —
 *  which cannot happen under the bridge's tools:[]/no-Task policies, so if it ever
 *  logs it is a new finding, not a reconciliation failure. */
function crossCheckModelUsage(message: SDKMessage, cc: TokenTotals): void {
	const sum = sumModelUsageTokens(message);
	if (!sum) return;
	const diverges = (["input", "output", "cacheRead", "cacheWrite"] as const).some((k) => sum[k] !== cc[k]);
	if (diverges) {
		debug(`reconcile: WARNING modelUsage != result.usage (possible CC-internal side-model call) modelUsage(in=${sum.input} out=${sum.output} cacheRead=${sum.cacheRead} cacheWrite=${sum.cacheWrite}) result(in=${cc.input} out=${cc.output} cacheRead=${cc.cacheRead} cacheWrite=${cc.cacheWrite})`);
	}
}

/** Adopt CC's `total_cost_usd` as the query's authoritative cost by truing up the
 *  still-open final segment: set its `cost.total` to `cc − Σ(closed segments'
 *  estimated cost.total)`, so pi's session sum (which reads `cost.total` per
 *  message) equals CC's figure exactly. Per-component costs and the closed
 *  segments' estimates are left untouched — only the final `total` is authoritative.
 *  A negative true-up is allowed and logged (catalog drift); the session sum stays
 *  exact regardless. Returns the cc/estimate/delta summary for the reconcile line,
 *  or undefined when the frame carried no cost (estimates then survive unchanged).
 *
 *  The final segment is necessarily open here: this runs only on a *success* result,
 *  which means the last response ended `end_turn`, so `closeSegment()` never banked
 *  it — `queryBankedCost` excludes it and the true-up cannot double-count. A 429 or
 *  other failure arriving after a tool boundary is an *error* result, which takes the
 *  branch that skips both adoption and reconciliation, leaving estimates intact. */
function adoptCcCost(message: SDKMessage, model: Model<any>, c: QueryContext): { cc: number; est: number; delta: number } | undefined {
	const cc = (message as SDKMessage & { total_cost_usd?: unknown }).total_cost_usd;
	if (typeof cc !== "number" || !c.turnOutput) {
		debug(`cost: no total_cost_usd on result, keeping estimates model=${model.id}`);
		return undefined;
	}
	const finalEstimate = c.turnOutput.usage.cost.total;
	const est = c.queryBankedCost + finalEstimate;
	const trueUp = cc - c.queryBankedCost;
	c.turnOutput.usage.cost.total = trueUp;
	const delta = cc - est;
	debug(`cost: cc=${cc} est=${est} delta=${delta} banked=${c.queryBankedCost} finalCost=${trueUp} model=${model.id}`);
	if (trueUp < 0) debug(`cost: WARNING negative final-segment cost.total=${trueUp} (catalog drift) — allowed, session sum stays exact`);
	return { cc, est, delta };
}

/** Reconcile the query's stream-derived token sum against CC's own `result.usage`
 *  at result time. Exact equality is expected (Decision 4): the provider runs CC
 *  with tools:[] and no Task, so no CC-native subagents exist and result.usage
 *  (top-level loop only) must equal our per-response sum. Match → one `reconcile:`
 *  debug line (carrying the cost delta from adoptCcCost); mismatch → a `WARNING:`
 *  line plus an unconditional diagDump carrying both sides and the per-segment
 *  breakdown. */
function reconcileQueryUsage(message: SDKMessage, model: Model<any>, c: QueryContext, cost?: { cc: number; est: number; delta: number }): void {
	const cc = resultUsageTokens(message);
	if (!cc) { debug("reconcile: result carried no usage, skipping"); return; }
	crossCheckModelUsage(message, cc);

	const total = c.queryTokenTotal();
	const ours: TokenTotals = { input: total.input, output: total.output, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite };
	const keys = ["input", "output", "cacheRead", "cacheWrite"] as const;
	const match = keys.every((k) => ours[k] === cc[k]);
	const segments = c.querySegments.length + 1; // closed segments + the open final one

	if (match) {
		const costText = cost ? ` cc=${cost.cc} est=${cost.est} costDelta=${cost.delta}` : "";
		debug(`reconcile: ok in=${ours.input} out=${ours.output} cacheRead=${ours.cacheRead} cacheWrite=${ours.cacheWrite} segments=${segments}${costText} model=${model.id}`);
		return;
	}

	const delta: TokenTotals = { input: ours.input - cc.input, output: ours.output - cc.output, cacheRead: ours.cacheRead - cc.cacheRead, cacheWrite: ours.cacheWrite - cc.cacheWrite };
	debug(`WARNING: reconcile mismatch model=${model.id} ours(in=${ours.input} out=${ours.output} cacheRead=${ours.cacheRead} cacheWrite=${ours.cacheWrite}) cc(in=${cc.input} out=${cc.output} cacheRead=${cc.cacheRead} cacheWrite=${cc.cacheWrite}) delta(in=${delta.input} out=${delta.output} cacheRead=${delta.cacheRead} cacheWrite=${delta.cacheWrite})`);
	const openSegment = { input: c.usageBase.input + c.usageLive.input, output: c.usageBase.output + c.usageLive.output, cacheRead: c.usageBase.cacheRead + c.usageLive.cacheRead, cacheWrite: c.usageBase.cacheWrite + c.usageLive.cacheWrite, reasoning: c.usageBase.reasoning + c.usageLive.reasoning };
	const session = typeof (message as SDKMessage & { session_id?: unknown }).session_id === "string" ? (message as SDKMessage & { session_id?: string }).session_id : undefined;
	diagDump("reconcile_mismatch", { model: model.id, session, ours, cc, delta, closedSegments: c.querySegments, openSegment });
}

/** Sum `modelUsage`'s per-model token totals, or undefined when the frame carries
 *  no modelUsage. Unlike result.usage (top-level loop only), this INCLUDES CC-native
 *  subagent activity — the token counterpart of what total_cost_usd already bills. */
function sumModelUsageTokens(message: SDKMessage): TokenTotals | undefined {
	const modelUsage = (message as SDKMessage & { modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }> }).modelUsage;
	if (!modelUsage) return undefined;
	const entries = Object.values(modelUsage);
	if (!entries.length) return undefined;
	const sum: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const v of entries) {
		sum.input += v.inputTokens ?? 0;
		sum.output += v.outputTokens ?? 0;
		sum.cacheRead += v.cacheReadInputTokens ?? 0;
		sum.cacheWrite += v.cacheCreationInputTokens ?? 0;
	}
	return sum;
}

/** Build a pi `Usage` from an SDK result frame. Cost components are left zero and
 *  `cost.total` adopts CC's `total_cost_usd` (Decision 6). Tokens prefer the
 *  `modelUsage` sum, which includes CC-native subagent activity, falling back to
 *  `result.usage` when modelUsage is absent — this matters for AskClaude read/full
 *  modes, which retain delegation tools (Agent/Task/Workflow), so a subagent's
 *  tokens would otherwise be undercounted while its cost was already billed.
 *  Reasoning is read from result.usage (modelUsage has no thinking breakdown) as an
 *  informational best-effort. Used by AskClaude and compaction summaries, which land
 *  in the "Tools/summaries" bucket of pi's /usage breakdown. */
function resultFrameToPiUsage(message: SDKMessage): Usage {
	const raw = (message as SDKMessage & { usage?: Record<string, number | undefined> & { output_tokens_details?: { thinking_tokens?: number } } }).usage;
	const totalCostUsd = (message as SDKMessage & { total_cost_usd?: unknown }).total_cost_usd;
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: typeof totalCostUsd === "number" ? totalCostUsd : 0 };
	const reasoning = raw?.output_tokens_details?.thinking_tokens;
	const modelSum = sumModelUsageTokens(message);
	const tokens = modelSum ?? {
		input: raw?.input_tokens ?? 0,
		output: raw?.output_tokens ?? 0,
		cacheRead: raw?.cache_read_input_tokens ?? 0,
		cacheWrite: raw?.cache_creation_input_tokens ?? 0,
	};
	return {
		...tokens,
		...(reasoning != null ? { reasoning } : {}),
		totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
		cost,
	};
}

// Log the *served* context window reported by an SDK result message
// (modelUsage[id].contextWindow), which can differ from the window pi
// registered (model.contextWindow) when the runtime entitlement doesn't
// match the docs — e.g. bare Opus served 200K on Pro, or [1m] not honored.
// The result message's modelUsage is otherwise discarded; this makes the
// gap observable. See issue #18.
function logServedContextWindow(label: string, message: SDKMessage, model: Model<any>): void {
	const modelUsage = (message as any).modelUsage as Record<string, { contextWindow?: number; maxOutputTokens?: number }> | undefined;
	if (!modelUsage) return;
	for (const [k, v] of Object.entries(modelUsage)) {
		debug(`${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`);
	}
}

// --- Provider helpers: misc ---

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		case "end_turn": default: return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}


// --- Provider: streaming function ---
//
// Push-based streaming with MCP tool bridge:
// 1. streamSimple starts a query() and kicks off consumeQuery() in background
// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
// 3. On tool_use: ends the current pi stream, nulls it out. The MCP handler
//    blocks the generator naturally — no events arrive until resolved.
// 4. Pi executes the tool, calls streamSimple again. We swap in the new stream,
//    resolve the MCP handler, and the generator unblocks — events flow to new stream.
//
// Note: resetTurnState clears turnSawStreamEvent while the generator may still
// have queued messages from the previous turn. This is safe because step 3 nulls
// currentPiStream, so any leftover messages hit the `!ctx().currentPiStream` guard
// in consumeQuery and are skipped before resetTurnState runs.

const completedStreams = new WeakSet<object>();

function markStreamComplete(stream: AssistantMessageEventStream | null): void {
	if (stream) completedStreams.add(stream as object);
}

function claimCurrentPiStream(stream: AssistantMessageEventStream, label: string, c: QueryContext): void {
	if (c.currentPiStream && !completedStreams.has(c.currentPiStream as object)) {
		debug(`WARNING: currentPiStream overwritten before terminal event (${label}); activeQuery=${Boolean(c.activeQuery)} pendingHandlers=${c.pendingToolCalls.size}`);
	}
	c.currentPiStream = stream;
}

function ensureTurnStarted(c: QueryContext): void {
	if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
		c.currentPiStream!.push({ type: "start", partial: c.turnOutput });
		c.turnStarted = true;
	}
}

function finalizeCurrentStream(c: QueryContext, stopReason?: string): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	debug(`provider: finalizeCurrentStream called, stopReason=${stopReason}, turnOutput=${JSON.stringify({stopReason: c.turnOutput!.stopReason, error: c.turnOutput!.errorMessage})}`);
	if (!c.turnStarted) ensureTurnStarted(c);
	const stream = c.currentPiStream;
	const isError = stopReason === "error" || c.turnOutput.stopReason === "error";
	if (isError) {
		stream.push({ type: "error", reason: "error", error: c.turnOutput });
	} else {
		const reason = stopReason === "length" ? "length" : "stop";
		stream.push({ type: "done", reason, message: c.turnOutput });
	}
	markStreamComplete(stream);
	stream.end();
	c.currentPiStream = null;
}

/** Maps Anthropic stream events to pi stream events (text, thinking, toolcall).
 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
function processStreamEvent(
	message: SDKMessage,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	c: QueryContext,
): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	c.turnSawStreamEvent = true;
	const event = (message as SDKMessage & { event: any }).event;

	if (event?.type === "message_start") {
		c.turnToolCallIds = [];
		// A new API response begins here: bank the previous one before its
		// successor's values start overwriting the live slot.
		c.beginUsageResponse();
		if (event.message?.usage) updateUsage(c.turnOutput, event.message.usage, model, c);
		return;
	}

	if (event?.type === "content_block_start") {
		ensureTurnStarted(c);
		if (event.content_block?.type === "text") {
			c.turnBlocks.push({ type: "text", text: "", index: event.index });
			c.currentPiStream!.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "thinking") {
			c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			c.currentPiStream!.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "tool_use") {
			const piName = piToolNameFor(event.content_block.name, customToolNameToPi);
			if (!piName) {
				debug(`processStreamEvent: skipping tool_use for unserved tool ${event.content_block.name} [${event.content_block.id}] — CC rejects it and retries`);
				return;
			}
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(event.content_block.id);
			c.turnBlocks.push({
				type: "toolCall", id: event.content_block.id,
				name: piName,
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "", index: event.index,
			});
			c.currentPiStream!.push({ type: "toolcall_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else {
			debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
		}
		return;
	}

	if (event?.type === "content_block_delta") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			c.currentPiStream!.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: c.turnOutput });
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			c.currentPiStream!.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: c.turnOutput });
		} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += event.delta.partial_json;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			c.currentPiStream!.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: c.turnOutput });
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		} else {
			debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		delete block.index;
		if (block.type === "text") {
			c.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			c.currentPiStream!.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: c.turnOutput });
		} else if (block.type === "toolCall") {
			c.turnSawToolCall = true;
			block.arguments = mapToolArgs(
				block.name, parsePartialJson(block.partialJson, block.arguments),
			);
			delete block.partialJson;
			c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
		}
		return;
	}

	if (event?.type === "message_delta") {
		c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
		if (event.usage) updateUsage(c.turnOutput, event.usage, model, c);
		return;
	}

	if (event?.type === "message_stop" && c.turnSawToolCall) {
		// Tool call complete — end this pi stream. The SDK will still yield an
		// assistant message for this turn, but currentPiStream=null causes
		// consumeQuery to skip it. The MCP handler blocks the generator until
		// pi delivers the tool result via the next streamSimple call.
		//
		// Bank this segment into the query totals BEFORE the tool-result delivery
		// calls resetTurnState and wipes usageBase/usageLive — see closeSegment.
		c.closeSegment();
		c.turnOutput.stopReason = "toolUse";
		const stream = c.currentPiStream;
		stream!.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		markStreamComplete(stream);
		stream!.end();
		c.currentPiStream = null;

		// Cursor is updated by the next streamSimple call (tool result delivery path)
		// which sets cursor = context.messages.length with the post-tool-result context.
		return;
	}

	if (event?.type !== "message_stop" && event?.type !== "ping") {
		debug("processStreamEvent: unhandled event type", event?.type);
	}
}

// The SDK always yields `assistant` messages (completed content blocks) after streaming.
// When stream_events already delivered the content, this is a no-op. But after
// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
// arrives before any stream_events, this is the primary content path. Must maintain
// the same stream lifecycle as processStreamEvent — including ending the stream on
// tool_use to prevent deadlock with the MCP handler.
function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>, c: QueryContext): void {
	if (c.turnSawStreamEvent) return;
	const assistantMsg = (message as any).message;
	if (!assistantMsg?.content) return;
	c.turnToolCallIds = [];
	debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`);
	for (const block of assistantMsg.content) {
		if (block.type === "text" && block.text) {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "text", text: block.text });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
			if (block.thinking) c.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: c.turnOutput });
		} else if (block.type === "tool_use") {
			const piName = piToolNameFor(block.name, customToolNameToPi);
			if (!piName) {
				debug(`processAssistantMessage: skipping tool_use for unserved tool ${block.name} [${block.id}] — CC rejects it and retries`);
				continue;
			}
			ensureTurnStarted(c);
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(block.id);
			c.turnBlocks.push({
				type: "toolCall", id: block.id,
				name: piName,
				arguments: mapToolArgs(piName, block.input),
			});
			const idx = c.turnBlocks.length - 1;
			const toolBlock = c.turnBlocks[idx];
			c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: c.turnOutput });
		} else {
			debug("processAssistantMessage: unhandled block type", block.type);
		}
	}
	// Non-streaming assistant message: its own API response, so bank the
	// previous one first.
	if (assistantMsg.usage && c.turnOutput) {
		c.beginUsageResponse();
		updateUsage(c.turnOutput, assistantMsg.usage, model, c);
	}

	// End the stream on tool_use, same as processStreamEvent's message_stop handler.
	if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
		// Bank this segment before resetTurnState wipes it — see closeSegment.
		c.closeSegment();
		c.turnOutput.stopReason = "toolUse";
		const stream = c.currentPiStream;
		stream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		markStreamComplete(stream);
		stream.end();
		c.currentPiStream = null;
	}
}

function debugTerminalFailure(label: string, result: SdkTerminalResult): void {
	debug(
		`${label}: terminal failure`,
		`subtype=${result.subtype} isError=${result.isError}`,
		`terminalReason=${result.terminalReason ?? "none"}`,
		`session=${result.sessionId?.slice(0, 8) ?? "none"}`,
	);
}

function systemInitSessionId(message: SDKMessage): string | undefined {
	return parseSdkSystemInit(message)?.sessionId;
}

function processRateLimitMessage(message: SDKMessage): void {
	const info = (message as SDKMessage & { rate_limit_info?: SDKRateLimitInfo })
		.rate_limit_info;
	debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
	if (info?.status === "rejected") {
		const resetsAt = rateLimitResetDate(info.resetsAt)?.toLocaleTimeString() ?? "unknown";
		piUI?.notify(`Claude rate limited (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`, "warning");
	} else if (info?.status === "allowed_warning") {
		const utilization = rateLimitUtilizationPercent(info.utilization);
		piUI?.notify(`Claude rate limit warning: ${utilization}% used (${info.rateLimitType ?? ""})`, "warning");
	}
}

/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
 *  an assistant message (completed blocks). On tool_use, the stream is ended by
 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
 *  and the MCP handler blocks the generator until pi delivers the tool result. */
async function consumeQuery(
	sdkQuery: ReturnType<typeof query>,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	wasAborted: () => boolean,
	queryCtx: QueryContext,
): Promise<{ capturedSessionId?: string }> {
	let capturedSessionId: string | undefined;

	for await (const message of sdkQuery) {
		if (RECORD_STREAM_PATH) appendFileSync(RECORD_STREAM_PATH, `${JSON.stringify(message)}\n`);
		if (wasAborted()) break;
		// Everything below the currentPiStream guard is content, which there is
		// nowhere to put once a turn has ended on a tool call. These three are not
		// content and must not share that gate:
		//
		// - stdin: nothing else closes the CLI's stdin now that the prompt is a
		//   streamed generator (isSingleUserTurn=false), so missing this hangs the query.
		// - the failure a `result` carries: it is the only record that the turn
		//   failed at all. Behind the guard, a 429 arriving at a tool boundary set
		//   no stopReason, no errorMessage, and logged nothing — the turn simply
		//   ended empty.
		// - rate-limit events: notifications to the user, which are most likely to
		//   fire during exactly the long tool-using turns the guard was skipping.
		let resultError: string | undefined;
		if (message.type === "result") {
			queryCtx.promptStream?.end();
			logServedContextWindow("result", message, model);
			resultError = resultErrorText(message);
			if (resultError !== undefined) {
				debug(`consumeQuery: error result, subtype=${message.subtype}, error=${resultError}`);
				if (queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = "error";
					queryCtx.turnOutput.errorMessage = resultError;
				}
			} else if (queryCtx.turnOutput) {
				// Success: adopt CC's total_cost_usd onto the still-open final segment,
				// then reconcile the query's stream-derived token sum against CC's own
				// result.usage. Both run above the currentPiStream guard so they fire
				// even when the final segment's stream was already finalized; the final
				// segment's turnOutput is finalized (pushed to pi) after consumeQuery,
				// so the cost override lands on the message pi receives.
				const cost = adoptCcCost(message, model, queryCtx);
				reconcileQueryUsage(message, model, queryCtx, cost);
			}
		}
		if (message.type === "rate_limit_event") {
			// processRateLimitMessage rather than inline: resetsAt is epoch seconds
			// and utilization a 0..1 fraction, and the helper owns those conversions.
			processRateLimitMessage(message);
			continue;
		}
		if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;

		switch (message.type) {
			case "stream_event":
				processStreamEvent(message, customToolNameToPi, model, queryCtx);
				break;
			case "assistant":
				processAssistantMessage(message, model, customToolNameToPi, queryCtx);
				break;
			case "result": {
				// The failure itself was recorded above the guard, along with the served
				// context window. What is left here is the success path: push the result
				// text when no stream event already delivered it, and capture the
				// session id the result carries.
				const terminalResult = parseSdkResult(message);
				capturedSessionId = terminalResult?.sessionId ?? capturedSessionId;
				if (resultError === undefined && terminalResult?.successful && !queryCtx.turnSawStreamEvent) {
					ensureTurnStarted(queryCtx);
					const text = terminalResult.text;
					queryCtx.turnBlocks.push({ type: "text", text });
					const idx = queryCtx.turnBlocks.length - 1;
					queryCtx.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: queryCtx.turnOutput });
				}
				break;
			}
			case "system":
				capturedSessionId = systemInitSessionId(message) ?? capturedSessionId;
				break;
			case "user":
				// SDK echo of the user prompt — no stream events to emit. Note it
				// carries only prompts and tool results: a steer CC drained at a
				// tool boundary is recorded in its session transcript as a
				// `queued_command` attachment and never reaches this stream, which
				// is why the mid-turn steering tripwire has to live in the
				// integration test.
				break;
			default:
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
	}

	// DEBUG: trace when consumeQuery exits
	debug(`consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`);

	return { capturedSessionId };
}

/** The trailing user turn as content blocks, or null if there isn't one.
 *  Blocks rather than text so image steers keep their images. */
function steerBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const blocks = extractUserPromptBlocks(messages);
	if (blocks) return blocks;
	const text = extractUserPrompt(messages);
	return text ? [{ type: "text", text }] : null;
}

/** A steer that never made it into CC's session. The cursor has already counted
 *  it, so count-based sync would skip it forever — rebuild instead, which
 *  re-imports the message from pi's context. */
function steerMissedSession(text: string): void {
	if (!sharedSession) return;
	sharedSession = { ...sharedSession, needsRebuild: true };
	debug(`provider: steer never reached CC, marked session for rebuild: ${text.slice(0, 60)}`);
}

/** Releases this turn's tool results to their MCP handlers, after first pushing
 *  any steer to CC.
 *
 *  The ordering is mandatory, not an optimization. The steer and the MCP tool
 *  result travel back to CC over the same stdin FIFO. Awaiting the push ack
 *  (which resolves only once the SDK's write to stdin completed) before
 *  resolving any handler guarantees CC enqueues the steer *before* it reads the
 *  tool result, so its post-tool-call drain sees it and acts on it this turn.
 *  Resolve first and the steer misses the drain, silently degrading to
 *  follow-up semantics.
 *
 *  Both the post-tool-call drain and the FIFO ordering are CC CLI internals,
 *  not SDK contract — tests/int-tool-message.mjs is the tripwire if they move. */
async function deliverToolResults(
	c: QueryContext,
	results: McpResult[],
	steer: ContentBlockParam[] | null,
	contextLength: number,
): Promise<void> {
	if (steer) {
		const text = steer.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
		if (!c.promptStream) {
			debug(`WARNING: steer with no prompt stream, dropping: ${text.slice(0, 60)}`);
			steerMissedSession(text);
		} else {
			try {
				await c.promptStream.push(userMessage(steer, "next"));
				debug(`provider: steer written to CC stdin before tool result: ${text.slice(0, 60)}`);
			} catch (error) {
				// The query is ending — pushing further input would wedge tool-result
				// delivery, so the steer doesn't reach this query. It is still in
				// pi's context, and the caller has already advanced the session
				// cursor past it, so force a rebuild or CC would never see it.
				debug(`provider: steer push rejected, delivering tool result anyway:`, error);
				steerMissedSession(text);
			}
		}
	}

	debug(`provider: tool results, ${results.length} results, ${c.pendingToolCalls.size} waiting handlers, ctx.msgs=${contextLength}`);
	for (const result of results) {
		const id = result.toolCallId;
		if (id && c.pendingToolCalls.has(id)) {
			const pending = c.pendingToolCalls.get(id)!;
			c.pendingToolCalls.delete(id);
			debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`, JSON.stringify(result.content).slice(0, 200));
			pending.resolve(result);
		} else if (id) {
			c.pendingResults.set(id, result);
			debug(`provider: queued result [${id}] (${c.pendingResults.size} pending)`);
		} else {
			debug(`WARNING: tool result without toolCallId, cannot match`);
		}
		if (c.pendingToolCalls.size > 0 && c.pendingResults.size > 0) {
			debug(`BUG: both maps non-empty! handlers=${c.pendingToolCalls.size} results=${c.pendingResults.size}`);
		}
	}
	if (c.pendingToolCalls.size > 0) {
		debug(`WARNING: ${c.pendingToolCalls.size} MCP handlers still waiting after delivering ${results.length} results`);
		piUI?.notify(`Claude bridge: ${c.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`, "warning");
	}
}

/** Provider entry point. Pi calls this for each new prompt and each tool result.
 *  Two cases: tool result delivery (active query) or fresh query. */
function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	showStartupNoticeOnce();
	const stream = newAssistantMessageEventStream();

	// DEBUG: trace followUp message triggering
	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	debug(`provider: streamClaudeAgentSdk called, activeQuery=${!!ctx().activeQuery}, lastMsgRole=${lastMsgRole}, isReentrant=${ctx().activeQuery !== null}`);

	const activeQuery = ctx().activeQuery !== null;
	const allResults = activeQueryContexts.size > 0 ? extractAllToolResults(context) : [];
	const resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined;
	const isReentrantUserQuery = activeQuery && lastMsgRole === "user" && allResults.length === 0;
	if (isReentrantUserQuery) {
		debug(`provider: active query user-only call treated as reentrant fresh query, waitingHandlers=${ctx().pendingToolCalls.size}, ctx.msgs=${context.messages.length}`);
	}

	// --- Tool result delivery ---
	// Pi appends tool results to context and calls back. Extract this turn's results
	// (everything after the last assistant message) and match against waiting MCP
	// handlers. Results that arrive before their handler get queued in pendingResults.
	if (resultCtx) {
		claimCurrentPiStream(stream, "tool-result", resultCtx);
		resultCtx.resetTurnState(model);
		// User messages (steer/followUp) pi injected into context during the
		// active query: a steer sent while a tool was executing, drained by pi at
		// the turn boundary and appended alongside the tool result.
		const steer = lastMsgRole === "user" ? steerBlocks(context.messages) : null;
		// Delivery is async because the steer must reach CC's stdin *before* the
		// tool result does — see deliverToolResults. Detached so the provider
		// still returns its stream synchronously.
		void deliverToolResults(resultCtx, allResults, steer, context.messages.length);
		// The shared cursor tracks the top-level conversation. A reentrant subagent
		// delivering its own results would drag it to that subagent's message count
		// — observed pulling a parent from 5 back to 3, which cost the parent's next
		// turn a full rebuild and a flushed prompt cache.
		if (sharedSession && resultCtx === ctx()) sharedSession.cursor = context.messages.length;
		resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length);
		return stream;
	}

	// --- Orphaned tool result (e.g. user aborted a tool call) ---
	// The query is gone but pi still delivered the result. Nothing to do — just
	// emit end_turn so pi waits for the next real user message.
	const lastMsg = context.messages[context.messages.length - 1];
	if (lastMsg?.role === "toolResult") {
		debug(`provider: orphaned tool result after abort, emitting end_turn`);
		if (sharedSession && activeQueryContexts.size === 0) sharedSession.cursor = context.messages.length;
		// No query owns this result, so there is no context to reset: resetTurnState
		// on the top-level ctx() would replace a live parent's turnOutput mid-stream,
		// stranding the blocks it had already emitted. A throwaway context just
		// supplies the empty message this turn ends with.
		const c = new QueryContext();
		c.resetTurnState(model);
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: c.turnOutput });
			markStreamComplete(stream);
			stream.end();
		});
		return stream;
	}

	// --- Fresh query ---

	// 1. Determine reentrancy. Reentrant queries get their own QueryContext so
	//    background subagents can run concurrently with the parent query.
	const isReentrant = activeQuery;
	const queryCtx = isReentrant ? new QueryContext() : ctx();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${activeQueryContexts.size}`);


	// 2. Fresh child context — constructor already gave us clean Maps and empty
	//    arrays. For a reused top-level context, clear explicitly.
	claimCurrentPiStream(stream, "fresh-query", queryCtx);
	queryCtx.pendingToolCalls.clear();
	queryCtx.pendingResults.clear();
	// Stale ids would let a late result from the previous query route here via
	// contextForToolResults — which now means pushing its steer into this
	// query's stdin, not just mismatching a map.
	queryCtx.turnToolCallIds = [];
	queryCtx.resetTurnState(model);
	// Clear the query-scoped usage accumulator here, where a query begins —
	// resetTurnState deliberately preserves it across tool-result deliveries.
	queryCtx.beginQuery();
	queryCtx.latestCursor = 0;

	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context, askClaudeToolName);
	const cwd = resolveCwd(options);
	// Pin the profile for the whole request. effectiveClaudeConfigDir is re-applied
	// on session_start, so a session starting while this query is in flight would
	// otherwise send the completion handler looking for the ephemeral session file
	// in a directory it was never written to, leaking it in the old one.
	const requestClaudeConfigDir = effectiveClaudeConfigDir;
	// cliModel is the actual id sent to Claude Code (may carry [1m]); model.id is the
	// pi-registered id. The rebuilt session records cliModel so the transcript names
	// the model CC actually runs, and debug lines reflect what CC received.
	const cliModel = claudeCodeModelId(model, longContextSettings);
	const syncResult = syncSharedSession(context.messages, cwd, requestClaudeConfigDir, customToolNameToSdk, cliModel);
	const { sessionId: resumeSessionId } = syncResult;
	const promptBlocks = extractUserPromptBlocks(context.messages);
	let promptText = extractUserPrompt(context.messages) ?? "";

	// Guard: empty prompt means the last context message isn't a user message.
	// This should never happen with per-query state — dump diagnostics if it does.
	if (!promptText && !promptBlocks) {
		diagDump("empty_prompt", {
			contextLength: context.messages.length,
			lastMsgRole: lastMsg?.role,
			isReentrant,
			activeQueryContexts: activeQueryContexts.size,
			activeQueryExists: queryCtx.activeQuery !== null,
			sharedSession: sharedSession ? { sessionId: sharedSession.sessionId.slice(0, 8), cursor: sharedSession.cursor } : null,
			messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
		});
		// Recover: use a continuation prompt so the SDK doesn't send an empty text block
		promptText = "[continue]";
	}

	// Always stream the prompt rather than passing a string: a parked input
	// generator is what lets us write steers to CC's stdin mid-turn. The cost is
	// that `isSingleUserTurn` is false, so the SDK no longer closes stdin on the
	// first result — consumeQuery ends the stream explicitly instead, or the
	// query would never terminate.
	const promptStream = makePromptStream();
	void promptStream.push(userMessage(promptBlocks ?? [{ type: "text", text: promptText }]))
		.catch((error) => debug(`provider: initial prompt push rejected:`, error));
	queryCtx.promptStream = promptStream;
	const mcpServers = buildMcpServers(mcpTools, queryCtx);
	// PI OWNS THE RULES. appendSystemPrompt gates exactly one thing: whether
	// pi's own content (context files, skills) is forwarded. The context files
	// come from pi's assembled system prompt - the same canonical set, order and
	// dedup a native pi session gets - never from a bridge-side re-discovery.
	const appendSystemPrompt = providerSettings.appendSystemPrompt !== false;
	const agentsAppend = appendSystemPrompt ? extractProjectContextBlock(context.systemPrompt) : undefined;
	const skillsAppend = appendSystemPrompt ? extractSkillsBlock(context.systemPrompt) : undefined;
	// Same gate: sanitizeHarnessPrompt's block dedupe only removes byte-exact
	// duplicates of what this session itself forwarded above, so it must see
	// context.systemPrompt only when that forwarding actually happened.
	const promptSanitizeSource = appendSystemPrompt ? context.systemPrompt : undefined;

	// PURE CLAUDE CODE BY DEFAULT. settingSources defaults to [] so the spawned
	// Claude Code loads no settings tiers and no CLAUDE.md of its own - rules
	// reach the model only through pi's channel above, in pi's order. Anything
	// Claude-Code-native (user/project/local settings, hooks, native CLAUDE.md
	// pickup) is explicit opt-in via provider.settingSources. This used to be
	// coupled to appendSystemPrompt, which silently changed which settings files
	// loaded when a user toggled a prompt flag, and let CC load the project's
	// CLAUDE.md natively next to pi's forwarded copy.
	const settingSources: SettingSource[] = providerSettings.settingSources ?? [];
	const strictMcpConfigEnabled = providerSettings.strictMcpConfig !== false;
	const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;

	const effort = resolveEffort(model, options?.reasoning);

	// Corrections follow the preset statements they override, and are not gated
	// on appendSystemPrompt: that setting controls whether pi's own content
	// (context files, skills) is forwarded, and turning it off must not leave the
	// model reading claims about its tools and ID that are false here.
	const corrections = buildHarnessCorrections({
		modelId: model.id,
		cliModelId: cliModel,
		toolsAreMcpOnly: true,
	});
	// Steering is bridge-owned and model-scoped like the corrections, NOT pi
	// content: it applies only to models it was validated on, so it is not gated
	// on appendSystemPrompt.
	const steeringAppend = steeringAppendFor(model.id, providerSettings.steeringModels);
	// The user's own --system-prompt/--append-system-prompt text goes last, so
	// what the user explicitly asked for wins over anything the bridge adds. It
	// is also ungated by appendSystemPrompt: that setting suppresses content the
	// bridge injects on its own, not what the user explicitly provided.
	//
	// pi-subagents' "append" prompt_mode embeds the parent's entire pi system
	// prompt (skeleton included) into userSystemPrompt.custom/.append; sanitize
	// strips that boilerplate so a subagent request doesn't carry pi's
	// self-identifying signature (see plans/subagent-prompt-sanitize.md).
	const sanitizedCustom = sanitizeHarnessPrompt(userSystemPrompt.custom, { sourcePrompt: promptSanitizeSource });
	const sanitizedAppend = sanitizeHarnessPrompt(userSystemPrompt.append, { sourcePrompt: promptSanitizeSource });
	if (sanitizedCustom !== userSystemPrompt.custom || sanitizedAppend !== userSystemPrompt.append) {
		debug(
			`provider: sanitizeHarnessPrompt stripped harness boilerplate, custom ${userSystemPrompt.custom?.length ?? 0}->${sanitizedCustom?.length ?? 0} chars, append ${userSystemPrompt.append?.length ?? 0}->${sanitizedAppend?.length ?? 0} chars`,
		);
	}
	const appendParts = [agentsAppend, skillsAppend, steeringAppend, corrections, sanitizedCustom, sanitizedAppend]
		.filter((part): part is string => Boolean(part));
	const systemPromptAppend = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;

	// Opus 4.7 defaults thinking.display to "omitted" (empty thinking text in stream).
	// Force summarized so thinking_delta events arrive. See anthropics/claude-agent-sdk-python#830.

	// Suppress claude.ai cloud MCP servers (Figma/Canva/etc. auto-discovered via OAuth).
	// strictMcpConfig blocks them in the target SDK; the environment switch remains as
	// defense in depth for older executable overrides and alternate loading paths.
	// DISABLE_AUTO_COMPACT=1: pi owns context-management and propagates its own
	// /compact via session_compact (see handler in default export). Letting CC
	// also autocompact would double-flush the prompt cache and races pi's
	// threshold with CC's, including CC's anti-thrashing guard (issue #8).
	// Manual /compact in CC still works (we never invoke it).
	const queryOptions = buildProviderQueryOptions({
		cwd,
		baseEnv: process.env,
		claudeConfigDir: requestClaudeConfigDir,
		cliModel,
		systemPromptAppend,
		effort,
		settingSources,
		mcpServers,
		resumeSessionId,
		claudeExecutable,
		strictMcpConfigEnabled,
		autoMemoryEnabled: providerSettings.autoMemoryEnabled,
		debugOptions: makeCliDebugOptions("provider"),
	});

	debug("provider: fresh query",
		`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
		`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
		`appendSys=${appendSystemPrompt} strictMcp=${strictMcpConfigEnabled}`,
		`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`);

	// 3. Start SDK query and claim it for this context
	let wasAborted = false;
	const sdkQuery = query({ prompt: promptStream.stream, options: queryOptions });
	queryCtx.activeQuery = sdkQuery;
	activeQueryContexts.add(queryCtx);

	// 4. Capture context for abort handling
	const abortCtx = queryCtx;

	const requestAbort = () => {
		// interrupt() asks the CLI to stop gracefully; close() kills it immediately.
		// Both are needed — interrupt alone lets the current API call finish.
		void sdkQuery.interrupt().catch(() => {});
		try { sdkQuery.close(); } catch {}
	};
	const onAbort = () => {
		wasAborted = true;
		drainForAbort(abortCtx, promptStream);
		requestAbort();
	};
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	// Background consumer — runs until query ends
	consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx)
		.then(async ({ capturedSessionId }) => {
			debug(`provider: consumeQuery completed, stopReason=${queryCtx.turnOutput?.stopReason}, error=${queryCtx.turnOutput?.errorMessage}, aborted=${wasAborted}`);

			// --- Abort detection in normal completion path ---
			if (wasAborted || options?.signal?.aborted) {
				if (sharedSession) sharedSession = { ...sharedSession, needsRebuild: true, forceRotate: true };
				debug(`provider: abort detected, marked sharedSession needsRebuild + forceRotate`);
				if (queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = "aborted";
					queryCtx.turnOutput.errorMessage = "Operation aborted";
				}
				const stream = queryCtx.currentPiStream;
				stream?.push({ type: "error", reason: "aborted", error: queryCtx.turnOutput! });
				markStreamComplete(stream);
				stream?.end();
				queryCtx.currentPiStream = null;
				return;
			}

			// --- Capture session ID ---
			const sessionId = capturedSessionId ?? sharedSession?.sessionId;
			if (syncResult.preserveSharedSession) {
				if (capturedSessionId && capturedSessionId !== sharedSession?.sessionId) {
					deleteEphemeralSession(capturedSessionId, cwd, requestClaudeConfigDir);
					debug(`provider: query done, deleted ephemeral session ${capturedSessionId.slice(0, 8)} to preserve shared session`);
				}
				debug(`provider: query done, ignoring captured session ${capturedSessionId?.slice(0, 8) ?? "none"} to preserve shared session`);
			} else if (sessionId) {
				const cursor = Math.max(context.messages.length, queryCtx.latestCursor, sharedSession?.cursor ?? 0);
				debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}`);
				sharedSession = { sessionId, cursor, cwd };
			}

			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				debug("provider: clearing activeQuery before final stream completion");
				queryCtx.activeQuery = null;
			}
			finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
		})
		.catch((error) => {
			debug(`provider: query error, model=${cliModel}, aborted=${Boolean(options?.signal?.aborted)}, error=`, error);
			if ((wasAborted || options?.signal?.aborted) && sharedSession) {
				sharedSession = { ...sharedSession, needsRebuild: true, forceRotate: true };
			} else {
				sharedSession = null;
			}
			promptStream.fail(error instanceof Error ? error : new Error(String(error)));
			if (queryCtx.turnOutput) {
				queryCtx.turnOutput.stopReason = options?.signal?.aborted ? "aborted" : "error";
				// The SDK drops its copy of the result text if any message follows the error
				// result, so prefer the cause consumeQuery recorded off the result itself.
				queryCtx.turnOutput.errorMessage ??= error instanceof Error ? error.message : String(error);
			}
			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				queryCtx.releasePendingToolCalls("Query ended");
				debug("provider: clearing activeQuery before error stream completion");
				queryCtx.activeQuery = null;
			}
			const stream = queryCtx.currentPiStream;
			stream?.push({ type: "error", reason: (queryCtx.turnOutput?.stopReason ?? "error") as "aborted" | "error", error: queryCtx.turnOutput! });
			markStreamComplete(stream);
			stream?.end();
			queryCtx.currentPiStream = null;
		})
		.finally(() => {
			if (options?.signal) options.signal.removeEventListener("abort", onAbort);
			// Settle any ack still parked in the generator — the CLI is gone, so
			// nothing will resume it. Clear the handle only if a later query
			// hasn't already claimed the shared context.
			promptStream.fail(new Error("query ended"));
			if (queryCtx.promptStream === promptStream) queryCtx.promptStream = null;
			// A later query claiming this context sets activeQuery to its own handle;
			// null means the .then/.catch above cleared ours and nothing replaced it.
			// Testing only for `=== sdkQuery` would never fire on the non-reentrant
			// path, leaving the top-level context in the routing set forever — where a
			// later orphaned tool result matches its stale turnToolCallIds and takes
			// the delivery branch, returning a stream nothing ends.
			if (queryCtx.activeQuery === sdkQuery || queryCtx.activeQuery === null) {
				queryCtx.releasePendingToolCalls("Query ended");
				queryCtx.activeQuery = null;
				activeQueryContexts.delete(queryCtx);
			}
			sdkQuery.close();
		});

	return stream;
}

// --- AskClaude: prompt and wait ---

async function promptAndWait(
	prompt: string,
	mode: "full" | "read" | "none",
	toolCalls: Map<string, ToolCallState>,
	signal?: AbortSignal,
	options?: {
		systemPrompt?: string;
		appendSkills?: boolean;
		model?: string;
		thinking?: string;
		isolated?: boolean;
		context?: Context["messages"];
		// The invoking session's cwd, from the tool's ExtensionContext. That is
		// authoritative where the module-level sessionCwd is only the last session
		// to start in this module instance, so pass it whenever it is in hand.
		cwd?: string;
	},
): Promise<{ responseText: string; stopReason: string; usage?: Usage }> {
	const cwd = resolveCwd(options);
	const requestedModel = options?.model ?? "opus";
	const model = resolveModel(requestedModel);
	const modelId = model?.id ?? requestedModel;
	if (!model) assertClaudeCodeModelAvailable(modelId, longContextSettings);
	const cliModel = model ? claudeCodeModelId(model, longContextSettings) : modelId;

	// Session resume for shared mode — reuse provider's session if it exists,
	// otherwise create one from pi's context.
	// Note: doesn't update sharedSession.cursor after completion, so the next
	// provider call will see missed messages and trigger a Case 4 rebuild.
	let resumeSessionId: string | null = null;
	if (!options?.isolated && options?.context?.length) {
		if (sharedSession) {
			// Provider already has a session — just resume from it
			// Any missed messages from other providers were already handled by the provider's Case 4
			resumeSessionId = sharedSession.sessionId;
		} else {
			// No provider session yet — create one from pi's context
			const contextWithPrompt = [...options.context, { role: "user" as const, content: prompt, timestamp: Date.now() }];
			const sync = syncSharedSession(contextWithPrompt as Context["messages"], cwd, effectiveClaudeConfigDir, undefined, cliModel);
			resumeSessionId = sync.sessionId;
		}
	}

	// Skills append. AskClaude runs on Claude Code's native tools, so pass
	// rewriteReadTool: false — the generic "Use the read tool" line stays correct,
	// where naming pi's MCP read tool would point the sub-agent at one it lacks. In
	// none mode Read is disallowed, so skip the block entirely: the sub-agent cannot
	// open a skill file, and forwarding the catalog would be pure token overhead.
	const readDisallowed = getAskClaudeDisallowedTools(mode).includes("Read");
	const skillsBlock = options?.appendSkills !== false && options?.systemPrompt && !readDisallowed
		? extractSkillsBlock(options.systemPrompt, { rewriteReadTool: false }) : undefined;

	// Corrections are only meaningful when the preset is actually sent, so this
	// mirrors the `usePreset` union in buildAskClaudeQueryOptions. Keep the two in
	// step: emitting corrections here is what makes the append non-empty, which is
	// the other half of that union. Unlike the provider, AskClaude keeps Claude
	// Code's native tools, so only the model ID is wrong here, plus the shell in
	// modes that block Bash.
	const presetActive = mode === "full" || Boolean(skillsBlock);
	const askClaudeCorrections = presetActive
		? buildHarnessCorrections({
			modelId,
			cliModelId: cliModel,
			toolsAreMcpOnly: false,
			noShellTool: getAskClaudeDisallowedTools(mode).includes("Bash"),
			noInteractiveChannel: true,
		})
		: undefined;
	const systemPromptAppend = [skillsBlock, askClaudeCorrections]
		.filter((part): part is string => Boolean(part))
		.join("\n\n") || undefined;

	// Effort — same model-aware lookup the provider path uses, so the same level
	// word means the same served tier through either interface.
	const effort = resolveEffort(model, options?.thinking);

	const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;


	debug("askClaude:",
		`mode=${mode} model=${modelId} cliModel=${cliModel} effort=${effort ?? "default"}`,
		`isolated=${options?.isolated ?? false} resume=${resumeSessionId?.slice(0, 8) ?? "none"}`,
		`skills=${Boolean(skillsBlock)} promptLen=${prompt.length}`);

	// skills: [] suppresses Claude Code's own skill listing, a system-reminder naming every
	// skill under the ~/.claude estate. The provider path gets this for free — `tools: []`
	// removes the Skill tool and the listing with it — but AskClaude runs on CC's native
	// tools, so it has to be asked for. Pi-side skills still arrive via skillsBlock below,
	// which is meant to be the only channel.
	const sdkQuery = query({
		prompt,
		options: buildAskClaudeQueryOptions({
			cwd,
			baseEnv: process.env,
			claudeConfigDir: effectiveClaudeConfigDir,
			cliModel,
			mode,
			effort,
			systemPromptAppend,
			resumeSessionId,
			isolated: options?.isolated,
			claudeExecutable,
			autoMemoryEnabled: providerSettings.autoMemoryEnabled,
			debugOptions: makeCliDebugOptions("askclaude"),
		}),
	});

	// Abort handling
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		sdkQuery.interrupt().catch(() => { try { sdkQuery.close(); } catch {} });
	};
	if (signal?.aborted) { onAbort(); throw new Error("Aborted"); }
	signal?.addEventListener("abort", onAbort, { once: true });

	let responseText = "";
	let sdkMessageCount = 0;
	const messageState = createSdkMessageState();
	let resultSubtype: string | undefined;
	let capturedUsage: Usage | undefined;

	try {
		for await (const message of sdkQuery) {
			if (wasAborted) break;
			sdkMessageCount++;

			const reduced = reduceSdkMessage(messageState, message);
			if (reduced.textDelta !== undefined) {
				responseText = messageState.streamedText;
			}
			if (reduced.toolUseStarted) {
				debug(`askClaude: tool_use start: ${reduced.toolUseStarted.name}`);
				toolCalls.set(reduced.toolUseStarted.id, {
					name: mapToolName(reduced.toolUseStarted.name),
					status: "running",
				});
			}
			for (const toolUse of reduced.toolUsesCompleted ?? []) {
				toolCalls.set(toolUse.id, {
					name: mapToolName(toolUse.name),
					status: "complete",
					rawInput: toolUse.input,
				});
			}
			if (reduced.result) {
				resultSubtype = reduced.result.subtype;
				const result = message as SDKMessage & {
					result?: unknown;
					usage?: Record<string, number | undefined> & { output_tokens_details?: { thinking_tokens?: number } };
					total_cost_usd?: unknown;
					num_turns?: number;
				};
				if (result.usage) {
					debug(`askClaude: result usage: in=${result.usage.input_tokens} out=${result.usage.output_tokens} cacheRead=${result.usage.cache_read_input_tokens ?? 0} cacheWrite=${result.usage.cache_creation_input_tokens ?? 0} turns=${result.num_turns ?? "?"}`);
				}
				// Attach the delegation's own spend to the tool result so it lands in
				// pi's /usage "Tools/summaries" bucket instead of being discarded. Tokens
				// prefer modelUsage (subagent-inclusive), since read/full modes keep the
				// delegation tools. Captured on failure too — a failed call still spent.
				capturedUsage = resultFrameToPiUsage(message);
				const resultText = typeof result.result === "string" ? result.result : "";
				if (!responseText && reduced.result.successful && resultText) {
					responseText = resultText;
				}
			}
		}

		if (!wasAborted && messageState.result && !messageState.result.successful) {
			debugTerminalFailure("askClaude", messageState.result);
			const failure = messageState.result.errorText ?? `Claude Code query failed: ${messageState.result.subtype}`;
			// A failed call still spent tokens; carry the usage on the error so the
			// tool result attributes it rather than losing it.
			throw Object.assign(new Error(failure), capturedUsage ? { usage: capturedUsage } : {});
		}

		const stopReason = wasAborted ? "cancelled" : "stop";
		debug(`askClaude: done`,
			`stopReason=${stopReason} resultSubtype=${resultSubtype ?? "none"}`,
			`sdkMessages=${sdkMessageCount} textDeltas=${messageState.textDeltaCount} responseLen=${responseText.length}`,
			`toolCalls=${toolCalls.size}`);
		return { responseText, stopReason, usage: capturedUsage };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		sdkQuery.close();
	}
}

// --- Extension registration ---

const DEFAULT_TOOL_DESCRIPTION_FULL = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself.";
const DEFAULT_TOOL_DESCRIPTION = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories). Read-only — Claude Code can explore the codebase but not make changes. Prefer to handle straightforward tasks yourself.";

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

// The name resolveMcpTools() maps pi's custom tools against, from the config of
// whichever session owns this module instance. See providerOwnerClaimed.
let askClaudeToolName = "AskClaude";
// Session cwd, cached from the one event that offers it. See the session_start
// handler: pi never puts cwd in stream options, so this is the only correct
// source, and process.cwd() is a last resort rather than the default.
let sessionCwd: string | undefined;
const resolveCwd = (options?: unknown): string =>
	(options as { cwd?: string } | undefined)?.cwd ?? sessionCwd ?? process.cwd();

// Claimed by the first factory run in this module instance, which is the one
// whose session may re-point the per-request settings above. Deliberately not
// derived from ACTIVE_STREAM_SIMPLE_KEY: clearSession() nulls that global on the
// owner's own first session_start (the /reload seam), so a second session's
// factory would see it free and claim ownership too. /reload is still handled,
// because pi's reload() calls clearExtensionCache() and the re-imported module
// gets a fresh scope with this back at false.
let providerOwnerClaimed = false;

export default function (pi: ExtensionAPI) {
	// Split by lifecycle, because the two halves cannot be corrected at the same
	// time. The long-context half feeds applyLongContext() below, whose result pi
	// registers and flushes before the first event: it runs once, here, and
	// session_start must leave it alone or the registered context window stops
	// matching the one the bridge requests. The rest is read fresh on every
	// request, so session_start can re-apply it from the session's own dirs.
	const applyLongContextConfig = (config: Config) => {
		const provider = config.provider ?? {};
		// We need these settings to know if we're eligible for 1M context on certain models
		longContextSettings = {
			plan: provider.plan ?? "pro",
			longContextExtraUsage: provider.longContextExtraUsage ?? false,
		};
	};
	const applyProviderConfig = (config: Config) => {
		providerSettings = config.provider ?? {};
		effectiveClaudeConfigDir = providerSettings.claudeConfigDir ?? defaultClaudeConfigDir();
	};

	// Claimed before anything is applied, because this factory body is itself a
	// per-session mutation of module-level state: pi keys its extension-module
	// cache on the cwd alone, so a second same-cwd session reuses this module and
	// re-runs the factory with its own pi.cwd/pi.agentDir. Gating the apply calls
	// here is what makes the first session's settings authoritative; gating only
	// session_start would leave the same clobber one call earlier.
	const isProviderOwner = !providerOwnerClaimed;
	providerOwnerClaimed = true;

	const load = loadDirs(pi);
	const config = loadConfig(load.cwd, load.agentDir);
	debug("loadConfig:", JSON.stringify(config), `cwd=${load.cwd} agentDir=${load.agentDir} owner=${isProviderOwner}`);
	if (isProviderOwner) {
		applyLongContextConfig(config);
		applyProviderConfig(config);
		effectiveAgentDir = load.agentDir;
	}
	// Always from the settings in force, never from this run's config: a
	// non-owner run must register (if it registers at all) the same list the
	// owner did, or pi would list a context window the bridge no longer requests.
	const registeredModels = applyLongContext(MODELS, longContextSettings);

	if (!config.startupNoticeShown) {
		if (config.provider?.plan === undefined) pendingNotices.push('Are you using a Max plan? You need to set provider.plan to "max" to unlock 1M context in Opus.');
		if (config.askClaude?.enabled === undefined) pendingNotices.push("The AskClaude tool is opt-in only. Set askClaude.enabled to use it.");
	}

	// Reset shared session on pi session lifecycle events
	const clearSession = (event: string) => {
		debug(`${event}: clearing session ${sharedSession?.sessionId?.slice(0, 8) ?? "none"}`);
		sharedSession = null;

		// Clear the global streamSimple if this instance registered it.
		// This allows /reload to work — the old instance clears the flag so
		// the new instance can register fresh without wrapping stale state.
		const g = globalThis as Record<symbol, any>;
		if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamClaudeAgentSdk) {
			debug(`${event}: clearing ACTIVE_STREAM_SIMPLE_KEY`);
			g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
		}
	};
	pi.on("session_start", (event, ctx) => {
		piUI = ctx.ui;
		piMode = ctx.mode;
		// The only place the session cwd is offered to an extension. Pi's stream
		// options carry no cwd, so without caching it here every downstream caller
		// falls back to process.cwd() - the directory the host process started in,
		// which is not the session's directory for any SDK or harness caller.
		sessionCwd = ctx.cwd;
		// Only the first closure in this module instance may re-point the settings
		// every request reads. Pi caches the extension module per cwd, so two
		// same-cwd sessions share these module-level bindings while both route
		// through one streamSimple (see ACTIVE_STREAM_SIMPLE_KEY); letting the
		// second one apply its own agentDir would hand the first a different Claude
		// profile mid-session. Sharing sessionCwd is harmless for the same reason
		// the sharing exists: a changed cwd evicts the cached module, so every
		// session on one instance has the same cwd. Known gap: if the first session
		// ends while a later closure lives on, nobody re-applies config for the
		// survivor and these keep the last applied value.
		if (isProviderOwner) {
			// Load-time config came from loadDirs(), which falls back to the process
			// dirs on pi builds without pi.cwd/pi.agentDir. ctx reports the dirs the
			// session actually uses on every build, so re-resolve before the first
			// request reads effectiveClaudeConfigDir and picks a Claude profile.
			// longContextSettings stays frozen: the model list it produced is already
			// registered, and pi flushed that before this event.
			const agentDir = sessionAgentDir(ctx);
			const sessionConfig = loadConfig(ctx.cwd, agentDir);
			debug("loadConfig(session):", JSON.stringify(sessionConfig), `cwd=${ctx.cwd} agentDir=${agentDir}`);
			applyProviderConfig(sessionConfig);
			effectiveAgentDir = agentDir;
		} else {
			debug(`session_start: not the first closure in this instance, keeping applied config (module=${moduleInstanceId})`);
		}
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearSession(`session_start:${event.reason}`);
		}
	});
	// `--system-prompt` replaces pi's default rather than adding to it, but Claude
	// Code's preset carries its own tool and permission guidance that the bridge
	// still depends on, so both flags are forwarded as an append.
	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		userSystemPrompt = { custom: options?.customPrompt, append: options?.appendSystemPrompt };
	});
	pi.on("session_shutdown", () => {
		reportLeaks("session_shutdown");
		// Reap parked Claude Code children before clearing session state: clearSession
		// nulls sharedSession and the ACTIVE_STREAM_SIMPLE_KEY global but never touches
		// activeQueryContexts, so a child parked under a settled run would otherwise
		// survive host teardown (CC has no parent-death watchdog and reparents). Only
		// the provider owner reaps; the reap is NOT added to clearSession itself, which
		// also runs on session_start (new/resume/fork) and would kill live queries on /new.
		reapLiveQueriesIfOwner(isProviderOwner, activeQueryContexts, "session_shutdown");
		clearSession("session_shutdown");
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (ctx.model?.baseUrl !== "claude-bridge") return undefined;
		debug(
			`session_before_compact: takeover reason=${event.reason} willRetry=${event.willRetry} ` +
			`isSplitTurn=${event.preparation.isSplitTurn} messages=${event.preparation.messagesToSummarize.length} ` +
			`turnPrefix=${event.preparation.turnPrefixMessages.length}`,
		);
		try {
			reinjectPriorCompactionFileOps(event.branchEntries, event.preparation);
			const compaction = await compact(
				event.preparation,
				ctx.model,
				undefined,
				undefined,
				event.customInstructions,
				event.signal,
				undefined,
				isolatedStreamFn,
				undefined,
			);
			debug(`session_before_compact: takeover complete summaryLen=${compaction.summary.length}`);
			return { compaction };
		} catch (err) {
			const msg = errorMessage(err);
			debug("session_before_compact: takeover failed; cancelling to avoid native compact fallback", err);
			ctx.ui?.notify?.(
				`Claude bridge compact failed (${msg}); cancelled to avoid known hang. Retry, switch model, or reduce context.`,
				"error",
			);
			return { cancel: true };
		}
	});

	// pi /compact and session-tree navigation (rewind / fork-at-point /
	// branch switch) both mutate pi's messages array out from under the
	// bridge. syncSharedSession's REUSE check would otherwise see
	// slice(cursor) === [] (or skip entries) and keep --resume'ing a CC
	// session that no longer matches pi's history. /compact in particular
	// triggers CC's autocompact-thrashing guard (issue #8). Force the next
	// call down the REBUILD path so CC sees the current history.
	const markRebuild = (event: string) => {
		if (sharedSession) {
			debug(`${event}: marking needsRebuild on session ${sharedSession.sessionId.slice(0, 8)}`);
			sharedSession = { ...sharedSession, needsRebuild: true };
		}
	};
	pi.on("session_compact", (event) => markRebuild(`session_compact:${event.reason}:willRetry=${event.willRetry}`));
	pi.on("session_tree", () => markRebuild("session_tree"));

	// Branch summarization — rewind or fork-at-point with "summarize" — is the other
	// place pi asks the model for a summary, and unlike compaction it runs through
	// the *agent's* stream function (agent-session passes `streamFn:
	// this.agent.streamFunction`). On a bridge model that reaches this provider
	// carrying pi's internal summarization prompt, which no `before_agent_start`
	// ever recorded, so the prompt-capture resolver has nothing to resolve it to.
	// Take it over the way compaction is taken over: the summary runs as its own
	// Claude Code subprocess, never touching the live session or the resolver.
	pi.on("session_before_tree", async (event, ctx) => {
		if (ctx.model?.baseUrl !== "claude-bridge") return undefined;
		const { entriesToSummarize, userWantsSummary, customInstructions, replaceInstructions } = event.preparation;
		if (!userWantsSummary || entriesToSummarize.length === 0) return undefined;
		debug(`session_before_tree: takeover entries=${entriesToSummarize.length} target=${event.preparation.targetId.slice(0, 8)}`);
		try {
			const result = await generateBranchSummary(entriesToSummarize, {
				model: ctx.model,
				signal: event.signal,
				customInstructions,
				replaceInstructions,
				streamFn: isolatedStreamFn,
			});
			return branchSummaryOutcome(result);
		} catch (err) {
			debug("session_before_tree: takeover failed; cancelling navigation", err);
			ctx.ui?.notify?.(
				`Claude bridge branch summary failed (${errorMessage(err)}); navigation cancelled.`,
				"error",
			);
			return { cancel: true };
		}
	});

	// --- Provider ---
	//
	// Guard against re-registration when the module is loaded multiple times
	// (e.g., when spawning subagents). The shared ModelRegistry would otherwise
	// overwrite the parent's streamSimple, breaking tool result delivery.
	// See ACTIVE_STREAM_SIMPLE_KEY for the full mechanism.

	const g = globalThis as Record<symbol, any>;
	if (!g[ACTIVE_STREAM_SIMPLE_KEY]) {
		// First instance: store our streamSimple and register.
		g[ACTIVE_STREAM_SIMPLE_KEY] = streamClaudeAgentSdk;
		pi.registerProvider(PROVIDER_ID, {
			baseUrl: "claude-bridge",
			apiKey: "not-used",
			api: "claude-bridge",
			models: registeredModels,
			// Cast: pi-ai AssistantMessageEventStream diamond dep between pi-coding-agent and pi-agent-core
			streamSimple: streamClaudeAgentSdk as any,
		});
	} else {
		// Subsequent instance (subagent session): skip registration entirely.
		// The subagent already has access to claude-bridge models via the shared
		// ModelRegistry from the parent's registration. Calls to those models
		// route through the parent's streamSimple via reentrant QueryContexts.
		debug(`provider: skipping re-registration, parent instance active (module=${moduleInstanceId})`);
	}

	// --- AskClaude tool ---

	const askConf = config.askClaude;
	const allowFull = askConf?.allowFullMode !== false;
	const defaultMode = askConf?.defaultMode ?? "read";
	const defaultIsolated = askConf?.defaultIsolated ?? false;
	// Module-level, and read by the shared streamClaudeAgentSdk, so it follows the
	// same owner gate as the provider settings. The four locals above stay
	// per-closure: they only shape the tool this closure registers.
	if (isProviderOwner) askClaudeToolName = askConf?.name ?? "AskClaude";

	const modeValues = allowFull ? ["read", "full", "none"] as const : ["read", "none"] as const;
	let modeDesc = `"read" (default): questions about the codebase — review, analysis, explain. "none": general knowledge only (no file access).`;
	if (allowFull) modeDesc += ` "full": allows writing and bash execution (careful: runs without feedback to pi).`;

	if (askConf?.enabled) {
		const askClaudeParams = Type.Object({
			prompt: Type.String({ description: "The question or task for Claude Code. By default Claude sees the full conversation history. Don't research up front, let Claude explore." }),
			mode: Type.Optional(StringEnum(modeValues, { description: modeDesc })),
			model: Type.Optional(Type.String({ description: 'Claude model (e.g. "opus", "sonnet", "haiku", or full ID). Defaults to "opus".' })),
			thinking: Type.Optional(StringEnum(ASK_CLAUDE_THINKING_LEVELS, { description: "Thinking effort level. Omit to use Claude Code's default." })),
			isolated: Type.Optional(Type.Boolean({ description: "When true, Claude sees only this prompt (clean session). When false (default), Claude sees the full conversation history." })),
		});
		pi.registerTool<typeof askClaudeParams>({
			name: askConf?.name ?? "AskClaude",
			label: askConf?.label ?? "Ask Claude Code",
			description: askConf?.description ?? (allowFull ? DEFAULT_TOOL_DESCRIPTION_FULL : DEFAULT_TOOL_DESCRIPTION),
			parameters: askClaudeParams,
			renderCall(args, theme) {
				let text = theme.fg("mdLink", theme.bold("AskClaude "));
				const mode = args.mode ?? defaultMode;
				const tags: string[] = [];
				if (mode !== defaultMode) tags.push(`mode=${mode}`);
				if (args.model) tags.push(`model=${args.model}`);
				if (args.thinking) tags.push(`thinking=${args.thinking}`);
				if (args.isolated) tags.push("isolated");
				if (tags.length) text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;
				const truncated = args.prompt.length > PREVIEW_MAX_CHARS ? args.prompt.substring(0, PREVIEW_MAX_CHARS) : args.prompt;
				const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
				text += theme.fg("muted", `"${lines.join("\n")}"`);
				if (args.prompt.length > PREVIEW_MAX_CHARS || args.prompt.split("\n").length > PREVIEW_MAX_LINES) text += theme.fg("dim", " …");
				return new Text(text, 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					const status = result.content[0]?.type === "text" ? result.content[0].text : "working...";
					return new Text(theme.fg("mdLink", "◉ Claude Code ") + theme.fg("muted", status), 0, 0);
				}

				const details = result.details as { prompt?: string; executionTime?: number; actions?: string; error?: boolean; usage?: { totalTokens?: number; cost?: number } } | undefined;
				const body = result.content[0]?.type === "text" ? result.content[0].text : "";

				let text = details?.error
					? theme.fg("error", "✗ Claude Code error")
					: theme.fg("mdLink", "✓ Claude Code");

				if (details?.executionTime) text += ` ${theme.fg("dim", `${(details.executionTime / 1000).toFixed(1)}s`)}`;
				const usageLine = formatUsageLine(details?.usage);
				if (usageLine) text += ` ${theme.fg("dim", usageLine)}`;
				if (details?.actions) text += ` ${theme.fg("muted", details.actions)}`;

				if (expanded) {
					if (details?.prompt) text += `\n${theme.fg("dim", `Prompt: ${details.prompt}`)}`;
					if (details?.prompt && body) text += `\n${theme.fg("dim", "─".repeat(40))}`;
					if (body) text += `\n${theme.fg("toolOutput", body)}`;
				} else {
					const truncated = body.length > PREVIEW_MAX_CHARS ? body.substring(0, PREVIEW_MAX_CHARS) : body;
					const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
					if (lines.length) text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
					if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES) text += `\n${theme.fg("dim", `… (${keyHint("app.tools.expand", "to expand")})`)}`;

				}

				return new Text(text, 0, 0);
			},
			async execute(_id, params, signal, onUpdate, ctx) {
				// Guard: circular delegation
				if (ctx.model?.baseUrl === "claude-bridge") {
					debug("askClaude: blocked circular delegation (active provider is claude-bridge)");
					return {
						content: [{ type: "text" as const, text: "Error: AskClaude cannot be used when the active provider is claude-bridge — you're already running through Claude Code." }],
						details: { error: true },
					};
				}

				const mode = (params.mode ?? defaultMode) as "full" | "read" | "none";
				const isolated = params.isolated ?? defaultIsolated;
				const toolCalls = new Map<string, ToolCallState>();
				const start = Date.now();

				const progressInterval = setInterval(() => {
					const elapsed = ((Date.now() - start) / 1000).toFixed(0);
					const summary = buildActionSummary(toolCalls);
					const status = summary ? `${elapsed}s — ${summary}` : `${elapsed}s — working...`;
					onUpdate?.({
						content: [{ type: "text", text: status }],
						details: { prompt: params.prompt, executionTime: Date.now() - start },
					});
				}, 1000);

				try {
					const result = await promptAndWait(params.prompt, mode, toolCalls, signal, {
						systemPrompt: ctx.getSystemPrompt(),
						appendSkills: askConf?.appendSkills,
						model: params.model,
						thinking: params.thinking,
						isolated,
						context: isolated ? undefined : buildSessionContext(ctx.sessionManager.getBranch()).messages as Context["messages"],
						cwd: ctx.cwd,
					});
					clearInterval(progressInterval);
					onUpdate?.({ content: [{ type: "text", text: "" }], details: {} });
					const executionTime = Date.now() - start;
					const actions = buildActionSummary(toolCalls);

					const text = actions
						? `${result.responseText}\n\n[Claude Code actions: ${actions}]`
						: result.responseText;
					return {
						content: [{ type: "text" as const, text }],
						details: { prompt: params.prompt, executionTime, actions, ...(result.usage ? { usage: { totalTokens: result.usage.totalTokens, cost: result.usage.cost.total } } : {}) },
						// Attach the delegation's spend so pi buckets it under "Tools/summaries"
						// in /usage; the tool result is correctly excluded from context-window
						// accounting by pi.
						...(result.usage ? { usage: result.usage } : {}),
					};
				} catch (err) {
					clearInterval(progressInterval);
					debug(`askClaude error: mode=${mode}, model=${params.model ?? "default"}, isolated=${isolated}, elapsed=${((Date.now() - start) / 1000).toFixed(1)}s, error=`, err);
					const msg = errorMessage(err);
					// A failed delegation still spent tokens; promptAndWait attaches the
					// usage to the thrown error so it is not lost from /usage accounting.
					const failedUsage = (err as { usage?: Usage })?.usage;
					return {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						details: { prompt: params.prompt, executionTime: Date.now() - start, error: true, ...(failedUsage ? { usage: { totalTokens: failedUsage.totalTokens, cost: failedUsage.cost.total } } : {}) },
						...(failedUsage ? { usage: failedUsage } : {}),
					};
				}
			},
		});
	}
}
