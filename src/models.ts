import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

// Canonical selection + display order for the model picker.
// `resolveModel` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

export const MODEL_IDS_IN_ORDER = ["claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"];

// pi-ai release that first shipped every id in MODEL_IDS_IN_ORDER (matches the
// peerDependency floor). Named in the missing-row diagnostic below.
export const REQUIRED_PI_AI_VERSION = "0.82.1";

// Fallback maps for pi-ai releases older than the peer floor, where Sonnet 5 and
// Sonnet 4.6 ship no thinkingLevelMap and getSupportedThinkingLevels therefore
// hides the opt-in xhigh/max levels (earendil-works/pi#6371). Values mirror what
// pi-ai >=0.82.1 supplies directly, so on a supported install both entries are
// unreachable: buildModels only consults them when the catalog omits the map.
const DEFAULT_THINKING_LEVEL_MAPS: Record<string, Record<string, string>> = {
	"claude-sonnet-5": { xhigh: "xhigh", max: "max" },
	"claude-sonnet-4-6": { max: "max" },
};

// Pi reasoning levels → CC SDK effort levels. Generic fallback for models whose
// catalog map omits the requested level, and for unregistered raw model ids.
// Keep xhigh→max here: models with no catalog xhigh entry (Opus 4.6, Sonnet 4.6,
// Haiku) have no distinct xhigh tier, so xhigh must escalate to max for them.
export const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max",
};

// Levels the AskClaude tool schema offers. Mirrors pi's own ModelThinkingLevel so
// callers can request the top tier explicitly instead of reaching it as a side
// effect of xhigh, which no longer escalates on models with a real xhigh tier.
// Exported so the schema stays testable without importing index.ts.
export const ASK_CLAUDE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// Single effort lookup for both the provider and AskClaude paths. Prefers the
// model's own thinkingLevelMap (pi-ai 0.72+ ships per-model overrides; Opus 5
// maps xhigh→xhigh and max→max as distinct served tiers) and falls back to
// REASONING_TO_EFFORT for unmapped levels or an unresolved model.
export function resolveEffort(
	model: { thinkingLevelMap?: Partial<Record<string, string | null>> } | undefined,
	level: string | undefined,
): EffortLevel | undefined {
	if (!level || level === "off") return undefined;
	return (model?.thinkingLevelMap?.[level] as EffortLevel | undefined) ?? REASONING_TO_EFFORT[level];
}

// buildModels drops ids the installed pi-ai does not supply, which is silent in
// the returned array but must not be silent to the operator: the bridge loads
// into whatever pi-ai the user's pi shipped, not the version it pins, and a
// missing claude-opus-5 silently redirects the `opus` shortcut and AskClaude's
// default to an older model. Kept out of buildModels so mock-driven tests stay
// quiet; called once at registration in index.ts. Returns the missing ids.
export function reportMissingModelIds<T extends { id: string }>(
	piAiModels: T[],
	log: (message: string) => void = console.error,
): string[] {
	const missing = MODEL_IDS_IN_ORDER.filter((id) => !piAiModels.some((m) => m.id === id));
	if (missing.length > 0) {
		log(
			`claude-bridge: installed @earendil-works/pi-ai has no catalog entry for ${missing.join(", ")}, ` +
			`so they are omitted from the model picker. Requires @earendil-works/pi-ai >=${REQUIRED_PI_AI_VERSION}.`,
		);
	}
	return missing;
}

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// and keep MODEL_IDS_IN_ORDER ordering. IDs missing from pi-ai are silently dropped.
// Context-dependent display labels are applied after plan/long-context config is known.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return MODEL_IDS_IN_ORDER
		.map((id) => piAiModels.find((m) => m.id === id))
		.filter((m) => m != null)
		// Forward thinkingLevelMap so pi-ai's per-model overrides (e.g. opus-4-8
		// mapping xhigh→xhigh and max→max) are visible to the effort lookup.
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap }) => ({
			id,
			name,
			reasoning, input, contextWindow, maxTokens,
			thinkingLevelMap: thinkingLevelMap ?? DEFAULT_THINKING_LEVEL_MAPS[id],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

export type LongContextSettings = {
	plan: "pro" | "max";
	longContextExtraUsage: boolean;
};

export type ClaudeCodeRuntimeModel = {
	cliModelId: string;
	contextWindow: number;
};

const TWO_HUNDRED_K_CONTEXT = 200_000;
const ONE_M_CONTEXT = 1_000_000;

const FABLE_MODEL_IDS = new Set(["fable", "claude-fable-5"]);

export function isClaudeCodeModelAvailable(modelId: string, settings: LongContextSettings): boolean {
	const bareModelId = modelId.toLowerCase().replace(/\[1m\]$/, "");
	return !FABLE_MODEL_IDS.has(bareModelId) || settings.plan === "max" || settings.longContextExtraUsage;
}

export function assertClaudeCodeModelAvailable(modelId: string, settings: LongContextSettings): void {
	if (isClaudeCodeModelAvailable(modelId, settings)) return;
	throw new Error(
		"Claude Fable 5 requires either a Max plan or Extra Usage on Pro. " +
		"Set provider.plan to \"max\" when applicable, or enable Extra Usage and set " +
		"provider.longContextExtraUsage to true.",
	);
}

// Measured Claude Agent SDK subscription/OAuth behavior. Do not infer this from
// pi-ai's advertised contextWindow: bare Opus 5, Opus 4.8, Opus 4.7, and Sonnet 5
// all serve 1M, while Fable 5 is unavailable on Pro without Extra Usage and [1m]
// eligibility still differs by model. See the Phase 8 upgrade record.
export function resolveClaudeCodeRuntimeModel(modelId: string, settings: LongContextSettings): ClaudeCodeRuntimeModel {
	switch (modelId) {
		// Opus 5 and Opus 4.8 are native 1M on the bare id — no [1m] suffix, no
		// plan or Extra Usage gate. Measured on Claude Code 2.1.220 (Max account):
		// `--model claude-opus-4-8` reports canonical=claude-opus-4-8 ctx=1000000,
		// identical to the suffixed form. The bare id is preferred because it is
		// what Claude Code reports back as canonical, so exact identity checks
		// (benchmark harnesses, logging) match without suffix-stripping.
		case "claude-opus-5":
			return { cliModelId: "claude-opus-5", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-8":
			return { cliModelId: "claude-opus-4-8", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-7":
			return { cliModelId: "claude-opus-4-7", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-6": {
			const useOneM = settings.plan === "max" || settings.longContextExtraUsage;
			return {
				cliModelId: useOneM ? "claude-opus-4-6[1m]" : "claude-opus-4-6",
				contextWindow: useOneM ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
			};
		}
		case "claude-fable-5":
			return { cliModelId: "claude-fable-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-5":
			return { cliModelId: "claude-sonnet-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-4-6":
			return {
				cliModelId: settings.longContextExtraUsage ? "claude-sonnet-4-6[1m]" : "claude-sonnet-4-6",
				contextWindow: settings.longContextExtraUsage ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
			};
		case "claude-haiku-4-5":
			return { cliModelId: "claude-haiku-4-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		default:
			console.error(`claude-bridge: encountered model ${modelId} with no known context size, defaulting to 200K`);
			return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
	}
}

export function claudeCodeModelId(model: { id: string }, settings: LongContextSettings): string {
	assertClaudeCodeModelAvailable(model.id, settings);
	return resolveClaudeCodeRuntimeModel(model.id, settings).cliModelId;
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower || m.id.includes(lower));
}

// Produce the model metadata registered with pi. The registered contextWindow must
// match the window the bridge actually requests from Claude Code, or pi's status
// bar and auto-compaction threshold will misreport. The runtime policy is based
// on measured SDK behavior - see diag/CONTEXT-SIZE.md
export function applyLongContext<T extends { id: string; name: string; contextWindow?: number | null }>(
	models: T[],
	settings: LongContextSettings,
): T[] {
	return models.flatMap((m) => {
		if (!isClaudeCodeModelAvailable(m.id, settings)) return [];
		const { contextWindow } = resolveClaudeCodeRuntimeModel(m.id, settings);
		const name = contextWindow > TWO_HUNDRED_K_CONTEXT && !/\b1M\b/i.test(m.name) ? `${m.name} 1M` : m.name;
		return [contextWindow === m.contextWindow && name === m.name ? m : { ...m, contextWindow, name }];
	});
}
