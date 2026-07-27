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
- **bridge** — the repo's own `buildProviderQueryOptions`, so the option set is
  the provider path's rather than a copy of it. The append is a copy, though:
  `index.ts` assembles it, not the builder, so the tool re-implements the
  deterministic part (the harness corrections) and the two can silently diverge
  if only one is edited. Check both when either changes.

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
| claude-opus-4-8 | 6,126 | 4,550 | new |
| claude-opus-5 | 9,452 | 7,672 | new |
| claude-fable-5 | 10,570 | 8,980 | new |
| claude-opus-4-6 | 27,620 | 14,603 | legacy |
| claude-opus-4-7 | 27,624 | 14,403 | legacy |
| claude-sonnet-5 | 27,624 | 14,594 | legacy |
| claude-sonnet-4-6 | 27,627 | 14,406 | legacy |
| claude-haiku-4-5 | 27,627 | 14,406 | legacy |

These counts are the checked-in files under `diag/system-prompts/`, produced by
`diag/system-prompt.mjs`. The two columns come from separate runs with different
temp working directories, so a few dozen characters of the cli-versus-bridge gap
are cwd-path noise rather than signal.

The bridge column reflects all three fixes below. Auto-memory being off (defect 2)
is why the legacy-family prompts are roughly half their cli size; the harness
corrections (defects 1 and 3) add back 712 characters where a model ID needs
correcting and 525 where it does not. Before any of it, the bridge column read
26,7xx for every legacy model and 5,978 / 9,287 / 10,409 for Opus 4.8 / Opus 5 /
Fable 5.

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
prompt rather than in the bridge's own code. Defects 1, 2, and 3 have since been
fixed; defect 4 is noise and is left alone.

1. **Wrong shell and tool names (legacy family only). FIXED.** With no `Bash` tool
   in the inventory the line degrades to:

   ```
    - Prefer dedicated tools over PowerShell when one fits (Read, Edit, Write, Glob, Grep)
      — reserve PowerShell for shell-only operations.
   ```

   On macOS and Linux this names the wrong shell, and `Read`/`Edit`/`Write`/
   `Glob`/`Grep` do not exist under those names in the bridge (pi's tools arrive
   as MCP tools under `mcp__custom-tools__`). The new family does not contain this
   line at all.

   The preset is generated inside the binary and cannot be edited at the source,
   so `buildHarnessCorrections` (`src/harness-prompt.ts`) appends a `# Harness
   corrections` block naming the real tool surface. It costs 525 characters and is
   emitted on the provider path only, where the native inventory really is empty.
   AskClaude keeps Claude Code's native tools, so disclaiming them there would
   itself be false; that path gets a narrower shell-only line in `read` and `none`
   modes, which are the modes that block `Bash`.

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
   no longer surfaced; nothing is deleted. The "after" column here predates the
   harness corrections, which add some of it back (see the size table above).

3. **The `[1m]` suffix leaked into the model's self-description. FIXED.** Because
   `claudeCodeModelId` appends `[1m]` for long-context models, the prompt tells
   the model:

   ```
    - You are powered by the model named Sonnet 5. The exact model ID is claude-sonnet-5[1m].
   ```

   `claude-sonnet-5[1m]` is a Claude Code request alias, not a valid API model ID,
   so a user asking "what model are you" got an ID that does not exist. Which
   models are affected follows `resolveClaudeCodeRuntimeModel`, so it depends on
   plan and Extra Usage; measured with `plan: "max"` it hits Fable 5, Opus 4.6,
   Opus 4.8, and Sonnet 5, while Opus 5, Opus 4.7, Sonnet 4.6, and Haiku 4.5
   already reported a clean ID.

   The corrections block states the bare ID and explains the suffix, costing 187
   characters and emitted only when `cliModelId` actually differs from the
   registered `modelId`. It applies to the provider path and to AskClaude.

4. **Hooks and CLAUDE.md references.** Both families describe Claude Code hooks,
   which pi has no concept of: five mentions in the legacy family, two in the new
   (counted post-fix). CLAUDE.md survives once in the legacy family and no longer
   at all in the new one, the remaining new-family mention having lived inside the
   memory section. This is harmless noise, and the CLAUDE.md reference is in fact
   accurate: `extractAgentsAppend` (`src/agents-md.ts:38`) labels the appended
   AGENTS.md as `# CLAUDE.md`, so the prompt names something the bridge does send.

## The AskClaude path is not the provider path

Worth knowing before assuming a provider-path finding transfers: **AskClaude sends
no Claude Code system prompt at all unless a skills block is being forwarded.**
`buildAskClaudeQueryOptions` leaves `systemPrompt` undefined when there is nothing
to append, and the SDK reads that as "no preset", not "default preset". Measured
with `claude-sonnet-5[1m]`:

| Mode | Skills block | Prompt | PowerShell | `[1m]` |
| --- | --- | --- | --- | --- |
| read / full / none | absent | 62 chars (identity line only) | n/a | n/a |
| read | present | 14,766 | yes | yes |
| full | present | 14,754 | no | yes |
| none | present | 13,894 | yes | yes |

PowerShell tracks whether `Bash` is in the disallowed list, which is why `full`
mode escapes it. AskClaude also keeps Claude Code's native tools, so it gets the
model-ID line and (in `read`/`none`) a shell-only line, never the provider path's
MCP tool disclaimer.

### What the preset-free sub-agent was missing

Probing the assembled request for a `full`-mode call with no skills block: 25 tool
definitions (Bash, Write, Edit, Agent and 21 others) against a 136-character system
prompt. Absent were the entire `# Environment` block (working directory, platform,
OS, shell, git status, model identity) and `# Executing actions with care`, which
is the reversibility and blast-radius policy. Tool *descriptions* were still
present and carry substantial embedded guidance, so the sub-agent was not
unguided; what it lacked was the cross-cutting harness framing.

Handing a model `Bash`, `Write` and `Edit` with no blast-radius policy and no idea
what directory it is in is not a defensible default, and it was not a chosen one:
whether a sub-agent got that framing depended on whether pi's system prompt
happened to contain a skills block, which has nothing to do with how much damage
that sub-agent can do.

### Resolution

`full` mode now always sends the preset. `read` and `none` stay preset-free when
there is nothing to append: `none` has a single tool and `read` has a low blast
radius, so ~14K characters of tool guidance would be waste.

The condition in `buildAskClaudeQueryOptions` is `mode === "full" || Boolean(append)`,
a union rather than a plain mode check, because the forwarded skills block is
delivered *through* that append. Testing the mode alone would silently stop
forwarding skills in `read` and `none`. `index.ts` mirrors the same union when
deciding whether to build corrections; the two have to stay in step, since
emitting corrections is itself what can make the append non-empty.

Measured after the change, with `claude-sonnet-5[1m]`:

| Mode | Skills block | Prompt | Blast-radius policy | Environment | Skills forwarded |
| --- | --- | --- | --- | --- | --- |
| full | absent | 16,045 | yes | yes | n/a |
| read | absent | 137 | no | no | n/a |
| none | absent | 137 | no | no | n/a |
| full | present | 16,097 | yes | yes | yes |
| read | present | 16,278 | yes | yes | yes |
| none | present | 15,406 | yes | yes | yes |

The preset block carries `cache_control: ephemeral 1h`, so the added cost is a
cache write on the first `full`-mode call per hour per distinct prefix and cache
reads after that, not full input tokens on every call.

Sending the preset brought one incoherence with it, since `# Executing actions
with care` tells the model to confirm before hard-to-reverse actions and to
"always confirm first". A delegated sub-agent cannot: `AskUserQuestion` is in
`ASKCLAUDE_UNSUPPORTED_INTERACTIVE_TOOLS`, nobody is listening, and
`permissionMode` is `bypassPermissions` so nothing gates mechanically either.

The correction invokes the preset's own documented override rather than
contradicting it:

> This default can be changed by user instructions - if explicitly asked to
> operate more autonomously, then you may proceed without confirmation, but still
> attend to the risks and consequences when taking actions.

so `buildHarnessCorrections` adds a `noInteractiveChannel` bullet telling the
sub-agent it is delegated, to proceed autonomously within the scope of the
request, and to stop and report rather than ask when something would exceed that
scope. The surrounding blast-radius guidance is left intact and still appears in
the captured prompt alongside the correction. This bullet is **not** emitted on
the provider path, where pi's TUI does put a user on the other end and the
confirmation guidance is actionable.

Measured effect: the sub-agent never stalled waiting for an answer, before or
after. Across 69 distinct sub-agent results in one authenticated run, three
contained a trailing offer, all from `none` mode and all of the form "I could not
do that, would you like me to try alternatives?" after being asked for four
operations it has no tools for. That is a different phenomenon from
permission-seeking, and no before/after rate was measured, so no improvement is
claimed there. What the correction fixes is the instruction itself being
impossible to follow.

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

The residual delta did not justify that cost, and all three actionable defects
have now been closed within the append seam for a total of 712 characters.

What was done:

1. ~~Set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` on the provider path.~~ **Done.**
   Applied to the provider and AskClaude paths through `CLAUDE_ISOLATION_ENV`
   (`src/sdk-options.ts`), matching what the compaction path already did. Halves
   the legacy-family prompt. Not gated behind a provider setting, since the
   instructions it removes name a tool neither path exposes; add a setting if
   someone turns out to want Claude Code memory through the bridge.
2. ~~Add a corrective block naming pi's actual tool surface and shell.~~ **Done.**
   `buildHarnessCorrections` (`src/harness-prompt.ts`) emits a `# Harness
   corrections` block naming `mcp__custom-tools__` (`MCP_TOOL_PREFIX`,
   `src/skills.ts:5`) in place of `Read`/`Edit`/`Write`/`Glob`/`Grep`/PowerShell.
3. ~~Correct the `[1m]` identity line.~~ **Done.** Same block, emitted only when
   `cliModelId` differs from the registered `modelId`.

Two deliberate choices in that implementation are worth keeping if it is revisited.
The corrections are **not** gated on `provider.appendSystemPrompt`: that setting
governs whether pi's own content (AGENTS.md, skills) is forwarded, and switching it
off must not leave the model reading false claims about its tools and ID. And each
bullet is emitted only where the defect was measured, so no path is told something
untrue about itself in the course of fixing something else.

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
