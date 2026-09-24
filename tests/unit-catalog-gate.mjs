import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getModels } from "@earendil-works/pi-ai/compat";
import { buildModels, resolveEffort, resolveModel } from "../src/models.js";

const catalog = getModels("anthropic");
const models = buildModels(catalog);

// These snapshots cover observed effort behavior, not a model-registration allowlist.
const EFFORT_SNAPSHOT = {
	"claude-fable-5": { xhigh: "xhigh", max: "max" },
	"claude-fable-5-1": { xhigh: "xhigh", max: "max" },
	"claude-opus-5-5": { xhigh: "xhigh", max: "max" },
	"claude-opus-5": { xhigh: "xhigh", max: "max" },
	"claude-opus-4-8": { xhigh: "xhigh", max: "max" },
	"claude-opus-4-7": { xhigh: "xhigh", max: "max" },
	"claude-opus-4-6": { xhigh: "max", max: "max" },
	"claude-sonnet-5": { xhigh: "xhigh", max: "max" },
	"claude-sonnet-4-6": { xhigh: "max", max: "max" },
	"claude-haiku-4-5": { xhigh: "max", max: "max" },
};

describe("installed pi-ai catalog", () => {
	it("projects every non-dated catalog model without a bridge allowlist", () => {
		assert.ok(catalog.length > 0);
		assert.deepEqual(models.map(model => model.id).sort(),
			catalog.filter(model => !/-20\d{6}$/.test(model.id)).map(model => model.id).sort());
		for (const model of models) {
			assert.deepEqual(model.thinkingLevelMap, catalog.find(entry => entry.id === model.id).thinkingLevelMap);
		}
	});
	it("resolves the newest installed Opus independently of picker order", () => {
		const newest = models.find(model => model.id.startsWith("claude-opus-"));
		assert.ok(newest);
		assert.equal(resolveModel(models, "opus").id, newest.id);
		assert.equal(resolveModel([...models].reverse(), "opus").id, newest.id);
	});
	for (const [id, expected] of Object.entries(EFFORT_SNAPSHOT)) {
		const model = models.find(entry => entry.id === id);
		it(`${id} retains observed effort mapping when supplied by this Pi version`, { skip: !model }, () => {
			assert.deepEqual({ xhigh: resolveEffort(model, "xhigh"), max: resolveEffort(model, "max") }, expected);
		});
	}
	const opus55 = models.find(model => model.id === "claude-opus-5-5");
	it("honors Opus 5.5's unsupported minimal effort", { skip: !opus55 }, () => {
		assert.equal(opus55.thinkingLevelMap.minimal, null);
		assert.equal(resolveEffort(opus55, "minimal"), undefined);
	});
});
