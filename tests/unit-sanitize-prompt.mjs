import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeHarnessPrompt } from "../src/sanitize-prompt.js";
// Not re-exported from the package root, and the `exports` map blocks deep
// bare-specifier imports (ERR_PACKAGE_PATH_NOT_EXPORTED), so this goes
// through the `file:` devDependency link by relative path — the fork
// checkout is guaranteed present (`npm ci` fails without it, per AGENTS.md).
import { buildSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

const CWD = "/tmp/sanitize-prompt-fixture-project";
const CONTEXT_FILES = [
	{ path: "AGENTS.md", content: "Follow the house style." },
];
const SKILLS = [
	{
		name: "test-skill",
		description: "A fixture skill for the sanitizer test.",
		filePath: "/tmp/skills/test-skill/SKILL.md",
		disableModelInvocation: false,
	},
];

// pi-subagents' buildAgentPrompt ("append" prompt_mode), literal template:
// identity + "\n\n" + bridge + "\n\n" + activeAgentTag + envBlock + customSection.
const SUB_AGENT_BRIDGE = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
- Use the read tool instead of cat/head/tail
- Use the edit tool instead of sed/awk
- Use the write tool instead of echo/heredoc
- Use the find tool instead of bash find/ls for file search
- Use the grep tool instead of bash grep/rg for content search
- Make independent tool calls in parallel
- Use absolute file paths
- Do not use emojis
- Be concise but complete
</sub_agent_context>`;
const ACTIVE_AGENT_TAG = `<active_agent name="test-agent"/>\n\n`;
const ENV_BLOCK = `# Environment
Working directory: ${CWD}
Not a git repository
Platform: darwin`;
const AGENT_INSTRUCTIONS = `\n\n<agent_instructions>\nFind the sentinel and report it.\n</agent_instructions>`;

function wrapAsSubagentAppend(parentSystemPrompt) {
	return (
		parentSystemPrompt +
		"\n\n" +
		SUB_AGENT_BRIDGE +
		"\n\n" +
		ACTIVE_AGENT_TAG +
		ENV_BLOCK +
		AGENT_INSTRUCTIONS
	);
}

describe("sanitizeHarnessPrompt", () => {
	it("strips the real fork skeleton and duplicate context/skills blocks, keeping the sub-agent wrapper verbatim", () => {
		const parentPrompt = buildSystemPrompt({
			cwd: CWD,
			contextFiles: CONTEXT_FILES,
			skills: SKILLS,
		});
		const wrapped = wrapAsSubagentAppend(parentPrompt);

		const result = sanitizeHarnessPrompt(wrapped, {
			sourcePrompt: parentPrompt,
		});

		assert.ok(result, "expected a sanitized prompt, not undefined");
		assert.doesNotMatch(
			result,
			/You are an expert coding assistant operating inside pi/,
		);
		assert.doesNotMatch(result, /docs\/custom-provider\.md/);
		assert.doesNotMatch(result, /<project_context>/);
		assert.doesNotMatch(result, /<available_skills>/);
		assert.match(result, /<sub_agent_context>/);
		assert.ok(
			result.includes(SUB_AGENT_BRIDGE),
			"expected the sub_agent_context bridge to survive byte-exact",
		);
		assert.ok(
			result.includes(AGENT_INSTRUCTIONS.trim()),
			"expected <agent_instructions> to survive byte-exact",
		);
	});

	it("preserves the parent's own --append-system-prompt text (review finding 1)", () => {
		const parentPrompt = buildSystemPrompt({
			cwd: CWD,
			appendSystemPrompt: "KEEP_ME_APPEND_TEXT",
		});
		const wrapped = wrapAsSubagentAppend(parentPrompt);

		const result = sanitizeHarnessPrompt(wrapped, {
			sourcePrompt: parentPrompt,
		});

		assert.ok(
			result.includes("KEEP_ME_APPEND_TEXT"),
			"expected the append-system-prompt text to survive byte-exact",
		);
		assert.doesNotMatch(
			result,
			/You are an expert coding assistant operating inside pi/,
		);
	});

	it("respects the appendSystemPrompt gate: no sourcePrompt keeps an embedded block, a sourcePrompt removes only its byte-exact duplicate (review finding 2)", () => {
		const sourceBlock = `<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="AGENTS.md">\nFollow the house style.\n</project_instructions>\n\n</project_context>`;
		const distinctBlock = `<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="OTHER.md">\nA different, unrelated rule.\n</project_instructions>\n\n</project_context>`;
		const sourcePrompt = `Unrelated preamble.\n\n${sourceBlock}\n`;
		const text = `Some custom prompt text.\n\n${sourceBlock}\n\n${distinctBlock}\n\nTrailer text.`;

		const ungated = sanitizeHarnessPrompt(text);
		assert.equal(
			ungated,
			text,
			"with no sourcePrompt, an embedded block is the only copy and must survive",
		);

		const gated = sanitizeHarnessPrompt(text, { sourcePrompt });
		assert.ok(
			!gated.includes(sourceBlock),
			"the byte-exact duplicate of sourcePrompt's block should be removed",
		);
		assert.ok(
			gated.includes(distinctBlock),
			"a second, distinct project_context block should survive",
		);
	});

	it("passes plain user text through unchanged, including triple newlines (review finding 3)", () => {
		const text =
			"Just some normal instructions.\n\n\n\nWith a triple newline gap on purpose.";
		assert.equal(sanitizeHarnessPrompt(text), text);
	});

	it("is a no-op when only the start anchor is present without the end anchor", () => {
		const text =
			"You are an expert coding assistant operating inside pi, a coding agent harness. But nothing else matches here.";
		assert.equal(sanitizeHarnessPrompt(text), text);
	});

	it("returns undefined when the input is all boilerplate", () => {
		const bareSkeleton = buildSystemPrompt({ cwd: CWD });
		assert.equal(sanitizeHarnessPrompt(bareSkeleton), undefined);
	});

	it("is idempotent", () => {
		const parentPrompt = buildSystemPrompt({
			cwd: CWD,
			contextFiles: CONTEXT_FILES,
			skills: SKILLS,
		});
		const wrapped = wrapAsSubagentAppend(parentPrompt);
		const opts = { sourcePrompt: parentPrompt };

		const once = sanitizeHarnessPrompt(wrapped, opts);
		const twice = sanitizeHarnessPrompt(once, opts);

		assert.equal(twice, once);
	});

	it("AC11: strips preamble AND block for both pi preamble variants", () => {
		// The forwarding extractor (src/skills.ts) keys off the versioned listing
		// delimiters; this one keeps the prose markers on purpose (D4) — it must
		// remove what pi *embedded*, preamble included, since that self-identifying
		// boilerplate is what routes a request to metered usage. pi picks the
		// instruction line from the active tool set, so pin both wordings.
		const preambles = [
			"Use the read tool to load a skill's file when the task matches its description.",
			"Use the skill tool to invoke a skill and receive its rendered instructions when the task matches its description.",
		];
		for (const instructionLine of preambles) {
			const span = [
				"The following skills provide specialized instructions for specific tasks.",
				instructionLine,
				"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
				"",
				'<available_skills version="2">',
				"  <skill><name>br</name><location>/tmp/skills/br/SKILL.md</location></skill>",
				"</available_skills>",
			].join("\n");
			const sourcePrompt = `Parent prompt head.\n\n${span}\n`;
			const text = `Some custom prompt text.\n\n${span}\n\nTrailer text.`;

			const result = sanitizeHarnessPrompt(text, { sourcePrompt });
			assert.ok(result, `expected survivors for preamble variant: ${instructionLine}`);
			assert.ok(!result.includes("The following skills"), "preamble survived");
			assert.ok(!result.includes("available_skills"), "block survived");
			assert.ok(!result.includes(instructionLine), "instruction line survived");
			assert.ok(result.includes("Some custom prompt text."));
			assert.ok(result.includes("Trailer text."));
		}
	});

	it("keeps the embedded listing when the caller forwarded none", () => {
		// The forwarding extractor declines a listing version it does not know,
		// while the prose markers here still match it. Stripping the embedded copy
		// then leaves the subagent with no catalog from either channel.
		const span = [
			"The following skills provide specialized instructions for specific tasks.",
			"Use the read tool to load a skill's file when the task matches its description.",
			'<available_skills version="9">',
			"  <skill><name>br</name><location>/tmp/skills/br/SKILL.md</location></skill>",
			"</available_skills>",
		].join("\n");
		const sourcePrompt = `Parent prompt head.\n\n${span}\n`;
		const text = `Some custom prompt text.\n\n${span}\n\nTrailer text.`;

		const kept = sanitizeHarnessPrompt(text, { sourcePrompt, skillsForwarded: false });
		assert.ok(kept.includes("<available_skills"), "stripped a catalog nothing replaced");

		// The project-context half of the dedupe is unaffected by the skills gate.
		const withContext = `${text}\n\n<project_context>\nrules\n</project_context>`;
		const deduped = sanitizeHarnessPrompt(withContext, {
			sourcePrompt: `${sourcePrompt}\n<project_context>\nrules\n</project_context>`,
			skillsForwarded: false,
		});
		assert.ok(!deduped.includes("<project_context>"), "project context dedupe stopped firing");
	});

	it("passes undefined through unchanged", () => {
		assert.equal(sanitizeHarnessPrompt(undefined), undefined);
	});
});
