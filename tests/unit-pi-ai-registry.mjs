#!/usr/bin/env node

/**
 * Extensions that call pi-ai's global dispatch — completeSimple/streamSimple
 * from "@earendil-works/pi-ai/compat", e.g. rpiv-btw's /btw command — resolve
 * the stream function by model.api in pi-ai's own api registry. pi.registerProvider
 * feeds pi-coding-agent's provider composer instead and never touches that
 * registry, so without a mirrored registration those calls throw
 * "No API provider registered for api: claude-bridge".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getApiProvider } from "@earendil-works/pi-ai/compat";

const { default: activate } = await import("../src/index.js");

const BRIDGE_MODEL = {
	id: "claude-test",
	api: "claude-bridge",
	provider: "claude-bridge",
	baseUrl: "claude-bridge",
};

function activateWithMockPi() {
	activate({ on: () => {}, registerProvider: () => {} });
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("pi-ai api registry registration", () => {
	it("registers claude-bridge so pi-ai's global dispatch can resolve it", () => {
		activateWithMockPi();
		assert.ok(
			getApiProvider("claude-bridge"),
			'completeSimple() on a bridge model throws "No API provider registered for api: claude-bridge" without this',
		);
	});

	it("routes a call into streamClaudeAgentSdk", async () => {
		activateWithMockPi();
		const provider = getApiProvider("claude-bridge");
		// An orphaned tool result with no active query takes the one path that
		// ends the stream without spawning a Claude Code subprocess.
		const stream = provider.streamSimple(BRIDGE_MODEL, {
			messages: [
				{
					role: "toolResult",
					toolCallId: "t1",
					toolName: "bash",
					content: [],
					isError: false,
					timestamp: 0,
				},
			],
		});
		const events = await collect(stream);
		assert.equal(
			events.at(-1)?.type,
			"done",
			"the bridge provider never answered — registration points elsewhere",
		);
	});

	it("routes the plain stream() slot too — pi-ai's complete()/stream() dispatch needs it", async () => {
		activateWithMockPi();
		const provider = getApiProvider("claude-bridge");
		const stream = provider.stream(BRIDGE_MODEL, {
			messages: [
				{
					role: "toolResult",
					toolCallId: "t1",
					toolName: "bash",
					content: [],
					isError: false,
					timestamp: 0,
				},
			],
		});
		const events = await collect(stream);
		assert.equal(
			events.at(-1)?.type,
			"done",
			"the stream slot never answered — complete()/stream() on a bridge model would hang or throw",
		);
	});

	it("wraps the registration with pi-ai's api guard, proving the entry is ours", () => {
		activateWithMockPi();
		const provider = getApiProvider("claude-bridge");
		assert.throws(
			() =>
				provider.streamSimple(
					{ ...BRIDGE_MODEL, api: "anthropic-messages" },
					{ messages: [] },
				),
			/Mismatched api/,
		);
	});

	it("a second activation (subagent module load) does not overwrite the first registration", () => {
		activateWithMockPi();
		const first = getApiProvider("claude-bridge").streamSimple;
		activateWithMockPi(); // ACTIVE_STREAM_SIMPLE_KEY is still held by the first instance
		assert.equal(getApiProvider("claude-bridge").streamSimple, first);
	});
});
