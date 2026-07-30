/**
 * Tests for project-context extraction: pi is the single source of truth for
 * rules, and the bridge forwards pi's assembled <project_context> block
 * verbatim instead of re-discovering files with its own (divergent) resolver.
 * The old resolver read AGENTS.md only, nearest ancestor only - a
 * CLAUDE.md-only project forwarded nothing, and nested projects lost their
 * root rules. Extraction cannot diverge: there is no second resolver.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractProjectContextBlock } from "../src/project-context.js";

const block = (inner) => `<project_context>\n\nProject-specific instructions and guidelines:\n\n${inner}\n</project_context>`;
const file = (path, content) => `<project_instructions path="${path}">\n${content}\n</project_instructions>\n`;

describe("extractProjectContextBlock", () => {
	it("returns undefined when the prompt has no context block (incl. noContextFiles sessions)", () => {
		assert.equal(extractProjectContextBlock("You are a coding agent.\n<available_skills></available_skills>"), undefined);
		assert.equal(extractProjectContextBlock(undefined), undefined);
		assert.equal(extractProjectContextBlock(""), undefined);
	});

	it("extracts the block verbatim, keeping file paths and order", () => {
		// pi's order: agent-dir global first, then ancestors root->cwd. The bridge
		// must not reorder - order IS the precedence contract.
		const inner = file("/home/u/.pi/agent/AGENTS.md", "GLOBAL") +
			file("/repo/CLAUDE.md", "ROOT RULES") +
			file("/repo/pkg/AGENTS.md", "PKG RULES");
		const prompt = `preamble\n\n${block(inner)}\n\nCurrent working directory: /repo/pkg`;
		const out = extractProjectContextBlock(prompt);
		assert.ok(out.includes('path="/home/u/.pi/agent/AGENTS.md"'));
		assert.ok(out.indexOf("GLOBAL") < out.indexOf("ROOT RULES"));
		assert.ok(out.indexOf("ROOT RULES") < out.indexOf("PKG RULES"));
		assert.ok(out.startsWith("Project-specific instructions and guidelines:"));
	});

	it("covers the CLAUDE.md-only project the old resolver silently dropped", () => {
		const prompt = block(file("/repo/CLAUDE.md", "ONLY CLAUDE MD HERE"));
		const out = extractProjectContextBlock(prompt);
		assert.ok(out.includes("ONLY CLAUDE MD HERE"));
	});

	it("does not over-capture into content after the block", () => {
		const prompt = `${block(file("/r/AGENTS.md", "R"))}\n\n<available_skills>SECRET SKILLS</available_skills>`;
		const out = extractProjectContextBlock(prompt);
		assert.ok(!out.includes("SECRET SKILLS"));
		assert.ok(out.endsWith("</project_context>"));
	});

	it("returns undefined on a malformed block missing its end marker", () => {
		assert.equal(extractProjectContextBlock("<project_context>\nunterminated"), undefined);
	});
});
