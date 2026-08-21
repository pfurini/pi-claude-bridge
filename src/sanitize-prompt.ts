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

const PROJECT_CONTEXT_START = "<project_context>";
const PROJECT_CONTEXT_END = "</project_context>";
// Deliberately NOT the versioned listing delimiters src/skills.ts extracts by:
// the forwarding extractor wants the block alone, but here the job is to strip
// what pi *embedded* in a subagent prompt — preamble lines included, since that
// self-identifying boilerplate is what routes the request to metered usage.
// "Unifying" the two would leave three orphan lines of pi prose behind.
const SKILLS_START =
	"The following skills provide specialized instructions for specific tasks.";
const SKILLS_END = "</available_skills>";

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

	// 1. Skeleton range: identity paragraph through the end of the docs-bullet line.
	const startIdx = result.indexOf(SKELETON_START);
	let cutBoundary = -1;
	if (startIdx !== -1) {
		const endLineIdx = result.indexOf(SKELETON_END_LINE_PREFIX, startIdx);
		if (endLineIdx !== -1) {
			const newlineIdx = result.indexOf("\n", endLineIdx);
			const lineEnd = newlineIdx === -1 ? result.length : newlineIdx + 1;
			const spliced = spliceCollapsingSeam(result, startIdx, lineEnd);
			result = spliced.text;
			cutBoundary = spliced.boundary;
			changed = true;
		}
	}

	// 2. Skeleton footer: pi appends "Current working directory: …" verbatim at
	// the tail of the embedded region. Remove it only there — before a
	// pi-subagents <sub_agent_context> wrapper, or immediately at the seam step
	// 1 just cut — so user-authored text is never at risk.
	const subAgentIdx = result.indexOf(SUB_AGENT_MARKER);
	if (subAgentIdx !== -1) {
		const head = result.slice(0, subAgentIdx);
		const match = head.match(CWD_LINE);
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
		const adjacent = rest.match(/^Current working directory: .*(\n|$)/);
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
		const skillsBlock = opts.skillsForwarded === false
			? undefined
			: extractRawBlock(opts.sourcePrompt, SKILLS_START, SKILLS_END);
		const beforeLength = result.length;
		result = removeAllExact(result, projectBlock);
		result = removeAllExact(result, skillsBlock);
		if (result.length !== beforeLength) changed = true;
	}

	if (!changed) return text;
	const trimmed = result.trim();
	return trimmed === "" ? undefined : trimmed;
}
