// AGENTS.md discovery for forwarding to Claude Code.
//
// Pi uses AGENTS.md for long-lived instructions; Claude Code receives the same
// content under "# CLAUDE.md". Paths and Pi-specific terms remain unchanged so
// the forwarded instructions still refer to real Pi resources.

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

const DEFAULT_AGENT_DIR = join(homedir(), ".pi", "agent");

/**
 * `startDir` must be the SESSION's cwd, not the process cwd. Pi's stream options
 * carry no cwd, so every caller used to fall back to process.cwd(): in the TUI
 * those coincide, but an SDK or harness caller that sets a session cwd got
 * discovery anchored on wherever the host process happened to start. That put
 * one project's AGENTS.md into a different project's session.
 *
 * `agentDir` is the session's agent dir, for the same reason. The global
 * fallback used to be a constant off homedir(), so a run isolated under
 * createAgentSession({ agentDir }) still had the operator's personal
 * instructions forwarded into it as "# CLAUDE.md".
 */
export function resolveAgentsMdPath(
	startDir: string = process.cwd(),
	agentDir: string = DEFAULT_AGENT_DIR,
): string | undefined {
	const fromCwd = findAgentsMdInParents(startDir);
	if (fromCwd) return fromCwd;
	const globalAgentsPath = join(agentDir, "AGENTS.md");
	if (existsSync(globalAgentsPath)) return globalAgentsPath;
	return undefined;
}

export function findAgentsMdInParents(startDir: string): string | undefined {
	let current = resolve(startDir);
	while (true) {
		const candidate = join(current, "AGENTS.md");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

export function extractAgentsAppend(startDir?: string, agentDir?: string): string | undefined {
	const agentsPath = resolveAgentsMdPath(startDir, agentDir);
	if (!agentsPath) return undefined;
	try {
		const content = readFileSync(agentsPath, "utf-8").trim();
		if (!content) return undefined;
		return `# CLAUDE.md\n\n${content}`;
	} catch {
		return undefined;
	}
}
