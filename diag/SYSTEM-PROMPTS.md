# Claude Code system prompts, per model

Measured record of the system prompt Claude Code assembles for each model, and of
what the bridge actually receives. Measured on 2026-07-26 against Claude Agent SDK
`0.3.220` with bundled Claude Code `2.1.220` (manifest commit `4073f595`), macOS
arm64, a single subscription account.

## Headline

**The bridge already uses the original per-model prompts.** `buildProviderQueryOptions`
sends `systemPrompt: {type: "preset", preset: "claude_code"}` (`src/sdk-options.ts:134`)
and passes the model through `extraArgs.model`, so the binary performs its own
per-model prompt selection on every request. There is nothing to "adopt": the
question is only whether the delivered prompt needs correcting for pi, and the
measured answer is that it needs very little.

## Method

Captured from our own outgoing traffic rather than reconstructed from the binary.
`diag/system-prompt.mjs` starts a local stub on `ANTHROPIC_BASE_URL` that records
the request body and answers `400`, so the assembled `system` array is observed
exactly as sent and no upstream call is made (no quota spent). Two harness modes
are captured per model:

- **cli** — the bundled binary run with `-p` (`cc_entrypoint=sdk-cli`).
- **bridge** — the repo's own `buildProviderQueryOptions`, so the option set
  cannot drift from what the provider path sends.

Bridge mode makes exactly one deliberate departure from the provider path: it
deletes `CLAUDE_CONFIG_DIR` from the built options so the capture can authenticate
(see the caveat below). That departure is now invisible in the prompt, because
disabling auto memory removed the only section that interpolated a profile-derived
path. It did matter for the pre-fix figures quoted in defect 2, where the captured
memory directory sat under `~/.claude/projects/...` rather than the bridge's real
`~/.pi/agent/claude/...`; only that path string differed.

`settingSources` is pinned to `[]` in both modes so CLAUDE.md and user settings
cannot pollute the per-model diff. Bridge mode resolves model IDs with
`{plan: "max", longContextExtraUsage: false}`, which exercises the `[1m]` request
path for the models that take it. Extracted prompts are checked in under
`diag/system-prompts/` as `<model>.cli.txt` and `<model>.bridge.txt`.

Reproduce with:

```
env -u ANTHROPIC_API_KEY node --import tsx diag/system-prompt.mjs
```

Two capture caveats worth knowing:

- The capture must **not** point `CLAUDE_CONFIG_DIR` at `~/.claude`. Measured on
  `2.1.220` with three otherwise-identical Agent SDK queries: unset succeeds,
  `CLAUDE_CONFIG_DIR=~/.claude` fails with `OAuth session expired and could not
  be refreshed`, and `CLAUDE_CONFIG_DIR=~/.pi/agent/claude` (the bridge's own
  default) succeeds. Note that unset resolves to `~/.claude` as well, so the same
  directory behaves differently depending only on whether the variable is set.
  The mechanism was not determined and is out of scope here; what matters is that
  the bridge's own profile authenticates normally, so this is a capture caveat
  and not a bridge defect.
- **cli mode only:** prompt sizes shift by a few dozen characters between runs
  because the auto memory directory path (derived from cwd) is interpolated into
  the prompt, and the tool captures from a fresh temp cwd each time. Compare
  structure, not exact byte counts, across cli runs. Bridge-mode captures are
  byte-stable across runs now that auto memory is off (defect 2), since nothing
  cwd-derived remains in the prompt.

## Result: eight distinct prompts, in two families

Every model gets a different prompt, and versions of the same model differ too.
`sysChars` is the third system block (the instruction body); the first two blocks
are a billing header and a one-line harness identity.

| Model | cli chars | bridge chars | Family |
| --- | --- | --- | --- |
| claude-opus-4-8 | 6,126 | 3,836 | new |
| claude-opus-5 | 9,452 | 7,145 | new |
| claude-fable-5 | 10,570 | 8,267 | new |
| claude-opus-4-6 | 27,620 | 13,889 | legacy |
| claude-opus-4-7 | 27,624 | 13,876 | legacy |
| claude-sonnet-5 | 27,624 | 13,880 | legacy |
| claude-sonnet-4-6 | 27,627 | 13,879 | legacy |
| claude-haiku-4-5 | 27,627 | 13,879 | legacy |

These counts are the checked-in files under `diag/system-prompts/`, produced by
`diag/system-prompt.mjs`. The two columns come from separate runs with different
temp working directories, so a few dozen characters of the cli-versus-bridge gap
are cwd-path noise rather than signal.

The bridge column is measured **after** auto-memory was disabled on the provider
path (defect 2 below), which is why the legacy-family prompts are roughly half
their cli size. Before that change the bridge column read 26,7xx for every legacy
model and 5,978 / 9,287 / 10,409 for Opus 4.8 / Opus 5 / Fable 5.

### Legacy family (Opus 4.6, Opus 4.7, Sonnet 5, Sonnet 4.6, Haiku 4.5)

Sections (cli mode): `# System`, `# Doing tasks`, `# Executing actions with care`,
`# Using your tools`, `# Tone and style`, `# Text output`,
`# Session-specific guidance`, `# auto memory` (with 6 subsections),
`# Environment`, `# Context management`.

Across all five models the instruction body is **byte-identical** except for two
lines in `# Environment`:

```
 - You are powered by the model named <Name>. The exact model ID is <id>.
 - Assistant knowledge cutoff is <date>.
```

Measured cutoffs, all eight models (cli mode):

| Model | Stated knowledge cutoff |
| --- | --- |
| claude-haiku-4-5 | February 2025 |
| claude-opus-4-6 | May 2025 |
| claude-sonnet-4-6 | August 2025 |
| claude-fable-5 | January 2026 |
| claude-opus-4-7 | January 2026 |
| claude-opus-4-8 | January 2026 |
| claude-sonnet-5 | January 2026 |
| claude-opus-5 | May 2026 |

### New family (Opus 4.8, Opus 5, Fable 5)

Sections (cli mode): `# Harness`, `# Session-specific guidance`, `# Memory`, `# Environment`,
`# Context management`. The ~13k-character `# auto memory` block of the legacy
family is replaced by a compact `# Memory` section, which is where most of the
size difference comes from.

Here the differences are genuine authoring, not substitution:

- **Opus 5** adds `# Delivering work` and `# Corrections` (~2.6k chars) that Opus
  4.8 does not have, and softens the destructive-action guidance ("Before deleting
  or overwriting, look at the target." versus 4.8's longer "if what you find
  contradicts how it was described ... surface that instead of proceeding").
- **Fable 5** adds a full `# Communicating with the user` section (~1.8k chars)
  that neither Opus 5 nor Opus 4.8 receives, plus a model-identity paragraph about
  the Claude 5 / Mythos tier, but **drops** `# Delivering work` and `# Corrections`.
- Opus 4.8 describes `<system-reminder>` tags explicitly; Opus 5 and Fable 5 use
  the more abstract "the system may send updates, reminders, or modifications to
  rules via mid-conversation system turns".

Tool *descriptions* are also shorter for the new family in cli mode (~47.5k chars
of tool JSON versus ~65.6k for legacy), which is a separate saving the bridge does
not benefit from because it ships zero native tools.

## What the bridge receives, and where it mismatches pi

The bridge sends `tools: []`, and the captured requests confirm the native
inventory is genuinely empty (`system:init` reports `tools: []`, and the request
carries `0` tool definitions). Claude Code's prompt assembly is tool-aware and
already drops most of what would not apply. Diffing `claude-sonnet-5.cli.txt`
against `claude-sonnet-5.bridge.txt`, the bridge correctly loses:

- the whole `# Session-specific guidance` block about `Agent`, `subagent_type=Explore`,
  and invoking `/<skill-name>` via `Skill`;
- the `Use TaskCreate to plan and track work` line.

The `# auto memory` and `# Memory` sections are also absent from the checked-in
bridge files, but that is the bridge's own doing rather than upstream adaptation
(see defect 2).

Four residual defects were found. All are small, and all are in the delivered
prompt rather than in the bridge's own code. Defect 2 has since been fixed;
defects 1, 3, and 4 remain open.

1. **Wrong shell named (legacy family only).** With no `Bash` tool in the
   inventory the line degrades to:

   ```
    - Prefer dedicated tools over PowerShell when one fits (Read, Edit, Write, Glob, Grep)
      — reserve PowerShell for shell-only operations.
   ```

   On macOS and Linux this names the wrong shell, and `Read`/`Edit`/`Write`/
   `Glob`/`Grep` do not exist under those names in the bridge (pi's tools arrive
   as MCP tools under the bridge's own server name). The new family does not
   contain this line at all.

2. **Auto memory was the largest unactionable block. FIXED.** Both families
   instructed the model to use a file-based memory directory and to "write to it
   directly with the `Write` tool", which is not in the inventory.
   `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` was set only on the compaction path
   (`buildIsolatedSummaryQueryOptions`); it now applies to the provider and
   AskClaude paths as well, via `CLAUDE_ISOLATION_ENV` in `src/sdk-options.ts`.
   Re-measured on the bridge path after the change:

   | Model | before | after | saved |
   | --- | --- | --- | --- |
   | claude-opus-4-6 | 26,771 | 13,889 | 12,882 chars (~3.2k tokens) |
   | claude-opus-4-7 | 26,758 | 13,876 | 12,882 chars |
   | claude-sonnet-5 | 26,762 | 13,880 | 12,882 chars |
   | claude-sonnet-4-6 | 26,761 | 13,879 | 12,882 chars |
   | claude-haiku-4-5 | 26,761 | 13,879 | 12,882 chars |
   | claude-fable-5 | 10,409 | 8,267 | 2,142 chars (~0.5k tokens) |
   | claude-opus-5 | 9,287 | 7,145 | 2,142 chars |
   | claude-opus-4-8 | 5,978 | 3,836 | 2,142 chars |

   The legacy-family prompt is now roughly half its former size. This is a saving
   on a cached prefix, so the practical value is the cache-write cost and the
   removal of instructions the model cannot follow, not a per-turn cost reduction.
   Note that any memories accumulated by earlier sessions under the pi profile are
   no longer surfaced; nothing is deleted.

3. **The `[1m]` suffix leaks into the model's self-description.** Because
   `claudeCodeModelId` appends `[1m]` for long-context models, the prompt tells
   the model:

   ```
    - You are powered by the model named Sonnet 5. The exact model ID is claude-sonnet-5[1m].
   ```

   `claude-sonnet-5[1m]` is a Claude Code request alias, not a valid API model ID.
   A user asking "what model are you" gets an ID that does not exist. Which models
   are affected follows `resolveClaudeCodeRuntimeModel`, so it depends on plan and
   Extra Usage; measured with `plan: "max"` it hits Fable 5, Opus 4.6, Opus 4.8,
   and Sonnet 5, while Opus 5, Opus 4.7, Sonnet 4.6, and Haiku 4.5 report a clean ID.

4. **Hooks and CLAUDE.md references.** Both families describe Claude Code hooks,
   which pi has no concept of: five mentions in the legacy family, two in the new
   (counted post-fix). CLAUDE.md survives once in the legacy family and no longer
   at all in the new one, the remaining new-family mention having lived inside the
   memory section. This is harmless noise, and the CLAUDE.md reference is in fact
   accurate: `extractAgentsAppend` (`src/agents-md.ts:38`) labels the appended
   AGENTS.md as `# CLAUDE.md`, so the prompt names something the bridge does send.

## Recommendation

**Keep the preset and correct it through the existing `append` seam. Do not
replace it with extracted text.**

The reason is maintenance surface, and the measurements make it concrete. A
checked-in custom prompt would have to be re-derived per model per Claude Code
release: this capture alone found eight distinct prompts, two structurally
different families, and version-level authoring differences between Opus 4.8,
Opus 5, and Fable 5 that no substitution rule predicts. The repo already tracks
releases closely (`2.1.220` pinned, `diag/CONTEXT-SIZE.md` as a measured record),
and every one of those eight would become a file to re-measure. The preset, by
contrast, tracks upstream for free and already self-adapts to the empty tool
inventory.

The residual delta does not justify that cost. After the tool-aware sections drop
out and auto memory is disabled, the mismatch is one wrong sentence about
PowerShell and a model ID with a suffix on it.

Proportionate follow-ups, in descending value:

1. ~~Set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` on the provider path.~~ **Done.**
   Applied to the provider and AskClaude paths through `CLAUDE_ISOLATION_ENV`
   (`src/sdk-options.ts`), matching what the compaction path already did. Halves
   the legacy-family prompt. Not gated behind a provider setting, since the
   instructions it removes name a tool neither path exposes; add a setting if
   someone turns out to want Claude Code memory through the bridge.
2. Add a short corrective block to `systemPromptAppend` naming pi's actual tool
   surface and shell, which overrides the PowerShell sentence for the legacy
   family. pi's tools arrive under the `custom-tools` MCP server, so they are
   visible to the model as `mcp__custom-tools__*` (`MCP_TOOL_PREFIX`,
   `src/skills.ts:5`), which is what the correction should name in place of
   `Read`/`Edit`/`Write`/`Glob`/`Grep`. Roughly 200 characters against 14k, and it
   costs nothing when the new family (which lacks the sentence) is selected.
3. Consider stripping `[1m]` from the identity line, either by appending a
   correction or by asking upstream for a fix. This is cosmetic unless users ask
   the model what it is.

Only a structural change upstream (for example, the preset ceasing to adapt to
tool inventory) would justify revisiting the wholesale-replacement option.

## Note for anyone re-running this

Isolating the auth failure above cost most of the time in this capture, so the
bisect is worth recording. Every other option in `buildProviderQueryOptions`
(`tools: []`, `bypassPermissions`, the preset prompt, `includePartialMessages`,
`strictMcpConfig`, `extraArgs.model` including the `[1m]` suffix, and the
`ENABLE_CLAUDEAI_MCP_SERVERS`, `DISABLE_AUTO_COMPACT`, and
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` variables from `claudeChildEnv`)
authenticated fine on its own against `2.1.220`. `CLAUDE_CONFIG_DIR` was the only
one that mattered, and only when pointed at `~/.claude`. If a future capture dies
at `Failed to authenticate`, start there rather than suspecting the stub.
