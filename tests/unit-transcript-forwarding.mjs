import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toBridgeContext } from "../src/transcript.js";
import { extractProjectContextBlock } from "../src/project-context.js";
import { sanitizeHarnessPrompt } from "../src/sanitize-prompt.js";
import { __test } from "../src/index.js";

const project = '<project_context>\n<project_instructions path="/workspace/AGENTS.md">PROJECT_RULE</project_instructions>\n</project_context>';
const listing = '<available_skills version="2">\n<skill><name>deploy</name><description>Deploy safely</description><location>/skills/deploy/SKILL.md</location></skill>\n</available_skills>';
const skillSection = `<skills>\nThe following skills provide specialized instructions for specific tasks.\n${listing}\n</skills>`;
const tool = name => ({ name, description: name, parameters: { type: "object", properties: {} } });
const user = content => ({ role: "user", content, timestamp: 1 });
const system = fields => ({ role: "system", content: "", timestamp: 0, ...fields });
const initial = () => system({ sections: { preamble: "PI_HARNESS", project_context: project, skills: skillSection }, toolsAdded: [tool("read"), tool("bash"), tool("skill")] });

describe("transcript forwarding without prompt captures", () => {
	it('forwards effective custom sections, addendum, and authored rule contributions exactly once', () => {
		const context = toBridgeContext({ messages: [system({ sections: { project_context: project, addendum: '<addendum>USER_ADDENDUM</addendum>', rules: '<rules>\n- Be concise in your responses\n- DATA_BOUNDARY\n</rules>', custom: '<custom>CUSTOM_POLICY</custom>' } }), user('go')] });
		const append = __test.buildProviderSystemPromptAppend({ id: 'claude-haiku-4-5' }, context);
		for (const marker of ['PROJECT_RULE', 'USER_ADDENDUM', 'DATA_BOUNDARY', 'CUSTOM_POLICY']) assert.equal(append.split(marker).length - 1, 1, marker);
	});

	it('treats forced replacements, including empty replacements, as authoritative over stale lifecycle customization', () => {
		const previous = __test.setUserSystemPrompt({ custom: 'STALE_CUSTOM', append: 'STALE_APPEND' });
		try {
			for (const content of ['FORCED_RULE', '']) {
				const context = toBridgeContext({ messages: [system({ content }), user('go')] });
				const append = __test.buildProviderSystemPromptAppend({ id: 'claude-haiku-4-5' }, context);
				assert.doesNotMatch(append, /STALE_CUSTOM|STALE_APPEND|PROJECT_RULE/);
				if (content) assert.match(append, /FORCED_RULE/);
			}
		} finally { __test.setUserSystemPrompt(previous); }
	});

	it("extracts project instructions and versioned skills after prompt widening", () => {
		const context = toBridgeContext({ messages: [initial(), system({ sections: { tools: "Expanded MCP descriptions" } }), user("go")] });
		assert.ok(context.systemPrompt.includes("Expanded MCP descriptions"));
		assert.ok(extractProjectContextBlock(context.systemPrompt).includes("PROJECT_RULE"));
		const append = __test.providerSkillsAppend(context, true);
		assert.ok(append.includes(listing));
		assert.ok(append.includes("mcp__custom-tools__skill"));
		assert.ok(!append.includes("PI_HARNESS"));
		assert.deepEqual(context.messages, [user("go")]);
	});
	it("replays prompt sections added on skill-bearing turns", () => {
		const context = toBridgeContext({ messages: [initial(), user('<skill name="deploy">instructions</skill>'), system({ sections: { extension: "EXTENSION_RULE" } })] });
		assert.ok(context.systemPrompt.includes("EXTENSION_RULE"));
		assert.ok(__test.providerSkillsAppend(context, true).includes(listing));
		assert.ok(extractProjectContextBlock(context.systemPrompt).includes("PROJECT_RULE"));
	});
	it("honors tool removal and restoration and updates skill framing", () => {
		const messages = [initial(), user("go"), system({ toolsRemoved: [{ name: "bash" }, { name: "skill" }] })];
		const removed = toBridgeContext({ messages });
		assert.deepEqual(removed.tools.map(tool => tool.name), ["read"]);
		assert.ok(__test.providerSkillsAppend(removed, true).includes("mcp__custom-tools__read"));
		const restored = toBridgeContext({ messages: [...messages, system({ toolsAdded: [tool("bash"), tool("skill")] })] });
		assert.deepEqual(restored.tools.map(tool => tool.name).sort(), ["bash", "read", "skill"]);
		assert.ok(__test.providerSkillsAppend(restored, true).includes("mcp__custom-tools__skill"));
	});
	it("needs no shared capture registry across independently imported instances", async () => {
		const child = await import("../src/index.js?transcript-child");
		const context = toBridgeContext({ messages: [initial(), user("child task")] });
		assert.equal(child.__test.providerSkillsAppend(context, true), __test.providerSkillsAppend(context, true));
		assert.equal(child.__test.promptCaptures, undefined);
	});
	it("uses the current transcript rather than stale lifecycle prompt keys", () => {
		const updated = project.replace("PROJECT_RULE", "NEW_PROJECT_RULE");
		const context = toBridgeContext({ messages: [initial(), system({ sections: { project_context: updated, skills: null } }), user("next")] });
		assert.ok(extractProjectContextBlock(context.systemPrompt).includes("NEW_PROJECT_RULE"));
		assert.equal(__test.providerSkillsAppend(context, true), undefined);
	});
	it("accepts independently constructed and forced transcript heads", () => {
		const context = toBridgeContext({ messages: [system({ content: `${project}\n\n${listing}` }), user("external host")] });
		assert.ok(extractProjectContextBlock(context.systemPrompt).includes("PROJECT_RULE"));
		assert.ok(__test.providerSkillsAppend(context, true).includes(listing));
	});
	it("does not reject authored documentation path pairs", () => {
		const authored = "Consult docs/custom-provider.md and docs/packages.md.";
		assert.equal(sanitizeHarnessPrompt(authored), authored);
	});
	it("preserves unpersisted skill carry-forward messages in projected history", () => {
		const carry = user('<skill name="deploy">CARRY_FORWARD</skill>');
		const context = toBridgeContext({ messages: [initial(), user("compaction summary"), carry, user("continue")] });
		assert.deepEqual(context.messages, [user("compaction summary"), carry, user("continue")]);
	});
});
