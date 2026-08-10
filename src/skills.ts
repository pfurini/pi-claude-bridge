// Skills block extraction + MCP naming constants.
// Extracted from index.ts so tests can import without activating the extension.

export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

// Extract pi's rendered skills block from its system prompt for forwarding to
// Claude Code verbatim (same mechanism as extractProjectContextBlock).
//
// rewriteReadTool (default true): the provider path executes tools through pi's
// MCP bridge, so the skill's generic "Use the read tool" line is rewritten to
// name mcp__custom-tools__read. AskClaude keeps Claude Code's native Read tool
// and passes rewriteReadTool: false, leaving the line generic — naming the MCP
// tool there would point the sub-agent at a tool it does not have.
export function extractSkillsBlock(
	systemPrompt?: string,
	opts?: { rewriteReadTool?: boolean },
): string | undefined {
	if (!systemPrompt) return undefined;
	const startMarker = "The following skills provide specialized instructions for specific tasks.";
	const endMarker = "</available_skills>";
	const start = systemPrompt.indexOf(startMarker);
	if (start === -1) return undefined;
	const end = systemPrompt.indexOf(endMarker, start);
	if (end === -1) return undefined;
	const block = systemPrompt.slice(start, end + endMarker.length).trim();
	return opts?.rewriteReadTool === false ? block : rewriteSkillsBlock(block);
}

export function rewriteSkillsBlock(skillsBlock: string): string {
	return skillsBlock.replace(
		"Use the read tool to load a skill's file",
		`Use the read tool (mcp__${MCP_SERVER_NAME}__read) to load a skill's file`,
	);
}
