# Claude Agent SDK and Claude Code Upgrade Assessment

**Assessment and execution dates:** 2026-07-22 to 2026-07-23
**Project:** `pi-claude-bridge`  
**Status:** Phases 1-9 complete; the local release candidate is verified but not published

## Executive summary

Upgrade the bridge in a dedicated compatibility change to `@anthropic-ai/claude-agent-sdk` `0.3.218`, which bundles Claude Code `2.1.218`. Do not add `@anthropic-ai/claude-code` as a separate dependency because the Agent SDK already provides the matching platform binary.

Phases 1-9 pass on the selected dependency set. Typechecking, 126 offline unit contracts, the authenticated provider/tool/cache/compaction suite, live AskClaude policy and native-subagent checks, deterministic terminal-error propagation, cross-version rollback, the supported native-package resolution matrix, Pro model/context behavior with Extra Usage disabled and enabled, and a final clean-consumer candidate installation all passed with the target SDK.

Separate authenticated `0.2.141`/`2.1.141` and `0.3.218`/`2.1.218` installations could read and directly resume each other's tested transcripts in both directions. The supported rollback path also passed: after downgrade and Pi restart, the old bridge rebuilt a usable Claude session from persisted Pi history. Phase 8 found one production compatibility issue: Fable 5 is no longer available on Pro when Extra Usage is disabled. The bridge now hides or rejects that ineligible model while preserving configured Max and Pro/Extra-on behavior. Phase 9 updated the target-binary documentation and verified a local package candidate; nothing was published.

The SDK upgrade and the proposed Claude configuration isolation remain separate changes. Phase 9 updated the isolation design for the target SDK but did not implement profile relocation or any other configuration-isolation behavior.

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

Phases 1-4 added focused option-builder tests for provider, AskClaude, and isolated compaction paths. They now cover the target SDK's dangerous-bypass acknowledgement, typed strict MCP setting, tool policies, environment overlays, persistence, resume, skills, and executable override behavior.

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

The offline message fixtures now cover:

- `system:init`.
- `stream_event`.
- Completed `assistant` messages.
- `result.is_error`, including `subtype: "success"`.
- Terminal reasons and session IDs.
- Abort behavior.
- Unknown future message types.

Authenticated rate-limit, aborted-assistant, and model-error semantics remain Phase 5 concerns.
`runIsolatedSummary`, the main provider consumer, and AskClaude now all reject terminal results when `is_error` is true, even if the subtype is `success`.

### MCP readiness and schemas

The offline contracts now assert MCP status, generated TypeBox-to-Zod schemas, handler execution, `alwaysLoad` metadata, and target-binary initialization. Authenticated first-turn execution with Pi's complete tool inventory remains unverified.

### AskClaude policy

The offline fake and target-binary probes now verify read, full, and none inventories, filesystem and web restrictions, current Task/Workflow names, and transitional Agent/RemoteTrigger policy. Native foreground/background subagent completion and action-summary rendering for live task events remain authenticated gaps.
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

### Phase 2: Add offline compatibility contracts (completed 2026-07-23)

Tests run without Claude credentials:

1. [x] Assert the SDK-reported Claude Code version in `system:init`.
2. [x] Assert MCP connection status and custom tool visibility.
3. [x] Exercise a custom Zod tool schema generated from TypeBox.
4. [x] Assert AskClaude tool policies for read, full, and none modes.
5. [x] Exercise success, terminal error, abort, and unknown-message fixtures.
6. [x] Verify `CLAUDE_CONFIG_DIR` and `settingSources` with temporary directories.
7. [x] Create a synthetic session and read it through the SDK session APIs.
8. [x] Assert bundled executable resolution and external executable override behavior.

#### Phase 2 completion record

Implemented coverage:

- `tests/fixtures/fake-claude-cli.mjs` now supports MCP initialization and tool calls, native tool filtering, terminal errors, unknown messages, and an abortable query.
- `tests/unit-sdk-runtime-contract.mjs` covers `system:init`, the generated TypeBox-to-Zod MCP schema and handler, all three AskClaude modes, success/error/abort/unknown paths, and executable selection.
- `tests/unit-sdk-storage-contract.mjs` covers relocated settings sources and SDK reads of a synthetic `cc-session-io` transcript.
- `src/sdk-options.ts`, `src/sdk-messages.ts`, and `src/typebox-to-zod.ts` expose the production policy, initialization, and schema-adaptation seams used by those tests.

Verification completed on 2026-07-23:

- The runtime remains on Agent SDK `0.2.141`; `package.json` and `package-lock.json` were unchanged.
- `npm run typecheck` passed.
- All 122 unit tests passed (the 110-test Phase 1 baseline plus 12 additional Phase 2 contract tests/subtests).
- The offline runtime tests explicitly remove Claude credential environment variables, use temporary configuration and session directories, and require no Claude login.
- Diagnostics and `git diff --check` passed.

Remaining risks:

- The fake process validates the SDK transport boundary, but authenticated model behavior, target-binary MCP startup timing, resume/compaction, and the target `system:init.tools` inventory still require later phases.
- Phase 4 still owns dangerous-bypass acknowledgement, typed strict MCP adaptation, `alwaysLoad`, tool-policy changes for new delegation names, and `result.is_error` semantics.
- Cross-platform native package selection remains a Phase 7 matrix concern.

**Phase 3 session handoff:** First run `npm view @anthropic-ai/claude-agent-sdk dist-tags`. If `latest` differs from `0.3.218`, update the Agent SDK and bundled Claude Code targets throughout this plan and repeat the clean-install rehearsal. Then apply only the Phase 3 dependency changes, regenerate `package-lock.json` from a clean install, and run these 122 offline contracts before making any Phase 4 behavior adaptations.

> **Scope justification for Phases 1-2.** Building a fake Claude CLI and extracting testable option and message builders is deliberately heavy for a one-time upgrade whose follow-up rehearsal already passed 99 unit tests and typechecking. It is worth it here for one reason: the actual bottleneck during the assessment was that expired Claude OAuth blocked every authenticated check, so there is currently no way to gate SDK behavior offline. This harness is what lets future SDK bumps run in CI without credentials, which is a stated goal of this plan (reviewed automated dependency PRs, see "Pinning policy" and Phase 9). Treat Phases 1-2 as durable regression infrastructure for recurring upgrades, not as one-shot scaffolding. If the project decides it will *not* pursue recurring automated SDK bumps, reconsider this scope, because for a single upgrade it is over-engineered.

### Phase 3: Apply the dependency upgrade (completed 2026-07-23)

1. [x] Re-ran `npm view @anthropic-ai/claude-agent-sdk dist-tags`; `latest` remained `0.3.218`, so no replacement rehearsal was required.
2. [x] Updated `package.json` to the selected runtime dependency versions.
3. [x] Regenerated `package-lock.json` from a clean installation.
4. [x] Confirmed `npm ls` has no invalid peer dependency relationships.
5. [x] Confirmed there is no standalone `@anthropic-ai/claude-code` dependency.
6. [x] Kept `cc-session-io` at `0.3.1`.

#### Phase 3 completion record

Selected versions:

- `@anthropic-ai/claude-agent-sdk` `0.3.218` (bundled Claude Code `2.1.218`).
- `@anthropic-ai/sdk` `0.113.0`.
- `@modelcontextprotocol/sdk` `1.29.0`.
- Zod `4.4.3`.
- `cc-session-io` `0.3.1`.
- All three Pi development packages `0.80.3`.

Dependency-only verification completed before any Phase 4 production adaptation:

- `npm run typecheck` passed.
- All 122 unit tests passed (37 suites, 0 failures) without Claude credentials.
- `npm ls` resolved the Agent SDK peers correctly, found only Pi `0.80.3` as the effective Pi version, and found no standalone Claude Code package.
- The dependency-only commit is `1d6d28c`.

### Phase 4: Adapt behavior deliberately (completed 2026-07-23)

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

#### Phase 4 completion record

Implemented adaptations:

- Added `allowDangerouslySkipPermissions: true` to every intentional SDK bypass-permissions query and the existing direct SDK integration-test queries.
- Replaced raw strict-MCP arguments with typed `strictMcpConfig`, preserving the provider configuration switch and AskClaude's strict default.
- Set `alwaysLoad: true` on the in-process Pi MCP server and kept the TypeBox-to-Zod schema adapter covered.
- Probed Claude Code `2.1.218` directly: the current inventory uses `Task`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, `TaskUpdate`, `Workflow`, `ReportFindings`, and `SendMessage`; legacy `Agent` and `RemoteTrigger` are absent.
- Made AskClaude policy explicit for current and transitional delegation names. Read mode exposes Read/Grep/Glob while blocking writes and shell, none mode blocks filesystem/shell/web/delegation, and full mode retains current delegation tools while blocking unsupported interactive tools.
- Changed provider, AskClaude, and isolated-summary terminal handling so every `result.is_error === true` is a failure while retaining terminal reason, error text, and session ID.
- Retained forward-compatible ignore/debug behavior for unknown SDK messages.

Offline verification after the adaptations:

- `npm run typecheck` passed.
- All 125 unit tests passed (37 suites, 0 failures) without Claude credentials.
- The bundled target-binary inventory and all three AskClaude policies were exercised without a Claude login.

### Phase 5: Run authenticated compatibility tests (completed 2026-07-23)

The authenticated suite ran on Darwin arm64 with Node `v26.5.0`, npm `11.17.0`, and the system Pi CLI `0.81.1`. The package itself retained the exact Pi `0.80.3` development baseline. The installed Agent SDK was `0.3.218`, its metadata and bundled executable both reported Claude Code `2.1.218`, and the executable resolved from `@anthropic-ai/claude-agent-sdk-darwin-arm64` rather than `PATH`.

#### Scenario coverage

| Required scenario | Authenticated coverage | Result |
| --- | --- | --- |
| Basic provider completion | `tests/int-smoke.sh`; `tests/int-served-window.mjs` | Passed; provider print modes returned responses and the served window was `200000` |
| First-turn custom Pi tool | First case in `tests/int-tool-message.mjs` | Passed; the first provider prompt invoked `SlowTool` and received its result |
| Parallel custom tools and result delivery | `tests/int-tool-message.mjs`; `tests/int-multi-turn.sh` | Passed; three parallel `SlowTool` calls survived a steer and all three results reached Claude |
| Multi-turn cache reuse | `tests/int-cache.sh`; `tests/int-cursor-after-tools.mjs` | Passed; one clean start, four reuses, zero rebuilds, one session ID, and `98-99%` cache hits on resumed primary prompts |
| Resume from a generated session | `tests/int-session-rebuild.mjs` | Passed; target Claude resumed `cc-session-io` sessions after create, clear/replace, and delete/recreate |
| Rebuild after rewritten Pi history | `tests/int-session-compact.mjs`; Case 4 in `tests/int-session-resume.mjs` | Passed; post-compact history forced an in-place rebuild, and provider-switch history was rebuilt and recalled |
| Abort during tool execution and recovery | `tests/int-tool-message.mjs`; `tests/int-session-resume.mjs` | Passed; abort drained the active tool turn, rotated once, and the next prompt recovered with prior context |
| Isolated compaction and summaries | `tests/int-compact-*.mjs`; `tests/int-session-compact.mjs` | Passed; manual, split-turn, repeated, and threshold compaction returned summaries and continued cleanly |
| AskClaude shared and isolated context | Turns 7-8 in `tests/int-session-resume.mjs` | Passed; shared mode recalled the non-provider phrase and isolated mode returned `UNKNOWN` |
| AskClaude native background subagent | `tests/int-askclaude-upgrade.mjs` | Passed; the Task wire path was rendered as Agent, completed through `TaskOutput`, and returned the subagent's fixture phrase |
| Read/full/none real-prompt policy | `tests/int-askclaude-upgrade.mjs` | Passed; read mode read but could not create, full mode used Bash and Read, and none mode produced no actions or side effects |
| Deterministic terminal error | `tests/int-askclaude-upgrade.mjs` | Passed; invalid model `claude-phase5-invalid-model` returned an `Error:` containing the model diagnostic and no success marker |

#### Phase 5 completion record

Commands and exact final totals:

- `npm run typecheck` passed before authenticated testing.
- The first `npm test` run passed all 125 unit tests, all 5 smoke checks, and all 5 multi-turn checks, then stopped in `tests/int-cache.sh` with 3 cache assertions. The shared session itself was healthy (`clean-start=1`, `reuse=4`, `rebuild=0`, one session ID); the assertions incorrectly compared MCP tool-result continuation turns with primary prompt turns.
- A focused `node --import tsx --test tests/int-*.mjs` run exposed Node 26 `ERR_STREAM_WRITE_AFTER_END` failures after otherwise successful RPC test bodies. The harness now waits for the child `close` event before ending its log stream.
- `node --import tsx --test tests/int-askclaude-upgrade.mjs` passed 5 tests in 1 suite after the live policy, native Task/TaskOutput, and terminal-error scenarios were added.
- The final `npm test` passed: 125/125 unit tests across 37 suites; 5/5 smoke checks; 5/5 multi-turn checks; the cache/session check; and 25/25 Node integration tests across 2 suites. There were 0 failures, cancellations, or test-runner skips.

Runtime observations:

- The final cache run recorded resumed primary-prompt hit rates of `99%`, `98%`, `99%`, and `98%`, with nondecreasing primary cache reads. The first MCP continuation used a separate `66%` cache shape and a later continuation hit `98%`; this is why continuation turns are now reported but not compared with adjacent prompt turns.
- The always-loaded Pi MCP inventory remained available on the first provider turn. No authenticated MCP startup race occurred.
- Threshold compaction performed at least two isolated summary spawns, preserved both read-file records, returned a non-empty split-turn summary, and continued with a normal provider answer.
- Read mode's allowed native delegation attempted the requested blocked Bash operation through a subagent, but the inherited restrictions prevented the side effect. Full mode created and read its fixture. None mode exposed no action summary, leaked no file secret, created no file, and performed no web or delegation action.
- The invalid-model result surfaced as `Claude Code returned an error result: There's an issue with the selected model (claude-phase5-invalid-model)` instead of being accepted as a successful response.

Only test infrastructure changed in Phase 5: the authenticated AskClaude cases, RPC shutdown ordering, and cache-turn classification. Production source and dependencies did not change.

### Phase 6: Test session upgrade and rollback (completed 2026-07-23)

Phase 6 used separate installations and authenticated profiles under ignored `.test-output/phase6` paths:

- Old installation: Agent SDK `0.2.141`, bundled Claude Code `2.1.141`, `CLAUDE_CONFIG_DIR=.test-output/phase6/profiles/old`.
- Target installation: Agent SDK `0.3.218`, bundled Claude Code `2.1.218`, `CLAUDE_CONFIG_DIR=.test-output/phase6/profiles/target`.
- The old and target binaries each reported their expected version. Neither profile pointed to the normal `~/.claude` directory.
- The first isolated target authentication probe returned `Not logged in`; testing paused as required. After both isolated profiles were authenticated, old and target probes passed without copying or printing credentials.

#### Direct transcript and SDK API matrix

`node tests/phase6-cross-version.mjs` passed with these results:

| Check | SDK session API readability | Direct binary resume | Result |
| --- | --- | --- | --- |
| Old-generated session resumed by old | Old generation produced a session ID | Claude Code `2.1.141` recalled the generated phrase | Passed |
| Target synthetic `cc-session-io 0.3.1` history | Target APIs returned 2 messages and listed the session | Claude Code `2.1.218` recalled the synthetic phrase | Passed |
| Target appends, then old reads copied transcript | Old `getSessionMessages` returned 5 messages and `listSessions` found it | Claude Code `2.1.141` recalled both target-written phrases | Passed |
| Old appends, then target reads copied transcript | Target `getSessionMessages` returned 5 messages and `listSessions` found it | Claude Code `2.1.218` recalled both old-written phrases | Passed |

The transcript was copied between the two isolated profiles only after the writing binary exited. Each SDK always spawned the native binary bundled with its own separate installation. This distinguishes raw transcript compatibility and SDK API readability from the supported rollback procedure.

#### Supported restart-and-rebuild rollback

The rollback check used the pre-upgrade bridge commit `be34786905f433321cb81bd3d2226a68bc6f456c` in a detached worktree with Agent SDK `0.2.141`. The target bridge first wrote a persistent Pi session, then exited. A new Pi process loaded that same Pi session with the old bridge and the separate old Claude profile.

`PHASE6_OLD_BRIDGE_DIR="$PWD/.test-output/phase6/old-bridge-worktree" tests/phase6-restart-rollback.sh` passed. The old bridge log showed:

- `Case 2: first turn with 4 prior messages`.
- A new old-profile synthetic Claude session containing 4 rebuilt records.
- `syncResult: path=rebuild ... first`.
- Successful recall of the target-run rollback phrase.

The supported downgrade path therefore passed: revert to the old bridge/dependencies, restart Pi to clear in-memory state, and rebuild from Pi history. It did not rely on the old binary directly resuming the target binary's active session, although direct resume also passed in both tested directions.

No production compatibility fix or dependency change was needed. `cc-session-io` remains `0.3.1`, and no Claude JSONL transformation was added to `src/index.ts`.

#### Phase 7 handoff

Remaining risks are packaging and native-platform selection, Node `22.19` versus current-LTS packaging behavior, and the later model/context-window revalidation. Authenticated prompts remain probabilistic, and the successful direct transcript matrix is evidence for these versions rather than a permanent cross-version guarantee.

**Next action:** from the clean Phase 6 completion commit, run `cd /Users/paolof/Developer/ai/pi-claude-bridge && npm pack`, then continue only with the Phase 7 tarball installation and platform matrix.

### Phase 7: Packaging and platform verification (completed 2026-07-23)

1. [x] Ran `npm pack` and inspected the complete archive inventory.
2. [x] Installed the tarball into clean consumer projects outside the repository.
3. [x] Started authenticated queries and asserted `system:init.claude_code_version === "2.1.218"`.
4. [x] Proved the SDK selected its installed platform package while a sanitized `PATH` could not resolve `claude`.
5. [x] Proved `pathToClaudeCodeExecutable` selected and invoked an external wrapper.
6. [x] Tested the declared minimum Node `22.19.0` and current Node LTS `24.18.0`.
7. [x] Checked every platform package declared by Agent SDK `0.3.218`, using runtime execution where available and clean target-resolution installs elsewhere.

#### Phase 7 completion record

The packaging host was Darwin arm64. The repository started at `c481062bf473a0316952a958933dbfd2ebdbf3fd` with only the unrelated, untracked `docs/claude-config-isolation.md`. The installed SDK metadata and native executable reported Agent SDK `0.3.218` and Claude Code `2.1.218`.

The live [Node.js releases page](https://nodejs.org/en/about/previous-releases) reported Node `24.18.0` (Krypton) as LTS on 2026-07-23; Node `26.5.0` was Current rather than LTS. Official Darwin arm64 archives for `22.19.0` and `24.18.0` were downloaded from `nodejs.org`, verified against each release's `SHASUMS256.txt`, and extracted under `/tmp/pi-claude-bridge-phase7-runtimes`.

##### Package creation and inventory

The package was created and inspected with:

```sh
rm -rf .test-output/phase7/package
mkdir -p .test-output/phase7/package
npm pack --json --pack-destination .test-output/phase7/package | tee .test-output/phase7/npm-pack.json
shasum -a 256 .test-output/phase7/package/pi-claude-bridge-0.6.2.tgz
tar -tzf .test-output/phase7/package/pi-claude-bridge-0.6.2.tgz | tee .test-output/phase7/tar-inventory.txt
```

`npm pack` produced:

- Tarball: `pi-claude-bridge-0.6.2.tgz`.
- Packed size: `201630` bytes.
- Unpacked size: `292592` bytes.
- Entries: `18`.
- npm SHA-1: `3947d75fa7e262b1a5f8dbdc66b7db261a153489`.
- npm integrity: `sha512-BihuA3rpbUQQx86eIhePLB5OayenGy5ZpqNgYY//z+uJCqOPglAz7R6lUpZd7V7MmV25k3o3Nntx8gHtPTQyEw==`.
- Independent SHA-256: `6233392579f893f9094a471b365144e0a91926c27b6c7cc09c4637669cd006dd`.

Complete archive inventory:

```text
package/LICENSE
package/package.json
package/README.md
package/assets/claude-bridge1.png
package/assets/claude-bridge2.png
package/src/agents-md.ts
package/src/askclaude-ui.ts
package/src/config.ts
package/src/convert.ts
package/src/extract-tool-results.ts
package/src/index.ts
package/src/models.ts
package/src/query-state.ts
package/src/sdk-messages.ts
package/src/sdk-options.ts
package/src/session-verify.ts
package/src/skills.ts
package/src/typebox-to-zod.ts
```

The archive contains every file selected by the package's `files` allowlist (`src`, `README.md`, `LICENSE`, and `assets`) plus npm's required `package.json`. It contains no tests, local environment files, `.test-output` artifacts, repository metadata, upgrade documents, or configuration-isolation material. The archived manifest retains Node `>=22.19.0`, exact Agent SDK `0.3.218`, and no standalone `@anthropic-ai/claude-code` dependency.

##### Clean consumer and authenticated executable checks

The primary consumer was created outside the repository at `/tmp/pi-claude-bridge-phase7-consumer-node24`. The minimum-Node consumer used the equivalent path ending in `node22`. The clean-install procedure was:

```sh
TARBALL=/Users/paolof/Developer/ai/pi-claude-bridge/.test-output/phase7/package/pi-claude-bridge-0.6.2.tgz
CONSUMER=/tmp/pi-claude-bridge-phase7-consumer-node24
NODE_HOME=/tmp/pi-claude-bridge-phase7-runtimes/node-v24.18.0-darwin-arm64
rm -rf "$CONSUMER" && mkdir -p "$CONSUMER" && cd "$CONSUMER"
export PATH="$NODE_HOME/bin:/usr/bin:/bin"
npm init -y
npm install "$TARBALL" \
  @earendil-works/pi-ai@0.80.3 \
  @earendil-works/pi-coding-agent@0.80.3 \
  @earendil-works/pi-tui@0.80.3
npm ls --all --json > npm-ls-all.json
npm ls pi-claude-bridge @anthropic-ai/claude-agent-sdk \
  @anthropic-ai/claude-agent-sdk-darwin-arm64 @anthropic-ai/sdk \
  @modelcontextprotocol/sdk zod cc-session-io \
  @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-tui
```

Both Darwin arm64 consumers returned `npm-ls-problems=[]`. They resolved bridge `0.6.2`, Agent SDK `0.3.218`, the matching `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.218`, Anthropic SDK `0.113.0`, MCP SDK `1.29.0`, Zod `4.4.3`, `cc-session-io 0.3.1`, and all three Pi peers at `0.80.3`. Unmatched SDK platform packages remained normal omitted optional dependencies rather than invalid relationships.

A temporary consumer-local harness imported the Agent SDK dependency installed by the tarball, used `spawnClaudeCodeProcess` to capture the selected command, set the query's `PATH` to `/usr/bin:/bin`, and first asserted that `claude --version` failed with `ENOENT` under that path. The authenticated command was:

```sh
cd /tmp/pi-claude-bridge-phase7-consumer-node24
PATH=/tmp/pi-claude-bridge-phase7-runtimes/node-v24.18.0-darwin-arm64/bin:/usr/bin:/bin \
  node phase7-auth-query.mjs
```

The query returned the requested marker, a successful terminal result, and `system:init.claude_code_version === "2.1.218"`. The captured executable was `/private/tmp/pi-claude-bridge-phase7-consumer-node24/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, which matched the installed optional platform package by real path. No `claude` executable was available from the query's `PATH`.

The override check used a consumer-local executable wrapper that wrote a non-secret invocation marker and then executed the bundled binary. It ran with:

```sh
node phase7-auth-query.mjs \
  /tmp/pi-claude-bridge-phase7-consumer-node24/phase7-claude-override \
  /tmp/pi-claude-bridge-phase7-consumer-node24/phase7-override-invoked.txt
```

The spawn hook selected the wrapper, the marker contained `invoked`, the wrapped authenticated query succeeded, and `system:init` still reported `2.1.218`. This proves `pathToClaudeCodeExecutable` takes precedence over the bundle.

The clean install also reported 10 npm audit advisories (9 moderate and 1 high) in the transitive consumer graph. `npm ls` remained valid. No audit fix was applied because it would change the exact SDK/Pi compatibility baseline and was not a packaging-resolution fix.

##### Node runtime matrix

| Node runtime | npm | Clean install and `npm ls` | Authenticated installed-tarball query | Result |
| --- | ---: | --- | --- | --- |
| `22.19.0` (declared minimum) | `10.9.3` | Passed; `327` packages installed and no `npm ls` problems | Passed natively on Darwin arm64; bundled selection and `system:init 2.1.218` asserted with no `claude` on sanitized `PATH` | Passed |
| `24.18.0` (current LTS) | `11.16.0` | Passed; `335` packages installed and no `npm ls` problems | Passed natively on Darwin arm64; bundled selection, override, and `system:init 2.1.218` asserted | Passed |

##### Platform package matrix

For Linux, clean containers used `node:24.18.0-bookworm-slim` for glibc and `node:24.18.0-alpine` for musl. Each container created `/consumer`, installed the tarball and exact Pi `0.80.3` peers, required an empty `npm ls --all --json` problems array, ran the selected native binary with `--version`, and started an unauthenticated SDK query with no `claude` on `PATH`. The query emitted `system:init 2.1.218` from the selected package before the expected not-logged-in terminal error. Credentials were not copied into containers.

The four Linux checks used these exact target, image, and package combinations with a common clean-container command body:

```sh
TARBALL="$PWD/.test-output/phase7/package/pi-claude-bridge-0.6.2.tgz"
PROBE="$PWD/.test-output/phase7/platform-probe.mjs"

run_linux_target() {
  TARGET="$1"
  IMAGE="$2"
  PLATFORM_PACKAGE="$3"
  docker run --rm --platform "$TARGET" \
    -v "$TARBALL:/artifact/package.tgz:ro" \
    -v "$PROBE:/artifact/probe.mjs:ro" \
    -e PHASE7_PLATFORM_PACKAGE="$PLATFORM_PACKAGE" \
    "$IMAGE" sh -lc '
      set -eu
      mkdir /consumer && cd /consumer
      npm init -y >/dev/null
      npm install --loglevel=error /artifact/package.tgz \
        @earendil-works/pi-ai@0.80.3 \
        @earendil-works/pi-coding-agent@0.80.3 \
        @earendil-works/pi-tui@0.80.3
      npm ls --all --json > /tmp/npm-ls-all.json
      node -e "const x=require(\"/tmp/npm-ls-all.json\"); if ((x.problems??[]).length) throw Error(JSON.stringify(x.problems))"
      npm ls pi-claude-bridge @anthropic-ai/claude-agent-sdk "$PHASE7_PLATFORM_PACKAGE"
      node /artifact/probe.mjs
    '
}

run_linux_target linux/arm64 node:24.18.0-bookworm-slim @anthropic-ai/claude-agent-sdk-linux-arm64
run_linux_target linux/amd64 node:24.18.0-bookworm-slim @anthropic-ai/claude-agent-sdk-linux-x64
run_linux_target linux/arm64 node:24.18.0-alpine @anthropic-ai/claude-agent-sdk-linux-arm64-musl
run_linux_target linux/amd64 node:24.18.0-alpine @anthropic-ai/claude-agent-sdk-linux-x64-musl
```

Windows target checks used clean Node `24.18.0` containers. The exact npm target-resolution commands inside fresh `/consumer` directories were:

```sh
npm install --os=win32 --cpu=x64 /artifact/package.tgz \
  @earendil-works/pi-ai@0.80.3 \
  @earendil-works/pi-coding-agent@0.80.3 \
  @earendil-works/pi-tui@0.80.3
npm ls --all --json --os=win32 --cpu=x64
npm ls --os=win32 --cpu=x64 \
  pi-claude-bridge @anthropic-ai/claude-agent-sdk \
  @anthropic-ai/claude-agent-sdk-win32-x64

npm install --os=win32 --cpu=arm64 /artifact/package.tgz \
  @earendil-works/pi-ai@0.80.3 \
  @earendil-works/pi-coding-agent@0.80.3 \
  @earendil-works/pi-tui@0.80.3
npm ls --all --json --os=win32 --cpu=arm64
npm ls --os=win32 --cpu=arm64 \
  pi-claude-bridge @anthropic-ai/claude-agent-sdk \
  @anthropic-ai/claude-agent-sdk-win32-arm64
```

Separate temporary metadata probes verified the selected package metadata, the presence of `claude.exe`, and its `MZ` PE header without executing it.

| Declared SDK target | Selected optional package | Clean installation resolution | Runtime evidence |
| --- | --- | --- | --- |
| macOS arm64 | `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.218` | Passed on Node `22.19.0` and `24.18.0`; peers valid | Native `--version`, offline initialization, and authenticated SDK queries passed; `system:init 2.1.218` |
| macOS x64 | `@anthropic-ai/claude-agent-sdk-darwin-x64@0.3.218` | Passed in a clean x64 Node `24.18.0` consumer under Rosetta; no `npm ls` problems | Not claimed. The bundled Bun executable warned that Rosetta did not expose required AVX support and timed out, so physical Intel macOS execution remains unavailable |
| Linux arm64 glibc | `@anthropic-ai/claude-agent-sdk-linux-arm64@0.3.218` | Passed in clean `linux/arm64` Docker | Native Docker execution passed; `--version` and SDK-selected `system:init 2.1.218` |
| Linux x64 glibc | `@anthropic-ai/claude-agent-sdk-linux-x64@0.3.218` | Passed in clean `linux/amd64` Docker | Emulated Docker execution passed; `--version` and SDK-selected `system:init 2.1.218` |
| Linux arm64 musl | `@anthropic-ai/claude-agent-sdk-linux-arm64-musl@0.3.218` | Passed in clean Alpine `linux/arm64` Docker | Native Docker execution passed; `--version` and SDK-selected `system:init 2.1.218` |
| Linux x64 musl | `@anthropic-ai/claude-agent-sdk-linux-x64-musl@0.3.218` | Passed in clean Alpine `linux/amd64` Docker | Emulated Docker execution passed; `--version` and SDK-selected `system:init 2.1.218` |
| Windows x64 | `@anthropic-ai/claude-agent-sdk-win32-x64@0.3.218` | Passed with clean npm target resolution; `claude.exe` was `263931552` bytes with an `MZ` header | Not executed; no Windows runtime was available |
| Windows arm64 | `@anthropic-ai/claude-agent-sdk-win32-arm64@0.3.218` | Passed with clean npm target resolution; `claude.exe` was `258307232` bytes with an `MZ` header | Not executed; no Windows arm64 runtime was available |

All eight optional native packages declared by Agent SDK `0.3.218` resolved at the exact SDK version. Runtime execution is not claimed for macOS x64 or either Windows architecture. Linux x64 results used Docker emulation rather than x64 hardware. These are environment limitations, not observed package-resolution failures.

No production source, package manifest, lockfile, dependency, or persistent test change was needed in Phase 7. The repository currently has no GitHub Actions workflow. If CI is added, keep authenticated tests on trusted manual, scheduled, or protected runs so credentials are never exposed to untrusted pull requests.

**Phase 8 session handoff:** Confirm the active subscription tier and Extra Usage state, keep `ANTHROPIC_API_KEY` unset, then start model-behavior revalidation with `cd /Users/paolof/Developer/ai/pi-claude-bridge && env -u ANTHROPIC_API_KEY node diag/context-size.mjs pro` (replace `pro` only if the authenticated profile is on another documented tier). Do not alter Claude configuration or begin configuration-isolation work as part of that measurement.

### Phase 8: Revalidate model behavior (completed 2026-07-23)

1. [x] Re-ran the existing context-size diagnostic first on the authenticated Pro profile with Extra Usage disabled.
2. [x] Re-ran the complete bare versus `[1m]` matrix after the user enabled Extra Usage and accepted the metered-usage warning.
3. [x] Measured the documented `fable`, `opus`, `sonnet`, and `haiku` aliases.
4. [x] Verified bridge-level served-window parity for Haiku and for Fable with Pro Extra Usage enabled.
5. [x] Compared the target results with the Claude Code `2.1.141` measurements instead of carrying old policy forward.
6. [x] Added the focused Fable eligibility fix and regression coverage.

#### Phase 8 environment and account state

- Host: Darwin arm64, Node `v26.5.0`, npm `11.17.0`.
- Agent SDK: `@anthropic-ai/claude-agent-sdk` `0.3.218`.
- Bundled and selected Claude Code: `2.1.218`.
- Authentication: subscription OAuth with `ANTHROPIC_API_KEY` unset in every authenticated command.
- Directly tested tier: Pro only.
- Directly tested Extra Usage states: disabled, then enabled after explicit user confirmation.
- Max, Team, Enterprise, API-key authentication, and other accounts were not tested.
- The user's statement that Fable 5 works on Max was used only to preserve existing Max behavior. It is not recorded as a measured Max result.

#### Exact commands

Initial state and dependency checks:

```sh
cd /Users/paolof/Developer/ai/pi-claude-bridge
git branch --show-current
git rev-parse HEAD
git status --short
npm ls @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk \
  @modelcontextprotocol/sdk zod cc-session-io \
  @earendil-works/pi-ai @earendil-works/pi-coding-agent \
  @earendil-works/pi-tui
node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --version
npm ls @anthropic-ai/claude-code --all
npm run typecheck
npm run test:unit
```

The first command below ran only after the user confirmed Pro with Extra Usage disabled. The second ran only after the user enabled Extra Usage and acknowledged that eligible calls could consume metered credits:

```sh
cd /Users/paolof/Developer/ai/pi-claude-bridge
env -u ANTHROPIC_API_KEY node diag/context-size.mjs pro
env -u ANTHROPIC_API_KEY node diag/context-size.mjs pro
env -u ANTHROPIC_API_KEY node diag/model-aliases.mjs pro on
env -u ANTHROPIC_API_KEY node --import tsx tests/int-served-window.mjs
```

The focused bridge-level Fable check used a temporary Pi project configuration and removed it on exit:

```sh
set -eu
ROOT=/Users/paolof/Developer/ai/pi-claude-bridge
WORK=$(mktemp -d /tmp/pi-claude-bridge-phase8-fable.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/.pi" "$ROOT/.test-output"
printf '%s\n' '{"provider":{"plan":"pro","longContextExtraUsage":true}}' \
  > "$WORK/.pi/claude-bridge.json"
: > "$ROOT/.test-output/phase8-fable-debug.log"
cd "$WORK"
env -u ANTHROPIC_API_KEY \
  CLAUDE_BRIDGE_DEBUG=1 \
  CLAUDE_BRIDGE_DEBUG_PATH="$ROOT/.test-output/phase8-fable-debug.log" \
  pi --no-session -ne -e "$ROOT" \
  --model claude-bridge/claude-fable-5 \
  -p 'Reply with just the word "yes".'
grep 'result: served contextWindow=' \
  "$ROOT/.test-output/phase8-fable-debug.log"
```

The final local verification commands are:

```sh
cd /Users/paolof/Developer/ai/pi-claude-bridge
npm run typecheck
npm run test:unit
npm ls
git diff --check
git status --short
```

Pi LSP diagnostics reported no errors for the changed TypeScript/JavaScript files, and the final `lens_diagnostics mode=all` error query had no remaining error-level findings. A full advisory scan also surfaced pre-existing warnings in unchanged ranges, including five empty-catch findings in `src/index.ts`; those were deferred for this session rather than expanding Phase 8 into an unrelated cleanup.

#### Direct measurements

Raw reports were saved under the ignored `.test-output/context-size/` directory:

- Pro, Extra Usage disabled: `pro-2026-07-23T21-22-19-695Z.{json,md}`.
- Pro, Extra Usage enabled: `pro-2026-07-23T21-26-26-003Z.{json,md}`.
- Pro alias resolution, Extra Usage enabled: `pro-extra-on-aliases-2026-07-23T21-38-11-147Z.{json,md}`.

Every report recorded Agent SDK `0.3.218`, Claude Code `2.1.218`, and `ANTHROPIC_API_KEY=false`. Every alias row also reported `system:init.claude_code_version === "2.1.218"`. In the disabled run, rate-limit events reported `overageStatus: "rejected"` and `overageDisabledReason: "org_level_disabled"`. In the enabled run, overage was allowed; Fable reported `rateLimitType: "overage"` and `overageInUse: true`, directly confirming that its probes used the Extra Usage path.

Values below are served input context / maximum output tokens. `429` means Extra Usage credits were required. `400` means that the requested long-context form was incompatible with subscription OAuth.

| Requested model ID | Pro, Extra disabled | Pro, Extra enabled | Direct conclusion |
| --- | ---: | ---: | --- |
| `claude-opus-4-8` | 1M / 64K | 1M / 64K | Bare now serves 1M |
| `claude-opus-4-8[1m]` | 1M / 64K | 1M / 64K | Explicit 1M remains valid |
| `claude-opus-4-7` | 1M / 64K | 1M / 64K | Bare remains 1M |
| `claude-opus-4-7[1m]` | 1M / 64K | 1M / 64K | Explicit 1M remains valid |
| `claude-opus-4-6` | 200K / 64K | 200K / 64K | Bare remains 200K |
| `claude-opus-4-6[1m]` | 429 | 1M / 64K | Extra Usage required on Pro |
| `claude-fable-5` | 429 | 1M / 64K | Entire model requires Extra Usage on Pro |
| `claude-fable-5[1m]` | 429 | 1M / 64K | Same gate; successful result canonicalizes to bare served ID |
| `claude-sonnet-5` | 1M / 64K | 1M / 64K | Bare now serves 1M |
| `claude-sonnet-5[1m]` | 1M / 64K | 1M / 64K | Explicit 1M remains valid |
| `claude-sonnet-4-6` | 200K / 32K | 200K / 32K | Bare remains 200K |
| `claude-sonnet-4-6[1m]` | 429 | 1M / 32K | Extra Usage required on Pro |
| `claude-haiku-4-5` | 200K / 32K | 200K / 32K | Bare remains 200K |
| `claude-haiku-4-5[1m]` | 400 | 400 | Not eligible for 1M through subscription OAuth |

Direct alias results on Pro with Extra Usage enabled:

| Requested alias | `system:init.model` and served model | Served input / max output |
| --- | --- | ---: |
| `fable` | `claude-fable-5` | 1M / 64K |
| `opus` | `claude-opus-4-8` | 1M / 64K |
| `sonnet` | `claude-sonnet-5` | 1M / 64K |
| `haiku` | `claude-haiku-4-5-20251001` | 200K / 32K |

The Haiku alias result also reported canonical model `claude-haiku-4-5`. Alias resolution with Extra Usage disabled was not directly tested. In particular, `fable` while Extra Usage was disabled is inferred to hit the same credit gate from the directly measured full-ID rejection and the enabled alias mapping; it is not presented as a direct measurement.

Bridge-level served-window checks passed:

- Existing authenticated check: `claude-haiku-4-5` reported served `200000`, registered `200000`, max output `32000`.
- Focused Extra Usage check: `claude-fable-5` reported served `1000000`, registered `1000000`, max output `64000`.
- The served input values come from `result.modelUsage[*].contextWindow`. Phase 8 did not send payloads close to each limit, so this is direct served-limit metadata rather than a boundary-size stress test.

#### Differences from Claude Code 2.1.141

- Bare Opus 4.8 changed from 200K to 1M on the tested Pro account.
- Bare Sonnet 5 changed from 200K to 1M on the tested Pro account.
- Fable 5 changed from available in the earlier Pro/no-Extra record to fully credit-gated in the current Pro/no-Extra measurement.
- The bridge's existing `[1m]` requests for Opus 4.8 and Sonnet 5 still receive 1M, so those changes required no compatibility adaptation.
- Opus 4.6, Sonnet 4.6, and Haiku long-context eligibility remained consistent with the prior Pro measurements.

#### Focused implementation change

The new Fable behavior exposed a real bridge defect: the Pro/no-Extra model picker registered Fable 5 even though every request failed with HTTP 429. Phase 8 made only these model/context changes:

- `src/models.ts` now treats `fable`, `claude-fable-5`, and `claude-fable-5[1m]` as unavailable when configured for Pro without `longContextExtraUsage`.
- Provider registration omits the ineligible Fable model. Shared model-ID conversion rejects stale or explicit ineligible Fable selections before spawning Claude Code.
- `src/index.ts` applies the same guard to raw AskClaude model IDs that do not resolve through the registered model list.
- Max behavior is preserved by policy, but remains unmeasured in this phase. Pro with Extra Usage enabled was directly verified at served and registered 1M.
- `tests/unit-models.mjs` covers Pro rejection/filtering and preservation for Max and Pro/Extra-on policy, bringing the unit total to 126 tests across 37 suites.
- `diag/model-aliases.mjs` provides a repeatable authenticated alias measurement with explicit tier/Extra labels, saved raw reports, per-row `system:init` versions, rate-limit details, and metered-use warning.
- `src/config.ts` and `CHANGELOG.md` describe the new Fable eligibility rule.

No dependency, package manifest, lockfile, standalone Claude Code package, `cc-session-io`, configuration-isolation, publishing, or release-preparation change was made.

#### Measured, inferred, and unavailable coverage

- Directly measured: Pro with Extra Usage disabled and enabled; every listed bare and `[1m]` ID; the four documented aliases with Extra Usage enabled; Haiku and Fable bridge-level served-window parity.
- Inferred only: disabled-state alias behavior where a directly measured full ID and enabled-state alias resolve to the same canonical model.
- Not tested: Max, Team, Enterprise, API-key authentication, other accounts, aliases with Extra Usage disabled, and near-limit payload boundary behavior.
- Max Fable support is preserved because the user reported it and the bridge already allowed it, but Phase 8 makes no authenticated Max coverage claim.

#### Phase 9 handoff

**Next action:** from the clean Phase 8 completion commit, update `diag/CONTEXT-SIZE.md` from the three raw reports listed above before changing release or configuration-isolation documentation. Then complete the remaining Phase 9 documentation and local candidate-package checks. Do not publish until those Phase 9 checks pass.

### Phase 9: Documentation and release-candidate verification (completed 2026-07-23)

1. [x] Updated `diag/CONTEXT-SIZE.md` first from the three Phase 8 target-binary reports.
2. [x] Separated directly measured, inferred, user-reported, historical, and untested model/account states.
3. [x] Replaced stale current-behavior claims from Claude Code `2.1.141` with Agent SDK `0.3.218` and bundled Claude Code `2.1.218` results.
4. [x] Read and updated the pre-existing untracked `docs/claude-config-isolation.md` without implementing its design.
5. [x] Corrected the non-interactive `/config key=value` assessment: it was added in Claude Code `2.1.181` and is supported by the bundled `2.1.218`; interactive configuration interfaces still require a terminal.
6. [x] Reviewed the existing `CHANGELOG.md` `## UNRELEASED` section. It already covers the SDK upgrade, Fable fix, and compatibility tests, so no duplicate section or docs-only entry was added.
7. [x] Built and completely inspected a local npm candidate archive.
8. [x] Installed the tarball in a clean consumer outside the repository and passed an unauthenticated installed-tarball provider smoke test.
9. [x] Re-ran dependency, type, unit, LSP, lens, archive, manifest, clean-consumer, and diff checks.
10. [x] Confirmed that no package was published and no registry or publishing configuration changed.

#### Phase 9 documentation results

- `diag/CONTEXT-SIZE.md` now records the complete Claude Code `2.1.218` Pro matrix for Extra Usage disabled and enabled, the enabled-state alias mapping, bridge served-window parity, raw artifact names, error shapes, and evidence boundaries.
- Direct Phase 8 coverage remains Pro subscription OAuth only, with `ANTHROPIC_API_KEY` unset and Extra Usage measured both disabled and enabled.
- Disabled-state alias behavior is inferred rather than directly measured. The user-reported Max Fable behavior remains labeled as user-reported.
- Max, Team, Enterprise, API-key authentication, other accounts, aliases with Extra Usage disabled, and near-limit payload behavior remain untested.
- `docs/claude-config-isolation.md` now targets Agent SDK `0.3.218` and Claude Code `2.1.218`, records the passing 126-test baseline, removes the obsolete bundled-binary skew assessment, and distinguishes supported non-interactive `/config key=value` from terminal-only interfaces.
- Configuration isolation remains design and documentation only. No `CLAUDE_CONFIG_DIR` default, profile relocation, session-path change, or configuration command was implemented.
- `CHANGELOG.md` was reviewed but left unchanged because its existing single `## UNRELEASED` section already describes the significant release behavior and Phase 9 itself changed documentation only.

#### Exact Phase 9 verification commands

Initial state, dependency, and baseline checks:

```sh
cd /Users/paolof/Developer/ai/pi-claude-bridge
git branch --show-current
git rev-parse HEAD
git status --short
npm ls @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk \
  @modelcontextprotocol/sdk zod cc-session-io \
  @earendil-works/pi-ai @earendil-works/pi-coding-agent \
  @earendil-works/pi-tui
node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --version
npm ls @anthropic-ai/claude-code --all
npm run typecheck
npm run test:unit
```

These confirmed branch `feat/upgrade-sdk`, starting commit `c4ebc22f25838dc0b5a9ba2721c44ab513e14727`, and the expected initial status containing only `?? docs/claude-config-isolation.md`. The Agent SDK was exact `0.3.218`, the selected bundled binary reported `2.1.218`, the aligned runtime peers remained `0.113.0`, `1.29.0`, and `4.4.3`, `cc-session-io` remained `0.3.1`, all three Pi development packages remained `0.80.3`, and no standalone Claude Code package was installed. Typechecking passed and all 126 unit tests passed across 37 suites with 0 failures.

Candidate creation and complete archive inspection:

```sh
ROOT=/Users/paolof/Developer/ai/pi-claude-bridge
OUT="$ROOT/.test-output/phase9/package"
rm -rf "$ROOT/.test-output/phase9" /tmp/pi-claude-bridge-phase9-consumer
mkdir -p "$OUT" "$ROOT/.test-output/phase9/extracted"
cd "$ROOT"
npm pack --json --pack-destination "$OUT" | tee "$ROOT/.test-output/phase9/npm-pack.json"
TARBALL="$OUT/pi-claude-bridge-0.6.2.tgz"
shasum -a 256 "$TARBALL"
tar -tzvf "$TARBALL" | tee "$ROOT/.test-output/phase9/tar-inventory.txt"
tar -xzf "$TARBALL" -C "$ROOT/.test-output/phase9/extracted"
node /tmp/pi-claude-bridge-phase9-manifest-check.mjs
```

The temporary manifest assertion script read the extracted `package/package.json` and required `engines.node === ">=22.19.0"`, `dependencies["@anthropic-ai/claude-agent-sdk"] === "0.3.218"`, and no `dependencies["@anthropic-ai/claude-code"]`. All assertions passed.

`npm pack` produced:

- Tarball: `pi-claude-bridge-0.6.2.tgz`.
- Packed size: `201941` bytes.
- Unpacked size: `293661` bytes.
- Entries: `18`.
- npm SHA-1: `bc2dcb0ef5193a5f09ea7afab006fb1407268dcc`.
- npm integrity: `sha512-arf2+PNxThWKnJorDTnXXr2N7cYjlj7ONKmBrfE3kP1u2G5kbyBLPj2nnoHoH/Egmbo104OT9vbIoBvkJZaYLA==`.
- Independent SHA-256: `aa63ce00407f307161cdb9113415580f455740c44283fa57e42d9311c2917e05`.

Complete archive inventory:

```text
package/LICENSE
package/package.json
package/README.md
package/assets/claude-bridge1.png
package/assets/claude-bridge2.png
package/src/agents-md.ts
package/src/askclaude-ui.ts
package/src/config.ts
package/src/convert.ts
package/src/extract-tool-results.ts
package/src/index.ts
package/src/models.ts
package/src/query-state.ts
package/src/sdk-messages.ts
package/src/sdk-options.ts
package/src/session-verify.ts
package/src/skills.ts
package/src/typebox-to-zod.ts
```

The archive contains the package allowlist plus npm's required manifest. It contains no tests, upgrade or isolation documents, `.test-output` artifacts, environment files, repository metadata, or secrets.

Clean consumer installation and offline tarball smoke:

```sh
ROOT=/Users/paolof/Developer/ai/pi-claude-bridge
TARBALL="$ROOT/.test-output/phase9/package/pi-claude-bridge-0.6.2.tgz"
CONSUMER=/tmp/pi-claude-bridge-phase9-consumer
rm -rf "$CONSUMER"
mkdir -p "$CONSUMER"
cd "$CONSUMER"
npm init -y
npm install "$TARBALL" \
  @earendil-works/pi-ai@0.80.3 \
  @earendil-works/pi-coding-agent@0.80.3 \
  @earendil-works/pi-tui@0.80.3
npm ls --all --json > npm-ls-all.json
node -e 'const x=require("./npm-ls-all.json"); const p=x.problems??[]; console.log(`npm-ls-problems=${JSON.stringify(p)}`); if(p.length) process.exit(1)'
npm ls pi-claude-bridge @anthropic-ai/claude-agent-sdk \
  @anthropic-ai/claude-agent-sdk-darwin-arm64 @anthropic-ai/sdk \
  @modelcontextprotocol/sdk zod cc-session-io \
  @earendil-works/pi-ai @earendil-works/pi-coding-agent \
  @earendil-works/pi-tui
npm ls @anthropic-ai/claude-code --all || true
node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --version
```

The clean consumer installed 335 packages and reported `npm-ls-problems=[]`. It resolved bridge `0.6.2`, Agent SDK and Darwin arm64 package `0.3.218`, Anthropic SDK `0.113.0`, MCP SDK `1.29.0`, Zod `4.4.3`, `cc-session-io 0.3.1`, and all three Pi packages at `0.80.3`. The standalone Claude Code query was empty, and the bundled executable reported `2.1.218`. npm reported the same 10 transitive advisories seen in Phase 7 (9 moderate and 1 high); no audit fix was applied because it would change the verified dependency baseline.

The first clean-consumer script used `set -e` and stopped after the expected-empty standalone `npm ls` returned exit status 1. Installation and `npm-ls-problems=[]` had already passed. The command was repeated with `|| true`, then the bundled-version and smoke checks passed. This was a shell expectation issue, not a package-resolution failure.

The installed-tarball smoke created a temporary project configuration pointing `provider.pathToClaudeCodeExecutable` at `tests/fixtures/fake-claude-cli.mjs`, then ran:

```sh
cd /tmp/pi-claude-bridge-phase9-consumer/smoke-project
env -u ANTHROPIC_API_KEY \
  FAKE_CLAUDE_VERSION=2.1.218 \
  FAKE_CLAUDE_RESPONSE=phase9-candidate-smoke \
  /tmp/pi-claude-bridge-phase9-consumer/node_modules/.bin/pi \
    --no-session -ne \
    -e /tmp/pi-claude-bridge-phase9-consumer/node_modules/pi-claude-bridge \
    --model claude-bridge/claude-haiku-4-5 \
    -p 'Return the configured offline smoke marker.'
```

The installed extension returned `phase9-candidate-smoke`. This test was unauthenticated, kept `ANTHROPIC_API_KEY` unset, and could not consume Extra Usage.

Final repository checks:

```sh
cd /Users/paolof/Developer/ai/pi-claude-bridge
npm run typecheck
npm run test:unit
npm ls
npm ls @anthropic-ai/claude-code --all
node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --version
git diff --check
git status --short
```

Typechecking passed. Unit tests passed 126/126 across 37 suites. `npm ls` was valid and retained the exact upgrade baseline, the standalone Claude Code tree was empty, and the bundled executable remained `2.1.218`. The primary TypeScript LSP scanned all 13 source files and reported no diagnostics. Markdown LSP checks confirmed two changed documents without findings; `diag/CONTEXT-SIZE.md` remained unconfirmed after a 60-second timeout, with no auxiliary findings. The scoped full lens check found no issues across the two documents it diagnosed and reported the same context-document LSP timeout; the final `mode=all` lens check found no issues across 14 files diagnosed in the session. `git diff --check` passed.

No authenticated or metered probe ran in Phase 9. Extra Usage remained enabled at handoff from Phase 8, but Phase 9 did not inspect or change that account setting. No package was published.

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
