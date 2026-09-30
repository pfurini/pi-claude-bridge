# Upstream merge decisions

Paolo confirms a merge of `upstream/main` at `a78a2a5` into `personal` at `edf19ed`.
The workspace is the current checkout on `merge/upstream-main-into-personal`, created from `edf19ed`.
The real merge is active; all textual conflict resolutions and the Pi companion are implemented.
Paolo authorizes the Pi companion commit and bridge merge commit after validation.
Pushes, PR creation, and authenticated tests still require separate approval.
The bridge supports only Paolo's Pi fork.

## Preflight

The isolated trial found 11 conflicted files, 32 textual hunks, and two modify/delete conflicts.
Seven semantic decision groups cover 33 conflict units.
One lockfile hunk becomes mechanical after dependency approval.
The trial worktree is removed.
The trial's opening-marker lines identify the original conflict units:

| Decision | Original trial locations | Units |
| --- | --- | ---: |
| D1 | `src/index.ts:185,764,781,853,882,2120,2246,2435,2457,2506,2588,2610,3231` | 13 |
| D2 | `src/index.ts:202,1932,2077,2216,2358` | 5 |
| D3 | `src/models.ts:70`; `tests/unit-models.mjs:40`; `README.md:34`; `diag/CONTEXT-SIZE.md:53,112` | 5 |
| D4 | Both prompt-capture modify/delete conflicts; `README.md:74,238` | 4 |
| D5 | `package.json:41` | 1 |
| D6 | `package.json:30`; `tests/lib/rpc-harness.mjs:139` | 2 |
| D7 | `CHANGELOG.md:5`; `README.md:24,256` | 3 |
| Mechanical | `package-lock.json:12`, regenerated after D5 | 1 |

D1's compatibility analysis also requires lifecycle changes outside conflict markers.
D8 adds the approved companion contract and corresponding bridge integration.

## D1: Session mirrors (approved)

Paolo selects reusable mirrors for each live Pi session, including retained native children.
Preserve history snapshots, accounting epochs, cwd/profile checks, and same-session concurrent-writer isolation.
Scope lifecycle cleanup, rewrite marks, query retirement, and late callbacks to the affected session.
A child shutdown must not clear a parent's mirror or shared provider registration.
Pi owns child lifetimes; the engine owns workflow attempts, retries, and crash recovery.
Use direct fork APIs without maintaining stock-Pi compatibility.

Evidence and validation requirements: `plans/upstream-merge-session-compatibility-2026-09-30.md`.

## D2: Rewrite recovery (approved)

Paolo selects the fork's existing retirement and recovery path for attributed mid-turn history rewrites.
Retire the old query once, stopping transport before releasing handlers.
Import completed tool results and continue from Pi's current projection and instructions.
Preserve usage and reject repeated identical recovery checkpoints without limiting productive long turns.
Retain upstream's offline query-injection seam and session-attribution regressions.
Do not add a separate compaction recovery implementation or workflow retry authority.

## D3: Sonnet 5.5 runtime policy (approved)

Paolo selects `claude-sonnet-5-5[1m]` with a registered 1M window.
Attribute the 2026-09-28 SDK 0.3.284 measurements to upstream; perform no new authenticated probe.
Update `src/models.ts`, model tests, `README.md`, and `diag/CONTEXT-SIZE.md` together.
Preserve all other fork runtime policies and eligibility checks.

## D4: Direct prompt extraction (directed by the initial request)

Keep `src/prompt-capture.ts` and `tests/unit-prompt-capture.mjs` deleted.
Keep the fork's direct extraction, sanitizer, conditional AskClaude preset, and native-tool restrictions.
Do not restore the capture registry or documentation-path rejection guard.

## D5: Dependencies (approved)

Paolo selects Agent SDK exactly `0.3.284`, matching upstream's measured release.
Keep MCP SDK `1.29.0`, Anthropic SDK types `0.124.0`, and local Pi links.
Registry verification confirms those versions satisfy Agent SDK `0.3.284` peer requirements.
Regenerate `package-lock.json` against the current linked Pi packages.
Do not adopt latest stable `0.3.285` or upstream's caret range in this merge.
Stock-Pi validation is not a compatibility requirement.

## D6: Integration gates (approved)

Paolo selects both the upstream deadlock gate and the fork's broader warning gate.
Run both gates against the same fresh per-run log directory.
Retain logs across harness restarts and preserve authentication preflight, fork CLI selection, buffer resets, and bounded shutdown.
Quota-consuming execution remains separately gated.

## D7: Documentation (approved)

Paolo selects explicitly separated upstream release history and current fork policy.
Preserve fork UNRELEASED entries and upstream release notes without attributing rejected upstream behavior to the fork.
Align documentation with D1–D6 and fork-only support.
Correct the stale fixed restart limit and qualify upstream cache measurements.

## Additional requested work

- Preserve both old and Pi 0.99 MCP-aware documentation lines in sanitizer recognition.
- Test nested MCP name mapping, provider-side resolution, codemode exposure, and the current 128-character API name constraint.
- Preserve effective tool scopes and the absence of runtime fork-capability detection or toolResultContinuation overrides.
- Keep claude-bridge excluded from synthetic skill pairs.

## Shared-understanding gate (approved)

Paolo confirms the full implementation plan on 2026-09-30.
Start the real merge and apply D1–D7 plus the additional requested work.
Remove the obsolete stock CI job and replace stock directory fallbacks with direct fork APIs.
Install the approved SDK and run focused regressions, `npm run typecheck`, and `npm run test:unit`.
Stop before commits, pushes, PRs, `npm test`, or authenticated probes.
Reopen the decision gate if implementation exposes a new semantic choice.

## D8: Extension-free child metadata (implemented and validated)

A built-Pi probe confirms that an extension-free child reaches the inherited bridge provider without authoritative directory metadata.
Paolo authorizes planning a narrow Pi-side provider-session metadata contract on 2026-09-30.
Paolo subsequently approves the companion implementation, focused offline checks, and `npm run build:offline`.
Paolo subsequently authorizes staging and committing the Pi companion and finishing the bridge merge commit locally.
Pushes, PRs, and authenticated validation remain unapproved.
The approved companion plan is `plans/pi-provider-session-context-2026-09-30.md`.
