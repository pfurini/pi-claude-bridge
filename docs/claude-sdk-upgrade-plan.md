# Claude Agent SDK and Claude Code Upgrade Assessment

**Assessment date:** 2026-07-22  
**Project:** `pi-claude-bridge`  
**Status:** Phase 1 complete; Phase 2 offline compatibility contracts are next

## Executive summary

Upgrade the bridge in a dedicated compatibility change to `@anthropic-ai/claude-agent-sdk` `0.3.218`, which bundles Claude Code `2.1.218`. Do not add `@anthropic-ai/claude-code` as a separate dependency because the Agent SDK already provides the matching platform binary.

The source appears compatible with the target SDK. A clean-install rehearsal of `0.3.218`, after aligning the Pi development dependencies, passed all 99 unit tests and typechecking. However, those results are not enough to approve the upgrade because the existing suite does not directly test SDK query construction, SDK message shapes, MCP initialization, AskClaude tool policy, or authenticated session compatibility.

The pre-upgrade assessment proved that the SDK session APIs could parse and list a generated session offline, but authenticated resume, rebuild, compaction, abort, and cross-version rollback behavior remain unverified because the local Claude OAuth session was expired during this assessment.

The upgrade should be completed before implementing the proposed Claude configuration isolation. Keeping the two changes separate will make failures attributable and will let the isolation work target the current SDK behavior.

## Recommended dependency target

Use these runtime dependency versions for the upgrade rehearsal and committed lockfile:

```json
{
  "@anthropic-ai/claude-agent-sdk": "0.3.218",
  "@anthropic-ai/sdk": "0.113.0",
  "@modelcontextprotocol/sdk": "1.29.0",
  "zod": "4.4.3"
}
```

Establish the clean baseline with an exact, coherent Pi development set:

```json
{
  "@earendil-works/pi-ai": "0.80.3",
  "@earendil-works/pi-coding-agent": "0.80.3",
  "@earendil-works/pi-tui": "0.80.3"
}
```

Keep `cc-session-io` at `0.3.1`, which was still its latest published version on the assessment date.

### Version comparison

| Component | Current | Recommended | Notes |
| --- | ---: | ---: | --- |
| Claude Agent SDK | `0.2.141` | `0.3.218` | Current npm `latest` release selected for execution |
| Bundled Claude Code | `2.1.141` | `2.1.218` | Paired and shipped by the Agent SDK |
| Anthropic API SDK | `^0.73.0` | `0.113.0` | Latest Agent SDK requires `>=0.93.0` |
| MCP SDK | Transitive | `1.29.0` | Latest Agent SDK declares it as a peer |
| Zod | Transitive but directly imported | `4.4.3` | Must become an explicit dependency |
| `cc-session-io` | `0.3.1` | `0.3.1` | No newer release available |

> **Re-validate the pin at execution time.** `0.3.218` (Claude Code `2.1.218`) is the stable target selected on the assessment date. Immediately before Phase 3, re-run `npm view @anthropic-ai/claude-agent-sdk dist-tags`. If `latest` has changed, update the target Agent SDK and bundled Claude Code versions consistently throughout this plan, repeat the clean-install rehearsal, and pin the newly selected Agent SDK exactly.

### Pinning policy

Pin the Agent SDK exactly. Each Agent SDK release selects a specific Claude Code binary, so an automatic patch-range update can change runtime behavior without a source change in this repository.

The supporting peer packages may also be pinned exactly for the first release. Future updates should arrive through reviewed dependency PRs that run the compatibility gates described below.

Pin `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` to the same exact release for the baseline. Use `0.80.3` here because it is the smallest coherent change from the current lockfile. A temporary `0.81.1` rehearsal also passed typechecking and all 99 unit tests, but taking that unrelated Pi minor upgrade in the same change would weaken failure attribution. Upgrade Pi separately after the SDK work.

## Integration surface

The upgrade affects more than the primary provider call.

### `src/index.ts`

The bridge creates SDK queries for:

- Initial provider turns.
- Continued and resumed provider turns.
- Isolated compaction and summary generation.
- AskClaude requests.
- Shared and rebuilt Claude Code sessions.

It also handles:

- Stream events and partial assistant output.
- Completed assistant-message fallbacks.
- Terminal results and errors.
- Abort and interrupt behavior.
- MCP server construction and Pi tool delivery.
- Permission and settings-source policy.
- Session creation, deletion, rotation, and resume.

### `src/config.ts`

The `SettingSource` type comes from the Agent SDK. The configuration isolation proposal also depends on the SDK continuing to respect `CLAUDE_CONFIG_DIR` and `settingSources`.

### `src/typebox-to-zod.ts`

This module converts Pi TypeBox tool schemas to Zod shapes accepted by `createSdkMcpServer`. It depends on both SDK tool-schema recognition and Zod behavior.

### `@anthropic-ai/sdk` (direct source dependency)

This is not just a peer package to align. `src/index.ts` imports types directly: `import type { Base64ImageSource, ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources"`. The upgrade moves this dependency from `^0.73.0` to `0.113.0`, roughly 40 minor versions on a pre-1.0 SDK where type shapes change routinely. The imports are type-only, so any breaking change surfaces at typecheck rather than runtime, which is exactly why the "Typecheck gate" dedup fix must land first: with typecheck already red, a new error introduced by this bump could be misattributed or missed. Confirm these three type imports still resolve and keep their expected shapes after the bump.

### `cc-session-io`

The bridge writes synthetic Claude Code JSONL before asking the SDK to resume it. This is intentionally coupled to an undocumented on-disk format and is therefore the most compatibility-sensitive integration.

## Upstream changes that matter

### Agent SDK `0.3.142`

This release includes breaking changes:

- Deprecated version 2 session APIs were removed. This project does not use those APIs.
- MCP connections became non-blocking by default. This can affect whether Pi tools are available on the first model turn.
- Headless and SDK task handling moved away from `TodoWrite` to the newer Task tools.

### Agent SDK `0.3.143`

The Anthropic API SDK, MCP SDK, and Zod became peer dependencies. The project must declare compatible versions explicitly instead of relying on nested transitive packages.

### Claude Code `2.1.162`

Native builds changed when dedicated Grep and Glob tools are exposed. An offline initialization probe showed that the bridge's current AskClaude read-mode restrictions still expose Read, Grep, and Glob on `2.1.217`, but this policy is not covered by a permanent test.

### Claude Code `2.1.198`

Subagents run in the background by default. AskClaude allows native Agent use in read and full modes, so delegation, completion, and cleanup need explicit tests.

### Expanded tool inventory

The target Claude Code initialization exposes new tools including:

- `TaskCreate`
- `TaskGet`
- `TaskList`
- `TaskUpdate`
- `Workflow`
- `ReportFindings`
- `SendMessage`

The existing `MODE_DISALLOWED_TOOLS` lists were written for the older inventory. They need a policy review, especially for AskClaude `none` mode and for the `Task` versus `Agent` wire-name transition.

This is a concrete gap, not a hypothetical one. `MODE_DISALLOWED_TOOLS.none` (`src/index.ts:158-164`) blocks `Agent` but does not block `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, `Workflow`, `SendMessage`, or `RemoteTrigger`. The design comment at `src/index.ts:141-143` states these are *intentionally* left unblocked, so this is a deliberate policy written against the old inventory, not an oversight. The stated contract for `none` mode is that it blocks delegation (see Phase 4 "Tool policy": "None mode blocks filesystem, shell, web, and Agent or Workflow delegation"). If the delegation mechanism in the target Claude Code build routes through the `Task*` and `Workflow` tools, `none` mode leaks delegation through the new wire names while only the legacy `Agent` name stays blocked. Before finalizing the block list, use the Phase 2 offline `system:init` probe to confirm which of these tools are actually default-exposed in the target build, then make an explicit, gated decision about adding the `Task*`/`Workflow` family to `MODE_DISALLOWED_TOOLS.none`.

## Rehearsal results

The original `0.3.217` dependency upgrade was rehearsed in a temporary clone. A follow-up clean-install rehearsal used `0.3.218` with the coherent Pi `0.80.3` development set. No repository source files were changed during either rehearsal. Unless noted otherwise, the offline initialization probes below came from the original `0.3.217` rehearsal.

### Passed checks

- The target packages installed successfully.
- The target Agent SDK's bundled native executable reported `2.1.218`.
- All 99 existing unit tests passed unchanged under `0.3.218`.
- Typechecking passed under `0.3.218` after aligning all Pi development packages at `0.80.3`.
- The assessed SDK's `resolveSettings()` read the relocated user settings from `CLAUDE_CONFIG_DIR`.
- `settingSources: ["user"]` loaded only relocated user settings.
- `settingSources: ["user", "project"]` loaded relocated user and project settings.
- `settingSources: []` loaded neither source.
- The assessed SDK's session APIs parsed and listed a session generated by `cc-session-io 0.3.1`.
- An in-process MCP server initialized as connected and advertised its tool in 5 of 5 probes.
- AskClaude read-mode initialization still included Read, Grep, and Glob.
- AskClaude none-mode initialization did not include filesystem, shell, web, or native Agent tools.

### Blocked checks

Authenticated live tests could not run because the local Claude OAuth session was expired or logged out. This affected both the current and target SDKs and is not evidence of an upgrade regression.

The following remain unverified:

- Actual model responses through the upgraded provider.
- First-turn Pi tool execution with the complete Pi tool inventory.
- Resuming synthetic JSONL with the target binary.
- Session rebuild and prompt-cache continuity.
- Abort rotation and recovery.
- Compaction and context-window behavior.
- AskClaude native subagent completion.
- Cross-version session rollback.

## Existing coverage

The current integration suite already covers important end-to-end behavior:

- Basic provider responses.
- Streaming and tool use.
- Multi-turn cache reuse.
- Session resume and rebuild.
- Tool-result delivery and ordering.
- Abort recovery.
- Compaction.
- Served context windows.
- Core `cc-session-io` operations.

These tests should remain the central authenticated regression suite.

## Coverage gaps

### SDK option construction

There is no direct test of the complete SDK options passed by the provider, continuation, AskClaude, or isolated compaction paths. A field rename or changed default can therefore pass the unit suite unnoticed.

Required assertions include:

- Model and effort selection.
- `cwd`.
- `settingSources`.
- Environment overlays.
- Permission mode and dangerous-bypass acknowledgement.
- Built-in tool enablement and denial.
- MCP server configuration.
- Strict MCP behavior.
- Session persistence and resume ID.
- Skills and hooks.
- Executable override.

### SDK message handling

There are no focused fixtures for:

- `system:init`.
- `stream_event`.
- Completed `assistant` messages.
- `result.is_error`.
- New terminal reasons.
- Aborted assistant messages.
- Rate-limit events.
- Unknown future message types.

`runIsolatedSummary` currently accepts `subtype: "success"` without also checking `is_error`. This should be corrected as part of the compatibility work.

### MCP readiness and schemas

The current tool-loop integrations do not assert the MCP status received in `system:init`, the advertised tool schema, or first-turn availability under non-blocking startup.

### AskClaude policy

The AskClaude smoke test proves basic text completion but does not verify:

- Read, full, and none tool inventories.
- Filesystem and web restrictions.
- Task and Workflow policy.
- Native foreground and background subagents.
- Action-summary rendering for the new task events.

### Packaging and native binaries

There is no install matrix proving that npm selects the correct optional native package on supported operating systems and architectures.

### Typecheck gate

Before Phase 1, typechecking was red because two installed copies of `@earendil-works/pi-ai` created a nominal type mismatch (`private property 'queue'`). The root used `0.80.3`, while `@earendil-works/pi-coding-agent 0.80.2` retained a nested `0.80.2` through its published `npm-shrinkwrap.json`; `npm dedupe` and a root `overrides` pin could not collapse it.

Phase 1 aligned `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` exactly at `0.80.3`. A clean install now resolves one effective `@earendil-works/pi-ai` version, and `npm run typecheck` passes without changing the affected provider call site.

### Node runtime baseline

`package.json` now declares Node `>=22.19.0`, matching the required `@earendil-works/pi-*` packages. Phase 7 still needs to run the packaging matrix on Node 22.19 and the current Node LTS.

## Upgrade plan

### Phase 1: Make the baseline measurable (completed 2026-07-22)

This phase was completed using the current Agent SDK (`0.2.141`).

1. [x] Pin `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` exactly to `0.80.3`, regenerate the lockfile from a clean install, and confirm only one effective `@earendil-works/pi-ai` version is installed. No `npm dedupe`, `overrides`, or provider call-site workaround was used.
2. [x] Change the package engine requirement from Node `>=20` to `>=22.19.0`, matching the required Pi packages.
3. [x] Extract testable SDK option builders for provider, AskClaude, and isolated compaction queries into `src/sdk-options.ts`.
4. [x] Extract shared SDK message reduction and terminal-result parsing into `src/sdk-messages.ts`.
5. [x] Add a fake Claude executable that speaks enough stream-json protocol to test the SDK without authentication.
6. [x] Record current functional invariants with focused assertions rather than complete option or message snapshots.

Implemented tests:

- `tests/unit-sdk-options.mjs`
- `tests/unit-sdk-messages.mjs`
- `tests/unit-sdk-runtime-contract.mjs`
- `tests/fixtures/fake-claude-cli.mjs`

#### Phase 1 completion record

Implemented files:

- `src/sdk-options.ts` owns the three production query-option builders.
- `src/sdk-messages.ts` owns reusable message reduction and terminal-result parsing.
- `tests/fixtures/fake-claude-cli.mjs` implements the offline stream-json process boundary.
- `tests/unit-sdk-options.mjs`, `tests/unit-sdk-messages.mjs`, and `tests/unit-sdk-runtime-contract.mjs` cover the new seams.

Verification completed on 2026-07-22:

- A clean `npm install` regenerated `package-lock.json`.
- `npm ls` resolved all three Pi development packages to `0.80.3` and found only one effective `@earendil-works/pi-ai` version.
- The runtime remained on Agent SDK `0.2.141`; the dependency upgrade has not started.
- `npm run typecheck` passed.
- All 110 unit tests passed (99 existing tests plus 11 new SDK contract tests).
- The fake executable completed an unauthenticated Agent SDK query and produced `system:init`, streaming, completed assistant, and terminal result messages.

**Phase 2 session handoff:** Keep the current dependency versions until the offline contracts are complete. Extend the fake executable and the extracted builders/reducer to cover MCP initialization, generated Zod schemas, AskClaude mode inventories, terminal error and abort paths, configuration-source isolation, synthetic session APIs, and executable resolution. Do not apply the Agent SDK upgrade until Phase 3.

### Phase 2: Add offline compatibility contracts (next)

Add tests that run without credentials:

1. Assert the SDK-reported Claude Code version in `system:init`.
2. Assert MCP connection status and custom tool visibility.
3. Exercise a custom Zod tool schema generated from TypeBox.
4. Assert AskClaude tool policies for read, full, and none modes.
5. Exercise success, terminal error, abort, and unknown-message fixtures.
6. Verify `CLAUDE_CONFIG_DIR` and `settingSources` with temporary directories.
7. Create a synthetic session and read it through the SDK session APIs.
8. Assert bundled executable resolution and external executable override behavior.

> **Scope justification for Phases 1-2.** Building a fake Claude CLI and extracting testable option and message builders is deliberately heavy for a one-time upgrade whose follow-up rehearsal already passed 99 unit tests and typechecking. It is worth it here for one reason: the actual bottleneck during the assessment was that expired Claude OAuth blocked every authenticated check, so there is currently no way to gate SDK behavior offline. This harness is what lets future SDK bumps run in CI without credentials, which is a stated goal of this plan (reviewed automated dependency PRs, see "Pinning policy" and Phase 9). Treat Phases 1-2 as durable regression infrastructure for recurring upgrades, not as one-shot scaffolding. If the project decides it will *not* pursue recurring automated SDK bumps, reconsider this scope, because for a single upgrade it is over-engineered.

### Phase 3: Apply the dependency upgrade

1. Re-run `npm view @anthropic-ai/claude-agent-sdk dist-tags`. If `latest` is no longer `0.3.218`, update every target SDK and bundled Claude Code reference in this plan and repeat the clean-install rehearsal before proceeding.
2. Update `package.json` to the recommended runtime dependency versions.
3. Regenerate `package-lock.json` from a clean installation.
4. Confirm `npm ls` has no invalid peer dependency relationships.
5. Do not add standalone `@anthropic-ai/claude-code`.
6. Keep `cc-session-io` unchanged unless authenticated compatibility fails.

### Phase 4: Adapt behavior deliberately

#### Permission bypass

Set `allowDangerouslySkipPermissions: true` wherever `permissionMode: "bypassPermissions"` is intentional. The latest SDK documents the acknowledgement as required. Tests must prove that read and none modes remain constrained by their disallowed-tool policies.

#### Strict MCP configuration

Prefer the typed `strictMcpConfig` option over duplicate raw CLI arguments where the target SDK supports it. Preserve the existing configuration switch for the main provider and the strict behavior used by AskClaude.

#### MCP loading policy

Two approaches are viable:

1. Set `alwaysLoad: true` on the in-process Pi MCP server. This guarantees first-turn tool availability but can increase prompt size.
2. Keep the new default. This reduces prompt cost but relies on non-blocking discovery and tool search behavior.

Recommendation: use `alwaysLoad: true` because access to Pi tools is the provider's core contract. Keep it only if the cache and usage tests show acceptable overhead.

#### Tool policy

Review the latest `system:init.tools` inventory and update the AskClaude policy explicitly. Include both legacy and current names during transitions where necessary.

At minimum, assert that:

- Read mode allows Read, Grep, and Glob.
- Read mode blocks writes and shell execution.
- None mode blocks filesystem, shell, web, and Agent or Workflow delegation.
- Full mode retains intentional access.

#### Terminal errors

Treat `result.is_error` as an error in every query path, even when the result subtype is `success`. Preserve diagnostic details such as terminal reason, error text, and session ID.

#### Unknown SDK messages

Continue ignoring or debug-logging unknown message types instead of throwing. Add a fixture so forward-compatible behavior is intentional.

### Phase 5: Run authenticated compatibility tests

Reauthenticate Claude and run the smoke suite outside the sandbox because it needs local Claude settings and authentication.

Required scenarios:

1. Basic provider completion.
2. First-turn custom Pi tool execution.
3. Parallel custom tools and result delivery.
4. Multi-turn cache reuse.
5. Resume from a generated session.
6. Rebuild after rewritten Pi history.
7. Abort during tool execution and clean recovery.
8. Isolated compaction and summary generation.
9. AskClaude shared and isolated context.
10. AskClaude native subagent completion after the background-default change.
11. Read, full, and none policy enforcement through real prompts.
12. Error propagation for an invalid model or another deterministic terminal failure.

### Phase 6: Test session upgrade and rollback

Use isolated profile directories and separate installations for the current and target versions.

1. Generate and resume a session with `0.2.141` and Claude Code `2.1.141`.
2. Resume equivalent synthetic history with `0.3.218` and Claude Code `2.1.218`.
3. Let the new binary append records, then test whether the old binary can read them.
4. Let the old binary append records, then test whether the new binary can read them.
5. Restart Pi and prove that the bridge can rebuild a fresh session from Pi history after a downgrade.

Cross-version direct resume is useful evidence but does not have to become a permanent runtime guarantee. Restart-and-rebuild is the supported rollback path.

If latest resume fails, fix or update `cc-session-io`. Avoid adding ad hoc JSONL transformations to `src/index.ts` because they would create a second session-format implementation.

### Phase 7: Packaging and platform verification

1. Run `npm pack`.
2. Install the tarball into a clean consumer project.
3. Start a query and assert `system:init.claude_code_version` is `2.1.218`.
4. Verify the bundled executable runs without relying on a `claude` binary from `PATH`.
5. Verify `pathToClaudeCodeExecutable` still overrides the bundle.
6. Test Node 22.19, the package's corrected minimum, and the current Node LTS.
7. Test native package resolution on Linux x64, macOS arm64, and Windows if those platforms remain supported.

The repository currently has no GitHub Actions workflow. If CI is added, keep authenticated tests on trusted manual, scheduled, or protected runs so credentials are never exposed to untrusted pull requests.

### Phase 8: Revalidate model behavior

Run the existing context-size diagnostics against the target binary for supported models and plan configurations.

Update measurements instead of carrying forward values observed under Claude Code `2.1.141`. At minimum, revalidate:

- Model ID aliases.
- Default context windows.
- Long-context eligibility.
- Subscription-plan behavior.
- Served input limits.

### Phase 9: Documentation and release

Update:

- `docs/claude-config-isolation.md`
- `diag/CONTEXT-SIZE.md`
- `CHANGELOG.md` under a new `## UNRELEASED` section

The configuration-isolation design remains valid under the target SDK. The following details in its current assessment must change:

- Current and target version references.
- Version-skew warnings tied to `2.1.141`.
- The statement that the bundled Claude Code lacks non-interactive `/config`, which was introduced after the currently bundled version.

Package the candidate and test it locally before publishing. Keep the Agent SDK exact-pinned after release and use reviewed automated dependency PRs for future updates.

## Acceptance criteria

The upgrade is ready to release only when all of the following are true:

- `npm run typecheck` passes from a clean checkout with `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` pinned coherently to `0.80.3` and only one effective `@earendil-works/pi-ai` version installed.
- All existing unit tests and new SDK contract tests pass.
- The complete authenticated integration suite passes with Claude Code `2.1.218`.
- `system:init` confirms the bundled version rather than an unintended system CLI.
- A Pi custom tool succeeds on the first provider turn.
- AskClaude read, full, and none policies match the documented contract.
- Terminal SDK errors are surfaced instead of being accepted as successful summaries.
- Synthetic session resume, rebuild, abort recovery, and compaction pass.
- Package installation resolves all peer and platform dependencies cleanly.
- The package declares Node `>=22.19.0`, and packaging checks pass on Node 22.19 and the current Node LTS.
- Model and context-window documentation reflects measurements from the target binary.
- A downgrade followed by Pi restart rebuilds a usable session from Pi history.

## Rollback plan

1. Revert `package.json` and `package-lock.json` to the previous Agent SDK versions.
2. Reinstall dependencies from the reverted lockfile.
3. Restart Pi to clear the bridge's in-memory shared session.
4. Let the bridge rebuild a fresh Claude session from Pi history rather than resuming a session actively written by the newer binary.
5. If configuration isolation has been implemented separately, preserve or back up the isolated profile before testing an older Claude Code binary against it.

## Recommended change boundaries

Use separate changes for:

1. Baseline testability and SDK contract tests.
2. Dependency upgrade and required compatibility fixes.
3. Claude configuration isolation.

This sequence prevents the binary upgrade and profile relocation from obscuring each other's failures.

## Sources

- [Claude Agent SDK TypeScript changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- [Claude Agent SDK TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Claude Code changelog](https://code.claude.com/docs/en/changelog)
- [Claude Agent SDK on npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [`cc-session-io` repository](https://github.com/elidickinson/cc-session-io)
