# Plan: sanitize harness boilerplate from forwarded system prompts (fix subagent extra-usage 400)

## Root cause (established by capture-proxy evidence, 2026-08-10)

A pi-subagents subagent on any `claude-bridge/*` model fails with
`API Error: 400 You're out of extra usage`. The failure is **not** a
`provider.plan` inheritance problem (plan threads correctly through the shared
bridge module; proven by a subagent succeeding under a temp agent dir with
`plan:"max"`). The 400 is Anthropic's subscription enforcement: requests on a
Claude Code OAuth token whose system prompt carries pi's harness signature are
pushed to metered ("extra") usage, and this org has overage disabled
(`anthropic-ratelimit-unified-overage-disabled-reason: org_level_disabled`).

The signature is pi's `buildSystemPrompt` skeleton (present since January,
upstream `d2de6d083`): the identity paragraph
`You are an expert coding assistant operating inside pi, a coding agent harness`
plus the `Pi documentation` bullet list containing
`custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)`.
Replays isolated the trigger as cumulative over that skeleton (full triple
400s, any pair passes, same keywords without doc paths pass, 200KB of neutral
padding passes, model swap to opus-4-8/sonnet-5/opus-5 400s identically).

How the skeleton reaches Claude Code **only** on the subagent path:

1. Main session: the bridge forwards only `extractProjectContextBlock()` and
   `extractSkillsBlock()` from pi's assembled prompt (plus its own
   steering/corrections). The skeleton never leaves the process. Main sessions
   pass.
2. Subagent: pi-subagents (`@tintinweb/pi-subagents`) builds the child prompt
   with `buildAgentPrompt()` in `prompt_mode: "append"` (the default for the
   built-in agents), which embeds `ctx.getSystemPrompt()` — the parent's
   **entire** pi system prompt, skeleton included — verbatim as the session's
   `systemPromptOverride`. That surfaces to the bridge as
   `before_agent_start.systemPromptOptions.customPrompt`, and the bridge
   appends `userSystemPrompt.custom` verbatim (src/index.ts:1768).
3. This only fires when the subagent session itself loads the bridge extension
   (real agent dir via `packages` in settings.json, or an agent frontmatter
   `extensions:` list). A subagent session without the bridge bound never
   captures a `customPrompt`, which is why the temp-agent-dir repro passed.

Side damage of the same path: the forwarded custom prompt duplicates the
`<project_context>` and `<available_skills>` blocks (the bridge already
forwards them via the extractors), inflating the captured subagent system
prompt to 76KB vs 41KB for a main session — wasted cache-write on every spawn.

Onset: last successful subagent-shaped Fable sessions Aug 4 ~21:20, first
extra-usage 400s Aug 5 16:15. Not the Aug-10 fork merge (failures at 12:40
local predate it; the merge touches nothing in the prompt path), not a CC
upgrade (2.1.220 on both sides). Anthropic-side enforcement change is the
remaining explanation.

## Goal

Subagents on claude-bridge models work again, without touching pi-subagents:
the bridge strips pi's `buildSystemPrompt` boilerplate — and any duplicate
`<project_context>`/`<available_skills>` blocks — from `userSystemPrompt.custom`
and `userSystemPrompt.append` before appending them to the Claude Code query.

Non-goals: changing pi-subagents (their `prompt_mode: append` is a legitimate
feature for other providers); changing what main sessions forward; chasing
Anthropic's classifier beyond removing pi's self-identifying boilerplate.

## Design

New pure module `src/sanitize-prompt.ts` (same convention as `models.ts` /
`skills.ts` / `project-context.ts`: importable by tests without activating the
extension).

```ts
export function sanitizeHarnessPrompt(
	text: string | undefined,
	opts?: { sourcePrompt?: string },
): string | undefined
```

`sourcePrompt` is the session's assembled system prompt (`context.systemPrompt`),
passed by the call site **only when** `provider.appendSystemPrompt` is not false
(i.e. when the extractors actually forwarded the context/skills blocks). It is
what makes dedupe provably duplicate-only (review finding 2).

Behavior, in order:

1. **Skeleton range strip — ends at the docs-bullet line, NOT at the skeleton
   tail** (review finding 1: pi's `buildSystemPrompt` places the user's
   `appendSection` immediately after the docs bullets and before
   project_context/skills/cwd, so stripping "through the last appendix" would
   delete the parent's own `--append-system-prompt` text). If the text contains
   BOTH the start anchor
   `You are an expert coding assistant operating inside pi` and the end anchor
   `- Always read pi .md files completely and follow links to related docs`,
   remove the range from the start anchor through the end of the end-anchor
   LINE. Requiring both anchors keeps the function a conservative no-op on
   partial or user-authored lookalikes.
2. **Skeleton footer strip.** Remove a `Current working directory: …` line
   only when it sits inside the embedded region (before any
   `<sub_agent_context>` marker, or adjacent to where step 1 cut). pi appends
   that line verbatim at the skeleton tail; the pattern is specific enough
   that user text is not at risk in practice.
3. **Exact-match block dedupe** (replaces the original "remove all tagged
   blocks" idea, which review found unsafe twice over: with
   `provider.appendSystemPrompt: false` the extractors never ran, so an
   embedded block is the ONLY copy and must survive — src/index.ts:1733; and
   the extractors forward only the FIRST matching block, so blanket removal
   could drop a distinct second one). Extract the raw
   `<project_context>…</project_context>` and skills
   (`The following skills provide specialized instructions` …
   `</available_skills>`) blocks from `opts.sourcePrompt` and remove only
   byte-exact occurrences of those same blocks from `text`. Raw blocks must be
   re-extracted here rather than reused from `extractSkillsBlock`'s return
   value, because that function rewrites the read-tool line
   (src/skills.ts:58-63) and would never exact-match the embedded original.
   When `sourcePrompt` is absent, this step is a no-op.
4. **Seam-only whitespace cleanup** (review finding 3: a global
   3+-newlines collapse would rewrite surviving authored spans like
   `<agent_instructions>`, contradicting verbatim preservation). After each
   removal, collapse only the seam to a single blank line; trim the outer
   ends; never touch untouched spans. If nothing but whitespace remains,
   return `undefined` so the part drops out of `appendParts` entirely.

What survives on the pi-subagents path (all authored content, kept verbatim):
`<sub_agent_context>`, `<active_agent …/>`, pi-subagents' `# Environment`
block, `<agent_instructions>`, memory/preloaded-skill extras, and the parent's
own `--append-system-prompt` text (pi's `appendSection`, which sits between
the docs bullets and the skeleton's context/skills/cwd tail).

Integration: in `src/index.ts` where `appendParts` is built (~line 1768),
replace `userSystemPrompt.custom, userSystemPrompt.append` with sanitized
versions. The call site already computes `appendSystemPrompt` (the gate) a few
lines above and has `context.systemPrompt` in scope, so:

```ts
const promptSource = appendSystemPrompt ? context.systemPrompt : undefined;
// ...
sanitizeHarnessPrompt(userSystemPrompt.custom, { sourcePrompt: promptSource }),
sanitizeHarnessPrompt(userSystemPrompt.append, { sourcePrompt: promptSource }),
```

One `debug()` line when stripping fires, with before/after sizes — this
mangles prompt content, so it must be visible in `CLAUDE_BRIDGE_DEBUG=1` logs.

Template coupling: the anchors are literals from the fork's
`packages/coding-agent/src/core/system-prompt.ts`. That is safe here because
the bridge already targets the fork (`file:` devDependencies, fork-only API);
the unit test below builds the skeleton from the fork's actual
`buildSystemPrompt` so template drift fails loudly instead of silently
re-exposing the signature.

## Tests

1. `tests/unit-sanitize-prompt.mjs` (node --import tsx --test, repo convention):
   - **Real-template skeleton**: assemble a prompt with the fork's actual
     `buildSystemPrompt` so template drift fails loudly instead of silently
     re-exposing the signature. Verified: it is NOT re-exported from the
     package root and the `exports` map blocks deep bare-specifier imports
     (`ERR_PACKAGE_PATH_NOT_EXPORTED`), so import it by relative path through
     the `file:` devDependency link,
     `../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js`
     (the fork checkout is guaranteed present — `npm ci` fails without it, per
     AGENTS.md), embed it in a pi-subagents-style append
     wrapper (`skeleton + <sub_agent_context> + <active_agent> + # Environment
     - <agent_instructions>`), and assert: identity paragraph gone,
     `docs/custom-provider.md` gone, `<project_context>`/`<available_skills>`
     gone, and `<sub_agent_context>` / `<agent_instructions>` preserved
     verbatim.
   - **Parent `--append-system-prompt` survives** (review finding 1): build the
     skeleton with `buildSystemPrompt({ appendSystemPrompt: "KEEP_ME", … })`,
     embed, sanitize, assert `KEEP_ME` is present and byte-exact.
   - **Dedupe respects the gate** (review finding 2): with no `sourcePrompt`
     passed (the `provider.appendSystemPrompt: false` case), an embedded
     `<project_context>`/skills block inside the custom prompt is preserved;
     with `sourcePrompt` passed, only byte-exact duplicates of its blocks are
     removed, and a second, distinct `<project_context>` block in the custom
     prompt survives.
   - **Plain user text passes through unchanged** (no anchors → no-op),
     including preserved triple newlines (review finding 3).
   - **Partial anchors are a no-op** (start anchor present, end anchor absent
     → unchanged).
   - **All-boilerplate input returns `undefined`** (part drops out).
   - **Idempotent**: sanitizing twice equals sanitizing once.
2. `tests/int-subagent-fable-plan.mjs` (live, modeled on
   `tests/int-subagent-rpiv-codebase-locator.mjs` and
   `diag/probe-fable-kimi-parent.mjs`):
   - Temp agent dir with `claude-bridge.json` = `{"provider":{"plan":"max"}}`
     **and** a `settings.json` whose `packages` includes the bridge, so the
     subagent session binds the bridge and fires `before_agent_start` with the
     custom prompt (this is the condition that distinguishes the failing
     real-dir repro from the passing temp-dir repro).
   - Parent on `claude-bridge/claude-haiku-4-5`, one Agent call with
     `model: claude-bridge/claude-fable-5`, trivial prompt.
   - Assert the run **succeeds** (pre-fix it 400s) AND grep the debug log for
     the sanitizer's strip marker. The success assertion is end-to-end but
     rides on Anthropic's current enforcement; the debug-marker assertion is
     the durable pin of bridge behavior. Document that distinction in the test
     header.
3. Run the existing unit suite (`npm test` unit portion) to catch regressions
   in prompt assembly (unit-sdk-options, unit-config, etc.).

## Changelog, docs, cleanup

- `CHANGELOG.md` UNRELEASED entry, tag `Fix`: subagents on claude-bridge
  models 400 with "out of extra usage" because the forwarded subagent system
  prompt carried pi's harness boilerplate; the bridge now strips pi's
  `buildSystemPrompt` skeleton and duplicate context/skills blocks from
  forwarded custom/append prompts.
- README: one sentence in the provider/appendSystemPrompt documentation
  noting that pi-harness boilerplate is stripped from forwarded prompts.
- Delete the one-off probes (`diag/probe-fable-subagent.mjs`,
  `diag/probe-fable-subagent-cap.mjs`, `diag/probe-fable-kimi-parent.mjs`,
  `diag/probe-fable-size.mjs`, `diag/probe-fable-tools-count.mjs`) once the
  int test covers the regression; keep `diag/capture-proxy.mjs` (pre-existing
  tool used for this diagnosis).
- `.test-output/` captures under `/tmp/fable-cap/` are throwaway; nothing to
  commit.

## Known interactions / out of scope

- `userSystemPrompt` is module-level and last-writer-wins across concurrent
  parent/subagent agent loops (the per-agent keying from `2e089c9` is not in
  current HEAD — it was superseded by later refactors). Sanitization does not
  make this worse, and per-turn re-capture narrows the window; fixing the
  keying is a separate change if it ever bites.
- AskClaude does not consume `userSystemPrompt` (provider path only), so no
  change needed there.
- If Anthropic widens the signature beyond pi's skeleton (e.g. to the
  `<sub_agent_context>` block or CC's own preset), this fix stops working;
  that would be Anthropic policy against the bridge itself, not something we
  can sanitize away.
