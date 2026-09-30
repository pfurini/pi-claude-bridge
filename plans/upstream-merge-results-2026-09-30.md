# Upstream merge validation checkpoint

The approved merge implementation passes typechecking and all 580 bridge unit tests.
The Pi companion passes 85 focused tests, the repository check, and the offline build.
The validation uses the rebuilt Pi fork and Agent SDK 0.3.284.
No authenticated model probe or integration battery runs.
Commits, pushes, and PR creation remain subject to Paolo's approval.

## Operation

| Item | Identity |
| --- | --- |
| Source | `upstream/main`, `a78a2a5525e96318f8dba7f9fd32ce2191be0136` |
| Target base | `personal`, `edf19ed6f3de6cc7f64fe77a3db4ccbfeba3e9d6` |
| Merge base | `07507489c0c54f7f978ab752eb9beb5cc0960f24` |
| Working branch | `merge/upstream-main-into-personal` in the original bridge checkout |
| Pi companion base | `personal`, `ab482a64a1b76983ec12413a66a5aa49babb4027` |
| Workflow evidence pin | `change/workflow-engine`, `d64cc9c921a32ed25a2eaae6661165992787ee1a` |

The trial worktree is removed.
The bridge's `main` and `personal` refs remain unchanged at this validation checkpoint.
The Pi companion remains uncommitted and unstaged at this checkpoint.
OpenIntent receives no edits.

## Resolved conflicts and intents

Preflight counts: 11 files, 32 textual hunks, and two modify/delete conflicts.
Seven semantic decision groups cover 33 conflict units.
Lockfile regeneration supplies the one dependent mechanical resolution.

- D1 retains mirrors per live Pi session, including resumable native children.
- D1 preserves accounting epochs, projected-history checks, cwd/profile isolation, and same-session writer separation.
- D1 scopes lifecycle cleanup and late callbacks instead of clearing every session's mirror.
- D2 routes attributed history rewrites through the fork's existing retirement and recovery path.
- D2 imports completed tool results and preserves productive restart checkpoints without replaying tools.
- D3 requests `claude-sonnet-5-5[1m]` and registers 1M from attributed upstream measurements.
- D4 keeps both prompt-capture files deleted and preserves direct prompt extraction.
- D5 pins Agent SDK 0.3.284 and retains the MCP/types pins and local Pi links.
- D6 keeps both integration log gates with fresh run directories and restart log retention.
- D7 separates upstream release history from current fork policy.

The sanitizer recognizes both old and MCP-aware Pi documentation lines.
MCP tests cover nested direct names, case preservation, transcript conversion, inventory-based resolution, and codemode.
The current API limit is 128 characters, including the bridge's 19-character prefix.
The bridge preserves names and does not shorten oversized names.

## Companion contract and trade-offs

D8 fixes a reproduced gap: extension-free native children inherit the provider but emit no bridge lifecycle registration.
Pi now supplies local `sessionContext` with `ownerSessionId`, `cwd`, and `agentDir` through its existing SDK request wrapper.
The wrapper reads the current owner ID and overrides caller-supplied context.
Request routing `sessionId` remains independent.
The bridge keeps auxiliary requests private and associates cleanup with the owning session.
Core resource cleanup reaches children that load no bridge extension.

The companion adds no registry, control protocol, runtime capability detection, dependency, or workflow-specific policy.
Pi retains child ownership; the workflow engine retains attempt, retry, question, and crash-recovery authority.
A direct low-level provider caller must supply authoritative metadata unless a matching live extension binding already exists.
An unbound call without directory metadata fails instead of using process cwd.
Stock Pi and older fork builds lacking the companion contract are not supported targets.

## Validation results

| Repository | Check | Result |
| --- | --- | --- |
| Bridge | `npm run typecheck` | Pass |
| Bridge | `npm run test:unit` | 580 pass; zero failures, cancellations, or skips |
| Bridge | `git diff --check` | Pass |
| Pi | `npm run check` | Pass |
| Pi coding-agent | Five focused suites | 71 pass |
| Pi AI | Two focused suites | 14 pass |
| Pi | `npm run build:offline` | Pass |
| Pi | `git diff --check` | Pass |

Pi coding-agent suites:
- `test/sdk-stream-options.test.ts`
- `test/provider-session-context.test.ts`
- `test/default-stream-fn.test.ts`
- `test/model-runtime-auth-options.test.ts`
- `test/suite/agent-session-summary-auth.test.ts`

Pi AI suites:
- `test/provider-session-context.test.ts`
- `test/fetch-option.test.ts`

The bridge's native-child regression runs against compiled Pi, including children without extensions and children with forced replacement prompts.
The SDK transport is mocked; native session construction, provider routing, and teardown remain real.
Offline Claude Code initialization checks verify the selected 2.1.284 binary and tool policies without credentials.

The original two sanitizer failures are fixed.
No unrelated test failure remains at this checkpoint.
Fixtures still exercise unknown-model warnings for unsupported catalog IDs; those warnings do not indicate failing checks.

## Finalization constraints

Land the Pi companion on `pfurini/pi@personal` before expecting remote bridge CI to find the new contract.
The bridge CI job builds that branch rather than local uncommitted Pi changes.
The stock-Pi CI job is removed; merge branches now trigger fork CI when pushed.
Remote CI has not run for these uncommitted changes.

Do not run `npm test`, authenticated context probes, or provider-funded integration tests without Paolo's approval.
Do not commit, push, create a PR, or merge a PR without Paolo's approval.
Approved decisions and evidence remain in:
- `plans/upstream-merge-decisions-2026-09-30.md`
- `plans/upstream-merge-session-compatibility-2026-09-30.md`
- `plans/pi-provider-session-context-2026-09-30.md`

## Local finalization

Paolo authorizes local commits after reviewing this checkpoint.
Pi companion commit: `6ca73ea7f` (`feat(ai): expose local provider session context`).
Pi's pre-commit checks and browser smoke checks pass without formatting changes.
The companion is not pushed; remote bridge CI still awaits that publication.
