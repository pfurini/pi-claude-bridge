import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractAgentsAppend } from "../src/agents-md.js";

describe("AGENTS.md forwarding", () => {
	it("preserves Pi paths and terminology verbatim", () => {
		const previousCwd = process.cwd();
		const root = mkdtempSync(join(tmpdir(), "claude-bridge-agents-"));
		const nested = join(root, "nested");
		const content =
			"Read ~/.pi/agent/AGENTS.md and use the pi package from .pi/skills.";
		try {
			mkdirSync(nested);
			writeFileSync(join(root, "AGENTS.md"), `${content}\n`);
			process.chdir(nested);
			assert.equal(extractAgentsAppend(), `# CLAUDE.md\n\n${content}`);
		} finally {
			process.chdir(previousCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("discovers from the given directory, not the process cwd", () => {
		// Pi's stream options carry no cwd, so the provider path used to fall back to
		// process.cwd(). In the TUI that matches the session; for an SDK or harness
		// caller it is wherever the host process started, which put one project's
		// instructions into another project's session.
		const previousCwd = process.cwd();
		const sessionRoot = mkdtempSync(join(tmpdir(), "claude-bridge-session-"));
		const processRoot = mkdtempSync(join(tmpdir(), "claude-bridge-process-"));
		try {
			writeFileSync(join(sessionRoot, "AGENTS.md"), "SESSION PROJECT\n");
			writeFileSync(join(processRoot, "AGENTS.md"), "HOST PROCESS PROJECT\n");
			process.chdir(processRoot);
			assert.equal(extractAgentsAppend(sessionRoot), "# CLAUDE.md\n\nSESSION PROJECT");
		} finally {
			process.chdir(previousCwd);
			rmSync(sessionRoot, { recursive: true, force: true });
			rmSync(processRoot, { recursive: true, force: true });
		}
	});

	it("still falls back to the process cwd when no directory is given", () => {
		const previousCwd = process.cwd();
		const root = mkdtempSync(join(tmpdir(), "claude-bridge-fallback-"));
		try {
			writeFileSync(join(root, "AGENTS.md"), "FALLBACK\n");
			process.chdir(root);
			assert.equal(extractAgentsAppend(), "# CLAUDE.md\n\nFALLBACK");
		} finally {
			process.chdir(previousCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
