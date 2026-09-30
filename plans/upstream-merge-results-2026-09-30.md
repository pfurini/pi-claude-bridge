# Upstream merge validation

Unfenced live validation passes on both the Pi and bridge paths.
The bridge passes typechecking and 588 unit tests.
The live battery passes 69 integration tests, all shell stages, and both log gates.
Fifteen additional recovery cases and resumed accounting pass against real Claude requests.
Paolo accepts the fenced checks as blocked by an unrelated credential-layout refusal.
Paolo authorizes the live-validation follow-up commit, publication of both repositories, and creation of the bridge PR.
PR merging requires separate approval.

## Operation and commits

| Item | Identity |
| --- | --- |
| Upstream source | `a78a2a5525e96318f8dba7f9fd32ce2191be0136` |
| Personal target base | `edf19ed6f3de6cc7f64fe77a3db4ccbfeba3e9d6` |
| Merge base | `07507489c0c54f7f978ab752eb9beb5cc0960f24` |
| Bridge merge commit | `68e2ef8f098f7f7995ebe612b7a812a5846e1465` |
| Bridge working branch | `merge/upstream-main-into-personal` |
| Pi companion commit | `6ca73ea7f282e1b15009ad56bbb441455dd7d35e` on `personal` |
| Pi companion base | `ab482a64a1b76983ec12413a66a5aa49babb4027` |
| Workflow evidence pin | `d64cc9c921a32ed25a2eaae6661165992787ee1a` |

The bridge merge has the confirmed personal and upstream commits as its two parents.
The temporary trial worktree is removed.
Bridge `main` and `personal` remain unchanged; the dedicated branch awaits integration.
OpenIntent and pi-fence receive no edits.

## Resolved intents

Preflight finds 11 conflicted files, 32 textual hunks, and two modify/delete conflicts.
Seven semantic groups cover 33 units; approved lockfile regeneration supplies the mechanical resolution.
The original hunk inventory and rulings are in `plans/upstream-merge-decisions-2026-09-30.md`.

- Keep reusable mirrors per live Pi session, including retained native children.
- Preserve projected-history checks, accounting epochs, cwd/profile isolation, and same-session writer separation.
- Scope shutdown, rewrite marks, retirement, and late callbacks instead of clearing every mirror.
- Route compaction rewrites through the fork's existing recovery path and import completed results without replaying tools.
- Request Sonnet 5.5 with `[1m]` and register 1M; retain all other fork model policies.
- Keep both prompt-capture files deleted and preserve direct extraction.
- Recognize both old and MCP-aware documentation templates in the sanitizer.
- Pin Agent SDK 0.3.284 and retain MCP/types pins and local Pi links.
- Keep both integration log gates and preserve logs across harness restarts.
- Separate upstream release history from current fork policy.
- Support only Paolo's Pi fork; remove stock CI and directory fallbacks.

## Pi companion and ownership boundary

Pi supplies local `sessionContext` with `ownerSessionId`, `cwd`, and `agentDir` through the existing SDK options wrapper.
The wrapper reads the current owner ID and overrides caller-supplied context.
Routing `sessionId` remains independent.
The bridge keeps auxiliary requests private and associates cleanup with the owning session.
Core resource cleanup reaches children that load no bridge extension.

The companion adds no registry, control protocol, runtime capability detection, dependency, or workflow-specific policy.
Pi retains child ownership; the workflow engine retains attempt, retry, question, and crash-recovery authority.
Unbound low-level calls must supply authoritative directory metadata rather than relying on process cwd.
Existing Pi processes need a restart to load the rebuilt core wrapper.

## Validation results

| Check | Result |
| --- | --- |
| Bridge `npm run typecheck` | Pass |
| Bridge `npm run test:unit` | 588 pass; zero failures or skips |
| Pi `npm run check` | Pass, including commit hooks and browser smoke |
| Pi coding-agent focused suites | 71 pass |
| Pi AI focused suites | 14 pass |
| Pi `npm run build:offline` | Pass |
| Shell smoke | 6 pass |
| Shell multi-turn | 5 pass |
| Shell cache | Pass |
| Final unfenced integration selection | 69 pass, zero failures, six default skips |
| Deadlock gate | Pass |
| Warning gate | 23 logs; zero WARNING/BUG lines |
| Live recovery cases | 15 executed and passed, verified from individual receipts |
| Live resumed accounting | Pass |
| Native Pi/bridge live probe | Pass |
| Sonnet 5.5 served-window probe | 1M reported for the suffixed request |
| Both repositories' diff checks | Pass |

Pi coding-agent suites:
- `test/sdk-stream-options.test.ts`
- `test/provider-session-context.test.ts`
- `test/default-stream-fn.test.ts`
- `test/model-runtime-auth-options.test.ts`
- `test/suite/agent-session-summary-auth.test.ts`

Pi AI suites:
- `test/provider-session-context.test.ts`
- `test/fetch-option.test.ts`

### Live Pi and provider proof

`diag/live-pi-session-context.mjs --run` uses the actual Pi native subagent service and actual Claude SDK.
The probe parks a parent's tool call while an extension-free child runs in another directory.
The child resumes its own Claude mirror, then shuts down without disturbing the parent.
The parent resumes its original mirror afterwards.
The probe verifies actual Claude session-file locations, nested MCP name delivery, and native shutdown with no remaining Claude descendants.
The probe does not establish fenced process-crash or orphan-reclamation behavior.

The separate Sonnet 5.5 probe requests `claude-sonnet-5-5[1m]` through SDK 0.3.284 / Claude Code 2.1.284.
The result reports context window 1000000 and maximum output 128000.
The local account tier and Extra Usage state remain unclassified; upstream evidence still supplies the separate Pro-condition comparison.

### Recovery receipts

The selected cases are:

- `replace`, `omit`, `remove`, `add`, `schema`
- `skill-followup`, `skill-steer`
- `instructions`, `custom-instructions`, `rules-instructions`, `addendum-instructions`, `forced-instructions`
- `checkpoint-chain`, `fault-cancel`, `fault-timeout`

Each ordinary case records exactly one effect; `checkpoint-chain` records four distinct effects.
Cancellation and timeout finish aborted, as required.
Resumed accounting compares each charged delta with the SDK's cumulative totals across three real queries.

## Live-test repairs and rejected evidence

The initial battery reports five failures.
Live investigation corrects the following test defects without changing production permissions or prompts:

- Update stale Claude Code 2.1.280 assertions to 2.1.284.
- Use opaque fixture values with explicit verbatim-return instructions.
- Invoke `pi-fence` explicitly instead of npm's local `pi` executable.
- Isolate unrelated steering scenarios with fresh sessions.
- Pin and assert the bridge model after each session replacement, using a temporary agent directory.
- Check each distinct returned duration rather than one incidental formatting phrase.
- Distinguish denied tool requests from executed actions using matched SDK/CLI tool-use IDs.

The permission checker rejects successful or unexplained forbidden requests.
Generic command failures are not accepted as permission denials.
Exact fixture-value and forbidden-file assertions remain in place.
AskClaude now supports the existing opt-in SDK-recording flag for this evidence.

The first recovery-wrapper report is invalid: its children exit without executing tests because they inherit `NODE_TEST_CONTEXT`.
That report is rejected, not counted as live coverage.
The runner now removes the inherited worker-protocol variable and requires each child's execution marker.
A focused unit test verifies real child-body execution.
The corrected rerun produces 15 separate evidence directories and passes every selected case.

## Blocked and skipped coverage

Paolo explicitly accepts fenced checks as blocked.
The corrected fence launcher refuses the unrelated Codex credential layout before launching the worker (`unsupported-layout`).
No manual credential repair, credential copying, configuration change, or fence bypass is performed.

- Two fenced abort/shutdown tests remain blocked and are excluded from the final unfenced selection.
- Native Bash fence containment remains unrun.
- `fault-startup` remains unrun because it needs disposable authenticated credentials; the real profile is deliberately prohibited.
- Two MCP suppression checks lack their required configured servers.
- The older parked-subagent shutdown placeholder remains deferred; the new native probe proves different lifecycle cases, not that placeholder's exact scenario.
- The default recovery and accounting skips are covered by the separate verified live run.

A plain `npm test` is therefore not claimed fully green in this environment.
The final unfenced selection, its exclusions, and both gate results are recorded explicitly.

## Evidence locations

All paths below are relative to this repository:

- `.test-output/live-merge-2026-09-30/final-unfenced.log`
- `.test-output/live-merge-2026-09-30/final-unfenced.J7D6b0/stages.tsv`
- `.test-output/live-merge-2026-09-30/final-unfenced.J7D6b0/integration-files.txt`
- `.test-output/live-merge-2026-09-30/final-unit.log`
- `.test-output/live-merge-2026-09-30/recovery-accounting-verified.log`
- `.test-output/live-merge-2026-09-30/verified-recovery-cases.json`
- `.test-output/live-accounting-OSyjtJ/result.json`
- `.test-output/live-merge-2026-09-30/pi-session-context-11PZip/results.json`
- `.test-output/live-merge-2026-09-30/sonnet-55.json`

The earlier failing and invalid runs remain beside these records for audit.
The evidence directories are gitignored; this report preserves their conclusions and exact locations.

## Publication

Push the Pi companion before expecting remote bridge CI to find `sessionContext` on `pfurini/pi@personal`.
Local validation precedes remote CI; the PR carries the current remote check status.
At this validation checkpoint, the bridge's dedicated branch is not merged into `personal`.
Paolo approves the follow-up commit and pushes, with the Pi prerequisite published first; merging the bridge PR remains gated.
