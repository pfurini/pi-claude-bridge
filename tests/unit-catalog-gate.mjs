/**
 * The only unit tests that read the INSTALLED pi-ai catalog.
 *
 * Kept apart from unit-models.mjs on purpose: everything there is mock-driven and
 * must never move when a dependency is bumped, whereas both cases below are
 * expected to react to a pi-ai bump. A catalog regression should surface as one
 * obvious failure in the file whose stated job is to track the catalog.
 *
 * Scope limit: this runs against the maintainer's node_modules and never executes
 * in a user's install. Runtime protection for users is reportMissingModelIds(),
 * called at registration in src/index.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getModels } from "@earendil-works/pi-ai/compat";
import { MODEL_IDS_IN_ORDER, REQUIRED_PI_AI_VERSION, buildModels, reportMissingModelIds, resolveEffort } from "../src/models.js";

// pi-ai does not export ./package.json, so walk up from a resolved entry point.
function installedVersion(specifier) {
	let dir = dirname(fileURLToPath(import.meta.resolve(specifier)));
	for (let i = 0; i < 10; i++) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, "utf8")).version;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return "unknown";
}

const installedPiAi = installedVersion("@earendil-works/pi-ai/compat");

const catalog = getModels("anthropic");
const models = buildModels(catalog);
const find = (id) => models.find((m) => m.id === id);

describe("installed pi-ai catalog", () => {
	it(`supplies every id in MODEL_IDS_IN_ORDER (pi-ai ${installedPiAi})`, () => {
		const missing = reportMissingModelIds(catalog, () => {});
		assert.deepEqual(
			missing,
			[],
			`installed @earendil-works/pi-ai ${installedPiAi} has no catalog entry for ${missing.join(", ")}. ` +
			`The bridge requires >=${REQUIRED_PI_AI_VERSION}.\n` +
			"If this fires after a pi-ai bump, the likely cause is an ID RENAME, not a deletion: pi's catalog " +
			"already carries dated twins (claude-haiku-4-5 / claude-haiku-4-5-20251001), and Claude Code " +
			"resolves the haiku alias to the dated id. If Opus 5 ever ships only as a dated id, the correct fix " +
			"is to update MODEL_IDS_IN_ORDER and the resolveClaudeCodeRuntimeModel case — NOT to loosen this " +
			"assertion into a prefix or substring match.",
		);
	});

	it("gives Opus 5 the metadata the bridge assumes", () => {
		const opus5 = find("claude-opus-5");
		assert.ok(opus5, "claude-opus-5 must survive buildModels");
		assert.equal(opus5.reasoning, true);
		assert.equal(opus5.contextWindow, 1_000_000);
		assert.deepEqual(opus5.thinkingLevelMap, { xhigh: "xhigh", max: "max" });
	});
});

/**
 * Intentional canary, not a logic test.
 *
 * Snapshot taken from @earendil-works/pi-ai 0.82.1. It is EXPECTED to need
 * updating whenever pi-ai changes a thinkingLevelMap — that is the point. When it
 * fails, confirm the new mapping against the catalog, then update the table here
 * and changelog any user-visible effort change. Do not weaken it into a
 * shape-only check; the logic assertions live in unit-models.mjs.
 *
 * Precedent: pi-ai 0.80.3 → 0.82.1 silently moved Sonnet 5 from the bridge's
 * xhigh→max fallback to a real xhigh→xhigh tier. Nothing caught it.
 */
const EFFORT_SNAPSHOT_PI_AI_VERSION = "0.82.1";
const EFFORT_SNAPSHOT = {
	"claude-fable-5": { xhigh: "xhigh", max: "max" },
	"claude-opus-5": { xhigh: "xhigh", max: "max" },
	"claude-opus-4-8": { xhigh: "xhigh", max: "max" },
	"claude-opus-4-7": { xhigh: "xhigh", max: "max" },
	"claude-opus-4-6": { xhigh: "max", max: "max" },
	"claude-sonnet-5": { xhigh: "xhigh", max: "max" },
	"claude-sonnet-4-6": { xhigh: "max", max: "max" },
	"claude-haiku-4-5": { xhigh: "max", max: "max" },
};

describe("registered-model effort snapshot", () => {
	it(`matches pi-ai ${EFFORT_SNAPSHOT_PI_AI_VERSION} (installed: ${installedPiAi})`, () => {
		const actual = {};
		for (const id of MODEL_IDS_IN_ORDER) {
			const model = find(id);
			if (!model) continue; // the gate above already reports missing ids
			actual[id] = { xhigh: resolveEffort(model, "xhigh"), max: resolveEffort(model, "max") };
		}
		assert.deepEqual(actual, EFFORT_SNAPSHOT);
	});
});
