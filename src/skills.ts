// Skills listing extraction + framing, and MCP naming constants.
// Extracted from index.ts so tests can import without activating the extension.

export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

// Copied from pi (packages/agent/src/harness/listing-budget.ts:1-3) rather than
// imported: registry builds satisfying our >=0.82.1 peer floor export none of
// these, so a static import would break the bridge on stock pi and fail the
// `stock` CI job. tests/unit-skills.mjs pins the copy against pi's own exports
// when running on the fork, so drift fails there instead of in the field.
export const SKILL_LISTING_VERSION = "2";
export const SKILL_LISTING_START_DELIMITER = `<available_skills version="${SKILL_LISTING_VERSION}">`;
export const SKILL_LISTING_END_DELIMITER = "</available_skills>";

// Stock pi's pre-versioning opening tag, accepted as a second shape so the
// bridge keeps working against a registry pi at the peer floor.
const SKILL_LISTING_LEGACY_START_DELIMITER = "<available_skills>";
// Used only to recognize a tag we then *reject*, so an unknown future listing
// version is reported rather than silently dropping the catalog. Never used to
// accept one: pi's own extractor matches the full delimiter, and accepting the
// bare prefix would let any prose that merely mentions the tag - a context file
// documenting this very contract, say - preempt the real listing.
const SKILL_LISTING_TAG_PREFIX = "<available_skills";

export const SKILL_TOOL_NAME = "skill";

export type SkillsFraming = "skill-tool" | "read-mcp" | "read-native";

export interface SkillsBlockResult {
	/** Framing plus block, ready to append. This is what call sites forward. */
	append: string;
	/** The listing block verbatim, delimiters included. Never the preamble. */
	block: string;
	/** Framing lines the bridge writes in place of pi's preamble. */
	framing: string;
	/** True when matched via the unversioned stock-pi form. */
	legacy: boolean;
}

// pi's own third preamble line, kept verbatim in all three framings: it is
// load-bearing for skills that reference references/*.md, and is otherwise
// lost with the preamble.
const RELATIVE_PATH_LINE =
	"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.";

// The bridge forwards the listing block alone and writes its own framing in
// place of pi's preamble, because only the bridge knows which tool the model
// can actually reach a skill through in this session:
//
// - skill-tool: pi's `skill` tool is active and reaches Claude as
//   mcp__custom-tools__skill. Must not tell the model to read the file.
// - read-mcp: no skill tool, so the model reads the <location> file through the
//   MCP read tool. Must not claim a skill tool exists.
// - read-native: AskClaude, where the sub-agent runs on Claude Code's native
//   tools and the MCP tools do not exist. Never names the MCP prefix.
// `satisfies`, not an annotation: it still fails the build if a framing loses
// its text, without widening each entry to plain `string`.
const FRAMINGS = {
	"skill-tool": [
		`Use the ${MCP_TOOL_PREFIX}${SKILL_TOOL_NAME} tool to invoke a skill and receive its rendered instructions when the task matches its description. Claude Code's native Skill tool is not available in this session.`,
		RELATIVE_PATH_LINE,
	].join("\n"),
	"read-mcp": [
		`Load a skill by reading the file at its <location> with the ${MCP_TOOL_PREFIX}read tool when the task matches its description.`,
		RELATIVE_PATH_LINE,
	].join("\n"),
	"read-native": [
		"Load a skill by reading the file at its <location> with the Read tool when the task matches its description.",
		RELATIVE_PATH_LINE,
	].join("\n"),
} satisfies Record<SkillsFraming, string>;

// extractSkillsBlock runs on every provider request and every AskClaude call,
// so an unrecognized tag would otherwise reprint its warning over the TUI on
// every turn for the rest of the session. Same reason, same idiom as
// config.ts's warnedClaudeConfigDirs.
const warnedListingTags = new Set<string>();

function warnOnce(message: string): void {
	if (warnedListingTags.has(message)) return;
	warnedListingTags.add(message);
	console.warn(message);
}

/** @internal Test seam: the warn-once Set is module state and would leak between cases. */
export function __resetSkillListingWarnings(): void {
	warnedListingTags.clear();
}

type ListingScan =
	| { kind: "found"; start: number; end: number; legacy: boolean }
	| { kind: "unknown-version"; tag: string }
	| { kind: "absent" };

// Locate pi's listing by its delimiters. A prompt can legitimately contain more
// than one candidate opening tag, because pi assembles the user's
// --append-system-prompt text and the raw contents of every project context
// file *before* its own listing (fork: core/system-prompt.ts), and either may
// quote the tag. Only complete, recognized listings are candidates, and the
// last one wins: pi's own is always the final section of the prompt, so a
// quoted tag can only precede it.
function locateListing(systemPrompt: string): ListingScan {
	let found: { start: number; end: number; legacy: boolean } | undefined;
	let unknownTag: string | undefined;
	let from = 0;
	for (;;) {
		const start = systemPrompt.indexOf(SKILL_LISTING_TAG_PREFIX, from);
		if (start === -1) break;
		const tagEnd = systemPrompt.indexOf(">", start);
		if (tagEnd === -1) break; // truncated tag, and nothing after it can close one either
		const tag = systemPrompt.slice(start, tagEnd + 1);
		from = tagEnd + 1;
		const legacy = tag === SKILL_LISTING_LEGACY_START_DELIMITER;
		if (!legacy && tag !== SKILL_LISTING_START_DELIMITER) {
			unknownTag ??= tag;
			continue;
		}
		const end = systemPrompt.indexOf(SKILL_LISTING_END_DELIMITER, tagEnd + 1);
		if (end === -1) continue; // opening tag with nothing closing it: not a listing
		found = { start, end: end + SKILL_LISTING_END_DELIMITER.length, legacy };
	}
	if (found) return { kind: "found", ...found };
	// Only report a version we do not know how to read. "No listing at all" is a
	// normal session, and a malformed one is indistinguishable from prose.
	if (unknownTag !== undefined) return { kind: "unknown-version", tag: unknownTag };
	return { kind: "absent" };
}

// Extract pi's skills listing block from its system prompt for forwarding to
// Claude Code (same mechanism as extractProjectContextBlock), paired with the
// framing the caller wants written in place of pi's preamble. An unrecognized
// listing version forwards nothing and warns, so a future format change fails
// visible instead of silently dropping the catalog.
export function extractSkillsBlock(
	systemPrompt: string | undefined,
	opts: { framing: SkillsFraming },
): SkillsBlockResult | undefined {
	if (!systemPrompt) return undefined;
	const scan = locateListing(systemPrompt);
	if (scan.kind === "absent") return undefined;
	if (scan.kind === "unknown-version") {
		warnOnce(
			`claude-bridge: unrecognized skills listing tag \`${scan.tag}\` (expected \`${SKILL_LISTING_START_DELIMITER}\`); not forwarding the listing`,
		);
		return undefined;
	}
	const block = systemPrompt.slice(scan.start, scan.end);
	const framing = FRAMINGS[opts.framing];
	return { append: `${framing}\n\n${block}`, block, framing, legacy: scan.legacy };
}
