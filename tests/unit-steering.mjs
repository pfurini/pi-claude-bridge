/**
 * Steering rules are model-scoped: validated on Opus 4.8, Opus 5 and Fable 5 in
 * blind-graded A/Bs, injected for exactly those models and nothing else. The
 * scope IS the contract - generality of wording is not generality of evidence.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_STEERING_MODELS, FABLE_IRREVERSIBLE_RULE, MODEL_EXTRA_RULES, STEERING_RULES, steeringAppendFor } from "../src/steering.js";
import { applyLongContext, buildModels, resolveModel } from "../src/models.js";

describe("steeringAppendFor", () => {
	it("injects for exactly the validated models by default", () => {
		for (const id of DEFAULT_STEERING_MODELS) {
			assert.ok(steeringAppendFor(id)?.startsWith(STEERING_RULES), id);
		}
	});

	it("per-model extras append AFTER the shared rules, only for their model", () => {
		// Candidate rule under A/B: Fable gets base + irreversibility, the Opus
		// models get exactly the base. An extra leaking to a model it was not
		// measured on is the scope violation this file exists to prevent.
		assert.equal(steeringAppendFor("claude-fable-5"), `${STEERING_RULES}\n\n${FABLE_IRREVERSIBLE_RULE}`);
		assert.equal(steeringAppendFor("claude-opus-5"), STEERING_RULES);
		assert.equal(steeringAppendFor("claude-opus-4-8"), STEERING_RULES);
		assert.deepEqual(Object.keys(MODEL_EXTRA_RULES), ["claude-fable-5", "claude-fable-5-1"]);
	});

	it("does not inject for unvalidated models, including other Claude tiers", () => {
		for (const id of ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-7", "claude-opus-4-6"]) {
			assert.equal(steeringAppendFor(id), undefined, id);
		}
	});

	it("pins the models an A/B actually measured - and only those", () => {
		// One entry here equals one blind-graded campaign. Fable 5 earned its place
		// on 2026-08-04 (40 cells, 3 Sonnet graders unanimous, H01 0/5 -> 5/5
		// pass^k, H07 0/5 -> 4/5, canaries H02/H03 5/5 pass^k, zero refusals) and
		// NOT by resembling Opus - its failure signature is the opposite one.
		// Fable 5.1 earned its own on 2026-09-03 (50 cells, unanimous 50/50:
		// H01/H07 0/5 -> 5/5 pass^k, canaries 5/5 in both arms, zero refusals;
		// rule 4 three-arm H09 fail/fail/refine with a 30/30 canary re-gate).
		// Adding an id without a campaign behind it should break this test.
		assert.deepEqual(
			[...DEFAULT_STEERING_MODELS].sort(),
			["claude-fable-5", "claude-fable-5-1", "claude-opus-4-8", "claude-opus-5"],
		);
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
