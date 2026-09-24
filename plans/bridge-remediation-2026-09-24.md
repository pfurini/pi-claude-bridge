# Bridge remediation and repository handoffs, 2026-09-24

The identified bridge defects are fixed and verified locally. The maintainer authorizes committing and pushing the remediation on `merge/main-into-personal`. Deployment and PR merging remain separate decisions. This report supersedes unresolved bridge rows in `plans/merge-live-verification-2026-09-23.md`, not its historical observations. Downstream accounting, lifecycle, configuration, and documentation work has separate GitHub handoffs. PR #7 and issue #6 remain open until a separately approved merge.

## Ownership and published handoffs

Every issue body is read back from GitHub and compared with its local draft.

| Repository | Handoff | Scope |
| --- | --- | --- |
| Bridge | https://github.com/pfurini/pi-claude-bridge/issues/8 | Verify and land the local accounting, instruction, and shutdown remediation |
| OpenIntent | https://github.com/pfurini/OpenIntent/issues/4 | Cancelled-attempt usage, compounded retries, recovery identity, and worker lifetime |
| Second-brain | https://github.com/pfurini/pi-second-brain/issues/1 | Concurrent initialization, registry ownership, configuration, interrupted accounting, and existing suite failures |
| Pi | https://github.com/pfurini/pi/issues/18 | Documented `SystemMessage.replace` semantics absent from the actual type and replay helpers |
| Pi-fence | https://github.com/pfurini/pi-fence/issues/1 | Descendant containment, credential/proxy lifetime, and hard-kill qualification |

The owner creates pi-fence's origin during this work. Issues are already enabled when checked.
The inspected OpenIntent and brain commits return HTTP 422 from GitHub commit lookup.
Their handoffs identify the local worktrees and require an approved source snapshot when a remote-only agent cannot access those commits.
No source branch is pushed to resolve that availability gap.

## Bridge fixes

### Query-local accounting

SDK `0.3.280` documents cumulative resumed-session `total_cost_usd` and `modelUsage`, while `usage` is current-turn main-loop usage.
A controlled authenticated probe confirms the distinction:

| Query | Current input/output | Cumulative estimated USD | Incremental estimated USD |
| --- | --- | --- | --- |
| 1 | 3453 / 54 | 0.003723 | 0.003723 |
| 2 | 3554 / 35 | 0.007452 | 0.003729 |
| 3 | 3636 / 35 | 0.011263 | 0.003811 |

The previous sum would report `0.022438` instead of `0.011263`.
That error inflates reported estimates; it does not establish duplicate Anthropic billing.

`src/session-accounting.ts` supplies a checkpoint for each persisted Claude transcript generation.
Provider and shared AskClaude requests subtract their starting checkpoint before attributing cost and model usage.
The final provider segment still reconciles against already-banked segment estimates.
Claude's cost estimate remains authoritative, including cache-pricing differences from Pi's catalog.

- Rebuilds reset the checkpoint even when the session UUID remains unchanged.
- Missing or ambiguous accounting prevents blind reuse.
- Failed AskClaude iteration retains captured usage on its error.
- Shared AskClaude validates projected history and pins its profile.
- Busy or foreign session owners receive independent imports rather than concurrent transcript writers.

A corrected live run reports `0.003815 + 0.003869 + 0.003955 = 0.011639`.
The sum exactly matches that run's final SDK cumulative value.
The two runs have different token counts and are not a performance comparison.

### Effective instruction forwarding

`src/transcript.ts` retains effective system state locally on each normalized request.
`src/sanitize-prompt.ts` strips recognized template pieces without deleting authored guidelines or built-in-section overrides.
The sanitizer deduplicates the actual selected skill listing rather than an unrelated earlier listing.

The provider forwards custom sections, rules, addenda, and forced replacements.
Forced empty replacements do not resurrect stale captured customization.
Disabled forwarding keeps its prior capture-only behavior for legacy flat contexts without structured prompt state.
No prompt-capture registry or identity/documentation rejection guard is introduced.

Active recovery compares the final forwarded instructions rather than raw boilerplate.
Authenticated inventory fixtures prove that changed system-only SKU values reach replacement queries.
Those tests establish delivery, not universal model obedience to arbitrary wording.

### Shutdown ownership

A deterministic regression releases an old SDK error after shutdown and reuses the same factory for another session.
Before the fix, the old callback changes the new message from `toolUse` to `error`.

The reaper now uses query-owned retirement before fallback process cleanup.
Retirement fences callbacks and settles an open Pi stream as aborted during shutdown.
Late completions cannot alter the replacement session's state.

The new live observer reads process identities outside the sandbox.
The inference worker remains beneath one credential-enabled fence.
Both query abort and normal Pi shutdown remove the exact observed Claude child processes.
The abort case also proves Pi remains alive.

Hard-killing a workflow owner is a separate downstream contract, not evidence supplied by those graceful cases.

## Verification matrix

Evidence root `E` is `.test-output/live-verification/` in this checkout.
Runtime provenance remains the revisions documented in `plans/merge-live-verification-2026-09-23.md`.
The shared Pi build and global extension installations are not changed.

| Check | Command or method | Result | Evidence |
| --- | --- | --- | --- |
| Fork typecheck | `npm run typecheck` | Pass | Captured command output |
| Fork units | `npm run test:unit` | 537 pass | `E/final-remediation-fork.log` |
| Stock floor | Isolated npm installation of Pi `0.86.1`; `tsc --noEmit` and the same unit command | 532 pass, five expected skips; typecheck passes | `E/final-remediation-stock*.log` |
| Stock identity | Installed manifest plus absence of fork capability module | `0.86.1`, no fork marker | Captured command output |
| Resumed accounting | `tests/int-resumed-accounting.mjs`, real loader/runtime/SDK | Three queries match incremental SDK cost | `E/resume-accounting-green.log` |
| History and tools | Authenticated replacement, omission, removal, addition, schema-change cases | Pass | `E/final-sixteen-live-cases.log` |
| Queued skills | Authenticated follow-up and steer cases | Pass | Same log |
| Instruction channels | Project, custom section, rules, addendum, forced content | Pass | Same log |
| Restart budget | Four unique completed checkpoints; only three replacements | Terminal budget error, no replay | Same log |
| Replacement setup failure | Real initial tool call; private profile path deliberately becomes a file | Terminal error, no replacement SDK query | Same log |
| Cancellation | Abort a real replacement after its first text event | Terminal aborted result | Same log |
| Deadline | Abort a replacement through a controlled timer | Terminal aborted result | Same log |
| Retired callbacks | Controlled late error/events, MCP callback, async result delivery, and shutdown-generation tests | Pass | `tests/unit-active-query-restart.mjs` |
| Open-stream shutdown | Retire a held SDK response before completion | Pi stream settles as aborted | Same unit suite |
| Real process termination | `node --import tsx --test tests/int-shutdown-kills-cc.mjs` from the authorized outer host | Both cases pass | `E/shutdown-host-observer-final.log` |
| Existing integrations | Fable child, foreground/background locator, session handoff, skills, branch summary, AskClaude policies/delegation, cache, steering | Eight entrypoints pass | `E/final-bridge-suite.log` and `E/final-bridge/` |
| Native Bash | Real SDK command in assigned temp plus protected-canary denial | Pass | `E/native-bash-fence-green.log` |
| Documentation contract | Compiled Pi replay with documented `replace: true` | Old instructions/tools remain; handed to Pi #18 | `E/pi-replace-contract.json` |
| Publication | Read back all five issue bodies | Exact draft matches; all open | `E/published-issues.json` |

Live recovery commands run under `pi run --profile general --with-credentials`.
The explicit test entry sets `CLAUDE_BRIDGE_LIVE=1` inside the inherited fence before importing the live test.
Each recovery scenario runs in its own process to isolate skill instructions and session ownership.
The host observer never broadens the inference worker's permissions.

The stock installation stays under `.test-output/peer-floor/` and does not replace the linked fork dependencies.
No shared artifact hydration or rebuild runs.

## Boundaries that remain explicit

- The original installed bridge remains unchanged; the fixes target `merge/main-into-personal`, not the deployed `personal` checkout.
- The independent brain adapter correction from the previous stage remains uncommitted in the brain checkout.
- Additional brain documentation changes appear during verification and remain untouched. Earlier brain test results are historical snapshots.
- Existing brain configuration/documentation tests and its dependency-version assertion remain assigned to brain #1.
- OpenIntent must still collect available usage after cancellation and preserve explicit unavailability.
- Bridge replay prevention is not a workflow-level exactly-once guarantee for arbitrary external effects.
- Graceful shutdown proof does not establish cleanup after an owner's SIGKILL.
- Context-window metadata does not demonstrate near-limit acceptance.
- Account tiers unavailable in this verification remain unproven.
- The explicitly deferred parked-subagent fixture is not relabelled as a passing test.

The bridge remediation has passing offline and authenticated evidence for the identified defects.
Deployment and merge approval remain the maintainer's decision.
