# Claude Code 2.1.220 and Claude Opus 5 update plan

<!-- markdownlint-disable MD013 -->

**Status (2026-07-26):** Analysis and implementation plan only. No production dependency or source change has been applied. The 2026-07-25 analysis is retained below; the 2026-07-26 reassessment supersedes its Pi version, model-catalog, dependency, and effort-mapping conclusions.

## Reassessment (2026-07-26)

### Conclusion

**The model-catalog blocker is resolved in a published package.** `@earendil-works/pi-ai@0.82.1` (published `2026-07-25T12:46:52Z`) ships a `claude-opus-5` row in the Anthropic catalog that `getModels("anthropic")` returns. Option A is no longer a wait; it is the implementable path today. Options B and C stay rejected.

### Repository state analysed

| Repository | Branch | Commit | Worktree |
| --- | --- | --- | --- |
| `pi-claude-bridge` | `feat/claude-config-isolation` | `732ea207dfad7f8c9469b84dc0da8096600b477f` | Three unrelated formatting-only modifications in `tests/int-config-isolation.mjs`, `tests/lib/claude-auth.mjs`, `tests/unit-agents-md.mjs`, left untouched |
| `pi` (personal fork) | `personal` | `71f82a1e2b9d7b620c75ad71b51e27c4749971c0` (`2026-07-26 09:56:27 +0200`, "feat: bound pi exec output and add configurable project-wide prompt history") | Clean |

Bridge remotes: `origin` → `pfurini/pi-claude-bridge`, `upstream`/`elidickinson` → `elidickinson/pi-claude-bridge`.
Pi remotes: `origin` → `pfurini/pi`, `upstream`/`earendil-works` → `earendil-works/pi`.

The Pi fork is 13 commits ahead of the fetched `upstream/main` (`5bc1c2c0`), and `upstream/main` is an ancestor of `HEAD`. All local package versions (`pi-ai`, `pi-coding-agent`, `pi-tui`, `pi-agent`) are `0.82.1`.

Relevant recent Pi commits touching models: `af3b934f feat(ai): support Claude Opus 5 on Bedrock (#7081)` and `921c3543 add opus-5 models settings (#7083)`.

### The four-way distinction that the earlier analysis conflated

Working from the local checkout alone is misleading here, because Pi's generated model data is **not** checked into git.

1. **Support present in tracked local source.** `packages/ai/scripts/generate-models.ts` carries explicit Opus 5 rules: adaptive-thinking recognition (`isAnthropicAdaptiveThinkingModel`, line ~490), temperature-unsupported classification (`isAnthropicTemperatureUnsupportedModel`, line ~507), the effort map merge `{ xhigh: "xhigh", max: "max" }` (line ~775), and the Bedrock inference-profile-only set (line ~295). Tests referencing Opus 5 live in `packages/ai/test/supports-xhigh.test.ts`, `anthropic-adaptive-thinking-models.test.ts`, `bedrock-models.test.ts`, and `bedrock-thinking-payload.test.ts`.
2. **Generated catalog data present in the local checkout.** `packages/ai/src/providers/data/anthropic.json` contains `claude-opus-5`, but `.gitignore:11` ignores `packages/ai/src/providers/data/`. That file is an untracked local build artifact produced by `npm run generate-models`, not source. `packages/ai/src/models.generated.ts` contains no model IDs at all (commits `a9f6a315` and `5dc40fee` moved data into per-provider JSON); `packages/ai/src/providers/anthropic.models.ts` is a four-line shim importing that JSON. Grepping `models.generated.ts` for `claude-opus-5` returns nothing and means nothing.
3. **Package version declared by the local source.** `0.82.1`, identical to the newest published release.
4. **Support in an actually published package.** Verified by unpacking the registry tarballs: `@earendil-works/pi-ai@0.82.0` (published `2026-07-24T06:11:35Z`) has 14 Anthropic rows and **no** `claude-opus-5`; `@earendil-works/pi-ai@0.82.1` has 15 rows **including** `claude-opus-5`. `pi-coding-agent` and `pi-tui` are also at `0.82.1` (lockstep releases).

Because the data directory is gitignored and regenerated at `prepublishOnly` (`build` → `generate-models` → `build:offline`), the presence of the row in *future* releases is a property of the generator plus upstream models.dev data, not of Pi source. `npm run check:model-data` (`scripts/check-model-data.ts` → `validateGeneratedModelData`) only validates structure and staleness of the data directory; **there is no required-model assertion**, so no forward guarantee exists. The effort map and compat flags, by contrast, are guaranteed by tracked generator rules whenever the row exists.

### Verified Opus 5 Pi model metadata

Identical byte-for-byte between the local checkout's generated data and the published `0.82.1` tarball, and returned by `getModels("anthropic")` — the exact compatibility API `src/index.ts:3` imports:

```json
{
  "id": "claude-opus-5",
  "name": "Claude Opus 5",
  "api": "anthropic-messages",
  "provider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "reasoning": true,
  "input": ["text", "image"],
  "cost": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 },
  "contextWindow": 1000000,
  "maxTokens": 128000,
  "thinkingLevelMap": { "xhigh": "xhigh", "max": "max" },
  "compat": {
    "forceAdaptiveThinking": true,
    "supportsTemperature": false,
    "supportsStrictTools": true
  }
}
```

`getSupportedThinkingLevels` (`packages/ai/src/models.ts:663-672`) returns `["off","minimal","low","medium","high","xhigh","max"]` for Opus 5: `xhigh` and `max` are opt-in levels that require an explicit `thinkingLevelMap` entry, and Opus 5 has both. Pi therefore represents Opus 5's top two tiers as genuine, distinct `xhigh` and `max` levels — matching what Claude Code's `supportedModels()` reports.

### pi-ai 0.80.3 → 0.82.1 changes the effort behaviour of models the bridge already ships

This is a consequence of the dependency bump, independent of Opus 5, and the plan must own it. Comparing the catalog rows the bridge registers:

| Model | `thinkingLevelMap` at 0.80.3 | at 0.82.1 | Effect |
| --- | --- | --- | --- |
| `claude-fable-5` | `{off:null, xhigh:"xhigh"}` | `{off:null, xhigh:"xhigh", max:"max"}` | Picker gains a real `max` level |
| `claude-opus-4-8` | `{xhigh:"xhigh"}` | `{xhigh:"xhigh", max:"max"}` | Picker gains a real `max` level |
| `claude-opus-4-7` | `{xhigh:"xhigh"}` | `{xhigh:"xhigh", max:"max"}` | Picker gains a real `max` level |
| `claude-opus-4-6` | `{xhigh:"max"}` | `{max:"max"}` | Picker now offers `max` instead of `xhigh`; SDK effort is `max` either way |
| `claude-sonnet-5` | *(absent — bridge fallback `{xhigh:"max"}` applied)* | `{xhigh:"xhigh", max:"max"}` | **Behaviour change:** pi `xhigh` now sends SDK `xhigh` instead of SDK `max` |
| `claude-sonnet-4-6` | *(absent — bridge fallback `{xhigh:"max"}` applied)* | `{max:"max"}` | Picker now offers `max` instead of `xhigh`; SDK effort stays `max` |
| `claude-haiku-4-5` | absent | absent | Unchanged (no effort support) |

Every row also gains `compat.supportsStrictTools: true`, which `buildModels()` strips, so it has no bridge effect.

`claude-sonnet-4-6` additionally moves `maxTokens` from `64000` to `128000`. This was checked rather than assumed. `buildModels()` forwards `maxTokens` to Pi, and Pi does consume it: `packages/coding-agent/src/core/compaction/compaction.ts:637-639` and `937-939` clamp the summarization budget with `Math.min(..., model.maxTokens > 0 ? model.maxTokens : Infinity)` and pass the result as `SimpleStreamOptions.maxTokens`. The bridge, however, never reads `options.maxTokens` — the only references in `src/` are the projection at `src/models.ts:25` and `:28` — and the bridge owns compaction for its own models anyway. Claude Code applies its own output cap (64K on every model measured here) regardless of what Pi computed. The change is therefore inert on the request path and visible only in Pi-side computation and `--list-models` output. No bridge code change; record it in the changelog.

`buildModels()` merges with `thinkingLevelMap ?? DEFAULT_THINKING_LEVEL_MAPS[id]` (`src/models.ts:29`), so the catalog always wins when present. Under pi-ai `0.82.1` both entries in `DEFAULT_THINKING_LEVEL_MAPS` are dead code, and the `claude-sonnet-5` entry is now factually wrong: the comment at `src/models.ts:7-10` claims Sonnet 5 has "no real xhigh", while `supportedModels()` on Claude Code `2.1.220` reports `xhigh` as a supported effort level for Sonnet 5.

### Runtime evidence gathered on 2026-07-26

Isolated authenticated profile `~/.pi/agent/claude`, Pro subscription, `settingSources: []`, `strictMcpConfig: true`, Agent SDK `0.3.220` installed in a scratch directory, executable overridden to the SDK's own `darwin-arm64` binary.

Binary identity:

- `/Users/paolof/.local/bin/claude` → `/Users/paolof/.local/share/claude/versions/2.1.220`, reports `2.1.220 (Claude Code)`.
- Both the installed native binary and the SDK `0.3.220` `darwin-arm64` binary are 256,908,272 bytes with SHA-256 `8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081` — byte-identical, and matching the manifest entry exactly.
- `manifest.json`: `version 2.1.220`, `commit 4073f59596e272f39393db4f96abc5f4b10eff21`, `buildDate 2026-07-24T22:28:51Z`, 8 platform entries.
- `manifest.sdkCompat.testedWrapperVersions` includes `0.3.218` (and stops there) with `harnessSchema: 1`. The 0.3.218-wrapper-on-2.1.220 combination is an officially tested pairing, not merely an empirical one.

`supportedModels()` on the authenticated isolated profile returned five entries: `default` → `claude-sonnet-5`, `sonnet` → `claude-sonnet-5`, `claude-fable-5[1m]` → `claude-fable-5`, `opus` → `claude-opus-5`, `haiku` → `claude-haiku-4-5-20251001`. Opus 5 reports `supportedEffortLevels: ["low","medium","high","xhigh","max"]`, `supportsAdaptiveThinking: true`, `supportsAutoMode: true`, and is the **only** entry with `supportsFastMode: true`. The picker lists Opus 5 under the bare `opus` value with no `[1m]` variant, which corroborates bare `claude-opus-5` as the production request ID.

Live single-turn probes (both returned the exact marker):

| Probe | `init.model` | `init.claude_code_version` | `modelUsage` | Fast mode |
| --- | --- | --- | --- | --- |
| `model: "claude-opus-5"`, `effort: "xhigh"` | `claude-opus-5` | `2.1.220` | `contextWindow 1000000`, `maxOutputTokens 64000`, `canonicalModel claude-opus-5` | `state off`, `disabled_reason sdk_opt_in_required` |
| `model: "opus"`, `effort: "max"` | `claude-opus-5` | `2.1.220` | `contextWindow 1000000`, `maxOutputTokens 64000`, `canonicalModel claude-opus-5` | `state off`, `disabled_reason sdk_opt_in_required` |

`init.capabilities` on both runs: `["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"]`.

The `xhigh` probe is new: the 2026-07-25 pass covered `high` and `max` but never `xhigh`. Effort `xhigh` is accepted and served for Opus 5, so Pi's `xhigh` level maps to a genuine SDK tier and not a silent alias for `max`.

`fast_mode_disabled_reason: "sdk_opt_in_required"` is worth recording: fast mode is off by default for every SDK consumer regardless of account state, so the "leave fast mode off" decision costs nothing and requires no defensive configuration.

### Dependency trial in a detached worktree

A detached worktree at `732ea20` with unmodified bridge source, `@earendil-works/pi-{ai,coding-agent,tui}@0.82.1` and `@anthropic-ai/claude-agent-sdk@0.3.220`:

- `npm run typecheck` passed.
- `npm run test:unit` passed 150/150 across 41 suites.

Typecheck passing against unmodified bridge source is the evidence that `0.82.1` introduced no breaking change on the Pi surfaces the bridge consumes — `Model`, `SimpleStreamOptions`, `AssistantMessageEventStream`, `Context`, `Tool`, `ExtensionAPI`, `ExtensionUIContext`, and `registerProvider`'s model shape. No provider-registration or reasoning-UI change is required.

A registration simulation against the real `0.82.1` catalog in that worktree confirmed:

- With `MODEL_IDS_IN_ORDER` unchanged, `buildModels()` still drops `claude-opus-5`, and `resolveModel(models, "opus")` still returns `claude-opus-4-8`.
- Inserting `claude-opus-5` after `claude-fable-5` makes `resolveModel(models, "opus")` return `claude-opus-5`.
- Inserting the ID **alone is not sufficient**: `applyLongContext()` then logs `claude-bridge: encountered model claude-opus-5 with no known context size, defaulting to 200K` and registers the model at 200K. `resolveClaudeCodeRuntimeModel()` needs an explicit case in the same change.

### Prior findings: confirmed, amended, refuted

| # | Prior finding | Verdict |
| --- | --- | --- |
| 1 | Agent SDK `0.3.220` bundles Claude Code `2.1.220` | Confirmed |
| 2 | Binary 256,908,272 bytes, SHA-256 `8addc857…be081` | Confirmed; also byte-identical to the natively installed `2.1.220` |
| 3 | Opus 5 metadata (canonical ID, native 1M, `[1m]` accepted, 64K default / 128K capability, default effort high, five effort levels, adaptive thinking, fast mode) | Mostly confirmed by `supportedModels()` and live `modelUsage`. The 64K figure is Claude Code's default output cap; 128K is the model capability the Pi catalog records as `maxTokens`. **Two items remain static-inspection only:** the `high` default effort and the Opus 4.8 fallback metadata. `supportedModels()` reports which effort levels exist, not which is the default, and no probe omitted `effort` to observe it |
| 4 | Authenticated probes for bare ID, `high`, `max`, `[1m]`, alias `opus`, fast mode, and old SDK `0.3.218` on the `2.1.220` executable | Confirmed as prior evidence. Today's re-verification was **two combined probes, not three independent ones**: bare `claude-opus-5` at effort `xhigh` (new — `xhigh` was never probed on 2026-07-25), and alias `opus` at effort `max`. Bare-ID-at-`max` was therefore not re-run today; it rests on the 2026-07-25 evidence. `[1m]` and fast mode were not re-run at all. The 0.3.218-wrapper pairing is now known to be a manifest-declared tested combination |
| 5 | The bridge model list does not contain `claude-opus-5` | Confirmed (`src/models.ts:5`) |
| 6 | Published pi-ai `0.82.0` had no Opus 5 catalog row | Confirmed for `0.82.0`, **amended**: `0.82.1` (published one release later, `2026-07-25T12:46:52Z`) does have the row. The blocker is resolved |
| 7 | SDK-only upgrade to `0.3.220` passed the authenticated suite and typecheck | Confirmed, and extended: typecheck plus 150/150 unit tests also pass with pi packages raised to `0.82.1` |
| 8 | AskClaude read/full/none policies remain valid under `2.1.220` | Retained from the 2026-07-25 evidence; not re-run today. The binary is unchanged, so re-verification is an implementation-time gate, not a new risk |
| 9 | Fast mode should stay off by default | Confirmed and strengthened: SDK sessions report `fast_mode_disabled_reason: "sdk_opt_in_required"`, so it is off unless explicitly opted in |

Additional corrections to the 2026-07-25 text:

- "Pi main already contains Opus 5 reasoning handling and tests, but npm `0.82.0` was published without the model row" is stale. Replace with the four-way distinction above.
- The proposed defensive `{ xhigh: "xhigh" }` entry for Opus 5 is **not needed**. `buildModels()` treats `DEFAULT_THINKING_LEVEL_MAPS` as a fallback, and the catalog always supplies Opus 5's map.
- "Insert `claude-opus-5` before `claude-opus-4-8` (after Fable 5)" is still correct and is now empirically verified.
- `@earendil-works/pi-ai/compat`'s `getModels` is marked `@deprecated` at `0.82.1` in favour of `getBuiltinModels` from `@earendil-works/pi-ai/providers/all` or `Models.getModels()`. It still exports and works; migrating is a separate follow-up, not part of this update.

## Recommendation

Implement a focused compatibility update that:

1. Pins `@anthropic-ai/claude-agent-sdk` to `0.3.220`, which bundles Claude Code `2.1.220`.
2. Pins the Pi development packages at `0.82.1` and raises **only** the `@earendil-works/pi-ai` peer minimum to `>=0.82.1`.
3. Registers `claude-opus-5` ahead of older Opus models, makes the `opus` shortcut resolve to Opus 5, and sends the bare `claude-opus-5` ID because 1M is native and default.
4. Realigns `DEFAULT_THINKING_LEVEL_MAPS` and the stale Sonnet 5 rationale to what pi-ai `0.82.1` actually ships, and gives AskClaude the same model-aware effort lookup the provider already uses.
5. Emits a registration diagnostic when the installed pi-ai catalog does not supply a registered model ID, since the bridge loads into the user's pi-ai rather than the pinned one.
6. Adds Opus 5 model-policy, authenticated provider, AskClaude, context, alias, session, abort, packaging, and rollback coverage.
7. Does **not** auto-enable fast mode. Fast mode has different billing and prompt-cache behaviour and should be a separate explicit opt-in feature.

## Verified release facts

### Versions and provenance

| Item | Current project | Target verified on 2026-07-26 |
| --- | ---: | ---: |
| Claude Agent SDK | `0.3.218` | `0.3.220` |
| Bundled Claude Code | `2.1.218` | `2.1.220` |
| Installed system Claude Code | n/a | `2.1.220` (byte-identical to the SDK binary) |
| `@earendil-works/pi-ai` | `0.80.3` | `0.82.1` — **contains `claude-opus-5`** |
| `@earendil-works/pi-coding-agent` | `0.80.3` | `0.82.1` |
| `@earendil-works/pi-tui` | `0.80.3` | `0.82.1` |
| Local Pi fork packages | n/a | `0.82.1` at commit `71f82a1e` |

The installed Darwin arm64 `2.1.220` binary is 256,908,272 bytes with SHA-256 `8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081`, matching the Agent SDK `0.3.220` manifest. The manifest identifies Claude Code commit `4073f59596e272f39393db4f96abc5f4b10eff21` and build time `2026-07-24T22:28:51Z`.

Claude Code `2.1.219` introduced Opus 5 and the new behaviour; `2.1.220` is the follow-up bug-fix and reliability release:

- [Claude Code 2.1.219 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.219)
- [Claude Code 2.1.220 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.220)
- [Agent SDK 0.3.220 changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/71c804dc8f4a61c1dca6fe10d4b95a6b65d1396b/CHANGELOG.md#L1-L13)

### Opus 5 binary metadata

- Canonical ID: `claude-opus-5`.
- Family: Opus; display name: Opus 5.
- Native context window: 1,000,000 tokens; served as 1M for the bare ID with no suffix and no plan flag.
- The `[1m]` suffix remains accepted but is unnecessary, and `supportedModels()` does not advertise a `[1m]` variant for Opus 5.
- Default output cap in Claude Code: 64,000 tokens (observed in `modelUsage.maxOutputTokens`); model capability recorded by Pi: 128,000 tokens.
- Default effort: `high` — from the 2026-07-25 static inspection only; `supportedModels()` reports the supported levels, not the default, so this was not re-verified on 2026-07-26.
- Supported effort capabilities: `low`, `medium`, `high`, `xhigh`, and `max` — all five confirmed available, with `xhigh` now confirmed live.
- Adaptive thinking is supported and on by default; Pi's catalog sets `compat.forceAdaptiveThinking: true`.
- Fast mode is supported, and Opus 5 is the only model in the picker that advertises it.
- First-party fallback metadata points to Opus 4.8 for third-party-provider fallback paths — from the 2026-07-25 static inspection only, not re-verified.

Anthropic's model documentation confirms that 1M is both the default and maximum context window, with adaptive thinking enabled by default:

- [What's new in Claude Opus 5](https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5)
- [Model overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)

### Authenticated live probes

Historical probes from 2026-07-25, all on Agent SDK `0.3.220` / Claude Code `2.1.220` with the isolated profile and a Pro subscription:

| Probe | Result |
| --- | --- |
| `supportedModels()` | `opus` resolves to `claude-opus-5`; five effort levels, adaptive thinking, fast mode, auto mode |
| Bare `claude-opus-5`, effort `high` | Successful; `system:init.model=claude-opus-5`; served 1M context; exact marker |
| Bare `claude-opus-5`, effort `max` | Successful; served 1M context; exact marker |
| `claude-opus-5[1m]` | Successful; served 1M context; canonical model remained `claude-opus-5` |
| CLI alias `opus` | Successful; resolved to `claude-opus-5` |
| Fast mode through SDK flag settings | Successful; init and result reported `fast_mode_state=on` |
| Old SDK `0.3.218` with executable override to `2.1.220` | Successful Opus 5 query; the manifest lists `0.3.218` as a tested wrapper version |

Re-verified or newly added on 2026-07-26: `supportedModels()`, bare `claude-opus-5` at effort `xhigh`, and alias `opus` at effort `max` — see the reassessment section for the full field capture.

## Agent SDK API delta (`0.3.218` to `0.3.220`)

Verified by diffing the installed declaration files. `agentSdkTypes.d.ts`, `sdk-tools.d.ts`, and `bridge.d.ts` are byte-identical; only `sdk.d.ts` changes (91 diff lines). It adds:

1. `DirectoryAddedHookInput`, the `DirectoryAdded` hook event, and its entries in `HOOK_EVENTS`, `HookEvent`, and `HookInput`.
2. `FastModeDisabledReason` and `fast_mode_disabled_reason` on `system:init`, result, and partial-result messages.
3. Low-level `SDKControlInterruptRequest.cancel_queued?: boolean`, `SDKControlInterruptResponse.cancelled?: string[]`, and the `interrupt_cancel_queued_v1` capability.
4. `sandbox.network.strictAllowlist`.
5. `workflowSizeGuideline`.
6. `precomputeCompactionEnabled`.
7. A tightened `register_repo_root` doc comment (strict-subdirectory requirement, duplicate registrations denied).

`Query.interrupt()` is still declared `interrupt(): Promise<SDKControlInterruptResponse | undefined>` with no parameters. `cancel_queued` exists **only** on the non-exported protocol type `SDKControlInterruptRequest`, so it is not reachable through the public API. The bridge already follows `interrupt()` with `close()` and rotates the persisted session after an abort, so queued work cannot continue in the killed child. **No abort implementation change is required**, and the existing abort and post-abort-rotation tests stay mandatory.

The new fast-mode fields are additive members of already-known init/result messages; the current reducer safely ignores them. Parsing and displaying them is required only if the bridge later exposes fast mode.

`DirectoryAdded`, `strictAllowlist`, `workflowSizeGuideline`, and `precomputeCompactionEnabled` are unused by the bridge. Claude Code auto-compaction remains disabled because Pi owns compaction, so `precomputeCompactionEnabled` is inert. **No production change is required for any of them.**

`mcp_server_errors` does not appear anywhere in the `0.3.220` type declarations. The bridge supplies validated programmatic MCP config with `strictMcpConfig`, so this raw startup diagnostic remains out of scope.

The 2.1.219 release restored nested subagents to a default maximum depth of three. No SDK option or type controls it; it is binary behaviour. Provider queries expose only Pi's MCP tools, so this affects AskClaude's native `Task`/`Workflow` execution rather than provider tool routing. **Add a nested-subagent regression test; do not change the read/full/none policy** unless that test finds a privilege leak.

## Tool-policy compatibility

The 2026-07-25 run of `buildAskClaudeQueryOptions()` produced the expected 2.1.220 inventories:

- `read`: `Read`, `Grep`, and `Glob` remain available; mutation tools remain absent.
- `full`: read/write/shell/delegation tools remain available; unsupported interactive tools remain absent.
- `none`: only the read-only `CronList` native tool remained; filesystem, web, skill, and delegation tools remained absent.

The targeted SDK contract suite passed 48/48 under `0.3.220`. No tool allowlist/denylist change is required. Update the version-specific comment at `src/sdk-options.ts:14` so it does not describe `2.1.218` as the current target.

## Model-catalog status: resolved

The bridge builds its provider model list synchronously from `getModels("anthropic")` at `src/index.ts:123`. `buildModels()` intentionally drops IDs missing from the installed Pi catalog, so registration depends entirely on the installed pi-ai release.

**Option A (use the published Pi catalog) is now available and is the chosen path.** `@earendil-works/pi-ai@0.82.1` supplies an authoritative `claude-opus-5` row with correct reasoning, input, context, output, effort-map, and compat metadata. No bridge-local model definition is needed.

- **Gain:** one authoritative model definition, no duplicated registry in the bridge.
- **Required gate:** after installing `0.82.1`, assert that `getModels("anthropic")` contains `claude-opus-5` before editing bridge code. Verified today; re-run at implementation time against the exact installed tree.

Rejected alternatives, retained for the record:

- **Option B — bridge-local fallback model row.** Rejected. It duplicates metadata that a published package now owns, weakens the "Pi catalog is authoritative" design, and creates cleanup work. It was only ever justified by the publication gap, which is closed.
- **Option C — dynamic discovery via `Query.supportedModels()`.** Rejected. Provider registration is synchronous, while SDK discovery starts a child process and depends on auth, settings, and account policy. Architectural redesign with unstable startup behaviour.

### Missing-row detection at runtime is required, not optional

Peer-dependency ranges are advisory in most npm installs, and the bridge loads into whatever pi-ai the user's Pi shipped — not the version the bridge pinned. A user on Pi `0.80.x`–`0.82.0` gets a catalog with no Opus 5 row, and today that fails silently in two ways:

- The provider picker simply omits `claude-bridge/claude-opus-5`.
- `AskClaude` with the default `model: "opus"` resolves to `claude-opus-4-8` instead, without any signal that the intended default was unavailable.

**Decision (2026-07-26): emit a diagnostic at registration when `MODEL_IDS_IN_ORDER` contains an ID the installed catalog does not supply**, naming the ID and the required pi-ai version. See section 2, change 7.

This was initially framed as a transitional concern about users on old pi-ai, which would age out on its own. It does not age out. Because `packages/ai/src/providers/data/` is gitignored and regenerated from models.dev at each `prepublishOnly`, with no required-model assertion in `check:model-data`, a *future* pi-ai release can drop the row just as easily as an old one never had it. The likelier mechanism is an ID rename rather than a deletion — see section 5 assertion 8.

Tests cannot cover this. Section 5 assertion 8 protects the maintainer's tree at pin time and at every later bump, which is the whole of what a test can reach; it executes against the maintainer's `node_modules` and never runs in a user's install. The runtime diagnostic is the only defence that runs where the failure actually occurs, which is why it is required rather than recommended.

Rejected alternative: **accept the silent degradation** — zero code, consistent with how `buildModels()` already handles every other missing ID. Rejected because Opus 5 is the `opus` shortcut's target and AskClaude's default, so its absence silently redirects the most common code path to a different model and bills against it.

## Fast-mode decision

Unchanged from 2026-07-25, and strengthened by today's evidence that SDK sessions report `fast_mode_disabled_reason: "sdk_opt_in_required"`:

1. **Leave fast mode off (recommended for this update):** model support ships without changing billing or cache behaviour, and no defensive configuration is needed because the SDK default is already off.
2. **Add explicit `provider.fastMode` and `askClaude.fastMode` settings in a follow-up:** users knowingly opt into premium inference. Requires state/reason diagnostics and tests for rate limits and cache separation.
3. **Enable fast mode automatically for Opus 5:** reject. It changes cost, and fast/standard requests do not share prompt-cache prefixes.

If option 2 is later approved, pass `settings: { fastMode: true }` to the relevant SDK options, capture `fast_mode_state` and `fast_mode_disabled_reason` in `src/sdk-messages.ts`, expose clear debug/UI diagnostics, and never enable fast mode for isolated compaction summaries by default.

See [Anthropic fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode) for pricing, rate-limit, and cache behaviour.

## Required implementation changes

### 1. Dependency and package metadata

Files:

- `package.json`
- `package-lock.json`

Changes:

1. Pin `@anthropic-ai/claude-agent-sdk` exactly to `0.3.220`.
2. Do not add `@anthropic-ai/claude-code`; the Agent SDK already supplies the matched native packages.
3. Pin the Pi development dependencies at `0.82.1`: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui`. Pi releases lockstep, so keeping all three aligned matches what any real installation looks like.
4. Raise **only** the `@earendil-works/pi-ai` peer minimum, to `>=0.82.1`. That is the package that owns the catalog, and it is the only one whose absence breaks Opus 5.
5. Leave the `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` peer minimums at `>=0.80.0`. The bridge only uses `buildSessionContext`, `compact`, `keyHint`, `CompactionEntry`, `ExtensionAPI`, `ExtensionUIContext`, `CONFIG_DIR_NAME`, and `Text`, and typecheck passes against `0.82.1` without source changes, so nothing forces a raise. Raising the pi-ai peer already implies Pi `>=0.82.1` in practice.
6. Recheck npm immediately before implementation. If Agent SDK `latest` or pi-ai `latest` has advanced, re-verify that exact pair rather than mechanically pinning these versions.
7. Regenerate the lockfile from a clean install and inspect all optional platform package versions and checksums. The `0.3.220` manifest declares all eight native platform packages at the same exact version; preserve that invariant.
8. Do not bump `@anthropic-ai/sdk`, MCP SDK, Zod, or `cc-session-io` solely for this change; the Agent SDK diff does not require it.

### 2. Model registration and runtime mapping

File: `src/models.ts`

Changes:

1. Insert `claude-opus-5` at index 1 of `MODEL_IDS_IN_ORDER`, after `claude-fable-5` and before `claude-opus-4-8`. Verified to make `resolveModel(models, "opus")` return `claude-opus-5`.
2. Add the runtime policy case — **required**, because without it `applyLongContext()` logs the unknown-model warning and registers Opus 5 at 200K:

   ```ts
   case "claude-opus-5":
     return { cliModelId: "claude-opus-5", contextWindow: ONE_M_CONTEXT };
   ```

   Opus 5 joins Opus 4.7 as a model this function **requests bare**; Fable 5, Opus 4.8, and Sonnet 5 are still requested with `[1m]`. Note that the comment at `src/models.ts:63-66` already records that *bare* Opus 4.8 and Sonnet 5 serve 1M even though the code still sends `[1m]` for them — that pre-existing gap between the measured note and the requested ID is out of scope here. Add Opus 5 to that comment's list and leave the existing `[1m]` requests alone.
3. Do **not** add an Opus 5 entry to `DEFAULT_THINKING_LEVEL_MAPS`. The catalog supplies `{ xhigh: "xhigh", max: "max" }`, and `buildModels()` uses the table only as a `??` fallback.
4. Realign the existing `DEFAULT_THINKING_LEVEL_MAPS` entries and rewrite the stale comment at `src/models.ts:7-10`. Under pi-ai `0.82.1` both entries are unreachable, and the Sonnet 5 entry contradicts both the catalog and `supportedModels()`. Set `claude-sonnet-5` to `{ xhigh: "xhigh", max: "max" }` and `claude-sonnet-4-6` to `{ max: "max" }` so the fallback matches the catalog for anyone below the peer floor, and state in the comment that pi-ai `>=0.82.1` supplies these maps directly.
5. Do not gate Opus 5 by `provider.plan` or `longContextExtraUsage`. It is present in the authenticated Pro catalog and serves 1M without a metered-context suffix.
6. Keep explicit Opus 4.8/4.7/4.6 entries for pinned selection and rollback, and keep Fable availability logic unchanged.
7. Emit a one-time diagnostic when the installed catalog does not supply an ID listed in `MODEL_IDS_IN_ORDER`. `buildModels()` already knows which IDs it dropped, so the check is a length or set comparison at the same site. Name the missing ID and the required pi-ai version (`>=0.82.1` for `claude-opus-5`). Fire it once per registration, not per query, and do not throw — a missing row must degrade, not break startup. This is the only defence that runs in a user's install; see "Missing-row detection at runtime is required".

Measured in the dependency-trial simulation against the real `0.82.1` catalog:

- Provider picker includes `claude-bridge/claude-opus-5` once the ID is in `MODEL_IDS_IN_ORDER`; without it, `buildModels()` drops the model.
- `resolveModel(..., "opus")` resolves to Opus 5 with the ID inserted at index 1, and to Opus 4.8 without it.
- With the ID but **without** the runtime case, `applyLongContext()` registers `Claude Opus 5` at 200K and logs the unknown-model warning.

Expected once the runtime case is added — predicted from `applyLongContext()`, not yet measured, and asserted by the section 5 tests:

- Opus 5 registers at 1M and is labelled `Claude Opus 5 1M`.
- Opus 5 registers at 1M on Pro and Max, with and without Extra Usage, since its policy consults neither setting.
- AskClaude's default `opus` selection resolves to Opus 5.
- Explicit `claude-opus-4-8` still works.

### 3. Effort mapping

Files:

- `src/models.ts`
- `src/index.ts`

The provider path (`src/index.ts:1230-1233`) already does the right thing: it prefers `model.thinkingLevelMap[reasoning]` and falls back to `REASONING_TO_EFFORT`. With the `0.82.1` catalog, Pi `xhigh` → SDK `xhigh` and Pi `max` → SDK `max` for Opus 5. **No behaviour change is required here** — the call site only moves to the shared helper introduced below.

The AskClaude path (`src/index.ts:1464-1465`) does **not** consult the model's map; it uses `REASONING_TO_EFFORT[options.thinking]` alone, and `REASONING_TO_EFFORT.xhigh === "max"` (`src/index.ts:736-738`). Its `thinking` enum (`src/index.ts:1706`) also stops at `xhigh`, even though Pi's own `ModelThinkingLevel` has included `max` since before `0.82.1`. Consequences for Opus 5: AskClaude cannot request the real SDK `xhigh` tier at all, and `thinking: "xhigh"` silently escalates to the more expensive `max`.

**Decision (2026-07-26): align AskClaude with the provider path.** The flat table was correct when no catalog row distinguished `xhigh` from `max`. pi-ai `0.82.1` now distinguishes them for six of the seven registered models, and Claude Code `2.1.220` serves them as distinct tiers — `xhigh` was confirmed live on Opus 5. Leaving the two interfaces divergent means the same effort word bills differently depending on which one the caller reached for.

Required changes:

1. Extract the provider's lookup into a shared helper **in `src/models.ts`**, and move `REASONING_TO_EFFORT` (`src/index.ts:736-738`) there with it. `src/models.ts` already owns `DEFAULT_THINKING_LEVEL_MAPS` and the `thinkingLevelMap` forwarding, and it imports without side effects — whereas `src/index.ts:123` binds `MODELS` from `getModels("anthropic")` at module scope, so any test that imports it drags in the installed catalog and the registration guard (see `tests/unit-sync-shared-session.mjs`, which works around this with a `__test` export). Placing the helper in `src/models.ts` is what makes section 5 assertion 12 a plain unit test. Use it from both call sites; this also removes the `(model as any)` cast at `src/index.ts:1231`:

   ```ts
   export function resolveEffort(
     model: { thinkingLevelMap?: Record<string, string> } | undefined,
     level: string | undefined,
   ): EffortLevel | undefined {
     if (!level || level === "off") return undefined;
     return (model?.thinkingLevelMap?.[level] as EffortLevel | undefined) ?? REASONING_TO_EFFORT[level];
   }
   ```

   `model` is optional because `resolveModel()` at `src/index.ts:1436` returns `undefined` for a raw model ID that is not registered; that case must keep falling back to `REASONING_TO_EFFORT`.

2. Add `max: "max"` to `REASONING_TO_EFFORT` as the fallback for unresolved models.
3. Add `max` to the AskClaude `thinking` enum (`src/index.ts:1706`) so callers can request the top tier explicitly instead of receiving it as a side effect of `xhigh`.

Resulting effect of AskClaude `thinking: "xhigh"` under the `0.82.1` catalog:

| Model | Today | After |
| --- | --- | --- |
| Opus 5, Opus 4.8, Opus 4.7, Sonnet 5, Fable 5 | `max` | `xhigh` |
| Opus 4.6, Sonnet 4.6 (catalog map defines no `xhigh`) | `max` | `max` |
| Haiku 4.5, unresolved raw model ID | `max` | `max` |

This is a user-visible de-escalation on five models: AskClaude prompts written when `xhigh` meant "maximum" now get one tier less thinking. The direction is safe — less spend, not more — and adding `max` to the enum gives anyone who genuinely wanted the top tier a way to ask for it. It requires a per-model effort test row (section 5) and its own changelog line (section 8).

### 4. SDK option and message handling

Files:

- `src/sdk-options.ts`
- `src/sdk-messages.ts` (only if fast-mode observability is included)

Required now:

- Update the version-specific `RemoteTrigger` comment at `src/sdk-options.ts:14` to the 2.1.220 observation, or make it version-neutral.
- Keep tool policies, `strictMcpConfig`, setting sources, isolated profile environment, and compaction options unchanged.
- Keep abort behaviour unchanged.

Not required in this compatibility update:

- `DirectoryAdded` hooks.
- `cancel_queued` control plumbing (unreachable through the public API).
- `strictAllowlist`, `workflowSizeGuideline`, or `precomputeCompactionEnabled`.
- Fast-mode parsing/configuration.
- `mcp_server_errors` handling (absent from SDK types entirely).

### 5. Unit and offline contracts

Files:

- `tests/unit-models.mjs` — assertions 1 to 7, 12, 14, and 15 (mock-driven)
- `tests/unit-catalog-gate.mjs` (new) — assertions 8 and 13, the only two that read the installed catalog
- `tests/unit-sdk-runtime-contract.mjs` — assertions 9 to 11
- `tests/unit-sdk-options.mjs` only if an option changes
- `tests/unit-sdk-messages.mjs` only if fast fields are parsed

`tests/unit-models.mjs` builds its inputs from `mockPiAiModel`, not from the installed catalog, so it is insulated from dependency bumps. Keep it that way: put the two catalog-reading assertions in their own file so a pi-ai bump produces one obvious failure in a file whose stated job is to track the catalog, instead of scattered failures in the logic suite.

Required assertions:

1. Opus 5 appears before Opus 4.8 in the projection and survives `buildModels()`.
2. `resolveModel(..., "opus")` returns `claude-opus-5`.
3. `resolveClaudeCodeRuntimeModel("claude-opus-5", …)` returns bare `claude-opus-5` at 1M under all plan/Extra Usage combinations, and `applyLongContext()` never emits the unknown-model warning for it. The warning is a `console.error` in `resolveClaudeCodeRuntimeModel`'s default branch, so asserting its absence requires capturing `console.error` — a `contextWindow === 1_000_000` check passes without ever proving the warning is gone. Share one `console.error` capture helper with assertion 15, which needs the same mechanism.
4. Opus 5 is never filtered the way Fable 5 is.
5. Opus 5's catalog `thinkingLevelMap` (`{xhigh:"xhigh", max:"max"}`) survives projection and is not overwritten by `DEFAULT_THINKING_LEVEL_MAPS`.
6. The realigned Sonnet 5 / Sonnet 4.6 fallback entries match the `0.82.1` catalog values.
7. Explicit Opus 4.8 remains selectable and retains its `[1m]` policy.
8. A real-catalog gate: import `getModels("anthropic")` from the installed pi-ai and assert every entry of `MODEL_IDS_IN_ORDER` resolves. This guards the maintainer's tree both at pin time and at every later pi-ai bump, in both directions — a downgrade that predates the row, and a future release that loses it.

   The likelier future failure is an **ID rename, not a deletion**. Pi's catalog already carries dated twins for older models (`claude-opus-4-1` / `claude-opus-4-1-20250805`, `claude-opus-4-5` / `claude-opus-4-5-20251101`, `claude-haiku-4-5` / `claude-haiku-4-5-20251001`), and `supportedModels()` on `2.1.220` resolves the `haiku` alias to the dated `claude-haiku-4-5-20251001`. If models.dev ever ships Opus 5 only under a dated ID, the bare `claude-opus-5` alias disappears while the model itself is still present. State this in the test file: the correct response is to update `MODEL_IDS_IN_ORDER` and the runtime case, **not** to loosen the assertion into a prefix or substring match.

   This assertion cannot protect end users — it runs against the maintainer's `node_modules` and never executes in a user's install. Section 2 change 7 covers that side.
9. The selected bundled executable reports `2.1.220` and comes from the Agent SDK platform package.
10. Read/full/none tool inventories remain policy-compliant.
11. Unknown additive fields and message types remain non-fatal (covers `fast_mode_disabled_reason`).
12. **`resolveEffort()` logic, mock-driven.** Feed the helper hand-written model objects — one with `{xhigh:"xhigh", max:"max"}`, one with `{max:"max"}` only, one with no map, and `undefined` for the unresolved-model case — and assert every level in `["off","minimal","low","medium","high","xhigh","max"]` maps to the section 3 result. Include `off` → `undefined` and the `REASONING_TO_EFFORT` fallback. These assertions must never change when a dependency is bumped.
13. **Registered-model effort snapshot, real catalog.** Separately, read the installed pi-ai catalog and snapshot the resolved effort for each entry of `MODEL_IDS_IN_ORDER` at `xhigh` and `max`. This is an intentional canary, not a logic test: it is *expected* to need updating when pi-ai changes a `thinkingLevelMap`, and the test file must say so in a comment naming the pi-ai version the snapshot was taken from. Without it nothing catches a repeat of the Sonnet 5 change; merged into assertion 12 it would instead fail on every legitimate dependency bump until someone weakened it into meaninglessness.
14. The AskClaude tool schema accepts `max`. Do not also assert that it rejects unknown levels — that is typebox's behaviour, not the bridge's.
15. The section 2 change 7 diagnostic fires when a mock catalog omits `claude-opus-5`, names the ID and the required pi-ai version, stays silent when every ID resolves, and does not throw in either case. Mock-driven, so it belongs with assertion 12. Note that the existing `tests/unit-models.mjs` case "silently drops IDs missing from pi-ai (no fallback)" needs updating: the drop stays silent in the returned array but is no longer silent to the operator.

### 6. Authenticated integration coverage

Add a focused integration file such as `tests/int-opus-5.mjs` and keep the existing auth preflight.

Required cases:

1. Provider query with `claude-bridge/claude-opus-5` returns a marker.
2. Debug/init evidence reports Claude Code `2.1.220` and canonical model `claude-opus-5`.
3. Result `modelUsage` reports `contextWindow 1000000` and `canonicalModel claude-opus-5`.
4. A second provider turn resumes the same session and recalls a unique token.
5. AskClaude with explicit `model: "claude-opus-5"` succeeds.
6. AskClaude with omitted model uses the new `opus` default and succeeds.
7. Provider `xhigh` and AskClaude `xhigh` both reach SDK `xhigh` on Opus 5 — one turn each. This is where the section 3 behaviour change lands, and `xhigh` is confirmed to be a distinct served tier. Do **not** add a live `max` turn: effort `max` on Opus 5 is the most expensive request the bridge can issue, and it would only prove the SDK accepts a value assertion 12 already computed. It belongs in `diag/` as a one-off probe (section 7), not in a per-run suite.
8. Bare Opus 5 is the production request ID. Keep `[1m]` as a diagnostic compatibility probe, not the registered ID.
9. Nested AskClaude subagents complete under read and full modes; read mode must not gain mutation capability through a child or grandchild (covers the restored depth-3 default).
10. Abort during Opus 5 execution stops output, rotates/rebuilds the shared session, and does not replay queued work.
11. Config isolation remains intact: session JSONL and settings stay under the configured isolated profile.
12. Existing cache, compaction, tool-message, session resume, and AskClaude suites pass under SDK `0.3.220` **and** pi-ai `0.82.1`.

Do not hard-code account-specific cost values. Asserting the model ID and context window is safe; record the observed 64K default output cap in diagnostics rather than making it a cross-account blocker unless all supported tiers confirm it.

### 7. Context and alias diagnostics

Files:

- `diag/context-size.mjs` (`MODELS` at line 28)
- `diag/model-aliases.mjs` (`ALIASES` at line 23 remains valid; expectations/output documentation change)
- `diag/CONTEXT-SIZE.md`

Changes and runs:

1. Add `claude-opus-5` to the `MODELS` array.
2. Probe bare `claude-opus-5` and `claude-opus-5[1m]` on every supported subscription configuration available to the maintainer.
3. Probe `opus` and record that it resolves to Opus 5.
4. Record context window, default max output, canonical model, effort, SDK version, binary version, plan, and Extra Usage state.
5. Probe Opus 5 at effort `max` once here rather than in the integration suite (section 6 case 7). Record the served effort and note that this is the bridge's most expensive single request, so it is a deliberate one-off, not a repeated check.
6. Keep the historical 2.1.218 measurements, but mark the 2.1.220 matrix as current. `diag/CONTEXT-SIZE.md` currently states `0.3.218`/`2.1.218` at lines 8-9, 47-48, 86, 95, and 157; all need updating.
7. Update the alias row at `diag/CONTEXT-SIZE.md:100`, which still maps `opus` to `claude-opus-4-8`.

Expected Pro rows from this analysis:

| Requested ID | Served model | Context | Default max output |
| --- | --- | --- | --- |
| `claude-opus-5` | `claude-opus-5` | 1M | 64K |
| `claude-opus-5[1m]` | canonical `claude-opus-5` | 1M | 64K |
| `opus` | `claude-opus-5` | 1M | 64K |

### 8. Documentation and changelog

Files:

- `README.md` (model list at line 26)
- `CHANGELOG.md`
- `diag/CONTEXT-SIZE.md`

Changes:

1. Add `claude-bridge/claude-opus-5` to the model list before older Opus versions.
2. State that `opus` and AskClaude's default now select Opus 5.
3. State that Opus 5 has native 1M context, uses a bare ID, and does not depend on plan/Extra Usage flags.
4. Keep Opus 4.8 documented as an explicit pin and rollback option.
5. Do not claim fast mode support unless the separate opt-in feature is implemented.
6. Document the AskClaude `thinking` levels, including the new `max`, and state that `xhigh` now means the literal SDK tier on both the provider and AskClaude.
7. Add one combined UNRELEASED changelog entry for the SDK/binary/pi-ai/model update, or merge it into the existing "Bump: upgrade Claude Agent SDK and aligned peers" entry, which is still unreleased. It must mention the Sonnet 5 effort behaviour change from the pi-ai bump, since the 0.6.2 entry documents the workaround it supersedes, and the Sonnet 4.6 `maxTokens` move from 64K to 128K.
8. Add a separate changelog entry for the AskClaude effort alignment. It is a user-visible behaviour change independent of Opus 5: `thinking: "xhigh"` now sends SDK `xhigh` instead of `max` on Opus 5, Opus 4.8, Opus 4.7, Sonnet 5, and Fable 5, and `max` is newly accepted.
9. Add an `Add` entry for the registration diagnostic (section 2 change 7), which is user-visible output on any Pi whose pi-ai predates the required version.
10. Do not rewrite historical completed plan records merely to replace their old version numbers.

### 9. Packaging and platform validation

Before release:

1. Run a clean `npm install` and require an empty `npm ls --all --json` problems array.
2. Verify Agent SDK metadata and every optional native package are exactly `0.3.220`.
3. Verify the selected native binary reports `2.1.220` without relying on a `claude` executable on `PATH`.
4. Run `npm pack --dry-run` and inspect the archive.
5. Install the packed bridge into clean Node consumers at the declared minimum Node version and current LTS.
6. Execute Darwin arm64 authenticated tests.
7. Resolve and execute Linux x64/arm64 glibc and musl binaries in clean containers, at least through `--version` and unauthenticated `system:init`.
8. Verify Windows x64/arm64 package resolution and PE headers; run on Windows when a runner is available.
9. Re-run `pathToClaudeCodeExecutable` precedence coverage with a wrapper around 2.1.220.

### 10. Cross-version and rollback validation

Use the existing Phase 6 harnesses with isolated source/target profiles. Note that `tests/phase6-cross-version.mjs` hard-codes `expectedClaudeCode: "2.1.218"` at lines 209, 229, and 281, and `tests/phase6-restart-rollback.sh:43-44` asserts SDK `0.2.141`/`0.3.218`; both need their target constants updated.

1. Create and resume a Haiku or Opus 4.8 session in `0.3.218`/`2.1.218`, then read and resume it in `0.3.220`/`2.1.220`.
2. Create and resume an older-model session in 2.1.220, then read and resume it after rollback to 2.1.218.
3. Verify `cc-session-io` can list/read both transcripts.
4. Verify Pi restart plus session rebuild remains usable after downgrade.
5. Verify Opus 5 sessions remain readable as history after rollback, but do not require 2.1.218 to execute another Opus 5 turn — that binary does not contain the model.
6. Confirm no normal `~/.claude` writes occur during either direction.

Rollback procedure:

1. Revert the Agent SDK and Pi dependency and lockfile changes.
2. Remove Opus 5 from bridge registration and restore the `opus` shortcut to Opus 4.8.
3. Restore the previous `DEFAULT_THINKING_LEVEL_MAPS` values if the pi-ai bump is also reverted; a bridge-only revert with pi-ai still at `0.82.1` leaves Sonnet 5 on the catalog's `xhigh → xhigh` mapping.
4. Revert the AskClaude effort alignment separately if only that change needs backing out: restore `REASONING_TO_EFFORT[options.thinking]` at the AskClaude call site and drop `max` from the `thinking` enum. It has no dependency on Opus 5 registration and can be reverted or kept on its own.
5. Restart Pi so provider registration is rebuilt.
6. Rebuild the active Claude session from persisted Pi history if the new binary wrote state that the old binary cannot directly resume.
7. Keep the isolated profile; do not delete user sessions as part of rollback.

## Acceptance checklist

The implementation is complete only when all items pass:

- [ ] Registry recheck confirms the exact Agent SDK/Claude Code and pi-ai target versions.
- [ ] Installed Pi Anthropic catalog contains `claude-opus-5` (real-catalog gate test, not a mock).
- [ ] `npm run typecheck` passes.
- [ ] `npm run test:unit` passes.
- [ ] Targeted SDK/model contracts pass under the bundled 2.1.220 executable.
- [ ] Full authenticated `npm test` passes under SDK `0.3.220` and pi-ai `0.82.1`.
- [ ] Provider picker exposes Opus 5 at 1M and `opus` resolves to it.
- [ ] `applyLongContext()` emits no unknown-model warning for Opus 5.
- [ ] Provider and AskClaude Opus 5 live queries pass at default and high effort.
- [ ] The shared `resolveEffort()` helper lives in `src/models.ts` and backs both the provider and AskClaude paths, `max` is accepted by the AskClaude schema, the mock-driven logic test covers every level, and the real-catalog effort snapshot names its pi-ai version.
- [ ] The Sonnet 5 effort behaviour change from the pi-ai bump is asserted and changelogged.
- [ ] Opus 5 reports 1M served context and canonical model `claude-opus-5`.
- [ ] Session resume, cache, compaction, abort recovery, tool messages, and config isolation pass.
- [ ] Nested AskClaude read-mode delegation cannot mutate files.
- [ ] 2.1.218 ↔ 2.1.220 transcript compatibility and rollback pass, with Phase 6 target constants updated.
- [ ] Clean consumer/package/platform checks pass.
- [ ] README, diagnostics, and UNRELEASED changelog are updated.
- [ ] Fast mode remains off unless a separately approved opt-in design is implemented.
- [ ] The registration diagnostic fires once, names the missing ID and required pi-ai version, and does not throw when a catalog row is absent.

## Evidence

### Tests and probes already performed

2026-07-25, in a detached worktree with SDK `0.3.220` and pi-ai `0.80.3`:

- Full authenticated `npm test` completed, including provider, AskClaude, cache, compaction, session, abort, tool-message, and isolation suites.
- `npm run typecheck` passed.
- Targeted model/SDK/tool-policy contracts passed 48/48.
- Authenticated Opus 5 `high`, `max`, `[1m]`, alias, and fast-mode probes succeeded.
- Read/full/none tool inventories remained compatible with the existing policy.
- No authentication failures appeared in the 2.1.220 integration logs.

2026-07-26, all read-only with respect to both main worktrees:

- `claude --version` reported `2.1.220`; the installed native binary is byte-identical to the SDK `0.3.220` `darwin-arm64` binary and matches the manifest size and SHA-256.
- `sdk.d.ts` diffed against `0.3.218`; the other three declaration files are byte-identical.
- Published `@earendil-works/pi-ai@0.82.0` and `@0.82.1` tarballs unpacked and compared: `0.82.1` adds the `claude-opus-5` row.
- `getModels("anthropic")` executed against the published `0.82.1` package and against the local Pi source at `71f82a1e`; both return an identical `claude-opus-5` row.
- `getSupportedThinkingLevels` evaluated for Opus 5, Opus 4.8, Sonnet 5, Sonnet 4.6, Haiku 4.5, and Fable 5 on the local source.
- Authenticated `supportedModels()` captured on the isolated profile.
- Authenticated live turns at effort `xhigh` (bare `claude-opus-5`) and effort `max` (alias `opus`), capturing `system:init` and `result` fields.
- Detached bridge worktree with pi packages at `0.82.1` and SDK `0.3.220`: `npm run typecheck` passed and `npm run test:unit` passed 150/150.
- Registration simulation against the real `0.82.1` catalog, confirming both the drop-without-ID and the 200K-without-runtime-case failure modes.
- Markdown diagnostics for this plan: the repository configures none. There is no `.markdownlint*`, `.remarkrc*`, `.github/workflows/`, or docs-lint npm script, so `git diff --check` is the only applicable mechanical check and it passes.

### Tests required during implementation

Everything in sections 1 through 10 above is implementation-time work and has **not** been done. Tests: the real-catalog gate, `tests/int-opus-5.mjs`, the nested-subagent regression, the mock-driven effort table and the real-catalog effort snapshot, the registration-diagnostic test, the updated Phase 6 cross-version and rollback runs, the diagnostics re-measurement, and all packaging/platform validation. Production changes with no test-section counterpart, easy to miss when scanning for what is left: **section 2 change 7** (the registration diagnostic) and **section 3** (moving `resolveEffort()` and `REASONING_TO_EFFORT` into `src/models.ts` and rewiring both call sites).

### Remaining external gates

- The Pi generated data directory is gitignored and regenerated from models.dev at publish time, and `check:model-data` asserts no required-model list. Presence of `claude-opus-5` is verified at `0.82.1` but is not structurally guaranteed for later releases. This is mitigated on both sides rather than left open: section 5 assertion 8 catches it in the maintainer's tree at pin time and at every later bump, and section 2 change 7 catches it at runtime in a user's install. Re-run the catalog gate against whatever pi-ai version is pinned at implementation time.
- Linux and Windows platform validation still needs runners.
- `[1m]`, fast-mode, and Extra Usage probes on a Max-plan account remain unmeasured.
