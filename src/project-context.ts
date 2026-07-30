// Project-rules forwarding: pi is the single source of truth.
//
// The bridge used to discover context files itself (agents-md.ts): AGENTS.md
// only, nearest-ancestor only, global dir as a fallback rather than a layer.
// Every one of those choices diverged from pi's own resolution - four filename
// candidates with AGENTS.md winning per directory, EVERY ancestor from root to
// cwd, the agent dir always first, worktree-shadow dedup - so a session through
// the bridge could see different rules than the same session in native pi, and
// a CLAUDE.md-only project forwarded nothing at all.
//
// pi already assembles the canonical set into its system prompt as a delimited
// <project_context> block, one <project_instructions path="..."> per file, in
// resolution order. Extracting that block - exactly like the skills block next
// to it - means the bridge cannot drift from pi again: there is no second
// resolver to disagree.

const START_MARKER = "<project_context>";
const END_MARKER = "</project_context>";

/**
 * Extract pi's project-context block from its assembled system prompt, for
 * forwarding to Claude Code verbatim: same files, same order, same paths.
 * Returns undefined when the session has no context files (including
 * noContextFiles sessions) - in that case nothing must be forwarded, because
 * pi decided nothing applies.
 */
export function extractProjectContextBlock(systemPrompt?: string): string | undefined {
	if (!systemPrompt) return undefined;
	const start = systemPrompt.indexOf(START_MARKER);
	if (start === -1) return undefined;
	const end = systemPrompt.indexOf(END_MARKER, start);
	if (end === -1) return undefined;
	const block = systemPrompt.slice(start, end + END_MARKER.length).trim();
	// The preset Claude Code prompt has no heading for this; give the block the
	// one-line frame pi gives it, so the model knows what these tags are.
	return `Project-specific instructions and guidelines:\n\n${block}`;
}
