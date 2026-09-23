import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	ASK_CLAUDE_THINKING_LEVELS, REASONING_TO_EFFORT, applyLongContext,
	assertClaudeCodeModelAvailable, buildModels, claudeCodeModelId,
	isClaudeCodeModelAvailable, resolveClaudeCodeRuntimeModel, resolveEffort, resolveModel,
} from "../src/models.js";

const PRO = { plan: "pro", longContextExtraUsage: false };
const MAX = { plan: "max", longContextExtraUsage: false };
const EXTRA = { plan: "pro", longContextExtraUsage: true };
const ALL_PLANS = [PRO, MAX, EXTRA, { plan: "max", longContextExtraUsage: true }];
const mock = (id, extra = {}) => ({
	id, name: id, reasoning: true, input: ["text"], contextWindow: 1_000_000,
	maxTokens: 8000, baseUrl: "https://example.invalid", api: "anthropic-messages",
	provider: "anthropic", headers: { secret: "test" }, ...extra,
});
const ids = ["claude-fable-5", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"];
const find = (models, id) => models.find(model => model.id === id);

function captureWarning(fn) {
	const lines = [];
	const previous = console.error;
	console.error = (...args) => lines.push(args.join(" "));
	try { return { result: fn(), lines }; }
	finally { console.error = previous; }
}

describe("catalog projection", () => {
	it("discovers new models and leaves input ordering untouched", () => {
		const source = [mock("claude-sonnet-5"), mock("claude-opus-6"), mock("claude-opus-5")];
		const before = structuredClone(source);
		assert.deepEqual(buildModels(source).map(model => model.id), ["claude-opus-6", "claude-opus-5", "claude-sonnet-5"]);
		assert.deepEqual(source, before);
	});
	it("sorts known families first and excludes dated aliases", () => {
		const source = ["claude-proxy-x", "claude-haiku-4-5", "claude-opus-4-5-20251101", "claude-fable-5", "claude-opus-4-5", "claude-fable-5-1"];
		assert.deepEqual(buildModels(source.map(id => mock(id))).map(model => model.id), ["claude-fable-5-1", "claude-fable-5", "claude-opus-4-5", "claude-haiku-4-5", "claude-proxy-x"]);
	});
	it("strips provider transport fields without inventing thinking maps", () => {
		for (const model of buildModels(ids.map(id => mock(id)))) {
			assert.equal(model.api, undefined);
			assert.equal(model.baseUrl, undefined);
			assert.equal(model.provider, undefined);
			assert.equal(model.headers, undefined);
			assert.equal(model.thinkingLevelMap, undefined);
		}
	});
	it("preserves supplied thinking maps including explicit unsupported levels", () => {
		const thinkingLevelMap = { off: null, minimal: null, xhigh: "xhigh", max: "max" };
		assert.deepEqual(buildModels([mock("claude-opus-5-5", { thinkingLevelMap })])[0].thinkingLevelMap, thinkingLevelMap);
	});
	it("forwards catalog pricing for usage valuation", () => {
		const cost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
		assert.deepEqual(buildModels([mock("claude-opus-5", { cost })])[0].cost, cost);
	});
	it("completes partial and absent pricing tables", () => {
		assert.deepEqual(buildModels([mock("claude-opus-5", { cost: { input: 5, output: 25 } })])[0].cost,
			{ input: 5, output: 25, cacheRead: 0, cacheWrite: 0 });
		assert.deepEqual(buildModels([mock("claude-opus-5")])[0].cost,
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});
	it("accepts an empty catalog", () => assert.deepEqual(buildModels([]), []));
});

describe("model selection", () => {
	const models = buildModels(ids.map(id => mock(id)));
	it("resolves newest family shortcuts independently of input order", () => {
		for (const ordered of [models, [...models].reverse()]) {
			assert.equal(resolveModel(ordered, "OPUS").id, "claude-opus-5-5");
			assert.equal(resolveModel(ordered, "fable").id, "claude-fable-5-1");
			assert.equal(resolveModel(ordered, "haiku").id, "claude-haiku-4-5");
		}
	});
	it("preserves every exact ID including older versions", () => {
		for (const id of ids) assert.equal(resolveModel(models, id), find(models, id));
		assert.equal(resolveModel(models, "claude-fable-5").id, "claude-fable-5");
	});
	it("returns undefined for unmatched input", () => assert.equal(resolveModel(models, "gpt-9"), undefined));
});

describe("explicit runtime windows", () => {
	for (const id of ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-fable-5-1"]) {
		it(`${id} uses its bare ID at 1M`, () => {
			for (const settings of ALL_PLANS) {
				const { result, lines } = captureWarning(() => resolveClaudeCodeRuntimeModel(id, settings));
				assert.deepEqual(result, { cliModelId: id, contextWindow: 1_000_000 });
				assert.deepEqual(lines, []);
			}
		});
	}
	it("preserves Fable 5 and Sonnet 5 suffix choices", () => {
		for (const id of ["claude-fable-5", "claude-sonnet-5"]) {
			assert.deepEqual(resolveClaudeCodeRuntimeModel(id, MAX), { cliModelId: `${id}[1m]`, contextWindow: 1_000_000 });
		}
	});
	it("gates Opus 4.6 on Max or Extra Usage", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-4-6", PRO), { cliModelId: "claude-opus-4-6", contextWindow: 200_000 });
		for (const settings of [MAX, EXTRA]) assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-4-6", settings), { cliModelId: "claude-opus-4-6[1m]", contextWindow: 1_000_000 });
	});
	it("requires Extra Usage for Sonnet 4.6 and leaves Haiku at 200K", () => {
		for (const settings of [PRO, MAX]) assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-sonnet-4-6", settings), { cliModelId: "claude-sonnet-4-6", contextWindow: 200_000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-sonnet-4-6", EXTRA), { cliModelId: "claude-sonnet-4-6[1m]", contextWindow: 1_000_000 });
		for (const settings of ALL_PLANS) assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-haiku-4-5", settings), { cliModelId: "claude-haiku-4-5", contextWindow: 200_000 });
	});
	it("keeps unmeasured catalog additions at 200K regardless of declared window", () => {
		for (const id of ["claude-opus-6", "claude-opus-4-5", "claude-sonnet-4-5"]) {
			const { result, lines } = captureWarning(() => applyLongContext(buildModels([mock(id)]), MAX));
			assert.equal(result[0].contextWindow, 200_000);
			assert.ok(lines.some(line => line.includes("no known context size")));
		}
	});
});

describe("eligibility and registration", () => {
	const models = buildModels(ids.map(id => mock(id)));
	it("filters Fable on Pro and rejects explicit requests", () => {
		for (const id of ["fable", "claude-fable-5", "claude-fable-5[1m]", "claude-fable-5-1"]) {
			assert.equal(isClaudeCodeModelAvailable(id, PRO), false);
			assert.throws(() => assertClaudeCodeModelAvailable(id, PRO), /requires either a Max plan or Extra Usage/);
			assert.throws(() => claudeCodeModelId({ id }, PRO), /requires either a Max plan or Extra Usage/);
		}
		assert.ok(applyLongContext(models, PRO).every(model => !model.id.includes("fable")));
	});
	it("allows Fable on Max or Extra Usage and never gates Opus", () => {
		for (const settings of [MAX, EXTRA]) {
			assert.equal(claudeCodeModelId({ id: "claude-fable-5" }, settings), "claude-fable-5[1m]");
			assert.equal(claudeCodeModelId({ id: "claude-fable-5-1" }, settings), "claude-fable-5-1");
		}
		for (const settings of ALL_PLANS) assert.equal(claudeCodeModelId({ id: "claude-opus-5-5" }, settings), "claude-opus-5-5");
	});
	it("registers matching windows and labels without mutating the catalog", () => {
		const before = structuredClone(models);
		for (const settings of ALL_PLANS) {
			for (const model of applyLongContext(models, settings)) {
				assert.equal(model.contextWindow, resolveClaudeCodeRuntimeModel(model.id, settings).contextWindow);
				assert.equal(model.name.includes("1M"), model.contextWindow === 1_000_000);
				assert.ok(!model.id.includes("[1m]"));
			}
		}
		assert.deepEqual(models, before);
	});
	it("does not duplicate existing 1M labels", () => {
		const model = mock("claude-opus-5", { name: "Claude Opus 5 1M" });
		assert.equal(applyLongContext([model], PRO)[0], model);
	});
});

describe("shared effort resolution", () => {
	const mappings = [
		[undefined, "xhigh", "max"],
		[{ thinkingLevelMap: { xhigh: "xhigh" } }, "xhigh", "xhigh"],
		[{ thinkingLevelMap: { minimal: null } }, "minimal", undefined],
		[{ thinkingLevelMap: { high: "unsupported" } }, "high", undefined],
		[{ thinkingLevelMap: { high: "" } }, "high", undefined],
		[{ thinkingLevelMap: { off: null } }, "off", undefined],
		[undefined, "", undefined], [undefined, undefined, undefined],
	];
	for (const [model, level, expected] of mappings) {
		it(`maps ${String(level)} with ${JSON.stringify(model)}`, () => assert.equal(resolveEffort(model, level), expected));
	}
	it("retains all generic effort levels including explicit max", () => {
		for (const [level, effort] of Object.entries(REASONING_TO_EFFORT)) assert.equal(resolveEffort(undefined, level), effort);
		assert.deepEqual([...ASK_CLAUDE_THINKING_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		assert.equal(REASONING_TO_EFFORT.xhigh, "max");
		assert.equal(resolveEffort(undefined, "max"), "max");
	});
});
