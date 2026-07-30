/**
 * Steering rules are model-scoped: validated on Opus 4.8 and Opus 5 in a
 * blind-graded A/B, injected for exactly those models and nothing else. The
 * scope IS the contract - generality of wording is not generality of evidence.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_STEERING_MODELS, STEERING_RULES, steeringAppendFor } from "../src/steering.js";

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

	it("rules text carries the three validated headings", () => {
		assert.ok(STEERING_RULES.includes("Explicit restrictions outrank session requests"));
		assert.ok(STEERING_RULES.includes("A reported bug is a hypothesis, not a spec"));
		assert.ok(STEERING_RULES.includes("Never claim verification you did not perform"));
	});
});
