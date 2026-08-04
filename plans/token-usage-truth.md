# Token usage truth: reconciliation, CC-derived cost, and enforcement

Planned 2026-08-04 against HEAD `60efeb9` (post-upstream-merge, branch `personal`).
Decisions were settled in a grilling session; the research findings below were
verified that day (binary extraction from the installed Claude Code, a live API
probe, official docs, and the pi fork's source). Line numbers reference that HEAD.

## Objective

Make the bridge's token and cost reporting true, verifiable, and enforced:

1. Per-query token sums reconciled against Claude Code's own `result.usage`
   every query, loudly on mismatch (goal: benchmark-grade numbers).
2. Reported cost adopted from Claude Code's `total_cost_usd` instead of
   pi-computed pricing (decision rationale below).
3. AskClaude and compaction spend visible in pi's session accounting instead
   of silently discarded.
4. The audit tooling that guards all of this actually working (`--since` is
   currently broken) and wired into the int suite as a gate.

## Non-goals

- Upstream's open AUDIT investigations (cold-resume rate, dose-response
  recompute, thinking-signature WARNING, issue #30 pruning). Different corpus,
  different owner.
- Owning a pricing table at CC parity (explicitly rejected, see Decision 2).
- Fast mode, batch, `inference_geo` (bridge never requests them).
- pi-ai catalog changes.
- Structured NDJSON diagnostics beyond the existing `diagDump` channel.

## Decisions

### 1. Goal priority

Benchmark/number correctness (a) and audit tooling (c) are the deliverable;
TUI surfacing (b) is a rider taken where nearly free (Decision 6).

### 2. Cost source: adopt Claude Code's figure

The reported cost for bridged work is CC's `total_cost_usd` (equivalently
`modelUsage[*].costUSD`), not pi-ai's `calculateCost` output.

Rationale (all verified 2026-08-04):

- CC 2.1.220 (the SDK-bundled binary) computes cost per API response at
  official first-party list rates, including the 5m/2x-1h cache-write split
  and web-search fees. Verified two ways: the pricing tiers and cost function
  were extracted from the binary, and a live probe returned
  `total_cost_usd: 0.0190428` which equals the official-rate math with the 1h
  split to the last digit.
- pi-ai's catalog carries only the 5m cache-write rate (1.25x), but bridged
  sessions always get 1h TTL (subscription accounts receive it automatically
  per the official cost-tracking doc; confirmed by `diag/AUDIT.md`'s capture).
  pi's math therefore under-prices every cache write by 37.5% of the write
  component; on the probe turn that made the whole-turn figure 34% low. The
  error concentrates in rebuild-heavy sessions, exactly the pathology the
  numbers exist to measure.
- Officially, CC's figure is "client-side estimates, not authoritative billing
  data ... computed locally from a price table bundled at build time"
  (code.claude.com/docs/en/agent-sdk/cost-tracking). On a subscription there
  is no per-token bill; "API-equivalent value" is precisely the semantics we
  want for comparisons.

Accepted known divergences of CC's figure (do not "fix" these):

- Sonnet 5 introductory pricing ($2/$10 through 2026-08-31, then $3/$15) is
  not modeled; CC prices it at the standard tier, overstating Sonnet 5 by 1.5x
  until September 1. Time-boxed, single model.
- Accuracy is per-CC-version (history: 10x-high Haiku #53371, 3x-high Opus 4.7
  #49872, Bedrock undercount #56110, all closed). The reconciler plus a
  spot-check on SDK bumps is the mitigation.

### 3. Granularity: estimate during, true up the final segment

CC reports cost per `query()`; pi wants usage on each assistant message, and
one query spans many pi messages (one per tool round-trip). Resolution:

- Keep per-segment `calculateCost` estimates during streaming (footer stays
  live mid-turn).
- When the `result` message arrives (the final segment is still open at that
  point), set the final segment's `usage.cost.total` to
  `cc_total − Σ(closed segments' cost.total)`, so the query's sum equals CC's
  figure exactly.
- Abort / missing result: estimates remain (never zero, slightly low).
- A negative true-up delta is theoretically possible (catalog drift); allow it
  and log it. pi only ever sums `cost.total` (verified: pi never recomputes
  cost; `usage-totals.ts` and the `/usage` breakdown read `cost.total` only),
  so a small negative segment total keeps session sums exact and is invisible
  otherwise.
- Cost components on the trued-up segment stay estimates; only `total` is
  authoritative. Log the per-query correction delta: it doubles as a running
  measure of pi-catalog pricing drift.

### 4. Reconciliation: exact, loud, enforced

At result time, compare the query-scoped accumulated
`{input, output, cacheRead, cacheWrite}` against `result.usage`:

- Expectation is exact equality, no tolerance band. The provider path runs CC
  with `tools: []` and AskClaude's policy blocks `Task`, so no CC-native
  subagents exist and `result.usage` (top-level loop only, per the official
  doc) must equal our stream-derived sum. If real traffic reveals a legitimate
  edge (e.g. a mid-stream retry double-streaming `message_start`), we will see
  it in the diag entries and decide with evidence, not bake in slack now.
- On match: one `reconcile:` debug line (new format), including the cc-cost vs
  estimate delta from Decision 3.
- On mismatch: a `WARNING:`-prefixed debug line plus a `diagDump` NDJSON entry
  carrying both sides, model, session, and per-segment breakdown. No TUI
  notification (not actionable mid-session).
- Also cross-check `modelUsage`'s token totals against `result.usage`
  (log-only): divergence would reveal CC-internal side-model calls.
- The `usage:` debug line format is FROZEN: `diag/audit-cache.mjs` parses it
  with an anchored regex (which already tolerates an optional `reasoning=N`
  field). All new output is new line formats. `audit-warnings.mjs` picks up
  the `WARNING:` prefix with no changes.

### 5. Reasoning tokens: rewire, sum, keep informational

The current reads (`usage.reasoning_tokens ?? usage.thinking_tokens`) are dead:
0 of 14,994 logged `usage:` lines ever carried `reasoning=`. The real field is
`usage.output_tokens_details.thinking_tokens` (present in the recorded fixture:
39 of 47 output tokens). Rewire to it, and accumulate it through the same
base+live pair as the other four fields (the current last-non-null assignment
is the same class of bug the usage-sum fix corrected). It is a subset of
`output_tokens`: never add it to `totalTokens`. It stays an informational extra
property on pi's usage object and the optional `reasoning=` field in the
`usage:` line. This also gives `diag/AUDIT.md`'s cold-resume investigation the
log-side thinking proxy it explicitly lacked.

### 6. AskClaude and compaction: attach + display

- AskClaude: build a pi `Usage` from the result frame (tokens from
  `result.usage`; `cost.total` from `total_cost_usd`, components zero) and
  return it on the tool result. The seam exists end-to-end in the pi fork:
  `AgentToolResult.usage` → `createToolResultMessage`
  (`packages/agent/src/agent-loop.ts:773`) → `ToolResultMessage.usage` →
  "Tools/summaries" bucket in `getUsageCostBreakdown`. Correctly excluded from
  context-window accounting by pi. Also add a short human-readable line to the
  tool details/renderer (e.g. `12.4k tok · $0.31` next to execution time).
- Compaction: `runIsolatedSummary` currently returns its summary with
  hardcoded zero usage; populate it from the result frame the function already
  consumes. Verify at implementation that pi's `compact()` propagates the
  summary message's usage onto the `CompactionEntry` (the type supports it;
  the copy was not traced).

### 7. Diagnostics: fix the gate, then arm it

- `diag/audit-cache.mjs --since` is broken twice: (1) the window predicate
  calls `Date.parse(b.at)` on an already-numeric timestamp → `NaN` → with
  `--since`, rebuild-boundary breaks can never be flagged; compare
  numerically. (2) the ceiling check uses the full-log boundary rate,
  contradicting the documented contract ("the exit code counts only records
  and log lines inside the window"); window it. Keep the printed full-corpus
  stats unchanged.
- Int-suite WARNING gate (upstream TODO item 4): after an int run, feed that
  run's debug log through the `audit-warnings.mjs` logic and fail on any
  bridge-prefixed `WARNING:`/`BUG:` line not on an explicit allowlist
  (some tests induce warnings deliberately; curate the allowlist as they are
  found). This is what makes Decision 4 self-enforcing in CI-like runs.

### 8. Process

Plan file (this document) + fresh implementation session driven by
`/implement` with `/tdd` at the seams named below. No intermediate
auto-commits; one commit at the end after `/code-review` passes
(explicitly authorized by the operator, overriding the repo's default
no-auto-commit rule for that final commit). The full int suite hits live APIs
and spends quota: run it only on the operator's say-so; unit tests and
`npm run typecheck` are mandatory per unit.

## Authoritative research findings (2026-08-04)

Recorded so they need not be re-derived. Sources: installed CC binary
`~/.local/share/claude/versions/2.1.220` (the exact build bundled by the
pinned Agent SDK 0.3.220), a live probe, official docs, pi fork source.

- **CC pricing tiers (extracted from the binary):**
  `tier_3_15 {in 3, out 15, 5m 3.75, 1h 6, read 0.3}`,
  `tier_5_25 {5, 25, 6.25, 10, 0.5}`, `tier_15_75 {15, 75, 18.75, 30, 1.5}`,
  `tier_10_50 {10, 50, 12.5, 20, 1}`, `haiku_45 {1, 5, 1.25, 2, 0.1}`,
  `haiku_35 {0.8, 4, 1, 1.6, 0.08}`; all with `web_search: 0.01` ($10/1k).
  Model → tier: opus-5/4.8/4.7/4.6 → `tier_5_25`; sonnet-5 AND sonnet-4-6 →
  `tier_3_15`; haiku-4-5 → `haiku_45`; fable-5 → `tier_10_50`.
- **CC cost function (extracted):** per request,
  `in×input + out×output + cacheRead×read + cacheWriteSplit + webSearch×fee`,
  where the cache-write term splits `cache_creation_input_tokens` into the
  `cache_creation.ephemeral_1h_input_tokens` portion at the 1h rate and the
  remainder at the 5m rate (falling back to all-5m only if the tier lacks a 1h
  rate, which none do in 2.1.220). Fast mode (`usage.speed === "fast"`) swaps
  opus-5/4.8 to `tier_10_50`. Unknown models emit telemetry and fall back to
  the default model's tier. A server-supplied `additional_model_costs` layer
  exists for gateway models.
- **Live probe (haiku, 2026-08-04):** `total_cost_usd 0.0190428` = exact 1h
  math for `in=10, out=37, write=8519 (all 1h), read=18098`. CC bills the 1h
  split correctly.
- **Stale fixture warning:** `tests/fixtures/sdk-streams/text.jsonl` carries
  `total_cost_usd: 0.01189125`, which is the all-5m math for its usage; it was
  recorded on an older CC that ignored the 1h split. Its token fields are
  valid ground truth for reconciliation tests; its cost field documents
  old-version behavior and is still fine as a fixture expectation (the adopted
  figure must equal the fixture's own `total_cost_usd`).
- **Official pricing** (platform.claude.com/docs/en/about-claude/pricing):
  flat per-model rates; cache multipliers 1.25x (5m), 2x (1h), 0.1x (read);
  "Long context pricing: Claude 4.6 and later models ... include the full 1M
  token context window at standard pricing. (A 900k-token request is billed at
  the same per-token rate as a 9k-token request.)" — the >200K premium was
  removed 2026-03-13, so CC's flat math is correct for long-context runs.
  Sonnet 5 intro pricing $2/$10 through 2026-08-31 (CC does not model it).
- **Official cost-tracking doc** (code.claude.com/docs/en/agent-sdk/
  cost-tracking): `total_cost_usd`/`costUSD` are "client-side estimates, not
  authoritative billing data"; `result.usage` excludes subagent activity while
  `total_cost_usd` and `modelUsage` include it; parallel tool calls share one
  message id with identical usage (dedupe by id); subscription users get 1h
  cache TTL automatically.
- **pi-ai fork catalog** (`packages/ai/src/providers/data/anthropic.json`):
  single `cacheWrite` at the 5m rate for every model (opus-5 6.25, fable 12.5,
  sonnet-4-6 3.75, haiku 1.25); sonnet-5 carries intro pricing (2/10/0.2/2.5).
- **pi fork cost handling:** `calculateCost` is called only inside providers;
  pi-coding-agent reads `message.usage.cost.total` and sums it
  (`packages/coding-agent/src/core/usage-totals.ts`); `ToolResultMessage.usage`
  and `AgentToolResult.usage` exist and flow through
  `createToolResultMessage`; toolResult/compaction usage lands in the
  "Tools/summaries" bucket of the `/usage` breakdown.

## Current codebase behavior (anchors at HEAD `60efeb9`)

- `src/query-state.ts`: `usageBase`/`usageLive` are per pi-message;
  `resetTurnState` (called on every tool-result delivery via
  `deliverToolResults`) zeroes both; `beginUsageResponse` folds live→base at
  each `message_start` and non-streamed assistant message.
- `src/index.ts:823 updateUsage`: assigns the live response, reports
  base+live, runs `calculateCost` per event, emits the frozen `usage:` line.
- Response boundaries: `processStreamEvent` (`message_start`) and
  `processAssistantMessage` (non-streamed fallback, gated on
  `!turnSawStreamEvent`).
- `src/index.ts:1146 consumeQuery`: `result` handling sits above the
  closed-stream guard (error text, served-context-window log); the result
  frame's `usage`/`total_cost_usd`/`modelUsage` are otherwise discarded.
- `src/index.ts:1649 promptAndWait` (AskClaude): debug-logs result usage at
  :1796, returns only `{responseText, stopReason}`; details carry
  `{prompt, executionTime, actions}`.
- `src/index.ts:359 runIsolatedSummary` (compaction): summary built by
  `newAssistantOutput` with zero usage.
- `diag/audit-cache.mjs`: `USAGE`/`LINE`/`FRESH`/`SYNC` regexes; the `recent`
  predicate and unwindowed `excess` are the two defects.
- Tests: `tests/unit-usage-accumulation.mjs` mirrors `updateUsage` arithmetic
  by hand (replace/augment through the real path);
  `tests/unit-stream-replay.mjs` + `tests/fixtures/sdk-streams/*` replay
  recorded streams through the real `consumeQuery` (its `__test` export
  already exposes what is needed). Note: unit-stream-replay's header comment
  claims `buildModels` ships zero pricing; that is stale (pricing is
  forwarded since `fbe1978`) — fix in passing.
- `tests/lib/setup.mjs` redirects `CLAUDE_BRIDGE_DEBUG_PATH` for the unit
  suite. `DIAG_LOG_PATH` is currently hardcoded to the real
  `~/.pi/agent/claude-bridge-diag.log` — tests that exercise `diagDump` would
  pollute it; unit 2 must make it redirectable first.

## Implementation sequence

Order 1 → 2 → 3 → 4 → 5; units 2 and 3 depend on 1; units 4 and 5 are
independent of each other. TDD at the named seams; `npm run typecheck` and the
unit suite green after every unit; a `CHANGELOG.md` UNRELEASED entry per unit
(combine per the changelog rule where entries cover one feature).

### Unit 1 — Query-scoped accumulator + reasoning rewire

- Add query-scoped totals to `QueryContext`: tokens
  `{input, output, cacheRead, cacheWrite, reasoning}` plus the sum of closed
  segments' estimated `cost.total`. NOT touched by `resetTurnState`; cleared
  only where a query begins (the fresh-query path re-using the top-level
  `ctx()`; reentrant contexts are new instances).
- Fold-order pitfall (pin with a test BEFORE fixing): at segment close,
  `resetTurnState` zeroes `usageLive` before the next `message_start` would
  fold it, so the closing segment's live response must be folded into the
  query totals (and its `cost.total` banked) before the wipe — e.g. a
  `closeSegment()` on `QueryContext` called from the delivery path, or folding
  inside `resetTurnState` itself.
- Rewire reasoning per Decision 5 (read
  `output_tokens_details.thinking_tokens`, accumulate base+live, informational
  only, delete the dead reads).
- Tests: replay fixtures through the real `consumeQuery` (text fixture:
  `usage.reasoning === 39`; token sums per fixture); QueryContext unit tests
  for the fold order across a segment boundary; keep the four accumulation
  scenarios of `unit-usage-accumulation.mjs` but drive them through the real
  `updateUsage` instead of the hand-mirrored arithmetic. Verify what the
  `single-tool` fixture's tail actually contains (whether it spans the tool
  boundary with post-result responses and a `result` frame) before relying on
  it for multi-segment assertions.

### Unit 2 — Reconciler

- Make `DIAG_LOG_PATH` redirectable (env var or derive from
  `CLAUDE_BRIDGE_DEBUG_PATH`'s directory) and set it in
  `tests/lib/setup.mjs`, mirroring the existing debug-log guard.
- In `consumeQuery`'s result branch: compare query totals vs `result.usage`
  per Decision 4; `reconcile:` line on match; `WARNING:` + `diagDump` on
  mismatch; `modelUsage` cross-check log.
- Tests: replay fixtures assert reconcile-ok against each fixture's own
  `result.usage`; a synthetic stream with a deliberately wrong `result.usage`
  asserts the WARNING line and the diag entry (read back from the redirected
  diag file).

### Unit 3 — Cost adoption

- At the result branch, with the final segment still open: set the final
  segment's `usage.cost.total` to `total_cost_usd − bankedSegmentCost`
  (Decision 3); log `cc=… est=… delta=…`; allow and log negative deltas.
- Tests: replay `text.jsonl` asserts the turn's `cost.total` equals the
  fixture's `total_cost_usd` exactly; a two-segment synthetic (or the
  single-tool fixture if its tail permits) asserts the true-up lands on the
  final segment and the query sum equals CC's figure; abort path asserts
  estimates survive untouched.

### Unit 4 — AskClaude + compaction usage

- `promptAndWait`: capture the result frame's usage + `total_cost_usd`
  (`reduceSdkMessage` already parses the result; extend its reduction or read
  the raw message as the existing code does), map to a pi `Usage`, return it,
  and include it in the tool result from `execute()`. Add the tokens/cost
  line to details and `askclaude-ui` rendering.
- `runIsolatedSummary`: populate the summary message's usage the same way.
  Verify `compact()` propagates it to the `CompactionEntry`; if it does not,
  surface that finding rather than forcing it.
- Tests: unit test for the SDK-usage→pi-Usage mapping (including missing
  fields); extend an existing AskClaude unit/contract test to assert usage is
  attached; UI render assertion optional.

### Unit 5 — Diag fixes + int WARNING gate

- `audit-cache.mjs`: numeric `recent` comparison; windowed ceiling per the
  documented `--since` contract; full-corpus printout unchanged. Test by
  spawning the script on crafted fixture logs and asserting exit codes for:
  windowed rebuild-break (fails), out-of-window rebuild-break (passes),
  ceiling within/over window.
- Int gate: a small helper (mjs, reusing `audit-warnings.mjs`'s parsing) run
  at the end of the int battery against that run's debug log, with an explicit
  allowlist file for deliberately induced warnings; wire into the `test`
  script after the int tests. Failing line output must name the offending log
  lines.

## Out of scope (explicit)

Everything under Non-goals, plus: changing the `usage:` line format; TUI
notifications for reconcile mismatches; per-component cost truth on trued-up
segments; handling CC-side subagents (none can exist under current policies —
if the `modelUsage` cross-check ever shows one, that is a new finding, not a
bug in this work).

## Acceptance

- Replay suite proves: token sums equal each fixture's `result.usage`;
  reported turn cost equals each fixture's `total_cost_usd`; reasoning
  accumulates from `output_tokens_details`.
- A synthetic mismatch produces the WARNING line and diag entry, and the int
  gate turns an unexpected WARNING into a failing run.
- `audit-cache.mjs --since` flags an in-window rebuild break and ignores
  out-of-window history.
- AskClaude and compaction usage appear under "Tools/summaries" in pi's
  `/usage` breakdown in a live session.
- `npm run typecheck` and `npm run test:unit` green; full int suite green on
  the operator's machine when they choose to run it.
