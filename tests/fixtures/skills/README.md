# Skill fixtures

Skills used by the live tests for `plans/skill-listing-contract.md` (AC12–AC15).
They are loaded with `pi --skill tests/fixtures/skills/<name>`, never installed,
so they cannot disturb the repo's own skill set or a developer's global skills.

Each body is one line and asks for a one-word reply, so a live assertion is a
substring match on stdout and the token cost stays near zero.

| fixture | frontmatter under test | expected reply |
| --- | --- | --- |
| `probe-skill` | none — plain listing + `skill` tool delivery | `ZANZIBAR-7731` |
| `probe-effort` | `effort: low` | `EFFORT-OK` |
| `probe-model` | `model: claude-sonnet-5` | `MODEL-OK` |
| `probe-xprovider` | `model: gpt-5.4-mini` (non-bridge provider) | `XPROV-MARKER-4412` |

## Two traps these fixtures encode

**`probe-effort` overrides *downward* on purpose.** An upward override is not
observable on every model: an earlier version used `effort: xhigh` and the
bridge logged `effort=high`, because Claude Haiku 4.5 clamps the level (A.2:
effort is clamped to the active model's supported thinking levels). That looked
like the override failing when it was working. `low` is representable everywhere,
so the assertion is unambiguous. Do not "strengthen" this to `xhigh`.

**`probe-model` produces a suffixed model id.** `claude-sonnet-5` is a
long-context model, so `claudeCodeModelId` appends `[1m]` and the debug line
reads `model=claude-sonnet-5[1m]`. Assert with a prefix or substring match, not
equality.

## Assertion surface

All four assert against the bridge's own debug log
(`CLAUDE_BRIDGE_DEBUG=1`, `CLAUDE_BRIDGE_DEBUG_PATH=<tmp>`), not a capture proxy:

- `provider: fresh query model=… msgs=… resume=… effort=…` — one per bridged
  request. Absence of this line means the turn did not reach the bridge at all,
  which is exactly what `probe-xprovider`'s first turn must show.
- `mcp handler: skill [<toolCallId>] → waiting` — the `skill` tool round trip.
- `syncResult: path=rebuild|resume …` — how the Claude Code session was
  reconciled.

## Environment notes

- `probe-skill` only exercises the `skill` tool when that tool is active. Until
  the fork defect described in the plan is fixed, that requires an explicit
  `--tools read,bash,edit,write,skill`; the default launch exercises the
  read-the-`<location>` branch instead. Both branches are required coverage.
- `probe-xprovider` needs a second authenticated provider (`openai-codex` when
  these were recorded). Skip the test rather than fail it when no non-bridge
  provider is configured.
