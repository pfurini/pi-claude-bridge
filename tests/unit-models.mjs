/**
 * Tests for MODELS construction + resolveModel + effort resolution.
 * Pins: opus shortcut resolves to whichever opus is first in MODEL_IDS_IN_ORDER,
 * projection strips pi-ai's baseUrl/api/provider/headers, and ordering is preserved.
 *
 * Every case here is mock-driven so a pi-ai bump cannot move it. The two
 * assertions that read the installed catalog live in unit-catalog-gate.mjs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ASK_CLAUDE_THINKING_LEVELS, MODEL_IDS_IN_ORDER, REASONING_TO_EFFORT, REQUIRED_PI_AI_VERSION, applyLongContext, assertClaudeCodeModelAvailable, buildModels, claudeCodeModelId, isClaudeCodeModelAvailable, reportMissingModelIds, resolveClaudeCodeRuntimeModel, resolveEffort, resolveModel } from "../src/models.js";

const PRO = { plan: "pro", longContextExtraUsage: false };
const MAX = { plan: "max", longContextExtraUsage: false };
const EXTRA = { plan: "pro", longContextExtraUsage: true };
const ALL_PLANS = [["pro", PRO], ["max", MAX], ["pro+extra", EXTRA]];

// resolveClaudeCodeRuntimeModel's default branch warns via console.error, so
// "no unknown-model warning" can only be asserted by capturing it — a
// contextWindow check passes whether or not the warning fired.
function captureConsoleError(fn) {
	const original = console.error;
	const lines = [];
	console.error = (...args) => lines.push(args.join(" "));
	try {
		return { result: fn(), lines };
	} finally {
		console.error = original;
	}
}

// Simulated pi-ai registry entry — extra fields mimic the ones pi-ai exposes
// that must not leak into the provider-registered MODELS array.
const mockPiAiModel = (id) => ({
	id, name: id, reasoning: true, input: ["text"], cost: { input: 1, output: 1 },
	contextWindow: 200000, maxTokens: 8000,
	// Leaky fields that should be stripped by the projection:
	baseUrl: "https://api.anthropic.com", api: "anthropic", provider: "anthropic",
	headers: { "x-api-key": "LEAK" },
});

const oneM = (id) => ({ ...mockPiAiModel(id), contextWindow: 1000000 });

const find = (models, id) => models.find((m) => m.id === id);

describe("MODELS projection", () => {
	it("strips baseUrl/api/provider/headers", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		for (const m of models) {
			assert.equal(m.baseUrl, undefined);
			assert.equal(m.api, undefined);
			assert.equal(m.provider, undefined);
			assert.equal(m.headers, undefined);
		}
	});

	it("preserves MODEL_IDS_IN_ORDER ordering", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		assert.deepEqual(models.map((m) => m.id), MODEL_IDS_IN_ORDER);
	});

	it("silently drops IDs missing from pi-ai (no fallback)", () => {
		// Only haiku present — opus/sonnet vanish from picker. buildModels itself
		// stays silent; reportMissingModelIds is the operator-facing signal (below).
		const models = buildModels([mockPiAiModel("claude-haiku-4-5")]);
		assert.deepEqual(models.map((m) => m.id), ["claude-haiku-4-5"]);
	});

	it("registers Opus 5 ahead of Opus 4.8", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		const ids = models.map((m) => m.id);
		assert.ok(ids.includes("claude-opus-5"));
		assert.ok(ids.indexOf("claude-opus-5") < ids.indexOf("claude-opus-4-8"));
	});

	it("keeps Opus 5's catalog thinkingLevelMap instead of a default", () => {
		const catalogMap = { xhigh: "xhigh", max: "max" };
		const models = buildModels([{ ...mockPiAiModel("claude-opus-5"), thinkingLevelMap: catalogMap }]);
		assert.deepEqual(find(models, "claude-opus-5")?.thinkingLevelMap, catalogMap);
	});

	it("forwards pi-ai pricing so usage can be valued", () => {
		// Cost used to be zeroed here (#9): Claude Code bills by subscription, so a
		// per-token total in the footer reads as a bill nobody is paying. Hiding it
		// also took the numbers from every other consumer, leaving a provider that
		// reports usage but values it at zero - nothing could compare this provider
		// against another. The figure is what the tokens would cost at API rates.
		const priced = {
			...mockPiAiModel("claude-opus-5"),
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		};
		assert.deepEqual(find(buildModels([priced]), "claude-opus-5")?.cost, {
			input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25,
		});
	});

	it("completes a partial cost table instead of emitting undefined members", () => {
		// pi multiplies these fields directly, so a missing member gives NaN totals
		// rather than an absent one - worse than a zero, because it propagates.
		const partial = { ...mockPiAiModel("claude-opus-5"), cost: { input: 5, output: 25 } };
		assert.deepEqual(find(buildModels([partial]), "claude-opus-5")?.cost, {
			input: 5, output: 25, cacheRead: 0, cacheWrite: 0,
		});
	});

	it("still yields a complete zero table when the catalog has no pricing", () => {
		const unpriced = { ...mockPiAiModel("claude-opus-5") };
		delete unpriced.cost;
		assert.deepEqual(find(buildModels([unpriced]), "claude-opus-5")?.cost, {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
		});
	});

	it("leaves display names bare before plan-specific context is applied", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(oneM));
		assert.deepEqual(models.map((m) => m.id), MODEL_IDS_IN_ORDER);
		assert.ok(models.every((m) => !m.name.includes("1M")));
	});

	// Fallbacks only reachable below the >=0.82.1 peer floor; values mirror what
	// that release's catalog supplies so the two paths cannot disagree.
	it("fills default thinkingLevelMap for sonnet-5 and sonnet-4-6 when pi-ai omits it", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		assert.deepEqual(find(models, "claude-sonnet-5")?.thinkingLevelMap, { xhigh: "xhigh", max: "max" });
		assert.deepEqual(find(models, "claude-sonnet-4-6")?.thinkingLevelMap, { max: "max" });
	});

	it("gives Opus 5 no default thinkingLevelMap (the catalog owns it)", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		assert.equal(find(models, "claude-opus-5")?.thinkingLevelMap, undefined);
	});

	it("preserves pi-ai's thinkingLevelMap when present", () => {
		const withMap = (id) => ({ ...mockPiAiModel(id), thinkingLevelMap: { xhigh: "xhigh" } });
		const models = buildModels([withMap("claude-sonnet-5")]);
		assert.deepEqual(find(models, "claude-sonnet-5")?.thinkingLevelMap, { xhigh: "xhigh" });
	});

	it("forwards undefined thinkingLevelMap unchanged (no fabricated defaults)", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		assert.equal(find(models, "claude-haiku-4-5")?.thinkingLevelMap, undefined);
	});
});

describe("Claude Code runtime model policy", () => {
	it("uses measured Pro defaults", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-5", PRO), { cliModelId: "claude-opus-5", contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-4-8", PRO), { cliModelId: "claude-opus-4-8", contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-4-7", PRO), { cliModelId: "claude-opus-4-7", contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-4-6", PRO), { cliModelId: "claude-opus-4-6", contextWindow: 200000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-sonnet-4-6", PRO), { cliModelId: "claude-sonnet-4-6", contextWindow: 200000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-haiku-4-5", PRO), { cliModelId: "claude-haiku-4-5", contextWindow: 200000 });
	});

	it("plan max only changes Opus 4.6", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-5", MAX), { cliModelId: "claude-opus-5", contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-4-8", MAX), { cliModelId: "claude-opus-4-8", contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-4-7", MAX), { cliModelId: "claude-opus-4-7", contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-4-6", MAX), { cliModelId: "claude-opus-4-6[1m]", contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-sonnet-4-6", MAX), { cliModelId: "claude-sonnet-4-6", contextWindow: 200000 });
	});

	it("longContextExtraUsage enables metered variants but not Haiku", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-4-6", EXTRA), { cliModelId: "claude-opus-4-6[1m]", contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-sonnet-4-6", EXTRA), { cliModelId: "claude-sonnet-4-6[1m]", contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-haiku-4-5", EXTRA), { cliModelId: "claude-haiku-4-5", contextWindow: 200000 });
	});

	it("unknown model falls back to bare id at 200K", () => {
		const { result, lines } = captureConsoleError(() => resolveClaudeCodeRuntimeModel("claude-future-9-9", PRO));
		assert.deepEqual(result, { cliModelId: "claude-future-9-9", contextWindow: 200000 });
		assert.ok(lines.some((l) => l.includes("no known context size")));
	});

	it("serves Opus 5 bare at 1M on every plan, with no unknown-model warning", () => {
		for (const [label, settings] of ALL_PLANS) {
			const { result, lines } = captureConsoleError(() => resolveClaudeCodeRuntimeModel("claude-opus-5", settings));
			assert.deepEqual(result, { cliModelId: "claude-opus-5", contextWindow: 1000000 }, label);
			assert.deepEqual(lines, [], `${label}: expected no warning, got ${lines.join(" | ")}`);
		}
	});
});

describe("claudeCodeModelId", () => {
	const models = buildModels(MODEL_IDS_IN_ORDER.map(oneM));

	it("returns the measured SDK request id", () => {
		assert.equal(claudeCodeModelId(find(models, "claude-opus-5"), PRO), "claude-opus-5");
		assert.equal(claudeCodeModelId(find(models, "claude-opus-4-8"), PRO), "claude-opus-4-8");
		assert.equal(claudeCodeModelId(find(models, "claude-opus-4-7"), PRO), "claude-opus-4-7");
		assert.equal(claudeCodeModelId(find(models, "claude-opus-4-6"), PRO), "claude-opus-4-6");
		assert.equal(claudeCodeModelId(find(models, "claude-opus-4-6"), MAX), "claude-opus-4-6[1m]");
		assert.equal(claudeCodeModelId(find(models, "claude-fable-5"), MAX), "claude-fable-5[1m]");
		assert.equal(claudeCodeModelId(find(models, "claude-fable-5"), EXTRA), "claude-fable-5[1m]");
		// 5.1 is native 1M on the bare id where 5 needs the suffix — measured on CC 2.1.259.
		assert.equal(claudeCodeModelId(find(models, "claude-fable-5-1"), MAX), "claude-fable-5-1");
		assert.equal(claudeCodeModelId(find(models, "claude-fable-5-1"), EXTRA), "claude-fable-5-1");
		assert.equal(claudeCodeModelId(find(models, "claude-sonnet-4-6"), EXTRA), "claude-sonnet-4-6[1m]");
		assert.equal(claudeCodeModelId(find(models, "claude-haiku-4-5"), EXTRA), "claude-haiku-4-5");
	});

	it("rejects the Fable family on Pro without Extra Usage", () => {
		const unavailable = /Claude Fable requires either a Max plan or Extra Usage on Pro/;
		assert.throws(
			() => claudeCodeModelId(find(models, "claude-fable-5"), PRO),
			unavailable,
		);
		assert.throws(
			() => assertClaudeCodeModelAvailable("claude-fable-5[1m]", PRO),
			unavailable,
		);
		// 5.1 is gated on the same terms as 5. Fail-closed rather than measured: the
		// eligibility probe ran on Max, so Pro-without-Extra-Usage was never exercised.
		assert.throws(
			() => claudeCodeModelId(find(models, "claude-fable-5-1"), PRO),
			unavailable,
		);
		for (const id of ["fable", "claude-fable-5", "claude-fable-5[1m]", "claude-fable-5-1"]) {
			assert.equal(isClaudeCodeModelAvailable(id, PRO), false);
		}
		for (const id of ["claude-fable-5", "claude-fable-5-1"]) {
			assert.equal(isClaudeCodeModelAvailable(id, MAX), true);
			assert.equal(isClaudeCodeModelAvailable(id, EXTRA), true);
		}
	});

	it("keeps the exact Fable 5 id from resolving to 5.1", () => {
		// resolveModel matches with `includes`, so list order is load-bearing here.
		assert.equal(resolveModel(models, "claude-fable-5").id, "claude-fable-5");
		assert.equal(resolveModel(models, "claude-fable-5-1").id, "claude-fable-5-1");
		assert.equal(resolveModel(models, "fable").id, "claude-fable-5");
	});
});

describe("applyLongContext", () => {
	const models = buildModels(MODEL_IDS_IN_ORDER.map(oneM));

	it("registers measured Pro defaults", () => {
		const registered = applyLongContext(models, PRO);
		assert.equal(find(registered, "claude-opus-5").contextWindow, 1000000);
		assert.equal(find(registered, "claude-opus-4-8").contextWindow, 1000000);
		assert.equal(find(registered, "claude-opus-4-7").contextWindow, 1000000);
		assert.equal(find(registered, "claude-opus-4-6").contextWindow, 200000);
		assert.equal(find(registered, "claude-fable-5"), undefined);
		assert.equal(find(registered, "claude-sonnet-4-6").contextWindow, 200000);
		assert.equal(find(registered, "claude-haiku-4-5").contextWindow, 200000);
		// Does not mutate the source table used for id resolution.
		assert.equal(find(models, "claude-opus-4-6").contextWindow, 1000000);
	});

	it("registers Max-plan Fable and Opus 4.6 at 1M but leaves Sonnet 4.6 at 200K", () => {
		const registered = applyLongContext(models, MAX);
		assert.equal(find(registered, "claude-opus-4-6").contextWindow, 1000000);
		assert.equal(find(registered, "claude-fable-5").contextWindow, 1000000);
		assert.equal(find(registered, "claude-sonnet-4-6").contextWindow, 200000);
	});

	it("registers extra-usage Fable, Opus 4.6, and Sonnet 4.6 at 1M", () => {
		const registered = applyLongContext(models, EXTRA);
		assert.equal(find(registered, "claude-opus-4-6").contextWindow, 1000000);
		assert.equal(find(registered, "claude-fable-5").contextWindow, 1000000);
		assert.equal(find(registered, "claude-sonnet-4-6").contextWindow, 1000000);
		assert.equal(find(registered, "claude-haiku-4-5").contextWindow, 200000);
	});

	it("keeps Opus 5 registered at 1M on every plan and never warns", () => {
		for (const [label, settings] of ALL_PLANS) {
			const { result, lines } = captureConsoleError(() => applyLongContext(models, settings));
			const opus5 = find(result, "claude-opus-5");
			assert.equal(opus5?.contextWindow, 1000000, label);
			assert.deepEqual(lines, [], `${label}: expected no warning, got ${lines.join(" | ")}`);
		}
	});

	it("labels exactly the registered 1M models", () => {
		const pro = applyLongContext(models, PRO);
		assert.equal(find(pro, "claude-opus-5").name, "claude-opus-5 1M");
		assert.equal(find(pro, "claude-opus-4-8").name, "claude-opus-4-8 1M");
		assert.equal(find(pro, "claude-opus-4-7").name, "claude-opus-4-7 1M");
		assert.equal(find(pro, "claude-opus-4-6").name, "claude-opus-4-6");
		assert.equal(find(pro, "claude-sonnet-4-6").name, "claude-sonnet-4-6");

		const extra = applyLongContext(models, EXTRA);
		assert.equal(find(extra, "claude-opus-4-6").name, "claude-opus-4-6 1M");
		assert.equal(find(extra, "claude-sonnet-4-6").name, "claude-sonnet-4-6 1M");
	});
});

describe("resolveModel", () => {
	const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));

	it("opus shortcut resolves to claude-opus-5 (first opus in order)", () => {
		assert.equal(resolveModel(models, "opus")?.id, "claude-opus-5");
	});

	it("older opus versions stay explicitly selectable for pinning and rollback", () => {
		for (const id of ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"]) {
			assert.equal(resolveModel(models, id)?.id, id);
		}
	});

	it("haiku shortcut resolves to claude-haiku-4-5", () => {
		assert.equal(resolveModel(models, "haiku")?.id, "claude-haiku-4-5");
	});

	it("full ID resolves to itself", () => {
		assert.equal(resolveModel(models, "claude-opus-4-6")?.id, "claude-opus-4-6");
	});

	it("returns undefined when no match", () => {
		assert.equal(resolveModel(models, "gpt-9"), undefined);
	});

	it("returns the matched model object for CLI-arg conversion", () => {
		const oneMModels = buildModels(MODEL_IDS_IN_ORDER.map(oneM));
		const model = resolveModel(oneMModels, "opus");
		assert.equal(model.id, "claude-opus-5");
		assert.equal(claudeCodeModelId(model, PRO), "claude-opus-5");
		// Explicit Opus 4.8 is native 1M on the bare id, same as Opus 5.
		assert.equal(claudeCodeModelId(resolveModel(oneMModels, "claude-opus-4-8"), PRO), "claude-opus-4-8");
	});
});

describe("Opus 5 availability", () => {
	it("is never gated the way Fable 5 is", () => {
		for (const [label, settings] of ALL_PLANS) {
			assert.equal(isClaudeCodeModelAvailable("claude-opus-5", settings), true, label);
			const registered = applyLongContext(buildModels(MODEL_IDS_IN_ORDER.map(oneM)), settings);
			assert.ok(find(registered, "claude-opus-5"), `${label}: Opus 5 must survive plan filtering`);
		}
		// Fable 5 is the contrast case: filtered out on Pro without Extra Usage.
		assert.equal(isClaudeCodeModelAvailable("claude-fable-5", PRO), false);
	});
});

// Logic-only effort coverage. These inputs are hand-written, so no pi-ai bump
// may change the expectations here — the real-catalog canary is in
// unit-catalog-gate.mjs.
describe("resolveEffort", () => {
	const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	const bothTiers = { thinkingLevelMap: { xhigh: "xhigh", max: "max" } };   // Opus 5, Opus 4.8/4.7, Sonnet 5
	const maxOnly = { thinkingLevelMap: { max: "max" } };                     // Opus 4.6, Sonnet 4.6
	const noMap = { id: "claude-haiku-4-5" };                                 // Haiku: no effort support

	const expected = {
		bothTiers: { off: undefined, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
		maxOnly: { off: undefined, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max" },
		noMap: { off: undefined, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max" },
		unresolved: { off: undefined, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max" },
	};

	for (const [label, model] of [["bothTiers", bothTiers], ["maxOnly", maxOnly], ["noMap", noMap], ["unresolved", undefined]]) {
		it(`maps every level for ${label}`, () => {
			for (const level of LEVELS) {
				assert.equal(resolveEffort(model, level), expected[label][level], `${label}/${level}`);
			}
		});
	}

	it("treats a missing level as no effort", () => {
		assert.equal(resolveEffort(bothTiers, undefined), undefined);
		assert.equal(resolveEffort(bothTiers, ""), undefined);
	});

	it("ignores a null catalog mapping and falls back to the table", () => {
		// Fable 5 ships { off: null, ... }; off must not become an effort value.
		assert.equal(resolveEffort({ thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } }, "off"), undefined);
	});

	it("keeps xhigh escalating to max in the generic fallback table", () => {
		// Load-bearing: models with no catalog xhigh entry have no distinct tier.
		assert.equal(REASONING_TO_EFFORT.xhigh, "max");
		assert.equal(REASONING_TO_EFFORT.max, "max");
	});
});

describe("AskClaude thinking levels", () => {
	it("offers max alongside the pre-existing levels", () => {
		assert.deepEqual([...ASK_CLAUDE_THINKING_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	it("resolves every offered level through the shared helper", () => {
		for (const level of ASK_CLAUDE_THINKING_LEVELS) {
			const effort = resolveEffort({ thinkingLevelMap: { xhigh: "xhigh", max: "max" } }, level);
			if (level === "off") assert.equal(effort, undefined);
			else assert.ok(["low", "medium", "high", "xhigh", "max"].includes(effort), `${level} → ${effort}`);
		}
	});
});

describe("missing-model diagnostic", () => {
	const full = MODEL_IDS_IN_ORDER.map(mockPiAiModel);

	it("stays silent when the catalog supplies every registered id", () => {
		const lines = [];
		const missing = reportMissingModelIds(full, (l) => lines.push(l));
		assert.deepEqual(missing, []);
		assert.deepEqual(lines, []);
	});

	it("names the missing id and the required pi-ai version", () => {
		const withoutOpus5 = full.filter((m) => m.id !== "claude-opus-5");
		const lines = [];
		const missing = reportMissingModelIds(withoutOpus5, (l) => lines.push(l));
		assert.deepEqual(missing, ["claude-opus-5"]);
		assert.equal(lines.length, 1);
		assert.match(lines[0], /claude-opus-5/);
		assert.match(lines[0], new RegExp(REQUIRED_PI_AI_VERSION.replace(/\./g, "\\.")));
	});

	it("does not throw on an empty catalog and reports every id", () => {
		const lines = [];
		let missing;
		assert.doesNotThrow(() => { missing = reportMissingModelIds([], (l) => lines.push(l)); });
		assert.deepEqual(missing, MODEL_IDS_IN_ORDER);
		assert.equal(lines.length, 1);
	});

	it("defaults to console.error and leaves buildModels itself silent", () => {
		const partial = [mockPiAiModel("claude-haiku-4-5")];
		const quiet = captureConsoleError(() => buildModels(partial));
		assert.deepEqual(quiet.lines, [], "buildModels must not warn — mock-driven tests stay quiet");
		const loud = captureConsoleError(() => reportMissingModelIds(partial));
		assert.equal(loud.lines.length, 1);
	});
});
