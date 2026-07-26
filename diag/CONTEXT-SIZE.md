# Context windows served by the Claude Agent SDK

Current target-binary measurements from Claude Agent SDK `query()`, grouped by
requested model ID and Pro Extra Usage state.

## Scope and evidence labels

The current target is Claude Agent SDK `0.3.220` with bundled Claude Code
`2.1.220`. Opus 5 was measured on that target on 2026-07-26 (see
"Claude Opus 5 on Claude Code 2.1.220"). The full model/variant matrix below was
measured on 2026-07-23 against Agent SDK `0.3.218` and Claude Code `2.1.218` and
has **not** been re-run on `2.1.220`; treat it as the prior record for every
model other than Opus 5. All measurements cover one Pro subscription account
only.

Evidence is labeled as follows:

- **Directly measured:** observed in the saved target-binary reports or a focused
  bridge-level served-window check.
- **Inferred:** derived from a measured full model ID and a separately measured
  alias mapping, but not run in that exact state.
- **User-reported:** supplied by the user and not reproduced in this phase.
- **Untested:** no Phase 8 result exists. No behavior claim is made.

## Method

`diag/context-size.mjs` calls the SDK for each model ID in bare and `[1m]`
forms. Each probe sends one trivial turn and records
`result.modelUsage[*].contextWindow`, maximum output tokens, terminal errors,
rate-limit metadata, and the selected Claude Code version.

```sh
env -u ANTHROPIC_API_KEY node diag/context-size.mjs pro
```

Adding `--effort-max` appends one extra Opus 5 turn at effort `max`. That is the
most expensive single request the bridge can issue, so it lives here as a
deliberate one-off probe and is deliberately absent from the per-run integration
suite:

```sh
env -u ANTHROPIC_API_KEY node diag/context-size.mjs pro --effort-max
```

`diag/model-aliases.mjs` measures the documented `fable`, `opus`, `sonnet`, and
`haiku` aliases separately:

```sh
env -u ANTHROPIC_API_KEY node diag/model-aliases.mjs pro on
```

Both diagnostics save JSON and Markdown reports under the gitignored
`.test-output/context-size/` directory. Extra Usage can consume metered credits.
Warn the user and obtain explicit confirmation before running an eligible probe.

## Claude Opus 5 on Claude Code 2.1.220

Measured on 2026-07-26 through the bridge provider (`tests/int-opus-5.mjs`) on
Agent SDK `0.3.220` / Claude Code `2.1.220`, Darwin arm64, Pro subscription OAuth
with `ANTHROPIC_API_KEY` unset and **Extra Usage disabled** — the turns reported
`overageStatus: "rejected"`, `overageDisabledReason: "org_level_disabled"`, and
`isUsingOverage: false`, so no metered credit was involved.

| Requested model ID | Served input / max output | Served usage key | Evidence |
| --- | ---: | --- | --- |
| `claude-opus-5` (bare) | 1M / 64K | `claude-opus-5` | Directly measured, Extra Usage disabled |
| `claude-opus-5[1m]` | 1M / 64K | `claude-opus-5` | Measured 2026-07-25 during the update analysis; not re-run |
| `opus` (alias) | 1M / 64K | `claude-opus-5` | Measured 2026-07-25 via `supportedModels()` and one alias turn; not re-run |

Directly measured facts about the bare ID:

- 1M is native. No `[1m]` suffix is needed and no plan or Extra Usage flag gates
  it, which is why `resolveClaudeCodeRuntimeModel` requests Opus 5 bare.
- Pi registers 1M and Claude Code serves 1M: the bridge's served-window
  diagnostic reported `served contextWindow=1000000 registered=1000000`, so Pi's
  status bar and compaction threshold match reality.
- Default maximum output is 64,000 tokens, which is Claude Code's own cap. Pi's
  catalog separately records the model capability as 128,000.
- Effort `xhigh` is accepted and served as a distinct tier, not an alias for
  `max`. Effort `max` was **not** exercised in the integration suite on purpose;
  run `diag/context-size.mjs --effort-max` if that row is wanted.
- Fast mode stays off. SDK sessions report
  `fast_mode_disabled_reason: "sdk_opt_in_required"`, so it is off for every SDK
  consumer regardless of account state.

Not measured for Opus 5: Max plan, Extra Usage enabled, any other account or
authentication method, and near-limit payload behavior.

## Measurement environment

The environment for the 2.1.218 matrix in the following sections:

- Date: 2026-07-23.
- Host: Darwin arm64 with Node `v26.5.0` and npm `11.17.0`.
- Claude Agent SDK: `@anthropic-ai/claude-agent-sdk` `0.3.218`.
- Bundled and selected Claude Code: `2.1.218`.
- Authentication: Pro subscription OAuth with `ANTHROPIC_API_KEY` unset.
- Directly measured Extra Usage states: disabled and enabled.
- SDK options: `settingSources: []`, `tools: []`, `maxTurns: 1`, and
  `persistSession: false`.
- Extra Usage remained enabled on the account after Phase 8.

## Direct Pro measurements (Claude Code 2.1.218)

Opus 5 is absent from this table because it does not exist in `2.1.218`. See
"Claude Opus 5 on Claude Code 2.1.220" above.

Values are served input context / maximum output tokens. `1M` is 1,000,000
tokens and `200K` is 200,000 tokens. `429` means the request required Extra
Usage credits. `400` means the requested long-context form was incompatible
with subscription OAuth.

| Requested model ID | Extra Usage disabled | Extra Usage enabled | Direct conclusion |
| --- | ---: | ---: | --- |
| `claude-opus-4-8` | 1M / 64K | 1M / 64K | Bare serves 1M |
| `claude-opus-4-8[1m]` | 1M / 64K | 1M / 64K | Explicit 1M remains valid |
| `claude-opus-4-7` | 1M / 64K | 1M / 64K | Bare serves 1M |
| `claude-opus-4-7[1m]` | 1M / 64K | 1M / 64K | Explicit 1M remains valid |
| `claude-opus-4-6` | 200K / 64K | 200K / 64K | Bare serves 200K |
| `claude-opus-4-6[1m]` | 429 | 1M / 64K | Extra Usage is required on Pro |
| `claude-fable-5` | 429 | 1M / 64K | The entire model requires Extra Usage on Pro |
| `claude-fable-5[1m]` | 429 | 1M / 64K | The same gate applies; success serves the bare canonical ID |
| `claude-sonnet-5` | 1M / 64K | 1M / 64K | Bare serves 1M |
| `claude-sonnet-5[1m]` | 1M / 64K | 1M / 64K | Explicit 1M remains valid |
| `claude-sonnet-4-6` | 200K / 32K | 200K / 32K | Bare serves 200K |
| `claude-sonnet-4-6[1m]` | 429 | 1M / 32K | Extra Usage is required on Pro |
| `claude-haiku-4-5` | 200K / 32K | 200K / 32K | Bare serves 200K |
| `claude-haiku-4-5[1m]` | 400 | 400 | Subscription OAuth rejects the 1M form |

Saved direct reports:

- Extra Usage disabled:
  `.test-output/context-size/pro-2026-07-23T21-22-19-695Z.{json,md}`.
- Extra Usage enabled:
  `.test-output/context-size/pro-2026-07-23T21-26-26-003Z.{json,md}`.

Every row recorded Agent SDK `0.3.218`, Claude Code `2.1.218`, and
`ANTHROPIC_API_KEY=false`. Disabled-state rate-limit events reported
`overageStatus: "rejected"` and `overageDisabledReason: "org_level_disabled"`.
The enabled Fable rows reported `rateLimitType: "overage"` and
`overageInUse: true`, directly confirming use of the Extra Usage path.

## Direct alias measurements

Aliases were measured on Pro with Extra Usage enabled. Every row reported
`system:init.claude_code_version === "2.1.218"`, except the `opus` row, which is
the `2.1.220` re-measurement noted below.

| Requested alias | `system:init.model` | Served usage key | Canonical model | Served input / max output |
| --- | --- | --- | --- | ---: |
| `fable` | `claude-fable-5` | `claude-fable-5` | `claude-fable-5` | 1M / 64K |
| `opus` | `claude-opus-5` | `claude-opus-5` | `claude-opus-5` | 1M / 64K |
| `sonnet` | `claude-sonnet-5` | `claude-sonnet-5` | `claude-sonnet-5` | 1M / 64K |
| `haiku` | `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` | `claude-haiku-4-5` | 200K / 32K |

Saved alias report:

- `.test-output/context-size/pro-extra-on-aliases-2026-07-23T21-38-11-147Z.{json,md}`.
  This saved report predates Opus 5 and still records `opus` →
  `claude-opus-4-8`. On `2.1.220` the alias resolves to `claude-opus-5`
  (measured 2026-07-25 via `supportedModels()` and one alias turn); re-run
  `diag/model-aliases.mjs` to refresh the saved report. `fable`, `sonnet`, and
  `haiku` were not re-measured on `2.1.220`.

## Bridge-level served-window parity

Two authenticated bridge checks directly compared Claude Code's served metadata
with the model registered in Pi:

- Haiku: served `200000`, registered `200000`, maximum output `32000`.
- Fable on Pro with Extra Usage enabled: served `1000000`, registered
  `1000000`, maximum output `64000`.
- Opus 5 on Pro with Extra Usage disabled, Claude Code `2.1.220`: served
  `1000000`, registered `1000000`, maximum output `64000`.

These values come from `result.modelUsage[*].contextWindow`. The probes did not
send payloads close to the limits, so they verify served-limit metadata rather
than boundary-size behavior.

## Error shapes

Rejected turns appear in the SDK stream as `result` messages with
`subtype: "success"` and `is_error: true`. The error text is in `result.result`
and the HTTP status is in `result.api_error_status`; `result.errors` remains
empty. The bridge must therefore treat `is_error` as authoritative.

### Credit-gated rejection (HTTP 429)

Pro with Extra Usage disabled returned 429 for Opus 4.6 `[1m]`, Sonnet 4.6
`[1m]`, and both Fable forms. Rate-limit metadata included
`status: "rejected"`, `overageDisabledReason: "org_level_disabled"`, and
`errorCode: "credits_required"`.

### Capability rejection (HTTP 400)

Haiku `[1m]` returned HTTP 400 with subscription OAuth in both Extra Usage
states:

```text
API Error: 400 This authentication style is incompatible with the long context beta header.
```

## Differences from the Claude Code 2.1.141 record

Compared with the earlier 2026-06-26 Pro measurements using Agent SDK
`0.2.141` and Claude Code `2.1.141`:

- Bare Opus 4.8 changed from 200K to 1M.
- Bare Sonnet 5 changed from 200K to 1M.
- Fable 5 changed from available on the earlier Pro/no-Extra record to fully
  credit-gated in the current Pro/no-Extra measurement.
- Opus 4.6, Sonnet 4.6, and Haiku retained their earlier bare served windows
  and long-context eligibility on the tested Pro account.

The older Max rows are historical records only. They are not current
Claude Code `2.1.220` coverage.

## Coverage boundaries

- **Directly measured:** Pro with Extra Usage disabled and enabled; every model
  ID and form in the `2.1.218` matrix; the four aliases with Extra Usage enabled;
  Haiku/Fable bridge-level served-window parity; and bare Opus 5 on `2.1.220`
  with Extra Usage disabled, including served-window parity and effort `xhigh`.
- **Inferred only:** aliases with Extra Usage disabled where the enabled alias
  maps to a canonical model whose disabled full ID was directly measured. In
  particular, disabled-state `fable` is expected to reach the measured Fable
  credit gate, but the alias itself was not run in that state.
- **User-reported only:** Fable 5 works on Max. The bridge preserves configured
  Max behavior, but Phase 8 did not measure it.
- **Untested:** Max, Team, Enterprise, API-key authentication, other accounts,
  aliases with Extra Usage disabled, near-limit payload boundary behavior, the
  non-Opus-5 model matrix on `2.1.220`, Opus 5 with Extra Usage enabled, and
  Opus 5 at effort `max`.

Do not extend these results to an untested account, authentication method,
subscription tier, or Extra Usage state.
