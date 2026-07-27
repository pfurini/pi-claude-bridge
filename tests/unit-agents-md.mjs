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
});
