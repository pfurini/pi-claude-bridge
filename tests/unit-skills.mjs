/**
 * Tests for skills listing extraction and framing (plans/skill-listing-contract.md).
 *
 * The bridge locates pi's skill listing by the versioned
 * `<available_skills version="2">` delimiters (AC1), still accepts the
 * unversioned stock-pi form (AC2), fails visible on an unknown version (AC3),
 * and writes its own framing in place of pi's preamble, chosen per request
 * from the session's active tool set (AC5-AC8). AC9/AC10 are fork drift
 * guards, skipped on stock pi.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as ca from "@earendil-works/pi-coding-agent";
import {
	SKILL_LISTING_END_DELIMITER,
	SKILL_LISTING_START_DELIMITER,
	SKILL_LISTING_VERSION,
	extractSkillsBlock,
	extractSkillsBlockForAskClaude,
	extractSkillsBlockForProvider,
} from "../src/skills.js";

/** Run fn with console.warn captured; returns the warning strings. */
function captureWarns(fn) {
	const warnings = [];
	const original = console.warn;
	console.warn = (...args) => warnings.push(args.join(" "));
	try {
		fn();
	} finally {
		console.warn = original;
	}
	return warnings;
}

const SKILL_ENTRIES = `  <skill>
    <name>br</name>
    <description>Browser automation CLI.</description>
    <location>/Users/esd/projects/pi-my-stuff/skills/br/SKILL.md</location>
  </skill>
  <skill>
    <name>deep-research</name>
    <description>Deep research via parallel web agents.</description>
    <location>/Users/esd/.pi/agent/skills/deep-research/SKILL.md</location>
  </skill>`;

const PREAMBLE_READ = `The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.`;

// The fork's other preamble variant: same shape, "skill tool" instruction line.
const PREAMBLE_TOOL = `The following skills provide specialized instructions for specific tasks.
Use the skill tool to invoke a skill and receive its rendered instructions when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.`;

// v2 listing (fork), with the skill-tool preamble variant.
const V2_PROMPT = `You are a coding assistant.

${PREAMBLE_TOOL}

${SKILL_LISTING_START_DELIMITER}
${SKILL_ENTRIES}
${SKILL_LISTING_END_DELIMITER}

Some other system prompt content after skills.`;

// Stock pi's emitted form: same preamble lines, hard-coded read wording, and a
// bare <available_skills> with no version attribute. Guards the >=0.82.1 peer
// promise.
const LEGACY_PROMPT = `You are a coding assistant.

${PREAMBLE_READ}

<available_skills>
${SKILL_ENTRIES}
</available_skills>

Some other system prompt content after skills.`;

describe("skills listing detection", () => {
	it("AC1: v2 block extracted by delimiter, block only — no preamble", () => {
		const result = extractSkillsBlock(V2_PROMPT, { framing: "read-mcp" });
		assert.ok(result, "should extract the listing");
		assert.equal(result.legacy, false);
		assert.ok(result.block.startsWith(SKILL_LISTING_START_DELIMITER));
		assert.ok(result.block.endsWith(SKILL_LISTING_END_DELIMITER));
		assert.ok(
			!result.block.includes("The following skills"),
			"preamble leaked into block",
		);
		assert.ok(
			!result.block.includes("Use the skill tool"),
			"preamble leaked into block",
		);
		assert.ok(!result.block.includes("Some other system prompt"));
	});

	it("AC2: unversioned stock-pi block still extracted, legacy: true", () => {
		const result = extractSkillsBlock(LEGACY_PROMPT, { framing: "read-mcp" });
		assert.ok(result, "should extract the legacy listing");
		assert.equal(result.legacy, true);
		assert.ok(result.block.startsWith("<available_skills>"));
		assert.ok(result.block.endsWith("</available_skills>"));
		assert.ok(
			result.block.includes("/Users/esd/projects/pi-my-stuff/skills/br/SKILL.md"),
		);
		assert.ok(
			result.block.includes("/Users/esd/.pi/agent/skills/deep-research/SKILL.md"),
		);
	});

	it("AC3: unknown listing version forwards nothing and warns exactly once", () => {
		const prompt = `<available_skills version="3">\n${SKILL_ENTRIES}\n</available_skills>`;
		let result;
		const warnings = captureWarns(() => {
			result = extractSkillsBlock(prompt, { framing: "read-mcp" });
		});
		assert.strictEqual(result, undefined);
		assert.equal(
			warnings.length,
			1,
			`expected exactly one warning, got ${JSON.stringify(warnings)}`,
		);
		assert.ok(
			warnings[0].includes('version="3"'),
			"warning should name the found tag",
		);
		assert.ok(
			warnings[0].includes('version="2"'),
			"warning should name the expected version",
		);
	});

	it("AC4: no listing → undefined, no warning; malformed (start, no end) → undefined, no warning", () => {
		const noListing = captureWarns(() => {
			assert.strictEqual(
				extractSkillsBlock("Just a normal prompt", { framing: "read-mcp" }),
				undefined,
			);
			assert.strictEqual(
				extractSkillsBlock(undefined, { framing: "read-mcp" }),
				undefined,
			);
			assert.strictEqual(
				extractSkillsBlock("", { framing: "read-mcp" }),
				undefined,
			);
		});
		assert.deepEqual(
			noListing,
			[],
			"no-skills must not warn (distinguishes 'no skills' from 'wrong version')",
		);

		const malformed = captureWarns(() => {
			assert.strictEqual(
				extractSkillsBlock(`${SKILL_LISTING_START_DELIMITER}\n${SKILL_ENTRIES}`, {
					framing: "read-mcp",
				}),
				undefined,
			);
		});
		assert.deepEqual(malformed, [], "malformed listing must not warn");
	});
});

describe("framing variants", () => {
	it("AC5: skill-tool framing names mcp__custom-tools__skill and never tells the model to read the file", () => {
		const result = extractSkillsBlockForProvider(V2_PROMPT, [{ name: "skill" }]);
		assert.ok(result);
		assert.ok(result.framing.includes("mcp__custom-tools__skill"));
		assert.ok(
			!/read(ing)? the file/i.test(result.framing),
			"skill-tool framing must not redirect to file reads",
		);
	});

	it("AC6: read-mcp framing names mcp__custom-tools__read and never claims a skill tool exists", () => {
		const result = extractSkillsBlockForProvider(V2_PROMPT, [
			{ name: "read" },
			{ name: "bash" },
		]);
		assert.ok(result);
		assert.ok(result.framing.includes("mcp__custom-tools__read"));
		assert.ok(!result.framing.includes("mcp__custom-tools__skill"));
	});

	it("AC6: missing tools list degrades to read-mcp, not a crash", () => {
		const result = extractSkillsBlockForProvider(V2_PROMPT, undefined);
		assert.ok(result);
		assert.ok(result.framing.includes("mcp__custom-tools__read"));
	});

	it("AC7: AskClaude framing names the native Read tool and never the mcp__custom-tools__ prefix", () => {
		const result = extractSkillsBlockForAskClaude(V2_PROMPT);
		assert.ok(result);
		assert.ok(result.framing.includes("Read tool"));
		assert.ok(
			!result.framing.includes("mcp__custom-tools__"),
			"naming the MCP tool there points the sub-agent at a tool it does not have",
		);
	});

	it("AC8: all three framings retain the relative-path resolution instruction", () => {
		for (const framing of ["skill-tool", "read-mcp", "read-native"]) {
			const result = extractSkillsBlock(V2_PROMPT, { framing });
			assert.ok(
				result.framing.includes("resolve it against the skill directory"),
				`${framing} framing lost the relative-path line`,
			);
		}
	});
});

describe("fork drift guards", () => {
	it("AC9: pi still excludes claude-bridge from synthetic-pair delivery", async (t) => {
		// selectSkillTransport is not re-exported through the package's exports
		// map, so import the compiled module by path. Stock pi has no such file.
		let delivery;
		try {
			delivery = await import(
				new URL(
					"../node_modules/@earendil-works/pi-coding-agent/dist/core/skills/delivery.js",
					import.meta.url,
				).href
			);
		} catch {
			t.skip("pi build without core/skills/delivery.js (stock pi)");
			return;
		}
		if (typeof delivery.selectSkillTransport !== "function") {
			t.skip("selectSkillTransport not reachable in this pi build");
			return;
		}
		// Control: a replay-capable non-excluded provider must get the synthetic
		// pair, or the exclusion assertion below proves nothing.
		assert.equal(
			delivery.selectSkillTransport(
				{ provider: "openai-codex", syntheticToolResultReplay: true },
				{ forceMessageBlock: false },
			),
			"synthetic-pair",
			"control failed: synthetic-pair path itself changed — re-check this test before trusting it",
		);
		assert.equal(
			delivery.selectSkillTransport(
				{ provider: "claude-bridge", syntheticToolResultReplay: true },
				{ forceMessageBlock: false },
			),
			"message-block",
			"claude-bridge dropped from SYNTHETIC_PAIR_EXCLUDED_PROVIDERS — the bridge cannot accept an injected assistant tool_use block",
		);
	});

	it("AC10: copied delimiters are byte-identical to pi's exports", (t) => {
		// Namespace import (module top-level): a missing export is undefined
		// here, not a link-time SyntaxError on stock pi.
		if (ca.SKILL_LISTING_START_DELIMITER === undefined) {
			t.skip("stock pi does not export the listing delimiters");
			return;
		}
		assert.equal(SKILL_LISTING_VERSION, ca.SKILL_LISTING_VERSION);
		assert.equal(SKILL_LISTING_START_DELIMITER, ca.SKILL_LISTING_START_DELIMITER);
		assert.equal(SKILL_LISTING_END_DELIMITER, ca.SKILL_LISTING_END_DELIMITER);
	});
});
