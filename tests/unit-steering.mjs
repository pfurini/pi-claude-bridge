/**
 * Steering rules are model-scoped: validated on Opus 4.8 and Opus 5 in a
 * blind-graded A/B, injected for exactly those models and nothing else. The
 * scope IS the contract - generality of wording is not generality of evidence.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_STEERING_MODELS, STEERING_RULES, steeringAppendFor } from "../src/steering.js";
import { applyLongContext, buildModels, resolveModel } from "../src/models.js";

describe("steeringAppendFor", () => {
	it("injects for exactly the validated models by default", () => {
		for (const id of DEFAULT_STEERING_MODELS) {
			assert.equal(steeringAppendFor(id), STEERING_RULES);
		}
	});

	it("does not inject for unvalidated models, including other Claude tiers", () => {
		for (const id of ["claude-fable-5", "claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-7", "claude-opus-4-6"]) {
			assert.equal(steeringAppendFor(id), undefined, id);
		}
	});

	it("false disables entirely; [] disables; explicit list overrides", () => {
		assert.equal(steeringAppendFor("claude-opus-5", false), undefined);
		assert.equal(steeringAppendFor("claude-opus-5", []), undefined);
		assert.equal(steeringAppendFor("claude-haiku-4-5", ["claude-haiku-4-5"]), STEERING_RULES);
		assert.equal(steeringAppendFor("claude-opus-5", ["claude-haiku-4-5"]), undefined);
	});

	it("the opus alias resolves to a steered id on every plan tier", () => {
		// Users say "opus", not "claude-opus-5". resolveModel returns the
		// registered model object, and steering keys on its id - this test breaks
		// if the alias ever resolves to an unvalidated opus or a suffixed id.
		const mock = (id) => ({ id, name: id, reasoning: true, input: ["text"], cost: { input: 1, output: 1 }, contextWindow: 1000000, maxTokens: 8000 });
		const ids = ["claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"];
		for (const settings of [{ plan: "max", longContextExtraUsage: false }, { plan: "pro", longContextExtraUsage: false }]) {
			const registered = applyLongContext(buildModels(ids.map(mock)), settings);
			assert.equal(steeringAppendFor(resolveModel(registered, "opus").id), STEERING_RULES, `plan=${settings.plan}`);
			assert.ok(registered.every((m) => !/\[1m\]/.test(m.id)), "no suffixed ids registered");
		}
	});

	it("rules text carries the three validated headings", () => {
		assert.ok(STEERING_RULES.includes("Explicit restrictions outrank session requests"));
		assert.ok(STEERING_RULES.includes("A reported bug is a hypothesis, not a spec"));
		assert.ok(STEERING_RULES.includes("Never claim verification you did not perform"));
	});
});
