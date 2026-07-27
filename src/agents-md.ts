// AGENTS.md discovery for forwarding to Claude Code.
//
// Pi uses AGENTS.md for long-lived instructions; Claude Code receives the same
// content under "# CLAUDE.md". Paths and Pi-specific terms remain unchanged so
// the forwarded instructions still refer to real Pi resources.

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

const GLOBAL_AGENTS_PATH = join(homedir(), ".pi", "agent", "AGENTS.md");

/**
 * `startDir` must be the SESSION's cwd, not the process cwd. Pi's stream options
 * carry no cwd, so every caller used to fall back to process.cwd(): in the TUI
 * those coincide, but an SDK or harness caller that sets a session cwd got
 * discovery anchored on wherever the host process happened to start. That put
 * one project's AGENTS.md into a different project's session.
 */
export function resolveAgentsMdPath(startDir: string = process.cwd()): string | undefined {
	const fromCwd = findAgentsMdInParents(startDir);
	if (fromCwd) return fromCwd;
	if (existsSync(GLOBAL_AGENTS_PATH)) return GLOBAL_AGENTS_PATH;
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

export function extractAgentsAppend(startDir?: string): string | undefined {
	const agentsPath = resolveAgentsMdPath(startDir);
	if (!agentsPath) return undefined;
	try {
		const content = readFileSync(agentsPath, "utf-8").trim();
		if (!content) return undefined;
		return `# CLAUDE.md\n\n${content}`;
	} catch {
		return undefined;
	}
}
