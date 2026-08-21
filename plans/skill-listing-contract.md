# Plan: adopt pi's versioned skill-listing contract (Workstream 3)

Implements **Workstream 3 — claude-bridge companion**, §5 of
`../pi/docs/plans/pi-skill-system-plan.md` (v6, frozen). That plan's §5 has four
items; two of them are wrong as written and one is already satisfied by pi. This
plan is the corrected version and supersedes §5 for the bridge. Where they
disagree, this file wins — the corrections are evidence-backed below.

Anchors verified at `d746734`. **Re-verify every anchor before editing**: line
numbers drift, and the fork moves independently of this repo.

---

## Decisions already made — do not relitigate

| # | Decision | Rationale |
| --- | --- | --- |
| **D1** | **Copy** pi's three listing delimiters into the bridge. Do **not** import `extractSkillListingBlock`. | A static import breaks the bridge on stock pi and would fail the `stock` CI job. See E2 below: no peer-dependency floor can gate it. The plan's own §A.9 prescribes copying cross-repo contract constants with identical conformance fixtures, no shared package. |
| **D2** | Derive the framing line from `context.tools` **per request**, never assert the `skill` tool is present. | Both branches occur in practice; see the probe table. |
| **D3** | Framing text lives in `src/skills.ts`, next to the block it frames. | `harness-prompt.ts` is documented as corrections to *Claude Code's* preset, which must stay small because it joins the cached prefix. This claim is about *pi*. |
| **D4** | `src/sanitize-prompt.ts` keeps its prose markers. Behaviour unchanged; add a comment plus one test. | Its job is the opposite of the forwarding extractor's: it must match what pi *embedded* (preamble **and** block), not what we forward. Switching it to the delimiters would strip the block and leave three orphan lines of pi boilerplate — which is precisely the self-identifying text that routes requests to metered usage. |

### Corrections to plan §5

- **E1 — §5 says "the new listing no longer says 'use the read tool'". False.**
  `formatSkillsForPrompt` (fork: `packages/coding-agent/src/core/skills/listing.ts:47-52`)
  picks the line from the session's *active* tool set: `"Use the skill tool…"` when
  `skill` is active, `"Use the read tool…"` otherwise. Deleting `rewriteReadTool` is
  still correct, but for a different reason: `extractSkillListingBlock` returns the
  block **without** the preamble, so there is no line left to rewrite. Framing
  becomes the bridge's job on both paths.
- **E2 — §5 says to raise the Pi peer-dependency floor. Unenforceable.**
  Registry `@earendil-works/pi-coding-agent` is at **0.84.2**; the fork is at
  **0.84.1** and does not track registry versions. Verified by unpacking the
  registry tarball: 0.84.2 exports neither `extractSkillListingBlock` nor
  `SKILL_LISTING_*`. Any floor we can express is already satisfied by a build that
  lacks the helper. D1 removes the need for a floor entirely; `peerDependencies`
  stays at `>=0.82.1`.
- **E3 — §5's "reaches Claude as `mcp__custom-tools__skill` automatically — verified:
  the bridge enumerates `context.tools`" verified the wrong proposition.**
  The enumeration is real (`src/index.ts:880-905`, only `askClaudeToolName` is
  excluded), but whether `skill` is *in* `context.tools` is a separate fact and is
  currently false in every session (see "pi-side defect"). Strike the sentence.
- **E6 — §5 is silent on commands. Nothing to do, deliberately.** pi emits no
  command listing in the system prompt (no `available_commands` block, no
  `formatCommandsForPrompt`), so there is nothing to extract or frame.
  `slash_command`'s description is a fixed three-line string that does not
  enumerate commands (fork: `core/commands/slash-command-tool.ts:56-59`), so it
  costs nothing and needs no framing. If active it maps to
  `mcp__custom-tools__slash_command` like any other tool, for free.
- **§5 item 4 (transport) is already satisfied by pi.**
  `SYNTHETIC_PAIR_EXCLUDED_PROVIDERS = new Set(["claude-bridge"])` in the fork's
  `core/skills/delivery.ts:47` hard-codes the bridge onto message-block delivery.
  No bridge work; **AC9** pins it so a fork refactor cannot silently drop us.

---

## Probe evidence (2026-08-21, fork `f80a6efb6`, bridge `d746734`)

All findings below are measured, not reasoned. The fixtures that produced them are
committed at `tests/fixtures/skills/` — see the README there for the assertion
surface and the two traps these fixtures encode.

**Framing branches** — probe extension dumping `getActiveTools()` and the system
prompt at `before_agent_start`, exiting before any provider request (zero tokens):

| | default `pi` launch | `pi --tools read,bash,edit,write,skill` |
| --- | --- | --- |
| `skill` active | **no** | **yes** |
| `slash_command` active | no | no |
| preamble emitted | `Use the read tool…` | `Use the skill tool…` |
| listing tag | `<available_skills version="2">` | same |

**Skill-tool round trip through MCP** — works end to end. Debug log:
`mcp handler: skill [toolu_01Yb4EjoDigibs3LZMoLe8gz] → waiting`, then the rendered
body delivered as the tool result, carrying the A.3.1 `Base directory for this
skill:` preamble with frontmatter stripped. The model returned the marker.
Note: an earlier worry that this payload was unusually large for the bridge was
wrong — `read` and `hypa_shell` results routinely carry more through the same path.

**Ephemeral overrides (§A.5) reach Claude Code correctly:**

| fixture | observed `provider: fresh query …` line |
| --- | --- |
| `effort: low` | `model=claude-haiku-4-5 … effort=low` |
| `model: claude-sonnet-5` | `model=claude-sonnet-5[1m] … effort=high` |
| two turns, one session | turn 1 `model=claude-sonnet-5[1m] resume=none`; turn 2 `model=claude-haiku-4-5 msgs=3 resume=b89291e3` |

A first attempt with `effort: xhigh` showed `effort=high`; that was haiku clamping
the level, not a defect. Use a **downward** override (`low`) in tests — upward
overrides are not observable on every model.

**Cross-provider override** (`model: gpt-5.4-mini`, a non-bridge provider):
turn 1 produced **zero** `fresh query` lines, i.e. it routed entirely off-bridge;
turn 2 returned to the bridge and correctly recalled the foreign turn's marker.
Mechanism from the log:

```
convertAndImportMessages: 2 pi msgs → 2 anthropic msgs
convertAndImportMessages: dropped 1 thinking (openai-codex)
syncResult: path=rebuild sessionId=358f6808… priors=2 first
```

The bridge takes the **rebuild** path (not resume), and already strips foreign
providers' reasoning blocks. No warnings, no errors. Cost characteristic, not a
defect: a turn following a foreign-provider turn pays a full rebuild, so a
prompt-cache miss.

### pi-side defect (fork, not this repo — do not fix here)

> **RESOLVED in fork `eee78cdf2` (2026-08-21), "activate skill/slash_command tools on
> default launch".** The analysis below is kept as the record of why the branch
> existed. What changed: the skill-tool branch is now the *default*, and the
> no-skill-tool branch needs an explicit `--tools read,bash,edit,write`. Both are
> still tested; `tests/int-skill-listing.mjs` names the tool set per branch rather
> than relying on the default, so neither test encodes which branch is common.

`skill` and `slash_command` are **never active on a default `pi` launch**.
`core/sdk.ts:265-271` always computes `initialActiveToolNames`
(`["read","bash","edit","write"]` minus exclusions, never `undefined`) and passes
it to `AgentSession` (`sdk.ts:455`). `_buildRuntime` then does
`options.activeToolNames ?? defaultActiveToolNames` (`agent-session.ts:4508`), so
the `defaultActiveToolNames` branch that appends `SKILL_TOOL_NAME` /
`SLASH_COMMAND_TOOL_NAME` (`:4498-4507`) is unreachable on the real path — it runs
only for test harnesses, which set `baseToolsOverride`.
`_refreshSkillToolRegistration` cannot rescue it either: it early-returns when
`registered === shouldRegister`, and the tool *is* already registered as a
definition (`:2313-2317`). Dates confirm it: the `_buildRuntime` list gained the
two names in C1c (`a1ba977e9`, 12 Aug 2026); `sdk.ts` was last touched here in
`2849623af` (4 Jan 2026), before skills existed.

**Consequence for this plan** (as written, before the fork fix): the "no skill tool"
branch is the *only* branch that executes today, and the "skill tool present" branch
becomes the default once the fork is fixed. Both must work and both must be tested. `--tools read,bash,edit,write,skill`
reproduces branch B today without any fork change.

---

## Current bridge behaviour (anchors at `d746734`)

- `src/skills.ts` — whole file, 35 lines. `extractSkillsBlock(systemPrompt, opts)`
  scrapes between the literal prose `"The following skills provide specialized
  instructions for specific tasks."` and `"</available_skills>"`, returning
  preamble **plus** block; `rewriteSkillsBlock` then rewrites
  `"Use the read tool to load a skill's file"` to name `mcp__custom-tools__read`
  unless `rewriteReadTool: false`.
- `src/index.ts:1734-1736` — provider path. `appendSystemPrompt` gate, then
  `skillsAppend = extractSkillsBlock(context.systemPrompt)`.
- `src/index.ts:1785` — `appendParts` join order:
  `[agentsAppend, skillsAppend, steeringAppend, corrections, sanitizedCustom, sanitizedAppend]`.
- `src/index.ts:1987-1989` — AskClaude. Skipped entirely when `Read` is disallowed;
  otherwise `extractSkillsBlock(options.systemPrompt, { rewriteReadTool: false })`.
- `src/index.ts:1997` — `presetActive = mode === "full" || Boolean(skillsBlock)`.
  **Do not break this coupling**: on AskClaude, sending an append at all is what
  switches Claude Code's preset on, and the skills block is that append in
  `read`/`none` modes.
- `src/index.ts:1688` — `resolveMcpTools(context, askClaudeToolName)`; runs before
  1736, so the tool inventory is already in scope at the framing site.
- `src/sanitize-prompt.ts:31-33` — `SKILLS_START` / `SKILLS_END` prose markers.
- `tests/unit-skills.mjs` — existing coverage; its fixture uses the **unversioned**
  `<available_skills>` shape, which is exactly the stock-pi form (AC2).

Stock pi's emitted form, verified from the registry tarball
(`0.84.2 dist/core/skills.js:262-268`): the same three preamble lines, a hard-coded
`"Use the read tool…"`, and a bare `<available_skills>` with **no** version
attribute.

---

## Design

### `src/skills.ts` — new surface

Keep `MCP_SERVER_NAME` / `MCP_TOOL_PREFIX` as they are. Replace the extractor and
delete `rewriteSkillsBlock`.

```ts
// Copied from pi (packages/agent/src/harness/listing-budget.ts:1-3).
// D1: copied, not imported — see AC10 for the drift guard.
export const SKILL_LISTING_VERSION = "2";
export const SKILL_LISTING_START_DELIMITER = `<available_skills version="${SKILL_LISTING_VERSION}">`;
export const SKILL_LISTING_END_DELIMITER = "</available_skills>";

export const SKILL_TOOL_NAME = "skill";

export type SkillsFraming = "skill-tool" | "read-mcp" | "read-native";

export interface SkillsBlockResult {
 /** The listing block verbatim, delimiters included. Never the preamble. */
 block: string;
 /** Framing lines the bridge writes in place of pi's preamble. */
 framing: string;
 /** True when matched via the unversioned stock-pi form. */
 legacy: boolean;
}

export function extractSkillsBlock(
 systemPrompt: string | undefined,
 opts: { framing: SkillsFraming },
): SkillsBlockResult | undefined;
```

**Detection is one scan, three outcomes** (this is what makes §5's "fail-visible on
mismatch" actually implementable — the old helper returns `undefined` for both
"no skills" and "wrong version", which is indistinguishable):

1. Find the first `<available_skills`. Absent → return `undefined`, **no**
   diagnostic (a session with no skills is normal).
2. Read the tag through its closing `>`.
   - Exactly `<available_skills version="2">` → v2, `legacy: false`.
   - Exactly `<available_skills>` → stock/pre-C0 pi, `legacy: true`.
   - Anything else → **return `undefined` and emit one `console.warn`**, naming the
     tag found and the version expected. This is the only fail-visible path.
3. Find `</available_skills>` after the tag. Absent → `undefined` (malformed;
   preserves today's behaviour, covered by an existing test).

Both v2 and legacy return the same shape, so there is exactly one output form and
no second code path downstream.

**Framing text.** All three variants keep pi's relative-path line, which is
load-bearing for skills that reference `references/*.md` and is otherwise lost with
the preamble:

- `skill-tool` — "Invoke a skill with the `mcp__custom-tools__skill` tool to receive
  its rendered instructions. Claude Code's native Skill tool is not available in
  this session."
- `read-mcp` — "Load a skill by reading the file at its `<location>` with the
  `mcp__custom-tools__read` tool."
- `read-native` — "Load a skill by reading the file at its `<location>` with the
  Read tool."

Exact wording is the implementer's call; the assertions in AC5–AC8 constrain what
must appear, not the prose around it.

### Call sites

**Provider** (`src/index.ts:1736`). `context.tools` is in scope:

```ts
const hasSkillTool = context.tools?.some((t) => t.name === SKILL_TOOL_NAME) ?? false;
const skills = appendSystemPrompt
 ? extractSkillsBlock(context.systemPrompt, { framing: hasSkillTool ? "skill-tool" : "read-mcp" })
 : undefined;
const skillsAppend = skills ? `${skills.framing}\n\n${skills.block}` : undefined;
```

**AskClaude** (`src/index.ts:1988`). Framing is always `read-native` — AskClaude runs
on Claude Code's native tools and never receives the MCP `skill` tool, so naming it
would point the sub-agent at a tool it does not have. The `readDisallowed` gate and
the `presetActive` coupling at 1997 stay exactly as they are.

### `src/sanitize-prompt.ts`

No behaviour change. Add a comment at 31-33 recording that the two extractors use
different boundaries **on purpose**, with the reason from D4, so the next reader
does not "unify" them and silently break either forwarding or the metered-usage fix.

---

## Implementation sequence (TDD)

Each step: write the failing test, then the code. Run
`npm run test:unit` after each; the full `npm test` (live) only at step 6.

1. **Delimiters + detection.** Tests for AC1–AC4 in `tests/unit-skills.mjs`, then
   the three constants and the one-scan detector. `rewriteSkillsBlock` and the
   `rewriteReadTool` option are deleted in this step; the two existing tests that
   assert the rewrite are replaced by AC1/AC5 rather than edited.
2. **Framing.** Tests for AC5–AC8, then the three framing variants.
3. **Drift guard.** Test for AC10 (fork-only, skipped on stock).
4. **Provider call site.** Tests for AC5/AC6 at the call-site level, then wire
   `hasSkillTool` at 1736.
5. **AskClaude call site + sanitize comment.** Tests for AC7 and AC11, then the
   edit at 1988-1989 and the comment in `sanitize-prompt.ts`.
6. **Live contracts.** AC12–AC15 in `tests/int-cc-contracts.mjs` (or a new
   `tests/int-skill-listing.mjs` if that file grows unwieldy). These spend quota;
   run them last.

Fixtures: already landed at `tests/fixtures/skills/` (`probe-skill`,
`probe-effort`, `probe-model`, `probe-xprovider`, plus a README covering the
assertion surface and the clamping/suffix traps). Load them with `--skill <path>`;
never install them. Verified in-session to parse and appear in the listing — their
live behaviour as committed is not yet exercised, which is step 6's job.

---

## Acceptance criteria

Every criterion is verified by at least one test. AC1–AC11 are unit tests
(`node --import tsx --test`, repo convention); AC12–AC15 are live.

| AC | Criterion | Test |
| --- | --- | --- |
| **AC1** | A v2 block is extracted by delimiter, and the result contains the block only — no preamble, whatever the preamble wording. | unit: feed a prompt whose preamble says `Use the skill tool…`; assert the returned `block` starts with the start delimiter, ends with the end delimiter, and contains none of the preamble text. |
| **AC2** | A stock-pi **unversioned** block is still extracted, with `legacy: true`. | unit: registry-shaped prompt (existing `tests/unit-skills.mjs` fixture); assert block returned and `legacy === true`. Guards the `>=0.82.1` peer promise. |
| **AC3** | An unknown listing version forwards **nothing** and warns exactly once. | unit: `<available_skills version="3">…`; assert `undefined` returned and one `console.warn` naming the found tag. |
| **AC4** | No listing block → `undefined`, and **no** warning. Malformed (start, no end) → `undefined`. | unit: two cases; assert no warning fires for either (distinguishes "no skills" from "wrong version"). |
| **AC5** | With `skill` in `context.tools`, the framing names `mcp__custom-tools__skill` and never tells the model to read the file. | unit on the framing function + unit on the provider call site with a stub `context.tools` containing `{name:"skill"}`. |
| **AC6** | Without `skill` in `context.tools`, the framing names `mcp__custom-tools__read` and never claims a skill tool exists. | unit, stub `context.tools` without `skill`. This is the branch that runs today. |
| **AC7** | AskClaude framing names the native `Read` tool and **never** the `mcp__custom-tools__` prefix. | unit on the AskClaude framing path. Regression guard: naming the MCP tool there points the sub-agent at a tool it lacks. |
| **AC8** | All three framings retain the relative-path resolution instruction. | unit, one assertion per variant. |
| **AC9** | pi still excludes `claude-bridge` from synthetic-pair delivery. | unit (fork-only, skipped on stock): read `SYNTHETIC_PAIR_EXCLUDED_PROVIDERS` behaviour via the fork's `selectSkillTransport` and assert `message-block` for `provider: "claude-bridge"`. |
| **AC10** | The bridge's copied delimiters are byte-identical to pi's exports. | unit (fork-only): `import * as ca from "@earendil-works/pi-coding-agent"` — **namespace import, not named**, so a missing export is `undefined` rather than a link-time `SyntaxError` on stock pi — and skip when `ca.SKILL_LISTING_START_DELIMITER === undefined`. |
| **AC11** | `sanitizeHarnessPrompt` still strips preamble **and** block for **both** preamble variants. | unit: two subagent-shaped prompts, one with the `read` wording and one with the `skill` wording; assert the whole span is removed in both. Pins the metered-usage fix against a future preamble edit. |
| **AC12** | Default launch (no `skill` tool): the listing reaches Claude Code with `read-mcp` framing. | live: `pi --skill tests/fixtures/skills/probe-skill -p …`, assert the model reports the fixture marker and the debug log shows no `mcp handler: skill`. |
| **AC13** | With `--tools …,skill`: the framing names the MCP skill tool and a real round trip succeeds. | live: same fixture with `--tools read,bash,edit,write,skill`; assert the marker is returned **and** the debug log shows `mcp handler: skill [`. |
| **AC14** | Ephemeral `effort` and `model` overrides from skill frontmatter reach Claude Code, and expire after their turn. | live: `/probe-effort` → assert `effort=low` on the `provider: fresh query` line; `/probe-model` across two turns with one `--session-id` → assert turn 1 `model=claude-sonnet-5`, turn 2 back to the session default with `resume=` set. |
| **AC15** *(recommended, not required)* | A skill whose `model:` names a non-bridge provider routes off-bridge, and the following bridge turn rebuilds the CC session including that turn. | live: `/probe-xprovider` then a recall prompt on one `--session-id`; assert turn 1 wrote no `fresh query` line, turn 2 recalls the marker, and the log shows `syncResult: path=rebuild`. This path has no other coverage. |

AC14 and AC15 pin **pi** behaviour the bridge depends on rather than bridge logic,
which is what `tests/int-cc-contracts.mjs` exists for (per `AGENTS.md`: prove
undocumented behaviour with a live probe, not by reading `~/.claude/projects/**`).

---

## Changelog and docs

- `CHANGELOG.md` `## UNRELEASED`, tag `Fix`, one combined entry: the bridge now
  locates pi's skill listing by the versioned `<available_skills version="2">`
  delimiters instead of scraping an English sentence; it forwards the block alone
  and writes its own framing, chosen per request from `context.tools`, so a session
  with the `skill` tool is told to invoke `mcp__custom-tools__skill` and one without
  is told to read the file's `<location>`. Unversioned listings from stock pi keep
  working; an unrecognised version forwards nothing and warns. Mention the one-time
  prompt-cache miss (below) and that `rewriteSkillsBlock` is gone.
- `README.md` — the `appendSystemPrompt` bullet already mentions `<available_skills>`;
  update it to say the block is forwarded with bridge-written framing, and that the
  framing depends on whether pi exposes its `skill` tool.
- No docs entry for the sanitize comment (comment-only change).

**Prompt-cache note for the changelog:** the appended system prompt changes shape,
so existing persisted sessions take a one-time cache miss on their first request
after upgrading. This is the third such change; match the wording used for the
auto-memory and harness-corrections entries.

---

## Out of scope / known limitations

- **The pi-side defect is not fixed here.** It lives in the fork
  (`core/sdk.ts:265-271` shadowing `agent-session.ts:4498-4508`) and is tracked
  separately. This plan works correctly before and after that fix; only which
  branch is common changes.
- **`disallowed-tools` schema removal is a no-op on the bridge path.** pi removes
  matching tool schemas from *subsequent requests of the turn*, but the bridge holds
  one live Claude Code query across tool round-trips with the MCP server built once
  at query start. A restricted tool therefore stays visible to Claude Code and is
  blocked at `tool_call` time instead when the result routes back through pi. Safe,
  but it wastes a round trip. Document as a known limitation; do not fix here.
- **Shell injection** (`` !`cmd` ``) executes inside pi, gated on pi's active tool
  set containing `bash`. A skill can therefore render differently in a bridge session
  than in a native one. Not a bridge concern; noted so it is not mistaken for a bug.
- **`slash_command`** — nothing to do (E6).
- The fork's `--help` does not list `skill` or `slash_command` among built-in tool
  names, so `--tools` users silently drop them. Fork docs issue, noted for whoever
  fixes the defect above.

---

## Fresh-session handoff

Read this file, then `AGENTS.md` (especially the "Claims about how Claude Code
behaves" and "Pi dependency" sections). You do **not** need to re-read
`../pi/docs/plans/pi-skill-system-plan.md` — §5 is reproduced and corrected above —
but do read fork `packages/coding-agent/src/core/skills/listing.ts` and
`packages/agent/src/harness/listing-budget.ts:1-3` to confirm the delimiters and the
preamble variants still match what D1 copies.

Verify before implementing: every anchor in "Current bridge behaviour", and that
`formatSkillsForPrompt` still selects its instruction line from the active tool set.
The probe evidence above is measured and does not need re-running — but if any
anchor has moved materially, re-run the zero-cost framing probe (a `before_agent_start`
extension dumping `getActiveTools()` and the system prompt, then `process.exit(0)`)
before trusting the branch table.
