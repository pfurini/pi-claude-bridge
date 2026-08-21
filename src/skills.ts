// Skills listing extraction + framing, and MCP naming constants.
// Extracted from index.ts so tests can import without activating the extension.

export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

// Copied from pi (packages/agent/src/harness/listing-budget.ts:1-3).
// D1: copied, not imported — registry builds at the peer floor (>=0.82.1)
// export none of these, so a static import would break the bridge on stock pi
// and fail the `stock` CI job. tests/unit-skills.mjs AC10 is the drift guard.
export const SKILL_LISTING_VERSION = "2";
export const SKILL_LISTING_START_DELIMITER = `<available_skills version="${SKILL_LISTING_VERSION}">`;
export const SKILL_LISTING_END_DELIMITER = "</available_skills>";

// Detection keys off the tag *prefix* — the full legacy tag would never match
// a versioned opening tag, which is exactly the case detection exists for.
const SKILL_LISTING_TAG_PREFIX = "<available_skills";
// Stock pi's pre-versioning form. Kept as a second accepted shape, per AC2.
const SKILL_LISTING_LEGACY_START_DELIMITER = `${SKILL_LISTING_TAG_PREFIX}>`;

export const SKILL_TOOL_NAME = "skill";

export type SkillsFraming = "skill-tool" | "read-mcp" | "read-native";

export interface SkillsBlockResult {
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
// can actually reach a skill through in this session (D2):
//
// - skill-tool: pi's `skill` tool is active and reaches Claude as
//   mcp__custom-tools__skill. Must not tell the model to read the file (AC5).
// - read-mcp: no skill tool (every default launch today, per the pi-side
//   defect in the plan); the model reads the <location> file through the MCP
//   read tool. Must not claim a skill tool exists (AC6).
// - read-native: AskClaude, where the sub-agent runs on Claude Code's native
//   tools and the MCP tools do not exist. Never the MCP prefix (AC7).
const FRAMINGS: Record<SkillsFraming, string> = {
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
};

// Extract pi's skills listing block from its system prompt for forwarding to
// Claude Code (same mechanism as extractProjectContextBlock). Detection is one
// scan with three outcomes: v2, legacy (unversioned stock pi), or unknown —
// unknown forwards nothing and warns once, so a future listing format fails
// visible instead of silently dropping the catalog (AC3).
export function extractSkillsBlock(
	systemPrompt: string | undefined,
	opts: { framing: SkillsFraming },
): SkillsBlockResult | undefined {
	if (!systemPrompt) return undefined;
	const tagStart = systemPrompt.indexOf(SKILL_LISTING_TAG_PREFIX);
	if (tagStart === -1) return undefined; // a session with no skills is normal — no diagnostic
	const tagEnd = systemPrompt.indexOf(">", tagStart);
	if (tagEnd === -1) return undefined; // malformed; preserves the old helper's behaviour
	const tag = systemPrompt.slice(tagStart, tagEnd + 1);
	let legacy: boolean;
	if (tag === SKILL_LISTING_START_DELIMITER) {
		legacy = false;
	} else if (tag === SKILL_LISTING_LEGACY_START_DELIMITER) {
		legacy = true;
	} else {
		console.warn(
			`claude-bridge: unrecognized skills listing tag \`${tag}\` (expected \`${SKILL_LISTING_START_DELIMITER}\`); not forwarding the listing`,
		);
		return undefined;
	}
	const end = systemPrompt.indexOf(SKILL_LISTING_END_DELIMITER, tagEnd + 1);
	if (end === -1) return undefined; // malformed; preserves the old helper's behaviour
	return {
		block: systemPrompt.slice(tagStart, end + SKILL_LISTING_END_DELIMITER.length),
		framing: FRAMINGS[opts.framing],
		legacy,
	};
}

// Provider path: the framing follows the session's *active* tool set (D2),
// because pi picks its own preamble line the same way — and both branches
// occur in practice (see the plan's probe table).
export function extractSkillsBlockForProvider(
	systemPrompt: string | undefined,
	tools: readonly { name: string }[] | undefined,
): SkillsBlockResult | undefined {
	const hasSkillTool =
		tools?.some((tool) => tool.name === SKILL_TOOL_NAME) ?? false;
	return extractSkillsBlock(systemPrompt, {
		framing: hasSkillTool ? "skill-tool" : "read-mcp",
	});
}

// AskClaude path: the sub-agent runs on Claude Code's native tools and never
// receives the MCP skill tool, so the framing is always read-native — naming
// the MCP tool there would point the sub-agent at a tool it does not have.
export function extractSkillsBlockForAskClaude(
	systemPrompt: string | undefined,
): SkillsBlockResult | undefined {
	return extractSkillsBlock(systemPrompt, { framing: "read-native" });
}
