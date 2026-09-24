# Merge live verification, 2026-09-23

Current bridge remediation and repository handoffs are recorded in `plans/bridge-remediation-2026-09-24.md`. The results below preserve the earlier verification stage.

The merge repairs the reproduced OpenIntent startup failure. Authenticated tests cover context recovery, instruction updates, and standalone brain instruction delivery for the cases below. Merge readiness remains conditional. Process termination, accounting, and several downstream lifecycle contracts still need evidence. Passing tests do not establish workflow-level exactly-once execution.

## Workspace and provenance

| Component | Examined revision and runtime |
| --- | --- |
| Merge checkout | `/Users/paolof/Developer/ai/pi-claude-bridge-merge-main-into-personal`, branch `merge/main-into-personal`, HEAD `16730709a84edea6380ce470545402b4240ac12f`, plus uncommitted remediation |
| Original bridge | `/Users/paolof/Developer/ai/pi-claude-bridge`, clean `personal` at `3a83275c7426a1fcce830160d23f95e33e84adc6` |
| Shared Pi | `/Users/paolof/Developer/ai/pi`, clean `personal` at `c280811041f21154ef4bf91a6387221ae74f113c`; package manifests report `0.87.1` |
| OpenIntent | `/Users/paolof/.openintent/workspaces/pfurini/OpenIntent/worktrees/workflow-engine`, `change/workflow-engine`, `7189ff16123fa3cb166e54f12ecd39f03b634563` |
| Fence | `/Users/paolof/Developer/ai/pi-fence`, clean `main`, `76daba8d1facc12da3f6db5cc5e68950f4334575` |
| Brain | `/Users/paolof/Developer/pi-second-brain`, `architecture/foundations`, `d82038c2205361ce306d22b61e3ca8927ef65457`, plus the adapter correction and tests |
| Subagent integration | `/Users/paolof/Developer/ai/pi-subagents`, clean `personal`, `d03f424c0b1937668c2580aa8a99d2e8346be360`; no modifications |
| Merge dependencies | Agent SDK `0.3.280`, bundled Claude Code `2.1.280`, Anthropic types `0.124.0`, MCP SDK `1.29.0` |
| Original dependencies | Agent SDK `0.3.259`, bundled Claude Code `2.1.259` |
| Node | `26.8.2` |

PATH `pi` resolves through `/Users/paolof/.local/bin/pi` to `pi-fence/dist/cli/main.js`.
The launcher entry record selects `pi/packages/coding-agent/dist/cli.js`.
Both bridge checkouts resolve Pi dependencies to the shared fork's compiled directories.
OpenIntent's workflow package resolves those same compiled Pi packages.
The brain's linked dependencies also consume those artifacts.

The previous session rebuilt those artifacts without changing branch pointers.
This session performs no shared rebuild or global installation change.
Existing long-running processes may retain older modules; no historical process memory was inspected.

TokenSave tools remain bound to the original bridge checkout.
Discovery for other repositories uses their own read-only databases, followed by current-source inspection.
The merge index's `src/index.ts` and `src/transcript.ts` hashes match before remediation.
The shared Pi graph predates the rebuild and does not establish current runtime behavior.

| Compiled entry | Observed modification time | SHA-256 |
| --- | --- | --- |
| `pi/packages/ai/dist/index.js` | `2026-09-23T16:57:53+0000` | `4eee4d99e3eaf82e28826808136b2eede4184c3fb697328cbfc32db3360a8540` |
| `pi/packages/coding-agent/dist/index.js` | `2026-09-23T16:57:56+0000` | `24a59e488be0a8f03cf2140f72f09165319fdf94b7fb5885dda50846006774ea` |

These hashes identify entry files, not every transitive compiled artifact.
No pre-rebuild artifact snapshot exists in this verification record.

## OpenIntent failure

OpenIntent's `acceptance-providers.json` selects the original bridge checkout.
The actual worker follows this sequence:

1. `worker-entry.ts` creates an independent model runtime and loads selected extensions.
2. Pi flushes provider registrations before OpenIntent's exact-model lookup.
3. Session binding emits `session_start` with the worker's temporary agent directory.
4. Pi supplies a transcript containing `system` and `user` messages.
5. The old bridge counts the system message as prior conversation.
6. Conversion produces zero Claude conversation records, so no resumable session file exists.
7. `session_verify_fail` attempts an unconditional write to `~/.pi/agent/claude-bridge-diag.log`.
8. The fence denies that global write, masking the original failure.

A test-only observer relocates diagnostics into OpenIntent's allowed workspace.
The revealed SDK error is `No conversation found with session ID`.
The same operator test passes when an alternate fixture selects the merge bridge.
The merge removes system records from conversation history before deciding whether a session needs importing.

The separate `empty_prompt` probe demonstrates another old-context incompatibility.
That probe is not the actual OpenIntent failure's trigger.

### Configuration and credentials

- The observed worker has a run-local working directory and temporary agent directory.
- The original default Claude profile remains `~/.pi/agent/claude`.
- Worker-local configuration does not automatically inherit the operator's global `provider.plan`.
- The operator's global bridge configuration declares `provider.plan: max`.
- A read-only bundled-CLI authentication check independently reports subscription type `max` and authentication method `claude.ai`.
- No account settings or Extra Usage settings change.
- Live rate-limit events report overage disabled and no overage use.
- Reports contain environment names, not credential values or authentication headers.

Relevant inherited names include `CLAUDE_CODE_OAUTH_TOKEN`, `HTTP_PROXY`, `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, and `PI_FENCE_*`.
The bridge preserves those values when creating Claude subprocesses.

### Evidence

OpenIntent evidence lives under its `packages/workflow/reports/bridge-verification/` directory:

- `personal.log`: original bridge fails after diagnostic relocation.
- `merge.log`: actual operator test passes with the merge.
- `diagnostics.jsonl`: preserved `session_verify_fail` record.
- `bridge-debug.log`: zero-record import, failed resume, and successful merge clean start.
- `personal-failures/`: retained synthetic worker transcripts, including the original `EPERM`.

The original operator command is `vitest run --config vitest.operator.config.ts test/operator/providers.test.ts -t claude-bridge`.
The command runs beneath `pi run --profile openintent --with-credentials`.
A temporary, approved read-only overlay grants the merge checkout during comparison.
The overlay is removed after checking that nobody changed it concurrently.

## Remediation

| Change | Implementation | Regression evidence |
| --- | --- | --- |
| Nonfatal diagnostics | `src/index.ts` preserves failed diagnostic/debug writes on stderr; inaccessible CLI debug files are omitted | `tests/unit-log-failure.mjs`, red then green |
| Active instruction updates | One shared prompt builder supplies startup options and continuation comparison; `QueryContext` stores the actual forwarded instructions | `tests/unit-active-query-restart.mjs`, authenticated instruction-only case |
| Recovery limits | Instruction-only changes consume the existing three-restart budget | Unit exhaustion regression; existing retirement/cancellation tests remain green |
| Standalone brain instructions | Brain `packages/core/src/models/adapters/pi.ts` requests `cacheRetention: none` only for `claude-bridge` | Brain adapter regression and actual adapter/executor live test |
| Isolated effort | Isolated requests use the shared model-aware effort resolver | SDK-options and compiled-Pi contract regressions, red then green |
| Native Claude Bash | `src/claude-config.ts` derives `CLAUDE_CODE_TMPDIR` from fenced `TMPDIR`, preserving explicit overrides | Native SDK A/B probe and `tests/int-native-bash-fence.mjs` |
| Test Git isolation | `tests/int-cache-git.sh` uses the assigned temporary directory and stops after failed initialization | `tests/unit-cache-git-fixture.mjs`; authenticated Git-transition test passes |
| Test shutdown cleanup | Shutdown integration always stops its Pi child, including assertion failures | Process-inspection proof remains blocked inside the fence |
| Cross-provider fixture | The skill fixture pins `openai-codex/gpt-5.6-luna` instead of an ambiguous bare model | Authenticated skill suite passes |
| Subagent source selection | Integration tests accept an explicit local subagent source without changing installed packages | Foreground/background locator and Fable tests pass with the installed fork |

The active-instruction comparison covers instructions actually forwarded to Claude.
The comparison does not broaden normal provider forwarding to every arbitrary system section.
Unforwarded metadata changes do not restart the query.
The existing sanitizer, direct extraction, catalog policy, and model IDs remain intact.

The standalone instruction omission predates this merge.
Original `3a83275:src/index.ts` already assembles selected project, skill, steering, correction, and captured-customization content rather than forwarding arbitrary system text.
The rebuilt Pi contract separately exposes the original bridge's invalid-resume defect.

The brain correction changes existing standalone inference code, not the planned daemon architecture.
The correction relies on the merge's isolated-request support.
The unchanged globally installed original bridge is not established as compatible with rebuilt Pi.

## Verification execution

Evidence root `E` means this checkout's `.test-output/live-verification/`.
JSON result files record each command, start time, finish time, exit status, and signal.
Raw generated fixtures contain no user documents.

The integration driver invokes `.mjs` files using `node --import tsx --test <file>` and shell files using `bash <file>`.
The outer launcher is `pi run --profile general --with-credentials`.
A test-local `pi` shim invokes the compiled Pi entry only when `PI_FENCE=1`.
That shim avoids starting a second sandbox inside the inherited fence.
No global executable or package registration changes.

The initial suite starts at `1673070`; diagnostic-only remediation lands before its last entries finish.
Later files record targeted reruns, not a claim that the entire final diff received another full live-suite run.

### Existing integration entrypoints

| Test under `tests/` | Latest result | Evidence under E |
| --- | --- | --- |
| `int-smoke.sh` | Pass | `int-smoke.sh.log` |
| `int-multi-turn.sh` | Pass | `int-multi-turn.sh.log` |
| `int-cache.sh` | Pass | `int-cache.sh.log` |
| `int-askclaude-upgrade.mjs` | Five pass after native temporary-directory correction | `ask-final/int-askclaude-upgrade.mjs.log` |
| `int-attachment-rebuild.mjs` | Pass | `int-attachment-rebuild.mjs.log` |
| `int-branch-summary.mjs` | Pass | `int-branch-summary.mjs.log` |
| `int-cc-contracts.mjs` | Pass; includes authenticated and local contract cases | `int-cc-contracts.mjs.log` |
| `int-compact-auto-threshold.mjs` | Pass | `int-compact-auto-threshold.mjs.log` |
| `int-compact-baseline.mjs` | Pass | `int-compact-baseline.mjs.log` |
| `int-compact-second-compact.mjs` | Pass | `int-compact-second-compact.mjs.log` |
| `int-compact-splitturn.mjs` | Pass | `int-compact-splitturn.mjs.log` |
| `int-config-isolation.mjs` | Pass | `int-config-isolation.mjs.log` |
| `int-cursor-after-tools.mjs` | Pass | `int-cursor-after-tools.mjs.log` |
| `int-image-session.mjs` | Pass | `int-image-session.mjs.log` |
| `int-opus-5.mjs` | Pass | `int-opus-5.mjs.log` |
| `int-parallel-tool-results.mjs` | Pass | `int-parallel-tool-results.mjs.log` |
| `int-served-window.mjs` | Pass | `int-served-window.mjs.log` |
| `int-session-compact.mjs` | Pass | `int-session-compact.mjs.log` |
| `int-session-new.mjs` | Pass | `int-session-new.mjs.log` |
| `int-session-rebuild.mjs` | Pass | `int-session-rebuild.mjs.log` |
| `int-session-resume.mjs` | Pass | `int-session-resume.mjs.log` |
| `int-shutdown-kills-cc.mjs` | Blocked: fenced `pgrep` cannot inspect processes | `int-shutdown-kills-cc.mjs.log` |
| `int-shutdown-reaps-parked-subagent.mjs` | Explicitly skipped by existing test | `int-shutdown-reaps-parked-subagent.mjs.log` |
| `int-skill-listing.mjs` | Pass after exact provider/model pin | `rerun/int-skill-listing.mjs.log` |
| `int-subagent-fable-plan.mjs` | Pass with actual local subagent fork | `rerun/int-subagent-fable-plan.mjs.log` |
| `int-subagent-rpiv-codebase-locator.mjs` | Pass with actual local subagent fork | `rerun/int-subagent-rpiv-codebase-locator.mjs.log` |
| `int-tool-message.mjs` | Nine pass after bounding the structural steering fixture | `rerun/int-tool-message.mjs.log` |
| `int-cache-git.sh` | Pass: 96% cache hit at commit boundary, no spurious rebuild | `cache-final/int-cache-git.sh.log` |

The shutdown test originally leaked its Pi child when process inspection failed before cleanup.
The operator terminated only that verified test-owned process; the test now cleans up on that failure path.
Termination behavior itself remains unproven by that failed run.

The original Git fixture failed initialization under the fence and accidentally searched its enclosing repository.
The fence denied Git lock writes; no repository commit or branch update occurred.
Concurrent remediation also invalidated that run's host-status comparison.
The repaired fixture passes without concurrent repository edits.

`tests/usage-test.sh` is an obsolete manual diagnostic, not counted as a passing integration test.
Its flat Keychain lookup and direct CLI/account-delta comparison need a scoped, credential-safe replacement before use.

### Focused evidence and coverage limits

| Behavior | Evidence | Status |
| --- | --- | --- |
| History replacement and omission during tool execution | `active-recovery-process-cases.log`; imported backend transcript checked | Authenticated pass |
| Tool addition, removal, schema change | Same log; completed fixture effect counted once | Authenticated pass |
| Queued skill follow-up and steer | Same log; effective tools inspected | Authenticated pass |
| Instruction-only change | Same log; unchanged history/tools, new system-only marker returned | Authenticated pass |
| Completed effects during recovery | Eight disposable case ledgers and resumed transcripts | No structural replay in tested cases |
| Retired callbacks and errors | `tests/unit-active-query-restart.mjs` | Deterministic unit proof; hostile late-event live scheduling remains unproven |
| Restart exhaustion and replacement startup failure | Same unit suite | Unit proof; authenticated fault-injection coverage remains incomplete |
| Parent/child operation | Local subagent integrations and unit isolation tests | Live foreground/background operation; exhaustive parallel restart interleavings remain unproven |
| Unattended recovery | SDK-created Pi sessions without client/UI | Authenticated pass for eight cases |
| Workflow retries and exactly-once effects | OpenIntent review | Not established by bridge replay prevention |
| Compaction and branch summaries | Existing live suites | Pass for covered workflows |
| Request-only carry-forward | Compiled-Pi mocked contract | No dedicated authenticated carry-forward assertion |
| Cross-provider handoff | Session-resume and repaired skill tests | Authenticated pass |
| Standalone brain instruction fidelity | `brain-instructions-live-red.log`, `brain-instructions-test-green.log` | Real adapter fails before correction and passes after correction |
| Native Bash and containment | `native-bash-temp.log`, `native-bash-fence-green.log` | Shell succeeds in assigned temp; protected canary remains unreadable |
| Effort mapping | Unit and compiled-Pi contract; existing Opus live suite | Mapping proved; backend reasoning compliance is not inferred |
| Context windows | Haiku reports 200K; Opus 5 reports 1M | Metadata only, not demonstrated near-limit acceptance |
| Model policy and account coverage | Catalog, effort, and context-policy unit tests; selected live model cases | Not every pinned model or account tier receives a fresh backend probe |
| Stalled-stream fallback | Existing deterministic recovery tests | No deliberately stalled authenticated stream in this session |
| Cost and cancellation totals | Stream reconciliation and review observations | Requires additional cumulative-resume and interrupted-attempt measurements |
| Final bridge offline gate | `npm run typecheck`; `npm run test:unit` | 514 tests pass; `final-unit.log` |
| Brain targeted gate | `tsc -p .`, targeted Biome check, adapter/executor tests | Typecheck/lint pass; 35 targeted tests pass |
| Brain full suite | `node node_modules/vitest/vitest.mjs run` | 757 pass, three fail, nine skip; `brain-full-tests.log` |
| Stock peer floor | Previous session's stock 0.86.1 verification | Not rerun after this session's uncommitted remediation |

The first expanded recovery fixture mixed several skill instructions in one session.
A later attempt reset the session manager without rebuilding the owning session.
Those failed fixture runs provide no additional compatibility proof.
The final harness isolates each scenario in its own process and passes all eight cases.

## Cross-repository impact and remaining work

| Owner | Finding or remaining contract | Disposition |
| --- | --- | --- |
| Bridge | Reused-session SDK `total_cost_usd` and `modelUsage` can include more than the current query's token counters | Investigate cumulative accounting with controlled captures before changing cost adoption |
| Bridge | Generic normal-provider system sections and interactive brain trust instructions may still be omitted | Standalone brain path fixed; broader interactive forwarding remains unproven |
| OpenIntent | `worker-factory.ts` rejects cancellation/nonsettlement before collecting transcript usage | Add a failing accounting regression; preserve partial usage or explicit unavailability |
| Brain | `piAdapter` marks bridge initialization before awaiting it | Reproduce concurrent first-call races before choosing initialization ownership |
| Brain | Lifecycle-free bridge loading cannot use deferred independent-registry registration | Test session/standalone load ordering and multiple runtimes |
| Brain | Temporary loader configuration differs from interactive configuration; deadline race drops late usage | Preserve these requirements for the planned daemon rather than silently rewriting its design |
| Brain | Two config tests compare implemented configuration with the newer architecture document | Resolve the implementation-versus-future-design test contract separately |
| Brain | Preflight test pins fork TypeBox `1.3.7`, while the shared fork declares `1.3.27` | Review compatibility rather than merely updating the expected string |
| OpenIntent Wave 7 | Runtime identity records package versions, not compiled artifact identity | Address same-version rebuild drift in recovery compatibility checks |
| OpenIntent Wave 8 | Forced termination of Pi may bypass cleanup of Claude descendants | Prove descendant teardown with an observer outside the sandbox, without weakening containment |
| OpenIntent Wave 9 | Pi retries, three bridge restarts, and SDK retries are different budgets | Verify compounded bounds, reset information, and failed-attempt accounting |
| OpenIntent Wave 10 | Headless parking has no autonomous wake service under the approved ruling | Preserve that explicit limitation in consumer acceptance |

OpenIntent's process-per-worker design avoids many current shared-process registry hazards.
That evidence does not justify pooling bridge-bearing workers later.
Bridge recovery preserves recorded tool results; it cannot guarantee exactly-once arbitrary shell or network effects after host death.

## Preservation and readiness

- PR #7 remains open; no project commit, push, merge, or issue-state operation runs.
- Original `personal`, shared Pi, and pi-fence tracked state remain unchanged.
- Existing OpenIntent and brain `.pi` work remains untouched.
- Both approved temporary read overlays return to their original absent state.
- OpenIntent's selected production bridge source remains unchanged.
- No global consumer is repointed to the merge checkout.
- The brain's future architecture and wave plans remain unchanged.

The targeted instruction fixes are implemented and authenticated.
The complete merge is not yet declared ready because the remaining accounting, lifecycle, and termination claims exceed current live evidence.
