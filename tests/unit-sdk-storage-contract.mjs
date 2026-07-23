import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	getSessionMessages,
	listSessions,
	resolveSettings,
} from "@anthropic-ai/claude-agent-sdk";
import { createSession } from "cc-session-io";

async function withClaudeConfigDir(configDir, callback) {
	const previous = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = configDir;
	try {
		return await callback();
	} finally {
		if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = previous;
	}
}

describe("offline SDK settings contracts", () => {
	it("relocates user settings and honors settingSources", async () => {
		const root = mkdtempSync(join(tmpdir(), "claude-sdk-settings-"));
		const configDir = join(root, "isolated-claude");
		const projectDir = join(root, "project");
		mkdirSync(join(projectDir, ".claude"), { recursive: true });
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "settings.json"),
			JSON.stringify({ model: "user-contract-model" }),
		);
		writeFileSync(
			join(projectDir, ".claude", "settings.json"),
			JSON.stringify({ cleanupPeriodDays: 17 }),
		);

		try {
			await withClaudeConfigDir(configDir, async () => {
				const userOnly = await resolveSettings({
					cwd: projectDir,
					settingSources: ["user"],
				});
				assert.equal(userOnly.effective.model, "user-contract-model");
				assert.equal(userOnly.effective.cleanupPeriodDays, undefined);
				assert.equal(
					userOnly.sources.find((source) => source.source === "user")?.path,
					join(configDir, "settings.json"),
				);
				assert.equal(
					userOnly.sources.some((source) => source.source === "project"),
					false,
				);

				const combined = await resolveSettings({
					cwd: projectDir,
					settingSources: ["user", "project"],
				});
				assert.equal(combined.effective.model, "user-contract-model");
				assert.equal(combined.effective.cleanupPeriodDays, 17);
				assert.ok(combined.sources.some((source) => source.source === "user"));
				assert.ok(combined.sources.some((source) => source.source === "project"));

				const isolated = await resolveSettings({
					cwd: projectDir,
					settingSources: [],
				});
				assert.equal(isolated.effective.model, undefined);
				assert.equal(isolated.effective.cleanupPeriodDays, undefined);
				assert.equal(
					isolated.sources.some(
						(source) => source.source === "user" || source.source === "project",
					),
					false,
				);
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("offline SDK session contracts", () => {
	it("reads and lists a synthetic cc-session-io transcript", async () => {
		const root = mkdtempSync(join(tmpdir(), "claude-sdk-session-"));
		const configDir = join(root, "isolated-claude");
		const projectDir = join(root, "project");
		const sessionId = "10000000-0000-4000-8000-000000000002";
		mkdirSync(projectDir, { recursive: true });

		try {
			const session = createSession({
				projectPath: projectDir,
				claudeDir: configDir,
				sessionId,
				version: "offline-contract",
				model: "fake-claude",
			});
			session.addUserMessage("synthetic user prompt");
			session.addAssistantMessage([
				{ type: "text", text: "synthetic assistant response" },
			]);
			session.save();

			await withClaudeConfigDir(configDir, async () => {
				const messages = await getSessionMessages(sessionId, {
					dir: projectDir,
				});
				assert.deepEqual(
					messages.map((message) => message.type),
					["user", "assistant"],
				);
				assert.deepEqual(messages[0].message, {
					role: "user",
					content: "synthetic user prompt",
				});
				assert.equal(
					messages[1].message.content[0].text,
					"synthetic assistant response",
				);

				const sessions = await listSessions({ dir: projectDir });
				const listed = sessions.find((entry) => entry.sessionId === sessionId);
				assert.ok(listed);
				assert.equal(listed.firstPrompt, "synthetic user prompt");
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
