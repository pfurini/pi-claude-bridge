# Context windows served by the Claude Agent SDK

Current target-binary measurements from Claude Agent SDK `query()`, grouped by
requested model ID and Pro Extra Usage state.

## Scope and evidence labels

This document reports Claude Agent SDK `0.3.218` with bundled Claude Code
`2.1.218`, measured on 2026-07-23. The current matrix covers one Pro
subscription account only.

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

`diag/model-aliases.mjs` measures the documented `fable`, `opus`, `sonnet`, and
`haiku` aliases separately:

```sh
env -u ANTHROPIC_API_KEY node diag/model-aliases.mjs pro on
```

Both diagnostics save JSON and Markdown reports under the gitignored
`.test-output/context-size/` directory. Extra Usage can consume metered credits.
Warn the user and obtain explicit confirmation before running an eligible probe.

## Measurement environment

- Date: 2026-07-23.
- Host: Darwin arm64 with Node `v26.5.0` and npm `11.17.0`.
- Claude Agent SDK: `@anthropic-ai/claude-agent-sdk` `0.3.218`.
- Bundled and selected Claude Code: `2.1.218`.
- Authentication: Pro subscription OAuth with `ANTHROPIC_API_KEY` unset.
- Directly measured Extra Usage states: disabled and enabled.
- SDK options: `settingSources: []`, `tools: []`, `maxTurns: 1`, and
  `persistSession: false`.
- Extra Usage remained enabled on the account after Phase 8.

## Direct Pro measurements

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
`system:init.claude_code_version === "2.1.218"`.

| Requested alias | `system:init.model` | Served usage key | Canonical model | Served input / max output |
| --- | --- | --- | --- | ---: |
| `fable` | `claude-fable-5` | `claude-fable-5` | `claude-fable-5` | 1M / 64K |
| `opus` | `claude-opus-4-8` | `claude-opus-4-8` | `claude-opus-4-8` | 1M / 64K |
| `sonnet` | `claude-sonnet-5` | `claude-sonnet-5` | `claude-sonnet-5` | 1M / 64K |
| `haiku` | `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` | `claude-haiku-4-5` | 200K / 32K |

Saved alias report:

- `.test-output/context-size/pro-extra-on-aliases-2026-07-23T21-38-11-147Z.{json,md}`.

## Bridge-level served-window parity

Two authenticated bridge checks directly compared Claude Code's served metadata
with the model registered in Pi:

- Haiku: served `200000`, registered `200000`, maximum output `32000`.
- Fable on Pro with Extra Usage enabled: served `1000000`, registered
  `1000000`, maximum output `64000`.

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
Claude Code `2.1.218` coverage.

## Coverage boundaries

- **Directly measured:** Pro with Extra Usage disabled and enabled; every model
  ID and form in the current matrix; the four aliases with Extra Usage enabled;
  and Haiku/Fable bridge-level served-window parity.
- **Inferred only:** aliases with Extra Usage disabled where the enabled alias
  maps to a canonical model whose disabled full ID was directly measured. In
  particular, disabled-state `fable` is expected to reach the measured Fable
  credit gate, but the alias itself was not run in that state.
- **User-reported only:** Fable 5 works on Max. The bridge preserves configured
  Max behavior, but Phase 8 did not measure it.
- **Untested:** Max, Team, Enterprise, API-key authentication, other accounts,
  aliases with Extra Usage disabled, and near-limit payload boundary behavior.

Do not extend these results to an untested account, authentication method,
subscription tier, or Extra Usage state.
