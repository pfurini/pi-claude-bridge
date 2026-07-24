# Claude Code Configuration Isolation Checkpoint

**Status (2026-07-24):** Design and documentation only. Phase 9 revalidated this proposal against Claude Agent SDK `0.3.218` and bundled Claude Code `2.1.218`; no configuration-isolation behavior has been implemented. Reviewed against `personal@fbb9e9f` on 2026-07-24: the mechanism and all cited call sites still hold, the profile path moved under `~/.pi/agent/`, and `provider.claudeConfigDir` was promoted into minimal scope.

## Decision

Isolate the Claude Code user profile used by `pi-claude-bridge` under:

```text
~/.pi/agent/claude
```

The profile lives under `~/.pi/agent/` rather than at the `~/.pi/` root because the extension's other user-level state already lives there: `~/.pi/agent/claude-bridge.json` (global config, `src/config.ts`) and `~/.pi/agent/claude-bridge.log` (default debug log, `src/index.ts:37`). The `~/.pi/` root is Pi's own namespace (`agent/`, `dashboard/`, `knowledge/`), and an extension should not claim a sibling entry there.

Implement this by passing the documented environment variable below to every Claude Code subprocess started by the extension:

```text
CLAUDE_CONFIG_DIR=/absolute/path/to/$HOME/.pi/agent/claude
```

Do not mutate `process.env` globally. Compute one absolute configuration-directory path in the extension and use it consistently for:

1. Every Agent SDK `query()` subprocess.
2. Every `cc-session-io` create, delete, and diagnostic operation. The extension never calls `openSession`; only tests do.
3. Provider turns, AskClaude calls, continuations, and isolated compaction summaries.

This is Option 1: isolate Claude's user-level profile while preserving the extension's current project-settings behavior.

## Goal

When Claude Code is invoked through Pi, it should not read from or write extension-owned state to the normal interactive Claude Code directory at `~/.claude`.

The isolated profile should contain user-level Claude state such as:

```text
~/.pi/agent/claude/
├── settings.json
├── .claude.json
├── projects/
├── plugins/
├── skills/
└── debug/
```

The exact contents are owned by Claude Code and may evolve. The extension should only select the profile root and avoid making assumptions about every child path.

## Non-goals

Option 1 does not provide a fully hermetic Claude Code process:

- Repository `.claude/settings.json` and `.claude/settings.local.json` may still load according to `settingSources`.
- Organization-managed settings still apply.
- On macOS, OAuth credentials remain in the system Keychain and are not isolated by `CLAUDE_CONFIG_DIR`.
- This does not isolate the Claude account. It isolates user-level files, settings, session history, plugins, and similar state.
- Existing sessions under `~/.claude/projects/` are not migrated automatically.

A stricter mode using `settingSources: ["user"]` or `settingSources: []` can be considered later as a separate feature.

## Authoritative Research Findings

Initial research was performed on 2026-07-22. The installed target versions and relevant offline contracts were revalidated on 2026-07-23.

### `CLAUDE_CONFIG_DIR` is the supported control

Anthropic documents `CLAUDE_CONFIG_DIR` as the environment variable that overrides Claude Code's configuration directory, whose default is `~/.claude`.

The documentation states that settings, session history, and plugins are stored under this path. Credentials are also stored there on Linux and Windows. On macOS, credentials remain in the system Keychain.

Sources:

- [Claude Code environment variables](https://code.claude.com/docs/en/env-vars)
- [Claude Code settings](https://code.claude.com/docs/en/settings)
- [Agent SDK TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript)

`CLAUDE_CONFIG_DIR` is not a `settings.json` key. It must be present in the environment before Claude Code starts and before it attempts to locate `settings.json`.

### The value replaces `~/.claude`

For the intended target:

```text
CLAUDE_CONFIG_DIR=$HOME/.pi/agent/claude
```

the user settings file is:

```text
$HOME/.pi/agent/claude/settings.json
```

It is not:

```text
$HOME/.pi/agent/claude/.claude/settings.json
```

This behavior was revalidated directly against the versions installed for the upgrade candidate:

- `@anthropic-ai/claude-agent-sdk`: `0.3.218` (exact-pinned).
- Bundled and selected Claude Code: `2.1.218`.

The offline target-SDK test used `resolveSettings()` with `settingSources: ["user"]`. With distinct values in `<config-dir>/settings.json` and `<config-dir>/.claude/settings.json`, the SDK loaded `<config-dir>/settings.json`. This is a statement about the installed candidate, not an assumption based on another SDK release.

### The SDK passes `env` to Claude Code

The Agent SDK's `query()` option `env` is the environment for the spawned Claude Code process. The SDK documentation warns that supplying `env` replaces the subprocess environment, so callers should preserve inherited variables:

```typescript
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: claudeConfigDir,
};
```

The bridge already follows the inheritance pattern for other variables, so adding `CLAUDE_CONFIG_DIR` fits the existing design.

`env` is the only supported lever. The installed SDK exposes no typed configuration-directory option: `sdk.d.ts` mentions `CLAUDE_CONFIG_DIR` only in prose, and the internal `resumeConfigDir` seen in the bundle is reachable only through the `sessionStore` code path, which this extension does not use. The bundle also confirms the replacement semantics directly — the child environment is built as `env ? {...env} : {...process.env}`, with no per-key merge.

### Filesystem setting sources remain independent

`CLAUDE_CONFIG_DIR` relocates the user source. It does not change which sources are enabled.

The target SDK's offline configuration-source contract directly confirmed:

- `settingSources: ["user"]` loaded only the relocated user settings.
- `settingSources: ["user", "project"]` loaded relocated user and project settings.
- `settingSources: []` loaded neither source.

The `local` source was not separately remeasured in Phase 9. Option 1 preserves the bridge's configured `settingSources` behavior rather than expanding the isolation claim to an untested source combination.

Managed policy is outside this control and may still apply.

### Known upstream caveat

An open Claude Code issue reports inconsistent custom-directory behavior for some user skill discovery in Claude Code `2.1.122`:

- [anthropics/claude-code#55065](https://github.com/anthropics/claude-code/issues/55065)

The settings path was verified successfully against this project's bundled Claude Code `2.1.218`. The issue is still relevant when claiming isolation of every customization surface, so tests should cover the behaviors this extension relies on rather than assuming all Claude Code internals follow the same path forever.

## Current Codebase Behavior

The extension currently inherits the Pi process environment for Claude Code subprocesses. Unless Pi itself was launched with `CLAUDE_CONFIG_DIR`, Claude Code therefore uses `~/.claude`.

### Agent SDK spawn paths

There are three independent spawn paths that must receive the isolated environment, across four `query()` call sites. The fourth site is the continuation query, which is covered by the main provider path (see below).

The permalinks in this section point at `c4ebc22`, the Phase 9 starting commit. `src/index.ts`, `src/config.ts`, and `src/sdk-options.ts` have all changed since then, so the quoted line ranges run roughly ten lines ahead of current `personal` HEAD. Every referenced construct still exists; only the offsets moved.

#### 1. Isolated compaction summaries

`src/index.ts`, function `runIsolatedSummary`:

```typescript
buildIsolatedSummaryQueryOptions({
  // existing options
  baseEnv: process.env,
});
```

This path already uses:

```typescript
settingSources: []
persistSession: false
```

It should still receive `CLAUDE_CONFIG_DIR` for consistency and to prevent future Claude Code behavior from falling back to `~/.claude`.

Stable source reference:

- [`src/index.ts:297-378`](https://github.com/elidickinson/pi-claude-bridge/blob/c4ebc22f25838dc0b5a9ba2721c44ab513e14727/src/index.ts#L297-L378)

#### 2. Main provider

`src/index.ts`, function `streamClaudeAgentSdk`:

```typescript
buildProviderQueryOptions({
  // existing options
  baseEnv: process.env,
});
```

Continuation queries clone the same `queryOptions` — `const contOptions = { ...queryOptions, resume: resumeId, ...makeCliDebugOptions("continuation") }` — so adding the isolated environment in `buildProviderQueryOptions` also covers continuations. Neither overriding key touches `env`.

Stable source reference:

- [`src/index.ts:1063-1397`](https://github.com/elidickinson/pi-claude-bridge/blob/c4ebc22f25838dc0b5a9ba2721c44ab513e14727/src/index.ts#L1063-L1397)

#### 3. AskClaude

`src/index.ts`, function `promptAndWait`:

```typescript
buildAskClaudeQueryOptions({
  // existing options
  baseEnv: process.env,
});
```

Stable source reference:

- [`src/index.ts:1401-1555`](https://github.com/elidickinson/pi-claude-bridge/blob/c4ebc22f25838dc0b5a9ba2721c44ab513e14727/src/index.ts#L1401-L1555)

### Current setting-source behavior

The current behavior should remain unchanged for Option 1:

- Main provider with `appendSystemPrompt: true` (the default): `settingSources` is omitted, so Claude Code loads user, project, and local sources.
- Main provider with `appendSystemPrompt: false`: defaults to `settingSources: ["user", "project"]`, unless configured otherwise.
- AskClaude: explicitly uses `settingSources: ["user", "project"]`.
- Isolated compaction summaries: explicitly use `settingSources: []`.

After Option 1, `user` resolves under `~/.pi/agent/claude`, while project and local sources retain their normal repository paths.

### Session-file coordination

This is the critical integration constraint.

The bridge seeds and rewrites Claude Code session JSONL files itself using `cc-session-io`. The current calls pass:

```typescript
claudeDir: process.env.CLAUDE_CONFIG_DIR
```

and:

```typescript
deleteSession(sessionId, cwd, process.env.CLAUDE_CONFIG_DIR)
```

If only the child environment is changed, the two sides diverge:

- The bridge writes seeded sessions under `~/.claude/projects/`.
- Claude Code searches under `~/.pi/agent/claude/projects/`.
- `--resume` cannot find the seeded session.
- Context synchronization and provider switching break.

The same resolved `claudeConfigDir` must therefore be passed explicitly to every `cc-session-io` operation. There are exactly three call sites that read `process.env.CLAUDE_CONFIG_DIR` today, all in `src/index.ts`: the rebuild-path `deleteSession`, the rebuild-path `createSession`, and the ephemeral-session cleanup after a synthetic query. `cc-session-io@0.3.1` already accepts the directory on both APIs (`deleteSession(sessionId, projectPath, claudeDir?)` and `CreateSessionOptions.claudeDir`), so no upstream change is needed.

Relevant bridge source:

- [`src/index.ts:447-548`](https://github.com/elidickinson/pi-claude-bridge/blob/c4ebc22f25838dc0b5a9ba2721c44ab513e14727/src/index.ts#L447-L548)

Relevant `cc-session-io` source:

- [`getClaudeDir`](https://github.com/elidickinson/cc-session-io/blob/90bb181871e64fd00f30161ad7f0fde06e2decd4/src/paths.ts#L9-L11)
- [`getSessionPath`](https://github.com/elidickinson/cc-session-io/blob/90bb181871e64fd00f30161ad7f0fde06e2decd4/src/paths.ts#L49-L56)
- [`deleteSession` and `createSession`](https://github.com/elidickinson/cc-session-io/blob/90bb181871e64fd00f30161ad7f0fde06e2decd4/src/session.ts#L307-L335)

### Diagnostics must report the effective path

Current diagnostics print `process.env.CLAUDE_CONFIG_DIR`. Option 1 deliberately avoids mutating `process.env`, so those messages would incorrectly report the variable as unset.

Update diagnostics to report the resolved extension path instead:

```text
claudeConfigDir=/Users/<user>/.pi/agent/claude
```

This affects:

- Session verification warnings.
- `diagDump("session_verify_fail", ...)`.
- `debugSessionPaths()`.
- Any future support bundle or status command.

## Option 1 Implementation Design

### Centralize path resolution

Compute the path once as an absolute path:

```typescript
import { homedir } from "node:os";
import { join } from "node:path";

const claudeConfigDir = join(homedir(), ".pi", "agent", "claude");
```

Do not put a literal `~` in the environment. Shell tilde expansion does not occur when Node sets an environment-variable value programmatically.

A small helper should construct each child environment:

```typescript
function claudeChildEnv(extra: Record<string, string> = {}) {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    ...extra,
  };
}
```

The merge order should make the extension's path authoritative. An inherited `CLAUDE_CONFIG_DIR` should not silently defeat the isolation feature.

### Thread the path explicitly

Preferred shape:

```typescript
syncSharedSession(
  messages,
  cwd,
  customToolNameToSdk,
  modelId,
  claudeConfigDir,
);
```

Inside the session code:

```typescript
deleteSession(previousSessionId, cwd, claudeConfigDir);

const session = createSession({
  projectPath: cwd,
  claudeDir: claudeConfigDir,
  // existing fields
});
```

Ephemeral session cleanup after synthetic queries must use the same path.

Avoid reading `process.env.CLAUDE_CONFIG_DIR` inside session synchronization after this change. The extension's resolved path should be the source of truth.

### Directory creation

The extension should not need to pre-create the complete directory tree:

- Claude Code creates its own profile files as needed.
- `cc-session-io` creates session parent directories when saving.

Creating `~/.pi/agent/claude` proactively is acceptable only if needed for a clear initialization or migration workflow. It is not required for the minimal implementation.

### Stop rewriting paths in `src/agents-md.ts`

`sanitizeAgentsContent` rewrites AGENTS.md content before it is appended to the system prompt, using four ordered substitutions:

1. `~/.pi` to `~/.claude`
2. `.pi/` (after whitespace or a quote) to `.claude/`
3. `.pi` (word-bounded) to `.claude`
4. `pi` (word-bounded, case-insensitive) to `environment`

Under isolation, rule 1 points the subprocess at the exact directory this feature exists to avoid — and `~/.claude` is not where the isolated profile lives either, so the rewritten path is wrong in both directions.

The rewrite is already unsound today. "skills live in `~/.pi/skills`" becomes "`~/.claude/skills`", a directory that exists in neither layout. It never produced a resolvable path; isolation only makes that visible.

**Do not fix rule 1 alone.** The rules interact. With rule 1 removed, `~/.pi/agent/AGENTS.md` falls through rules 2 and 3 (no whitespace boundary before `.pi/`, no word boundary before `.`) and is then caught by rule 4, which matches the bare `pi` between `.` and `/`. The output becomes `~/.environment/agent/AGENTS.md` — neither the real path nor `~/.claude`. Verified against the current implementation. A partial fix is silently undone by the rule it leaves in place.

Minimal correct change: stop calling `sanitizeAgentsContent` and forward the raw AGENTS.md content under the existing `# CLAUDE.md` header. Real Pi paths then survive intact and Claude can read them through the bridged `read` tool. This removes mangling rather than adding behavior, so the risk is contained to prompt text. Do not retarget any substitution at `claudeConfigDir` — that would fabricate paths under a profile directory the extension owns and Pi does not populate.

Scope note: this is a prompt-text correction, not a filesystem-isolation concern, so it does not gate the acceptance criteria below. If the team prefers to keep the isolation change free of prompt-output changes, defer the whole function to the follow-on replacement described under Critical Evaluation item 5 — but defer all four rules together, never a subset. What remains for the follow-on either way is the larger problem: `extractAgentsAppend` forwards only the nearest `AGENTS.md` rather than Pi's resolved rule hierarchy.

### Configuration policy

The minimum implementation makes `~/.pi/agent/claude` the extension default without depending on Pi's inherited environment, and ships one configuration field alongside it:

```json
{
  "provider": {
    "claudeConfigDir": "/custom/absolute/path"
  }
}
```

Precedence:

1. Explicit `provider.claudeConfigDir`.
2. Extension default `~/.pi/agent/claude`.

Do not use inherited `process.env.CLAUDE_CONFIG_DIR` as an implicit middle layer. The feature's promise is isolation from the user's normal Claude installation, and an inherited value would silently defeat it.

Validation: the value must be a non-empty absolute path. A relative or non-string value should log a warning through the existing `loadConfig` warning pattern in `src/config.ts` and fall back to the default rather than throwing, so a bad config never prevents the extension from starting. The field slots into the existing `Config["provider"]` interface next to `pathToClaudeCodeExecutable`, and inherits `loadConfig`'s existing global-then-project merge.

#### Why this field is in minimal scope, not deferred

Rejecting inherited `CLAUDE_CONFIG_DIR` removes the only mechanism the repository currently has for pointing the extension at a non-default profile. `tests/phase6-restart-rollback.sh:52,69` depends on exactly that: it launches the real extension twice under `CLAUDE_CONFIG_DIR="$TARGET_PROFILE"` and `CLAUDE_CONFIG_DIR="$OLD_PROFILE"` to prove the downgrade path, and guards explicitly against `$HOME/.claude`. Without a replacement lever, both runs would silently share `~/.pi/agent/claude` and the harness would still pass while proving nothing.

This is not a CI break — `npm test` runs `int-*`, not `phase6-*` — but the harness must migrate to `provider.claudeConfigDir` in the same change that lands the precedence rule. Shipping the precedence rule without the field would leave the rollback harness quietly non-isolating.

The migration must target the **project** config path. `loadConfig` reads global config from a hardcoded `~/.pi/agent/claude-bridge.json` and project config from `join(cwd, CONFIG_DIR_NAME, "claude-bridge.json")`; it never consults `PI_CODING_AGENT_DIR`. Since the global path resolves inside the real `$HOME` — precisely what the harness's `$HOME/.claude` guard exists to prevent — the only isolated, readable target is `$WORKSPACE/<CONFIG_DIR_NAME>/claude-bridge.json`, written between the two launches while the bridge runs with `cwd=$WORKSPACE`.

## Migration and Authentication Effects

### Existing sessions

Existing bridge sessions under `~/.claude/projects/` become invisible to the extension after the switch. Pi conversation history can still seed a new Claude session through the bridge's rebuild path, so this should not lose the Pi transcript. It does reset Claude-side session continuity and prompt-cache state at the migration boundary.

Automatic copying of old Claude session files is not recommended for the first implementation because it would also copy unrelated interactive Claude history and undermine isolation.

### Existing settings

Do not automatically copy `~/.claude/settings.json` into the isolated profile. The purpose is to start with extension-specific settings rather than inherit interactive Claude customizations.

Users who want selected settings can add them deliberately to:

```text
~/.pi/agent/claude/settings.json
```

### Authentication

- macOS: Claude Code credentials remain in Keychain, so changing the directory should normally continue using the same logged-in account.
- Linux and Windows: credentials live under the configuration directory. The new profile may require separate authentication provisioning before non-interactive Agent SDK calls succeed.

An upstream issue documents the macOS Keychain limitation for users expecting multiple `CLAUDE_CONFIG_DIR` values to isolate OAuth accounts:

- [anthropics/claude-code#20553](https://github.com/anthropics/claude-code/issues/20553)

## Test Plan

### Unit tests

Add focused tests for a pure path/environment helper:

1. The default resolves to the absolute `$HOME/.pi/agent/claude` path.
2. The child environment preserves inherited variables such as `PATH`.
3. The child environment overrides an inherited `CLAUDE_CONFIG_DIR`.
4. Existing extra variables remain present.

Add configuration-precedence tests alongside them, extending `tests/unit-config.mjs`:

5. An absolute `provider.claudeConfigDir` wins over the default.
6. A project `claude-bridge.json` overrides a global one, matching `loadConfig`'s existing merge.
7. A relative or non-string value warns and falls back to the default.
8. An inherited `CLAUDE_CONFIG_DIR` loses to both the configured value and the default.

### Session synchronization tests

Update or extend `tests/unit-sync-shared-session.mjs` to assert that seeded JSONL files are created beneath the explicit isolated directory.

Cover:

- First session creation.
- Rebuild with a preserved session ID.
- Post-abort rotation.
- Ephemeral synthetic-session cleanup.

### Agent SDK settings test

Most of this already exists. `tests/unit-sdk-storage-contract.mjs` uses `resolveSettings()` against the installed SDK with temporary directories and already covers:

1. `<config-dir>/settings.json` is the user source, asserted on both the effective value and the reported source path.
2. Project settings merge under `settingSources: ["user", "project"]`, and neither source loads under `settingSources: []`.

The gap is the negative case. The Phase 9 notes above claim a comparison against a competing `<config-dir>/.claude/settings.json`, but no committed test writes that file. Add it to the existing suite: write distinct values to `<config-dir>/settings.json` and `<config-dir>/.claude/settings.json`, then assert the resolved user source is the former. Without it, the "the value replaces `~/.claude`" claim rests on an unrecorded manual check.

These tests target the installed SDK version rather than assuming the latest documentation matches the bundled binary.

### Integration tests

The strongest integration assertion is that the bridge and Claude Code agree on the session path:

1. Start Pi with a temporary home or explicit temporary isolated profile.
2. Trigger a provider turn that requires session seeding.
3. Assert the debug log reports the expected isolated `jsonlPath`.
4. Resume the same session and verify context continuity.
5. Assert no session JSONL was written to the test user's default `~/.claude/projects/`.

Smoke and session-resume tests may require running outside a sandbox because they use local Pi and Claude authentication.

### Rollback harness migration

`tests/phase6-restart-rollback.sh` must move off inherited `CLAUDE_CONFIG_DIR` in the same change, since the precedence rule makes those two exports inert. Replace them by writing `{"provider":{"claudeConfigDir":"$TARGET_PROFILE"}}` and then `{"provider":{"claudeConfigDir":"$OLD_PROFILE"}}` into `$WORKSPACE/<CONFIG_DIR_NAME>/claude-bridge.json` between the two launches — the project config path, not the global one, which would write into the real `$HOME`. Keep the existing guard that rejects `$HOME/.claude` and requires the two profiles to differ; it is the assertion that makes the harness meaningful.

Note that the old-bridge half of that test runs a pre-upgrade checkout that still honors inherited `CLAUDE_CONFIG_DIR` and knows nothing about `provider.claudeConfigDir`. Set both the environment variable and the config file for each launch so either bridge version lands on the intended profile.

## Acceptance Criteria

Option 1 is complete when:

- Every Claude Code subprocess started by the extension receives the same absolute `CLAUDE_CONFIG_DIR` under `~/.pi/agent/claude`.
- Every bridge-managed session operation uses that same path explicitly.
- `provider.claudeConfigDir` overrides the default, validates as an absolute path, and warns-and-falls-back otherwise.
- An inherited `CLAUDE_CONFIG_DIR` never changes the effective path.
- `tests/phase6-restart-rollback.sh` selects its old and target profiles through `provider.claudeConfigDir` and still refuses to run against `$HOME/.claude`.
- Provider resume, provider switching, AskClaude shared sessions, compaction, and abort recovery continue to work.
- User settings load from `~/.pi/agent/claude/settings.json`.
- The normal `~/.claude/settings.json` is not loaded as the user source by extension-spawned Claude Code.
- Diagnostics display the effective isolated path.
- Unit tests and typechecking pass against the baseline recorded below, apart from any separately documented pre-existing failure.
- A significant implementation change adds an entry under `## UNRELEASED` in `CHANGELOG.md`.

## Follow-on Features for Brainstorming

These are intentionally outside the first implementation but are natural extensions:

1. **Named profiles:** Support profile names such as `default`, `work`, or `sandbox`, each rooted under `~/.pi/agent/claude-profiles/<name>`.
2. **Hermetic mode:** Set `settingSources: []` and supply only programmatic settings.
3. **User-only mode:** Use `settingSources: ["user"]` to preserve isolated user preferences while rejecting repository Claude configuration.
4. **Status command:** Show the effective profile path, setting sources, session directory, and authentication mode.
5. **Initialization command:** Create an empty isolated `settings.json` and explain platform-specific authentication behavior.
6. **Selective migration:** Offer an explicit, user-approved import of selected settings without copying sessions, plugins, or credentials.
7. **Per-project profiles:** Derive a profile directory from the project root while keeping shared authentication behavior explicit.
8. **Cleanup policy:** Manage accumulated extension-owned Claude sessions under `~/.pi/agent/claude/projects/`.
9. **Regression probe:** Add a diagnostic using `resolveSettings()` to detect upstream changes in `CLAUDE_CONFIG_DIR` semantics.

The former "configurable profile path" item moved into minimal scope; see Configuration policy above.

## Phase 9 Repository Checkpoint

At the start of the Phase 9 documentation work:

- Branch: `feat/upgrade-sdk`.
- Starting commit: `c4ebc22f25838dc0b5a9ba2721c44ab513e14727`.
- Installed Agent SDK: exact `0.3.218`; bundled Claude Code: `2.1.218`.
- The only initial working-tree entry was this untracked document.
- No configuration-isolation implementation had been made.
- Unit baseline at that commit: 126 passing tests across 37 suites.
- Typecheck baseline: passing.
- This document is now Phase 9 documentation scope. The design remains a separate future implementation and does not create a changelog entry by itself.

### 2026-07-24 Review Checkpoint

Re-measured on branch `personal` at `fbb9e9f`:

- Unit baseline: **141 passing tests across 39 suites**, zero failures.
- Typecheck: passing.
- Installed Agent SDK: exact `0.3.218`; `cc-session-io`: `0.3.1`.
- Still no configuration-isolation implementation. All three `process.env.CLAUDE_CONFIG_DIR` reads in the session path and all three diagnostic reads remain as described.

Use 141/39 as the acceptance-criteria baseline, not the Phase 9 figure.

## Critical Evaluation and Design Directions

### Recommendation

Keep Option 1 as the foundation, then build a small **profile control plane plus Pi compatibility adapter**. Do not try to make the isolated directory itself a generated mirror of Pi.

Separate three concerns:

1. **Persistent Claude profile:** `~/.pi/agent/claude`, owned by Claude Code.
2. **Bridge runtime policy:** Child environment, setting sources, inline settings, tools, and system prompt.
3. **Dynamic Pi compatibility:** Pi rules, skills, tools, trust state, and subagents.

This preserves the requirement that only extension-spawned children receive `CLAUDE_CONFIG_DIR`, without changing Pi's global environment.

### Critical Evaluation of Option 1

The path and session coordination design is correct. The missing risks are mostly above that layer.

#### 1. The extension already mutates Pi's global environment

The extension's default export currently sets, as its first statement:

```typescript
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
```

A strict interpretation of the isolation requirement should move this into the child environment helper too. Otherwise the new feature avoids one global mutation while retaining another.

#### 2. Project Claude configuration is a larger security boundary than documented

The Agent SDK runs Claude Code non-interactively, where workspace trust prompts are skipped. The bridge currently combines this with:

- Project and local setting sources.
- Filesystem hooks and skills.
- `permissionMode: "bypassPermissions"`.
- `strictMcpConfig`, which blocks MCP configuration but does not block hooks or other project customizations.

Therefore, a repository's `.claude/settings.json` may execute hooks even when Pi would not trust that repository's `.pi` configuration. Isolation from `~/.claude` does not address this.

A future policy should be explicit:

- `all`: Preserve current behavior.
- `trusted-only`: Load project/local Claude sources only when Pi trusts the project.
- `user-only`: Load only the isolated profile.
- `none`: Use fully programmatic configuration.

The recommended policy is `trusted-only`, initially opt-in if backward compatibility requires preserving `all`.

#### 3. Profile management must use the provider's executable

Verified on 2026-07-23:

| Source | Agent SDK | Claude Code |
|---|---:|---:|
| Project manifest and installation | exact `0.3.218` | bundled `2.1.218` |
| Selected Darwin arm64 platform executable | n/a | `2.1.218` |

An earlier checkpoint warned about project/system executable skew. The upgrade candidate now bundles and selects `2.1.218`; Phase 9 makes no claim about whatever system CLI may currently be on `PATH`. A future `/cc` command must invoke the same SDK-resolved executable as provider turns so a separate system installation cannot write newer or older profile metadata. The status command should still report both selected and system versions when available.

#### 4. Arbitrary Claude plugins will not currently behave normally

The main provider uses `tools: []` and exposes Pi tools through MCP. Both provider and AskClaude enable strict MCP configuration.

Consequences:

- Plugin MCP servers are suppressed.
- User-configured MCP servers are suppressed.
- Plugin skills or agents that expect Claude's built-in `Read`, `Edit`, or `Bash` may not work with the main provider.
- AskClaude is more native because it retains Claude's built-in tools, but its MCP components are still suppressed.

A plugin manager should show this compatibility warning rather than imply that every installed plugin is fully usable.

#### 5. Current AGENTS forwarding becomes incorrect under isolation

`src/agents-md.ts` performs broad substitutions such as:

- `~/.pi` to `~/.claude`.
- `.pi` to `.claude`.
- Every occurrence of "pi" to "environment".

This can corrupt package names, URLs, and instructions. It would also point isolated Claude toward the normal `~/.claude` directory, directly contradicting the new profile boundary.

It also forwards only the nearest project `AGENTS.md` or the global file, rather than Pi's complete resolved rule hierarchy. The bridge should use Pi's resolved prompt/context data and stop rewriting paths globally.

The substitutions cannot be fixed one at a time; see "Stop rewriting paths in `src/agents-md.ts`" above for why, and for the recommendation to drop the whole `sanitizeAgentsContent` call inside Option 1. What stays in the follow-on replacement is the incomplete rule hierarchy: `extractAgentsAppend` forwards only the nearest `AGENTS.md` instead of Pi's resolved prompt/context data.

#### 6. Profile mutations and active sessions can race

Settings and plugin changes may occur while:

- A provider query is active.
- An AskClaude query is active.
- A reentrant Pi subagent query is active.
- Another Pi process is using the same profile.

Management commands should wait for bridge queries to become idle, write atomically, and invalidate or rotate the shared Claude session when a startup-sensitive configuration changes.

#### 7. "Isolated profile" must remain narrowly defined

Inherited variables can still override authentication and behavior (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, provider selection variables, and other `CLAUDE_*` values). On macOS, Keychain authentication is shared.

The status command should therefore say "isolated filesystem profile," not imply account or environment isolation.

### Can Every Claude Code Command Be Invoked Through Pi?

Not cheaply in the literal sense.

#### Low-to-moderate effort

A Pi `/cc` command can proxy non-interactive CLI operations with an explicit child environment:

```text
/cc status
/cc plugin list
/cc plugin install ...
/cc plugin marketplace ...
/cc mcp ...
/cc doctor
/cc config ...
```

Important constraints:

- Spawn without a shell and parse arguments safely.
- Set `CLAUDE_CONFIG_DIR` only on the child.
- Use a neutral working directory and user-only sources for profile administration. Commands such as `doctor` and `mcp list` may otherwise inspect or launch project MCP configuration.
- Wait for bridge queries to become idle.
- Do not log authentication arguments or secrets.
- Truncate displayed output.

Pi's current `pi.exec()` API has neither an environment option nor interactive stdin/PTY support, so this would need `node:child_process` with an explicit `env`.

#### Settings management

There are two reasonable interfaces:

1. **Native command path:** Use non-interactive `/config key=value`.
   - Claude Code added this form in `2.1.181`, so the bundled `2.1.218` supports it.
   - This replaces the earlier checkpoint's unsupported-version limitation.
   - It covers only settings exposed by `/config` and must run through the provider's SDK-resolved executable.

2. **Pi settings editor:** Open `~/.pi/agent/claude/settings.json` through `ctx.ui.editor`, validate it, then replace it atomically.
   - This works with arbitrary settings.
   - It requires locking, backup, validation, and preservation of unknown keys.

Either interface can be provided after the isolation design is implemented; the native route no longer requires a Claude Code upgrade beyond the bundled `2.1.218`.

#### High effort and not recommended initially

Interactive commands such as the full `/config` interface, `/permissions`, `/memory`, `/skills`, login dialogs, and plugin browser still require a real terminal. Support for non-interactive `/config key=value` does not make these interfaces headless. The Agent SDK only dispatches commands listed as non-interactive in its initialization result.

Supporting every interactive command would require a PTY-backed terminal emulator inside Pi or launching Claude in another terminal. That is a separate feature, not a small extension to Option 1.

### What Pi Can Reliably Forward

| Pi surface | Current state | Recommended route |
|---|---|---|
| Model, effort, cwd, conversation | Already forwarded | Keep |
| Active tools and extension tools | Already exposed through in-process MCP | Keep as the primary compatibility mechanism |
| Pi MCP integrations | Already become Pi tools, then bridge tools | Keep |
| Global and project rules | Partially and incorrectly forwarded | Append a curated Pi compatibility block from Pi's resolved prompt/context |
| Per-turn system-prompt changes | Mostly lost | Derive from the final `context.systemPrompt`; do not rediscover files manually |
| Pi skills | Descriptions and paths are appended | Keep this baseline; optionally add native skill registration later |
| Prompt templates and user-invoked skills | Expanded by Pi before provider invocation | No mirroring needed |
| Tool prompt guidelines/snippets | Mostly lost | Include them in the compatibility block |
| Project trust | Not forwarded | Use it to choose Claude `settingSources` |
| Session name | Not forwarded | Optionally pass as the SDK title |
| Pi subagents | Main provider already receives Pi's `Agent` tool through MCP | Keep Pi as the orchestration authority |
| AskClaude subagents | Uses Claude Code's native Agent implementation | Treat separately and document |

#### Skills

The SDK cannot register arbitrary skills purely in memory. Native Claude skills must exist on the filesystem or come from a plugin.

A useful optional extension is a bridge-owned local plugin generated under the isolated profile. It could expose Pi skills without mixing generated files into the user's own `skills/` directory. Trade-offs include namespacing, duplicate skill listings, tool-name translation, collision handling, and the known custom-config-directory discovery caveat.

This should be optional. The current progressive-disclosure approach is simpler and already lets Claude read Pi skills through the bridged `read` tool.

#### `@tintinweb/pi-subagents`

For the main provider, native translation is unnecessary. The Pi `Agent` tool is already one of the tools passed through `buildMcpServers()`, preserving:

- Pi's model registry.
- Concurrency and scheduling.
- Worktree behavior.
- Steering and resume.
- Extension scoping.
- Pi's agent UI and lifecycle events.

Translating those definitions into Claude's `agents` option would create a second orchestration system and lose several Pi-only fields.

The missing piece is fresh catalog discovery. `@tintinweb/pi-subagents` protocol v2 currently exposes only `ping`, `spawn`, and `stop`; it has no list-types RPC. If richer integration is needed, add an upstream `subagents:rpc:list-types` method rather than importing package internals or independently parsing its files.

AskClaude is different: It currently uses Claude's native Agent tool and cannot trivially execute ordinary Pi tools while the parent Pi tool call is waiting. A future explicit setting such as `askClaude.agentBackend: "claude" | "pi"` would be clearer than silently mixing both systems.

### Design Directions

#### 1. Option 1 Plus a Command Facade

Implement isolation and add `/cc status`, `/cc plugin`, `/cc doctor`, and a settings editor.

**Gains:** Smallest change, immediate profile management, and low compatibility risk.

**Losses:** Existing prompt forwarding remains brittle; project-hook trust remains unresolved; Pi skills and agents are not more native; arbitrary plugins remain partially incompatible.

**Best fit:** A quick first release.

#### 2. Profile Control Plane Plus Pi Compatibility Adapter (Recommended)

Add a central per-spawn policy builder that produces:

- Child-only environment.
- Effective profile and executable.
- Trust-aware setting sources.
- Bridge-owned inline settings.
- Curated Pi rules, skill catalog, and tool guidance.
- A configuration fingerprint for session invalidation.

Keep persistent user configuration in `~/.pi/agent/claude`, and manage it through `/cc`. Keep Pi tools and Pi subagents routed through MCP rather than duplicating them natively.

**Gains:** Strong Pi behavioral parity, clear ownership, manageable complexity, good diagnostics, and no generated profile drift.

**Losses:** Requires careful prompt composition and trust plumbing. Native Claude skill integration remains optional rather than automatic.

**Best fit:** The durable default architecture.

#### 3. Generated Native Claude Mirror

Materialize Pi rules, skills, and agents as a generated Claude plugin/profile and pass SDK `agents`, `plugins`, and settings on every query.

**Gains:** Native Claude skill and agent discovery, slash-command integration, and closer compatibility with the Claude ecosystem.

**Losses:** High synchronization cost, naming collisions, tool-schema mismatches, duplicate subagent schedulers, stale generated state, and incomplete translation of Pi agent fields. It also expands reliance on upstream `CLAUDE_CONFIG_DIR` behavior.

**Best fit:** An experimental opt-in after Direction 2 is stable.

### Final Recommendation

Implement Direction 2 in stages:

1. Deliver Option 1, including `provider.claudeConfigDir`, the rollback-harness migration, removal of the existing global environment mutation, and dropping the `sanitizeAgentsContent` path rewrites.
2. Add `/cc status` and non-interactive profile administration using the same executable as provider turns.
3. Add safe settings editing and `resolveSettings()` provenance.
4. Replace the remaining `src/agents-md.ts` rewriting with a curated Pi compatibility prompt.
5. Keep Pi's `Agent` tool as the main subagent bridge.
6. Add native Pi skill mirroring only as an opt-in experiment.
