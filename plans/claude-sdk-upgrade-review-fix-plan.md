# Claude Agent SDK upgrade review fix plan

<!-- markdownlint-disable MD013 -->

## Objective

Resolve the confirmed pre-merge defects found during review of `feat/upgrade-sdk`, add regression coverage for each behavior, and leave the two rejected findings unchanged.

The implementation should preserve the intentional SDK-upgrade behavior already covered by tests:

- Terminal stream finalization remains an error rather than a successful `done` event when the SDK reports failure.
- Provider failures keep `stopReason: "error"`.
- AskClaude continues to return a tool-level error for non-success terminal results.
- SDK `is_error: true` remains authoritative even when `subtype` is `"success"`.
- None mode continues to block Task, Workflow, ReportFindings, SendMessage, and transitional delegation names.

## Scope and decisions

| Review item | Decision | Planned action |
| --- | --- | --- |
| 1. Rate-limit reset displays 1970 | Fix | Convert SDK epoch seconds to JavaScript milliseconds before constructing `Date`. |
| 2. Rate-limit utilization is 100 times too small | Fix | Convert the SDK fraction to a percentage. Use `Math.floor(value * 100)` to match bundled Claude Code. |
| 3. Invalid `askClaude.defaultMode` throws cryptically | Fix with fail-closed validation | Normalize invalid modes to `"read"` with a clear warning. Never restore the old `?? []` unrestricted fallback. Also prevent `allowFullMode: false` plus `defaultMode: "full"` from bypassing the full-mode lockout. |
| 4. Terminal metadata can trigger false retries | Fix | Keep `terminal_reason` and `session_id` as structured result fields and debug metadata, but remove them from user-facing `errorMessage`. |
| 5. AskClaude omits partial messages | Fix | Set `includePartialMessages: true`. Keep streamed text accumulation and tool-start tracking. Remove the currently unwired `onStreamUpdate` option rather than implying progressive answer rendering exists. |
| 6. Full mode lacks native Grep/Glob | Fix | Centralize mode policy and explicitly add Read, Grep, and Glob to full mode's allowed tools. |
| 7. None mode exposes Skill | Fix | Add Skill to none-mode disallowed tools and pass `skills: []` to the SDK for none mode. |
| 8. RPC shutdown can hang forever | Fix | Add bounded SIGTERM wait, SIGKILL escalation, a second bounded wait, and actionable diagnostics. |
| 9. Offline inventory probe loads project settings | Fix | Make AskClaude `settingSources` configurable with a production default, pass `[]` directly in the probe, and run the probe from a temporary workspace. |
| 10. Phase 6 scripts are outside npm globs | No change | They are deliberate authenticated/manual verification scripts, with prerequisites and commands documented in `docs/claude-sdk-upgrade-plan.md`. |
| 11. Fable availability is a broken parallel gate | No change | Current production callers combine centralized availability checks with runtime model resolution. The explicit-ID guard is not dead, and no bypass was found. |

## Non-goals

- Do not change the successful/error terminal semantics introduced by the SDK upgrade.
- Do not weaken none mode to preserve compatibility with Skill.
- Do not add Phase 6 scripts to `npm test` or make them ordinary CI tests.
- Do not refactor the Fable model policy in this change.
- Do not add progressive AskClaude answer rendering. Partial SDK messages are needed now for accurate text accumulation and tool state, but exposing partial answer text in Pi's tool UI should be a separate UX change.
- Do not auto-commit.

## Implementation sequence

### 1. Centralize AskClaude mode normalization and SDK policy

Files:

- `src/config.ts`
- `src/sdk-options.ts`
- `src/index.ts`
- `tests/unit-config.mjs`
- `tests/unit-sdk-options.mjs`
- `tests/unit-sdk-runtime-contract.mjs`

#### 1.1 Add fail-closed mode normalization

Add a small exported normalization function for effective AskClaude mode. It must accept runtime data rather than trusting the TypeScript `Config` interface.

Required behavior:

1. `undefined` remains unset so the existing defaulting location can choose `"read"`.
2. `"read"`, `"none"`, and `"full"` remain valid when allowed.
3. Any other value becomes `"read"` and produces one clear configuration warning.
4. `"full"` becomes `"read"` when `allowFullMode` is false, with a warning that the full-mode lockout overrode the configured default.
5. The warning must not print the full parsed configuration, because future configuration fields may contain sensitive values.

Normalize the merged effective `askClaude` configuration in `loadConfig()`. This is necessary because a global `defaultMode` and a project `allowFullMode` can combine into an invalid effective state.

Keep a defensive fallback in the policy resolver as well. If an invalid runtime mode somehow reaches SDK option construction, use the read policy rather than returning an empty disallow list or throwing a non-iterable `TypeError`.

Recommended warning shapes:

```text
claude-bridge: invalid askClaude.defaultMode "typo"; using "read"
claude-bridge: askClaude.defaultMode "full" is disabled by allowFullMode=false; using "read"
```

Do not restore this pattern:

```ts
MODE_DISALLOWED_TOOLS[mode] ?? []
```

An empty fallback silently grants the full native tool inventory and is not safe for a permission mode.

#### 1.2 Replace split policy assembly with one mode policy

Add a single `getAskClaudeToolPolicy(mode)` function in `src/sdk-options.ts`. It should return all mode-dependent SDK controls together:

```ts
interface AskClaudeToolPolicy {
  allowedTools: string[];
  disallowedTools: string[];
  skills?: Options["skills"];
}
```

Policy requirements:

- `read`
  - Allowed: `Read`, `Grep`, `Glob`.
  - Disallowed: current interactive/delayed tools plus all write/shell/worktree/cron/team mutation tools already listed.
  - Skills: leave SDK behavior unchanged.
- `full`
  - Allowed: `Read`, `Grep`, `Glob`.
  - Disallowed: current unsupported interactive/delayed tools.
  - Skills: leave SDK behavior unchanged.
- `none`
  - Allowed: none.
  - Disallowed: the current none list plus `Skill`.
  - Skills: `[]` so CLI-default skill discovery is disabled explicitly.

Read is included in full mode for symmetry and to make the intended base inventory explicit. The important native compatibility requirement is that Grep and Glob appear in `allowedTools`, as documented by Agent SDK `sdk.d.ts`.

Change `AskClaudeQueryOptionsInput` to take `mode` instead of independently supplied `allowedTools` and `disallowedTools`. Have `buildAskClaudeQueryOptions()` resolve and apply the policy. This prevents callers and tests from rebuilding only part of the policy and drifting again.

If retaining `getAskClaudeDisallowedTools()` for compatibility is necessary, make it a wrapper over the centralized policy. New production and test code should use the complete policy or the builder's `mode` input.

#### 1.3 Make AskClaude settings sources explicit and testable

Add this optional input to `AskClaudeQueryOptionsInput`:

```ts
settingSources?: SettingSource[]
```

Build options with:

```ts
settingSources: input.settingSources ?? ["user", "project"]
```

The nullish check is important because `[]` must remain an explicit isolation request.

Production `promptAndWait()` should omit this input and preserve the existing `['user', 'project']` behavior. Offline runtime probes should pass `settingSources: []` directly into the builder.

#### 1.4 Tests for mode normalization and policy

Add or update tests with these cases:

`tests/unit-config.mjs`:

- Invalid `defaultMode` normalizes to `"read"`.
- A clear warning is emitted once.
- `defaultMode: "full"` plus `allowFullMode: false` normalizes to `"read"`.
- Valid read, none, and allowed full values remain unchanged.
- Global/project merge is normalized after merging, not before.

`tests/unit-sdk-options.mjs`:

- Read policy contains Read/Grep/Glob and the existing read restrictions.
- Full policy contains Read/Grep/Glob.
- None policy disallows Skill and passes `skills: []`.
- AskClaude options default to `settingSources: ["user", "project"]`.
- Explicit `settingSources: []` survives unchanged.
- A forced invalid runtime mode resolves to the read policy rather than throwing or failing open.

`tests/unit-sdk-runtime-contract.mjs`:

- Native read inventory includes Read/Grep/Glob and excludes write/shell tools.
- Native full inventory includes Read/Grep/Glob plus its existing write/shell tools.
- Native none inventory excludes Skill and all previously blocked file, shell, web, and delegation tools.
- The inventory assertions use the centralized builder policy rather than local mode conditionals.

### 2. Enable AskClaude partial SDK messages without adding new UI semantics

Files:

- `src/sdk-options.ts`
- `src/index.ts`
- `tests/unit-sdk-options.mjs`
- `tests/unit-sdk-runtime-contract.mjs`

Add this invariant to `buildAskClaudeQueryOptions()`:

```ts
includePartialMessages: true
```

This causes the Agent SDK wrapper to pass `--include-partial-messages`, enabling the `stream_event` messages already handled by `reduceSdkMessage()` and `promptAndWait()`.

In `promptAndWait()`:

- Keep updating `responseText` from `messageState.streamedText` on each text delta.
- Keep marking `toolUseStarted` entries as `running`.
- Keep replacing them with completed tool input when the assistant message arrives.
- Remove `onStreamUpdate` from the local options type and remove its optional invocation because the only caller never supplies it.
- Keep the existing one-second action-summary updates in the AskClaude tool executor.

This deliberately avoids mixing partial answer text with the existing action-summary status updates. If progressive answer rendering is desired later, design one update payload that can show both answer text and current actions without each update overwriting the other.

Regression tests:

- Assert `options.includePartialMessages === true` in the AskClaude SDK-options unit test.
- Run the fake CLI through AskClaude-built options and assert at least one text delta is reduced (`textDeltaCount > 0`) for a streaming success fixture.
- For a tool-use fixture, assert the reduction path observes a tool start before the completed assistant tool block.

### 3. Correct rate-limit units and percentage formatting

Files:

- `src/sdk-messages.ts`
- `src/index.ts`
- `tests/unit-sdk-messages.mjs`

Use the SDK's `SDKRateLimitInfo` type rather than a local shape that permits an undocumented string reset value.

Add small pure helpers in `src/sdk-messages.ts` so the transformations can be tested without importing extension state:

```ts
export function rateLimitResetDate(resetsAt?: number): Date | undefined
export function rateLimitUtilizationPercent(utilization?: number): number
```

Required behavior:

- `rateLimitResetDate(1_700_000_000).getTime()` equals `1_700_000_000_000`.
- Missing or non-finite reset values return `undefined`.
- Utilization is interpreted as a 0..1 fraction.
- `0.85` becomes `85`.
- Use `Math.floor(utilization * 100)` to match bundled Claude Code exactly.
- Missing utilization becomes `0` for the existing warning message.

Update `processRateLimitMessage()` to use the helpers:

- Rejected status formats the converted `Date` with `toLocaleTimeString()` or uses `"unknown"`.
- Allowed-warning status prints the converted percentage.

Do not change rate-limit state or retry behavior in this step. This is display correction only.

Add unit tests for epoch conversion, absent values, 0%, 70%, 85%, and 100%.

### 4. Separate terminal diagnostics from retry-classified error text

Files:

- `src/sdk-messages.ts`
- `src/index.ts`
- `tests/unit-sdk-messages.mjs`
- optionally `tests/unit-sdk-runtime-contract.mjs`

Change `resultErrorText()` so it returns only the provider/model failure text. Remove the suffix containing `terminal_reason` and `session_id`.

Keep these fields on `SdkTerminalResult`:

- `terminalReason`
- `sessionId`

Add structured debug logging at the consumers where a terminal failure is handled:

- `processTerminalResultMessage()` for provider queries.
- `promptAndWait()` for AskClaude queries.
- `runIsolatedSummary()` when a summary terminal result fails.

The log should include subtype, `isError`, terminal reason, and a session identifier. Follow the existing logging convention for session IDs (a short prefix is sufficient unless full IDs are required for an existing diagnostic workflow).

User-facing `AssistantMessage.errorMessage`, thrown AskClaude errors, and summary errors must contain only the actionable provider text. Opaque identifiers must not be concatenated into strings consumed by pi-ai retry classification.

Regression test:

1. Parse a permanent result such as:

```ts
{
  type: "result",
  subtype: "success",
  is_error: true,
  result: "Credit balance is too low",
  terminal_reason: "api_error",
  session_id: "00000000-0504-4000-8000-000000000000"
}
```

1. Assert:

- `successful` is false.
- `errorText` is exactly `"Credit balance is too low"`.
- `terminalReason` and `sessionId` remain available as structured fields.
- `errorText` does not contain `504` or `session_id`.
- If `isRetryableAssistantError` is imported in the test, an assistant error built from this `errorText` is not retryable.

Do not alter the primary `errors`, `error`, or `is_error/result` precedence in `resultErrorText()`.

### 5. Make native inventory tests hermetic

Files:

- `tests/unit-sdk-runtime-contract.mjs`
- `src/sdk-options.ts`
- `tests/unit-sdk-options.mjs`

Refactor `captureBundledSystemInit()` so it does not construct an isolated base object and then spread production policy options over it.

Required structure:

1. Create a temporary Claude config directory.
2. Create a temporary workspace directory inside the temporary root.
3. Build AskClaude options once with:
   - `cwd` set to the temporary workspace.
   - `settingSources: []`.
   - `persistSession: false` through the existing isolated option.
   - the requested mode.
   - credential-free environment variables.
4. Pass those options directly to `query()`.
5. Close the query and remove the full temporary root in `finally`.

Do not use `process.cwd()` for the inventory query. The test should remain stable if the repository later gains `.claude/settings.json`, `.claude/settings.local.json`, CLAUDE.md policy, or a deny list.

Add a builder-level assertion that an empty settings-source list remains empty. This catches the original spread/default regression without needing a native process.

### 6. Bound RPC harness shutdown

Files:

- `tests/lib/rpc-harness.mjs`
- new `tests/unit-rpc-harness.mjs` (recommended)

Extend `createRpcHarness()` options with dedicated shutdown budgets, or define documented constants near the harness:

```js
shutdownGraceMs = 2_000
shutdownKillMs = 2_000
```

The exact defaults may be adjusted, but normal shutdown should stay quick and a wedged child must not block indefinitely.

Refactor shutdown into a testable helper if practical:

```js
async function terminateChild(child, closePromise, options)
```

Required `stop()` behavior:

1. Snapshot the current child, close promise, and log stream so a concurrent restart cannot redirect cleanup to a newer process.
2. If the child is running, send SIGTERM.
3. Race the close promise against the grace timeout.
4. If the grace timeout wins:
   - Append a diagnostic with PID, elapsed timeout, RPC log path, and debug log path.
   - Send SIGKILL.
   - Race close against the kill timeout.
5. If the child still has not closed, throw an error containing the PID and log paths.
6. End the captured log stream in `finally`.
7. Clear harness state only if it still refers to the captured child.
8. Clear all shutdown timers so they do not keep the Node test process alive.

Tests should use a Node child process rather than pi or Claude credentials:

- A normal child exits after SIGTERM.
- A child with a SIGTERM handler that deliberately stays alive is escalated to SIGKILL within the configured bound.
- Shutdown of an already-exited child resolves without sending another signal.
- Failure diagnostics include enough information to locate logs.
- Test cleanup sends SIGKILL in `finally` to prevent orphaned fixture processes if an assertion fails.

Keep integration/smoke execution outside restricted sandboxes because the normal RPC harness starts the installed pi binary and may use local settings/authentication.

### 7. Documentation and changelog

Files:

- `README.md`
- `CHANGELOG.md`
- optionally `docs/claude-sdk-upgrade-plan.md` if final verification evidence is recorded there

README updates:

- Clarify that `allowFullMode: false` also prevents `defaultMode: "full"`; the bridge falls back to read mode.
- State that an invalid configured default mode falls back to read mode with a warning.
- Keep none mode described as no file access. No special exception for Skill should remain after the fix.

Changelog updates are required because this is a significant production and test change. Add or combine entries in `## UNRELEASED` using the repository format. Prefer one production fix entry and one test entry, for example:

```md
- **Fix: harden AskClaude SDK policy and diagnostics** - validate configured modes fail-closed, restore partial events and native search tools, disable skills in none mode, correct rate-limit display units, and keep opaque terminal metadata out of retry-classified errors.
- **Tests: isolate SDK inventory and bound RPC shutdown** - prevent project settings from contaminating native tool-policy probes and escalate wedged test processes after bounded shutdown waits.
```

Use the repository's existing punctuation style when editing the actual changelog.

Do not add a changelog entry for this plan document itself.

## File-by-file change map

| File | Planned changes |
| --- | --- |
| `src/config.ts` | Normalize effective AskClaude default mode after global/project merge; fail closed to read; warn on invalid values and full-mode lockout conflicts. |
| `src/sdk-options.ts` | Centralize mode policy; add Skill/skills isolation for none; add Read/Grep/Glob for full; enable partial messages; support explicit settings sources; default invalid runtime policy to read. |
| `src/sdk-messages.ts` | Add rate-limit conversion helpers; stop appending terminal metadata to error text; retain structured terminal fields. |
| `src/index.ts` | Consume centralized mode policy through the builder; remove dead `onStreamUpdate`; use corrected rate-limit helpers; log structured terminal diagnostics. |
| `tests/unit-config.mjs` | Cover invalid mode and full-lockout normalization after config merge. |
| `tests/unit-sdk-options.mjs` | Cover complete read/full/none policies, partial messages, none skills, and `settingSources: []`. |
| `tests/unit-sdk-messages.mjs` | Cover rate-limit units/percentages and retry-safe terminal error text. |
| `tests/unit-sdk-runtime-contract.mjs` | Use a temporary workspace and no settings sources; assert native Grep/Glob and Skill behavior; verify partial stream events. |
| `tests/lib/rpc-harness.mjs` | Add bounded graceful shutdown and forced termination. |
| `tests/unit-rpc-harness.mjs` | Test normal exit, SIGKILL escalation, already-closed behavior, and diagnostics without pi/auth. |
| `README.md` | Document fail-closed default mode and full-mode lockout semantics. |
| `CHANGELOG.md` | Add combined UNRELEASED production/test entries. |

## Verification plan

Run checks in this order so failures stay attributable.

### Fast static checks

```sh
npm run typecheck
```

Run LSP diagnostics on all modified TypeScript and JavaScript files before broader tests.

### Focused unit and contract tests

```sh
node --import tsx --test \
  tests/unit-config.mjs \
  tests/unit-sdk-options.mjs \
  tests/unit-sdk-messages.mjs \
  tests/unit-sdk-runtime-contract.mjs \
  tests/unit-rpc-harness.mjs
```

Expected native inventory invariants:

- Read mode includes Read, Grep, and Glob.
- Full mode includes Read, Grep, and Glob, plus existing full tools.
- None mode excludes Skill, Read, Write, Grep, Glob, Bash, web tools, and delegation tools.

### Full offline unit suite

```sh
npm run test:unit
```

### Authenticated/integration suite

Run outside a restricted sandbox when the required local pi and Claude settings are available:

```sh
npm test
```

Do not run the Phase 6 cross-version scripts as part of ordinary verification. They require separate old/target SDK installations and authenticated profiles. Their existing documented workflow remains unchanged.

### Final diagnostics

- Run `lens_diagnostics` with `mode=all` and resolve every blocking error in edited files.
- Confirm `git diff --check` is clean.
- Review `git diff` for accidental changes to Phase 6 scripts or Fable model policy.
- Confirm no credentials, temporary profile paths, or `.test-output` artifacts were added.

## Acceptance criteria

The work is complete only when all of the following are true:

- A rejected rate-limit event renders a current reset time rather than a 1970 time.
- An allowed-warning utilization of `0.85` renders `85%`.
- Invalid configured AskClaude modes do not throw and do not grant unrestricted tools.
- `allowFullMode: false` prevents a configured full default from executing.
- Permanent terminal errors with numeric session-ID substrings are not made retryable by appended metadata.
- Terminal reason and session ID remain available in structured state and debug logs.
- AskClaude query options enable partial messages.
- AskClaude tool-start stream events can populate a running action state.
- Native full mode exposes Grep and Glob.
- Native none mode exposes no Skill tool and receives `skills: []`.
- Native inventory tests ignore all user/project settings and run from a temporary workspace.
- RPC harness shutdown always finishes or fails with diagnostics within a bounded interval.
- Typecheck, focused tests, and the full offline unit suite pass.
- Relevant authenticated integration tests pass outside the sandbox when credentials are available.
- `CHANGELOG.md` contains an appropriate combined UNRELEASED entry.
- Phase 6 test wiring and Fable policy remain unchanged.

## Risks and mitigations

### Allowed tools semantics

`allowedTools` is an auto-allow/addition mechanism, not a restrictive allowlist. Keep `disallowedTools` as the restriction mechanism and verify the actual native `system/init.tools` inventory after changes.

### Skill isolation

Adding only `Skill` to `disallowedTools` removes the tool, but `skills: []` is also required to disable CLI-default skill discovery explicitly. Test both the generated options and native inventory.

### Partial-message volume

Enabling partial messages increases SDK event volume. The reducer already handles these events, and the provider path already uses the same option. Keep updates in memory and avoid emitting every text delta through Pi's tool update callback in this change.

### Error diagnostic loss

Removing metadata from user-facing errors must not remove it from `SdkTerminalResult`. Add debug logging before throwing/emitting failures and keep tests for the structured fields.

### Shutdown test flakiness

Signal tests can race child startup. Wait for a fixture readiness message before invoking shutdown, use short but nonzero timeouts, and guarantee cleanup in `finally`.

### Configuration compatibility

Invalid configurations previously either failed open in old code or threw in the upgraded code. Falling back to read is an intentional fail-closed compatibility behavior. Emit a warning so the typo is visible.

## Fresh-session handoff prompt

```text
Implement docs/claude-sdk-upgrade-review-fix-plan.md on branch feat/upgrade-sdk.

Follow the plan exactly. Fix confirmed findings 1 through 9 plus the adjacent allowFullMode=false/defaultMode=full bypass. Do not change the intentional terminal-error semantics, Phase 6 manual test wiring, or the Fable availability/runtime policy. Centralize AskClaude mode policy, fail closed to read for invalid configuration, enable partial SDK messages, restore native Grep/Glob in full mode, disable Skill and SDK skills in none mode, correct rate-limit units, keep terminal metadata out of retry-classified error strings while logging it structurally, isolate the native inventory probe, and add bounded RPC SIGTERM/SIGKILL shutdown.

Add focused regression tests and update README.md and the UNRELEASED changelog. Run TypeScript diagnostics, npm run typecheck, the focused tests listed in the plan, and npm run test:unit. Run authenticated smoke/integration tests outside the sandbox only if the required local profiles are available. Do not run Phase 6 scripts as ordinary tests. Do not auto-commit.
```
