// Strip pi's own harness system-prompt boilerplate from prompts pi-subagents
// forwards verbatim to Claude Code. `prompt_mode: "append"` (the default for
// built-in agents) embeds the parent's entire pi system prompt — skeleton
// included — as the subagent session's system prompt, and a Claude Code OAuth
// token whose system prompt carries pi's self-identifying skeleton gets
// pushed to metered ("extra") usage by Anthropic. See
// plans/subagent-prompt-sanitize.md for the root-cause writeup.
//
// Template coupling: the anchors below are literals from the fork's
// packages/coding-agent/src/core/system-prompt.ts (`buildSystemPrompt`) and
// core/skills.ts (`formatSkillsForPrompt`). This is acceptable because the
// bridge already targets the fork exclusively (`file:` devDependencies,
// fork-only API surface); tests/unit-sanitize-prompt.mjs assembles a real
// skeleton via the fork's own `buildSystemPrompt` so template drift fails
// loudly instead of silently re-exposing the signature.

import { extractSkillsBlock } from "./skills.js";

const SKELETON_START = "You are an expert coding assistant operating inside pi";
// A prefix of the skeleton's last guideline bullet, matched as a substring
// and extended to the end of its line so the rest of the sentence doesn't
// need to be duplicated here. Stripping stops at this line — not at the
// skeleton's cwd tail — because buildSystemPrompt inserts the parent's own
// `--append-system-prompt` text immediately after it; stopping any later
// would delete that text along with pi's boilerplate.
const SKELETON_END_LINE_PREFIX =
	"- Always read pi .md files completely and follow links to related docs";
const SUB_AGENT_MARKER = "<sub_agent_context>";
const CWD_LINE = /^Current working directory: .*$/m;
const CWD_SECTION = /^<cwd>\n[^\n]*\n<\/cwd>$/m;

const STOCK_PREAMBLE = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
const STOCK_TOOL_FOOTER = "\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.";
const STOCK_RULES = new Set([
	"- Use bash for file operations like ls, rg, find",
	"- Use PowerShell for file operations like listing, searching, and finding files",
	"- Use bash or PowerShell for file operations like listing, searching, and finding files",
	"- Be concise in your responses",
	"- Show file paths clearly when working with files",
]);
const DOCS_HEADER = "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";
const STOCK_DOC_LINES = new Set([
	DOCS_HEADER,
	"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
	"- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)",
	"- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
	"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
]);

/** Remove recognized template text, never an entire section merely because its name is built in. */
export function sanitizeSystemSection(name: string, text: string): string | undefined {
	const open = `<${name}>\n`;
	const close = `\n</${name}>`;
	const wrapped = text.startsWith(open) && text.endsWith(close);
	const body = wrapped ? text.slice(open.length, -close.length) : text;
	if (name === "preamble" && body === STOCK_PREAMBLE) return undefined;
	if (name === "cwd" && /^(?:\/|[A-Za-z]:[\\/])[^\n]*$/.test(body)) return undefined;
	if (name === "tools" && body.endsWith(STOCK_TOOL_FOOTER)) {
		const inventory = body.slice(0, -STOCK_TOOL_FOOTER.length);
		if (inventory === "(none)" || inventory.split("\n").every(line => /^- [^:]+: .+$/.test(line))) return undefined;
	}
	let retained = body;
	if (name === "rules") retained = body.split("\n").filter(line => !STOCK_RULES.has(line)).join("\n");
	if (name === "docs" && body.startsWith(`${DOCS_HEADER}\n`)) {
		retained = body.split("\n").filter(line => !STOCK_DOC_LINES.has(line) && !/^- (?:Main documentation: .+[\\/]README\.md|Additional docs: .+[\\/]docs|Examples: .+[\\/]examples \(extensions, custom tools, SDK\))$/.test(line)).join("\n");
	}
	if (retained === body) return text;
	if (!retained.trim()) return undefined;
	return wrapped ? `${open}${retained}${close}` : retained;
}

const PROJECT_CONTEXT_START = "<project_context>";
const PROJECT_CONTEXT_END = "</project_context>";
// Deliberately NOT the versioned listing delimiters src/skills.ts extracts by:
// the forwarding extractor wants the block alone, but here the job is to strip
// what pi *embedded* in a subagent prompt — preamble lines included, since that
// self-identifying boilerplate is what routes the request to metered usage.
// "Unifying" the two would leave three orphan lines of pi prose behind.
const SKILLS_START =
	"The following skills provide specialized instructions for specific tasks.";

function extractRawBlock(
	source: string,
	startMarker: string,
	endMarker: string,
): string | undefined {
	const start = source.indexOf(startMarker);
	if (start === -1) return undefined;
	const end = source.indexOf(endMarker, start);
	if (end === -1) return undefined;
	return source.slice(start, end + endMarker.length).trim();
}

// Remove text[from, to) and collapse the resulting seam to at most one blank
// line. Never touches whitespace elsewhere in the string: a blanket "collapse
// 3+ newlines" pass would rewrite surviving authored spans (e.g.
// <agent_instructions>) that just happen to contain that much spacing.
// Returns the index in the new string where `after` now begins, so a caller
// stripping a second, adjacent piece of boilerplate can find the new seam.
function spliceCollapsingSeam(
	text: string,
	from: number,
	to: number,
): { text: string; boundary: number } {
	const before = text.slice(0, from);
	const after = text.slice(to);
	const beforeGap = before.match(/[ \t]*\n(?:[ \t]*\n)*[ \t]*$/);
	const afterGap = after.match(/^[ \t]*\n(?:[ \t]*\n)*[ \t]*/);
	const trimmedBefore = beforeGap
		? before.slice(0, before.length - beforeGap[0].length)
		: before;
	const trimmedAfter = afterGap ? after.slice(afterGap[0].length) : after;
	let seam = "";
	if (trimmedBefore !== "" && trimmedAfter !== "") {
		const sawNewline = Boolean(
			beforeGap?.[0].includes("\n") || afterGap?.[0].includes("\n"),
		);
		seam = sawNewline ? "\n\n" : "";
	}
	return {
		text: trimmedBefore + seam + trimmedAfter,
		boundary: trimmedBefore.length + seam.length,
	};
}

function removeAllExact(text: string, block: string | undefined): string {
	if (!block) return text;
	let result = text;
	let idx = result.indexOf(block);
	while (idx !== -1) {
		result = spliceCollapsingSeam(result, idx, idx + block.length).text;
		idx = result.indexOf(block);
	}
	return result;
}

function removeForwardedSkills(text: string, source: string): string {
	const block = extractSkillsBlock(source, { framing: "read-mcp" })?.block;
	if (!block) return text;
	const preambleLines = new Set([
		SKILLS_START,
		"Use the read tool to load a skill's file when the task matches its description.",
		"Use the skill tool to invoke a skill and receive its rendered instructions when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
	]);
	let result = text;
	for (let at = result.indexOf(block); at !== -1; at = result.indexOf(block)) {
		const preamble = result.lastIndexOf(SKILLS_START, at);
		const stockPreamble = preamble !== -1 && result.slice(preamble, at).split("\n").every(line => line === "" || preambleLines.has(line));
		result = spliceCollapsingSeam(result, stockPreamble ? preamble : at, at + block.length).text;
	}
	return result;
}

/**
 * Strip pi's `buildSystemPrompt` skeleton — and, when `opts.sourcePrompt` is
 * given, duplicate `<project_context>`/skills blocks — from a prompt about to
 * be forwarded to Claude Code verbatim. Pass `sourcePrompt` (the session's own
 * assembled system prompt) only when the caller's `provider.appendSystemPrompt`
 * gate is on: that is what makes the dedupe provably duplicate-only, since
 * with the gate off an embedded block may be the prompt's only copy.
 *
 * `skillsForwarded: false` narrows that further, suppressing the skills half of
 * the dedupe. The gate alone is not enough: the caller's skills extractor can
 * decline a listing the prose markers here still match (an unrecognized listing
 * version), and stripping a copy nothing re-forwarded leaves the subagent with
 * no catalog at all.
 *
 * A conservative no-op on plain user text or partial anchor matches. Returns
 * `undefined` when nothing but whitespace survives, so the caller can drop
 * the part entirely.
 */
export function sanitizeHarnessPrompt(
	text: string | undefined,
	opts?: { sourcePrompt?: string; skillsForwarded?: boolean },
): string | undefined {
	if (!text) return text;
	let result = text;
	let changed = false;

	// Preserve authored rules and section overrides inside a recognized harness template.
	const startIdx = result.indexOf(SKELETON_START);
	let cutBoundary = -1;
	let cutEnd = -1;
	let retained = "";
	if (startIdx !== -1 && result.startsWith(STOCK_PREAMBLE, startIdx)) {
		const after = result.slice(startIdx + STOCK_PREAMBLE.length);
		const docsEnd = after.indexOf("</docs>");
		if (docsEnd !== -1) {
			const region = after.slice(0, docsEnd + "</docs>".length);
			const sections = [...region.matchAll(/<(tools|rules|docs)>\n[\s\S]*?\n<\/\1>/g)];
			if (new Set(sections.map(match => match[1])).size === 3) {
				retained = region;
				for (const match of sections) retained = retained.replace(match[0], sanitizeSystemSection(match[1], match[0]) ?? "");
				retained = retained.trim();
				cutEnd = startIdx + STOCK_PREAMBLE.length + region.length;
			}
		}
	}
	if (cutEnd === -1 && startIdx !== -1) {
		const endLineIdx = result.indexOf(SKELETON_END_LINE_PREFIX, startIdx);
		if (endLineIdx !== -1) {
			const newlineIdx = result.indexOf("\n", endLineIdx);
			const lineEnd = newlineIdx === -1 ? result.length : newlineIdx + 1;
			const docsClose = result.slice(lineEnd).match(/^<\/docs>(?:\r?\n|$)/);
			cutEnd = docsClose && result.slice(startIdx, lineEnd).includes("<docs>") ? lineEnd + docsClose[0].length : lineEnd;
			const legacyRules = result.slice(startIdx, cutEnd).match(/\nGuidelines:\n([\s\S]*?)(?=\nPi documentation\b)/)?.[1];
			retained = legacyRules ? sanitizeSystemSection("rules", legacyRules)?.trim() ?? "" : "";
		}
	}
	if (cutEnd !== -1) {
		if (retained) {
			result = result.slice(0, startIdx) + retained + result.slice(cutEnd);
			cutBoundary = startIdx + retained.length;
		} else {
			const spliced = spliceCollapsingSeam(result, startIdx, cutEnd);
			result = spliced.text;
			cutBoundary = spliced.boundary;
		}
		changed = true;
	}

	// 2. Skeleton footer: pi appends "Current working directory: …" verbatim at
	// the tail of the embedded region. Remove it only there — before a
	// pi-subagents <sub_agent_context> wrapper, or immediately at the seam step
	// 1 just cut — so user-authored text is never at risk.
	const subAgentIdx = result.indexOf(SUB_AGENT_MARKER);
	if (subAgentIdx !== -1) {
		const head = result.slice(0, subAgentIdx);
		const match = head.match(CWD_LINE) ?? (cutBoundary !== -1 ? head.match(CWD_SECTION) : null);
		if (match && typeof match.index === "number") {
			const from = match.index;
			const to =
				result[from + match[0].length] === "\n"
					? from + match[0].length + 1
					: from + match[0].length;
			result = spliceCollapsingSeam(result, from, to).text;
			changed = true;
		}
	} else if (cutBoundary !== -1) {
		let i = cutBoundary;
		while (result[i] === "\n") i++;
		const rest = result.slice(i);
		const adjacent = rest.match(/^Current working directory: .*(\n|$)/)
			?? rest.match(/^<cwd>\n[^\n]*\n<\/cwd>(?:\n|$)/);
		if (adjacent) {
			result = spliceCollapsingSeam(result, i, i + adjacent[0].length).text;
			changed = true;
		}
	}

	// 3. Exact-match block dedupe, gated on the caller having actually forwarded
	// these blocks separately (see the appendSystemPrompt note above).
	if (opts?.sourcePrompt) {
		const projectBlock = extractRawBlock(
			opts.sourcePrompt,
			PROJECT_CONTEXT_START,
			PROJECT_CONTEXT_END,
		);
		const beforeLength = result.length;
		result = removeAllExact(result, projectBlock);
		if (opts.skillsForwarded !== false) result = removeForwardedSkills(result, opts.sourcePrompt);
		if (result.length !== beforeLength) changed = true;
	}

	if (!changed) return text;
	const trimmed = result.trim();
	return trimmed === "" ? undefined : trimmed;
}
