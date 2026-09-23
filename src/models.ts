import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

const TWO_HUNDRED_K_CONTEXT = 200_000;
const ONE_M_CONTEXT = 1_000_000;
const FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"];
const VALID_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

export const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max",
};

export const ASK_CLAUDE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Missing mappings use the fallback; null or invalid mappings leave Claude Code's default in effect. */
export function resolveEffort(
	model: { thinkingLevelMap?: Partial<Record<string, string | null>> } | undefined,
	level: string | undefined,
): EffortLevel | undefined {
	if (!level || level === "off") return undefined;
	const mapped = model?.thinkingLevelMap?.[level];
	if (mapped === undefined) return REASONING_TO_EFFORT[level];
	return mapped !== null && VALID_EFFORTS.has(mapped) ? mapped as EffortLevel : undefined;
}

function versionRank(id: string): { family: string; tuple: [number, number] } {
	const [, family, major, minor] = id.split("-");
	return { family, tuple: [Number(major) || 0, Number(minor) || 0] };
}

/** Discover models from the installed catalog, excluding dated snapshot aliases. */
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return piAiModels
		.filter((model) => typeof model.id === "string" && !/-20\d{6}$/.test(model.id))
		.sort((a, b) => {
			const ra = versionRank(a.id);
			const rb = versionRank(b.id);
			const fa = FAMILY_ORDER.indexOf(ra.family);
			const fb = FAMILY_ORDER.indexOf(rb.family);
			const ta = fa === -1 ? FAMILY_ORDER.length : fa;
			const tb = fb === -1 ? FAMILY_ORDER.length : fb;
			return ta - tb || rb.tuple[0] - ra.tuple[0] || rb.tuple[1] - ra.tuple[1] || a.id.localeCompare(b.id);
		})
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap, cost }) => ({
			id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap,
			// Catalog prices value token consumption for comparisons, not subscription invoices.
			// Complete partial tables because Pi multiplies every field directly.
			cost: {
				input: cost?.input ?? 0,
				output: cost?.output ?? 0,
				cacheRead: cost?.cacheRead ?? 0,
				cacheWrite: cost?.cacheWrite ?? 0,
			},
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

// Fable 5.1 inherits the conservative gate; its Pro eligibility was not measured.
const FABLE_MODEL_IDS = new Set(["fable", "claude-fable-5", "claude-fable-5-1"]);

export function isClaudeCodeModelAvailable(modelId: string, settings: LongContextSettings): boolean {
	const bareModelId = modelId.toLowerCase().replace(/\[1m\]$/, "");
	return !FABLE_MODEL_IDS.has(bareModelId) || settings.plan === "max" || settings.longContextExtraUsage;
}

export function assertClaudeCodeModelAvailable(modelId: string, settings: LongContextSettings): void {
	if (isClaudeCodeModelAvailable(modelId, settings)) return;
	throw new Error(
		"Claude Fable requires either a Max plan or Extra Usage on Pro. " +
		"Set provider.plan to \"max\" when applicable, or enable Extra Usage and set " +
		"provider.longContextExtraUsage to true.",
	);
}

/** Runtime windows are explicit policy, never inferred from a newly discovered catalog model. */
export function resolveClaudeCodeRuntimeModel(modelId: string, settings: LongContextSettings): ClaudeCodeRuntimeModel {
	switch (modelId) {
		// Existing bare-ID measurements are recorded in diag/CONTEXT-SIZE.md and the Fable 5.1 changelog.
		case "claude-opus-5":
		case "claude-opus-4-8":
		case "claude-opus-4-7":
		case "claude-fable-5-1":
			return { cliModelId: modelId, contextWindow: ONE_M_CONTEXT };
		// Maintainer-confirmed policy: bare Opus 5.5 serves 1M; no probe runs during this merge.
		case "claude-opus-5-5":
			return { cliModelId: modelId, contextWindow: ONE_M_CONTEXT };
		case "claude-fable-5":
		case "claude-sonnet-5":
			return { cliModelId: `${modelId}[1m]`, contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-6": {
			const useOneM = settings.plan === "max" || settings.longContextExtraUsage;
			return {
				cliModelId: useOneM ? `${modelId}[1m]` : modelId,
				contextWindow: useOneM ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
			};
		}
		case "claude-sonnet-4-6":
			return {
				cliModelId: settings.longContextExtraUsage ? `${modelId}[1m]` : modelId,
				contextWindow: settings.longContextExtraUsage ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
			};
		case "claude-haiku-4-5":
			return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
		default:
			console.error(`claude-bridge: encountered model ${modelId} with no known context size, defaulting to 200K`);
			return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
	}
}

export function claudeCodeModelId(model: { id: string }, settings: LongContextSettings): string {
	assertClaudeCodeModelAvailable(model.id, settings);
	return resolveClaudeCodeRuntimeModel(model.id, settings).cliModelId;
}

/** Exact IDs win; family shortcuts select the newest version independently of picker order. */
export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((model) => model.id === lower)
		?? newestPartialMatch(models.filter((model) => model.id.includes(lower)));
}

function newestPartialMatch<T extends { id: string }>(candidates: T[]): T | undefined {
	if (candidates.length === 0) return undefined;
	return candidates.reduce((best, model) => {
		const a = versionRank(model.id).tuple;
		const b = versionRank(best.id).tuple;
		return (a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1]) ? model : best;
	});
}

/** Register the requested window and retain the fork's subscription eligibility filtering. */
export function applyLongContext<T extends { id: string; name: string; contextWindow?: number | null }>(
	models: T[],
	settings: LongContextSettings,
): T[] {
	return models.flatMap((model) => {
		if (!isClaudeCodeModelAvailable(model.id, settings)) return [];
		const { contextWindow } = resolveClaudeCodeRuntimeModel(model.id, settings);
		const name = contextWindow > TWO_HUNDRED_K_CONTEXT && !/\b1M\b/i.test(model.name) ? `${model.name} 1M` : model.name;
		return [contextWindow === model.contextWindow && name === model.name ? model : { ...model, contextWindow, name }];
	});
}
