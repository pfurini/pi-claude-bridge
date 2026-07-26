// Corrections for statements in Claude Code's preset system prompt that are false
// under this harness. The preset is generated inside the binary and cannot be
// edited at the source, so the only lever is the systemPrompt append seam.
//
// Every bullet here corresponds to a defect measured against a captured request
// body, and is emitted only on the paths where that defect was actually observed.
// See diag/SYSTEM-PROMPTS.md for the measurements. Keep this block small: it joins
// the cached prompt prefix, and each claim has to stay true as Claude Code changes.

import { MCP_TOOL_PREFIX } from "./skills.js";

export interface HarnessCorrectionsInput {
	/** pi-registered model id, e.g. "claude-sonnet-5". */
	modelId: string;
	/** Id actually sent to Claude Code, which may carry a "[1m]" suffix. */
	cliModelId: string;
	/**
	 * True on the provider path, which sends `tools: []` and bridges pi's tools
	 * over MCP instead. False for AskClaude, where Claude Code's native tools are
	 * really present and must not be disclaimed.
	 */
	toolsAreMcpOnly: boolean;
	/**
	 * True when no shell tool is reachable. On the provider path this is covered
	 * by the MCP bullet; set it for AskClaude modes that block Bash.
	 */
	noShellTool?: boolean;
}

export function buildHarnessCorrections(input: HarnessCorrectionsInput): string | undefined {
	const bullets: string[] = [];

	// The legacy-family preset (Opus 4.6/4.7, Sonnet 5/4.6, Haiku 4.5) tells the
	// model to "prefer dedicated tools over PowerShell when one fits (Read, Edit,
	// Write, Glob, Grep)". With an empty native inventory none of those exist, and
	// PowerShell is named regardless of the actual platform.
	if (input.toolsAreMcpOnly) {
		bullets.push(
			`Claude Code's own tools (Read, Edit, Write, Glob, Grep, Bash) are not available under those names, ` +
			`and there is no PowerShell. Every tool in this session is supplied by the host application under the ` +
			`\`${MCP_TOOL_PREFIX}\` prefix. Use the tools you were actually given and disregard guidance naming ` +
			`Claude Code's tools or a specific shell.`,
		);
	} else if (input.noShellTool) {
		bullets.push(
			`You have no shell tool in this session. Disregard guidance about running commands through ` +
			`PowerShell or Bash, and do not substitute another tool for shell execution.`,
		);
	}

	// claudeCodeModelId appends "[1m]" to request the 1M context window. Claude Code
	// echoes whatever it was given into "The exact model ID is ...", so without this
	// the model reports an id that does not exist in the API.
	// Guarded on startsWith rather than plain inequality: the only difference this
	// block is qualified to explain is an appended suffix. Any other divergence
	// (an unregistered id resolved elsewhere) is not a suffix, and describing it as
	// one would replace a true-but-odd statement with a false one.
	if (input.cliModelId !== input.modelId && input.cliModelId.startsWith(input.modelId)) {
		bullets.push(
			`Your exact model ID is \`${input.modelId}\`. The \`${input.cliModelId.slice(input.modelId.length)}\` ` +
			`suffix shown in the environment section is this harness's way of requesting the 1M-token context ` +
			`window, not part of the model ID.`,
		);
	}

	if (bullets.length === 0) return undefined;
	return [
		"# Harness corrections",
		"",
		"The instructions above are Claude Code's defaults and describe a harness this session does not use.",
		"Where they conflict with the following, the following wins.",
		"",
		...bullets.map((bullet) => ` - ${bullet}`),
	].join("\n");
}
