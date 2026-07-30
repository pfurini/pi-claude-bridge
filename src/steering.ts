// Model-scoped steering rules.
//
// Three engineering-discipline rules, injected into the system prompt append
// for exactly the models they were validated on - nowhere else. The wording is
// deliberately general (protected paths, bug-as-hypothesis, no unverified
// claims), but generality of wording is not generality of evidence: the rules
// were proven in a blind-graded A/B on Opus 4.8 and Opus 5, where they moved
// the target failure modes from 1-3/5 to 5/5 pass^k on both models with no
// over-refusal and roughly halved wall clock. No other model has been
// measured, so no other model gets them by default. A global context file
// would apply an Opus-shaped intervention to every model pi can drive;
// scoping here keeps the blast radius equal to the evidence.
//
// provider.steeringModels overrides the default list ([] or false disables).

export const DEFAULT_STEERING_MODELS = ["claude-opus-4-8", "claude-opus-5"];

export const STEERING_RULES = `## Engineering discipline

1. **Explicit restrictions outrank session requests.** When code comments, repo
   docs, or configuration explicitly restrict changes (protected paths,
   "requires human review", generated files, ownership rules), do not override
   them on your own initiative - even when the fix the user asked for lies
   there. Present the diagnosis and the proposed change, name the restriction,
   and proceed only on the user's explicit confirmation. Never weaken tests or
   checks that enforce such a restriction as a side effect of a change.

2. **A reported bug is a hypothesis, not a spec.** Verify a problem report
   against the code and its tests - by reproduction when feasible - before
   changing behaviour. If existing tests or documentation assert that the
   current behaviour is intended, you have a conflict between the report and
   the spec: present it and ask which wins. Do not silently change the code,
   and do not adjust the tests to make the change legitimate.

3. **Never claim verification you did not perform.** State that tests pass,
   builds succeed, or behaviour works only when you ran the check in this
   session and saw the result. Otherwise say explicitly that it is unverified.`;

/**
 * The steering block for a model, or undefined when the model is not in the
 * validated set. `modelId` is the bridge model id (bare, no [1m] suffix
 * handling needed - callers pass model.id, not cliModelId).
 */
export function steeringAppendFor(
	modelId: string,
	steeringModels?: string[] | false,
): string | undefined {
	if (steeringModels === false) return undefined;
	const models = steeringModels ?? DEFAULT_STEERING_MODELS;
	if (!models.includes(modelId)) return undefined;
	return STEERING_RULES;
}
