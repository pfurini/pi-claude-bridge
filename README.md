# pi-claude-bridge

[![npm version](https://img.shields.io/npm/v/pi-claude-bridge)](https://www.npmjs.com/package/pi-claude-bridge)

Pi extension that integrates Claude Code via the [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Based initially on [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal. This fork adds streaming, MCP tool bridging, custom pi tool bridging, session resume/persistence, context sync, thinking support, skills forwarding, and many correctness fixes.

1. **Provider** — Use Opus/Sonnet/Haiku as models in pi, with all tool calls flowing through pi's TUI
2. **AskClaude tool** — Delegate tasks or questions to Claude Code when using another provider


**FYI:** Anthropic [announced and then unannounced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) a change to how you would be billed for tools that use the Agent SDK like this one. It currently uses your regular subscription quota just like Claude Code.

<p>
<a href="assets/claude-bridge1.png"><img src="assets/claude-bridge1.png" width="49%"></a>&nbsp;
<a href="assets/claude-bridge2.png"><img src="assets/claude-bridge2.png" width="49%"></a>
</p>

## Install

```
pi install npm:pi-claude-bridge
```

Requires Pi 0.86.1 or newer (`pi-ai`, `pi-coding-agent`, and `pi-tui`) for the transcript provider contract.

## Provider

Use `/model` to select Claude models from Pi's installed Anthropic catalog, subject to the eligibility policy below.

- The picker discovers new catalog entries automatically and hides dated snapshot aliases.
- Full IDs select exact versions. Family shortcuts select the newest matching version.
- Use full IDs when reproducibility matters; catalog updates can change shortcut targets.
- Model discovery does not automatically extend context-window policy or validated steering.

Pi's tools run through the bridge's MCP server. Bash calls receive a 120-second default timeout.
The bridge forwards Pi's project instructions and skill listing. Mid-turn steering reaches Claude Code at a tool boundary.

**Context and eligibility:**

| Models | Request ID | Registered window | Eligibility |
| --- | --- | --- | --- |
| Opus 5.5, 5, 4.8, 4.7 | Bare ID | 1M | No local plan gate |
| Fable 5.1 | Bare ID | 1M | Max or Extra Usage |
| Fable 5 | `[1m]` suffix | 1M | Max or Extra Usage |
| Sonnet 5 | `[1m]` suffix | 1M | No local plan gate |
| Opus 4.6 | `[1m]` when eligible | 1M or 200K | Max or Extra Usage for 1M |
| Sonnet 4.6 | `[1m]` when eligible | 1M or 200K | Extra Usage for 1M |
| Other catalog models | Bare ID | 200K | No additional local gate |

Opus 5.5's bare-ID 1M policy is maintainer-confirmed. Existing measurements predate SDK 0.3.280; see [diag/CONTEXT-SIZE.md](diag/CONTEXT-SIZE.md).
Fable 5.1's Pro restriction remains conservative rather than measured on Pro.

## AskClaude Tool

Opt-in: set `askClaude.enabled` to `true` (see [Configuration](#configuration)). Available when using any non-claude-bridge provider. Pi's LLM can delegate tasks to Claude Code and wait for it to answer a question or perform a task. Examples of how to use:

- "Ask Claude to plan a fix"
- "If you get stuck, ask claude for help"
- "Ask claude to review the plan in @foo.md, implement it, then ask an isolated=true claude to review the implementation"
- "Ask claude to poke holes in this theory"
- "Find all the places in the codebase that handle auth"

Delegated calls use the configured Claude profile and exclude native `CLAUDE.md` files.
Full mode always receives Claude Code's preset. Read and none modes receive the preset only when the bridge has instructions to append.
None mode blocks all tools; read and full modes retain their existing native-skill policy.

You could also create skills or add something to AGENTS.md to e.g. "Always call Ask Claude to review complicated feature implementations before considering the task complete."

### Parameters

- **`prompt`** — the question or task for Claude Code
- **`mode`** — `read` (default, read files and search/fetch on web), `none` (no file access), or `full` (read+write+bash). Set `allowFullMode: false` to disable full mode.
- **`model`** — `opus` by default, another family shortcut, or an exact full model ID. Shortcuts follow the newest installed catalog version.
- **`thinking`** — effort level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Levels resolve per model, the same way they do for the provider: on models with a distinct top-but-one tier (Opus 5, Opus 4.8, Opus 4.7, Sonnet 5, Fable 5, Fable 5.1) `xhigh` means the literal `xhigh` tier, and `max` is the maximum. On models with no separate `xhigh` tier (Opus 4.6, Sonnet 4.6, Haiku 4.5) `xhigh` and `max` both request the maximum.
  Explicit null or invalid catalog mappings omit the effort argument. Only missing mappings use the generic fallback.
- **`isolated`** — when `true`, Claude gets a clean session with no conversation history (default: `false`)

## Configuration

Config: `~/.pi/agent/claude-bridge.json` (global) or the project Pi config directory, usually `.pi/claude-bridge.json` (project; merged over global).

Claude Code subprocesses use an isolated filesystem profile at `~/.pi/agent/claude` by default. This keeps bridge settings, plugins, skills, and session history separate from the normal interactive `~/.claude` profile. Existing Claude sessions and settings are not copied automatically. Linux and Windows store credentials inside the profile, while macOS stores OAuth credentials in Keychain but still keeps account metadata in the profile. A new isolated profile can therefore require a one-time login on every platform:

```bash
CLAUDE_CONFIG_DIR="$HOME/.pi/agent/claude" claude auth login
```

When `provider.pathToClaudeCodeExecutable` is configured, use that executable instead of the `claude` command above.

```json
{
  "askClaude": {
    "enabled": true,
    "allowFullMode": true,
    "defaultIsolated": false,
    "description": "Custom tool description override"
  },
  "provider": {
    "plan": "max",
    "longContextExtraUsage": false,
    "excludeModels": ["claude-opus-4-5", "claude-sonnet-4-5"],
    "strictMcpConfig": true,
    "claudeConfigDir": "/home/you/.pi/agent/claude",
    "pathToClaudeCodeExecutable": "/home/you/.nix-profile/bin/claude"
  }
}
```

`askClaude`:
- `enabled` — register the AskClaude tool (default `false`). If it's unset, the startup notice below points this out once.
- `name` — override the tool's pi-side name (default `"AskClaude"`)
- `label` — override the TUI label (default `"Ask Claude Code"`)
- `description` — override the tool description. Default when `allowFullMode: true`: *"Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself."*
- `defaultMode` — `"read"` (default), `"none"`, or `"full"`. Invalid values fall back to read mode with a warning.
- `defaultIsolated` — start each call in a fresh session (default `false`)
- `allowFullMode` — allow `mode: "full"`; set `false` to lock it out. This also overrides `defaultMode: "full"`, falls back to read mode, and emits a warning.
- `appendSkills` — forward pi's skills block into the system prompt (default `true`). Note that `full` mode always sends Claude Code's system prompt regardless of this setting, since it grants shell and filesystem access and needs the accompanying safety guidance; `read` and `none` send it only when there is something to append. See [diag/SYSTEM-PROMPTS.md](diag/SYSTEM-PROMPTS.md).

`provider`:
- `plan` (default `"pro"`) — set to `"max"` for Max (or Team Premium/Enterprise) to enable Opus 4.6 with 1M context. If it's unset, the first interactive session points this out once, then records `startupNoticeShown` (the date, `YYYY-MM-DD`) in the global config so it doesn't nag again.
- `longContextExtraUsage` — set to `true` to enable 1M models that cost money through Extra Usage. It enables Sonnet 4.6 with 1M on every plan and Opus 4.6 with 1M on Pro. Not needed for Opus 4.7 or 4.8.
- `excludeModels` — model ids (case-insensitive) to drop from the `/model` picker entirely, e.g. `["claude-opus-4-5", "claude-sonnet-4-5"]`. Use this to silence the `claude-bridge: encountered model … with no known context size` warning for catalog entries you don't intend to use — the excluded id never reaches the context-window lookup that logs it. Load-time only, like `plan` and `longContextExtraUsage` above.
- `appendSystemPrompt` controls generated project-context and skill forwarding (default `true`).
  - Project instructions come from Pi's global and ancestor `AGENTS.md` / `CLAUDE.md` files.
  - Skill framing names the available MCP `skill` or `read` tool. AskClaude uses native `Read` framing.
  - Effective authored sections, guidelines, addenda, and forced prompts remain authoritative independently of this gate.
  - The sanitizer removes recognized Pi boilerplate while preserving authored contributions and section overrides.
  - Exact project/skill duplicates disappear only when the dedicated forwarding path already supplies the same block.
  - Provider harness corrections always apply. AskClaude receives corrections in full mode or when forwarding skills.
  - Disabled forwarding retains capture-only customization for legacy flat contexts that lack structured prompt state.
  - See [diag/SYSTEM-PROMPTS.md](diag/SYSTEM-PROMPTS.md) for the prompt-channel background.
- `settingSources` — which Claude Code settings tiers the spawned binary loads (`user`/`project`/`local`). Default `[]`: no `settings.json` of any tier and no `CLAUDE.md` of Claude Code's own, so pi's forwarded context block is the only channel for project rules. Independent of `appendSystemPrompt`. (The bridge also excludes `**/CLAUDE.md` on every spawn path, so opting a tier back in for its `settings.json` — e.g. Bedrock/Vertex `apiKeyHelper` — does not re-admit a native CLAUDE.md.)
- `strictMcpConfig` — block MCP servers from the isolated profile's `.claude.json` and project `.mcp.json` (default `true`). Cloud MCP (Gmail/Drive via claude.ai OAuth) is always blocked.
- `autoMemoryEnabled` — enable Claude Code's auto-memory system (default `false`). The default off both sets the SDK settings layer and passes `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` to the subprocess; opting in drops both.
- `claudeConfigDir` — absolute path to the Claude Code filesystem profile (default `~/.pi/agent/claude`). Each config file is validated on its own, so an invalid or relative value warns and falls back to the next valid setting (a bad project value falls back to your global one, not to the default). An inherited `CLAUDE_CONFIG_DIR` does not override this setting.
- `pathToClaudeCodeExecutable` — path to the `claude` binary. Useful if your OS/filesystem has the SDK's bundled musl/glibc binaries in a place where they can't run. For example, with Nix you can set the binary to e.g. `"/home/you/.nix-profile/bin/claude"`.
- `usageEvents` — publish Claude subscription usage on pi's `pi:provider-usage` event channel (default `true`). See [Usage events](#usage-events) below. An invalid value warns once and falls back to `true`.


**Startup notice:** the first interactive session to reach Claude Code lists whichever of `provider.plan` and `askClaude.enabled` you have left unset, then records `startupNoticeShown` (the date, `YYYY-MM-DD`) in the global config so it doesn't nag again.

The bridge's explicit context-window policy lives in `src/models.ts`. This fork does not expose `provider.forceTwoHundredK`.

## Conversation recovery and accounting

The bridge compares projected history, tool declarations, and effective forwarded instructions before continuing an active query.
A mismatch imports current history into a replacement query, including completed tool results.
Recovery allows three replacements per turn and returns a terminal error when that budget is exhausted.
Recorded tool results prevent structural replay; the bridge does not promise exactly-once external effects after a host crash.

Standalone, tool-free SDK consumers can select `cacheRetention: "none"` for an independent request with the complete system prompt and no persisted conversation reuse.

Claude's estimated cost and model-usage totals can include earlier resumed turns.
The bridge subtracts the saved session baseline before attributing new usage, while retaining Claude's cost estimate rather than substituting catalog estimates.
A rebuild starts a new accounting baseline even when the session UUID stays unchanged.
Ambiguous termination invalidates reuse; concurrent shared calls use separate transcript imports.
These estimates are not billing statements or subscription-quota measurements.

## Usage events

The bridge publishes your Claude subscription usage on pi's shared event bus, on the channel `pi:provider-usage`, so a usage-indicator extension can render it in pi's footer. [`pi-usage-bars`](https://github.com/pfurini/pi-usage-bars) is the reference consumer.

This has to come from the bridge. Claude Code owns its own OAuth session outside pi's credential store, so the bridge registers with a static placeholder credential, and no other extension can authenticate as `claude-bridge` and fetch the numbers itself. **No credential is ever published**: the payload carries only normalized percentages, labels, and timestamps.

**What goes out.** A snapshot on `session_start`, and a refresh whenever Claude Code reports a rate limit event (which is used purely as a "something changed" trigger, never as a data source — it omits utilization while an account is healthy, so publishing it would disagree with the usage endpoint). The numbers themselves always come from `GET /api/oauth/usage`.

```ts
{
  v: 1,
  providerId: "claude-bridge",
  capturedAt: "2026-08-27T12:00:00.000Z",   // when the numbers were true
  quotas: [
    { kind: "session", percent: 32, resetsAt: "2026-08-27T15:30:00.000Z" },
    { kind: "weekly",  percent: 50, resetsAt: "2026-08-31T07:00:00.000Z" },
    { kind: "scoped",  label: "Fable", percent: 64, resetsAt: "2026-08-31T07:00:00.000Z" },
  ],
  notice: "overage disabled",               // optional
}
```

**When it cannot get the numbers**, the bridge says so rather than staying silent:

```ts
{ v: 1, providerId: "claude-bridge", quotas: [], capturedAt: "…", unavailable: { reason: "usage endpoint returned 503" } }
```

Silence would be unattributable: a consumer has no HTTP fallback for a bridge-provided provider ID, so a broken publisher and an absent one look identical, and the bar would sit on "waiting" forever. The reason is emitted **on transition**, not per attempt — a provider failing every poll produces one event, not one a minute — and re-emitted only when the reason changes. Recovery needs no separate message: a normal snapshot clears it. Reasons come from a closed set: credentials not found, credentials expired or rejected, rate limited, `usage endpoint returned <status>`, unreachable, unreadable.

**Load order and timing.** Pi runs `session_start` handlers in extension order, so an emit made inside the bridge's own handler would reach only the extensions loaded before it. The startup publish is therefore deferred past that dispatch loop, which makes the load order immaterial — verified live with a probe extension in both orders. One case remains: a consumer running in *one-shot* mode (`pi --usage`) prints and exits inside its own `session_start`, before any deferred emit can land, so a first-ever run there reports `pending` rather than the numbers or a reason. Snapshots survive it because the consumer persists them and the next run renders the last one; an unavailability does not, because a failure is deliberately never persisted as though it were data. In an interactive session both arrive normally.

**`unavailable.reason` and `notice` are operator-facing text rendered verbatim in another extension's terminal UI.** They never carry a response body, an exception message, a file path, or anything credential-adjacent; the status code is the only dynamic part of a reason. The consumer truncates them to 80 and 120 characters respectively, but the bridge already bounds and strips control characters from both rather than relying on somebody else's sanitizer to make its own output renderable.

**Request rate.** Usage is cached cross-process under the system temp directory, one file per Claude profile, with a 55-second TTL and a lock around the refresh, so twenty concurrent pi sessions cost the same as one. Ordinary failures are cached for 30 seconds and a 429 enters a cooldown starting at two minutes, doubling per consecutive rate limit and capped at thirty, honouring `Retry-After` within those bounds. `CLAUDE_BRIDGE_USAGE_CACHE_DIR` overrides the location.

**Turning it off.** Set `provider.usageEvents` to `false`. Nothing is then emitted and no credential is read at all. Note what that means for a consumer: because a bridge-provided provider ID has no HTTP path of its own, a usage indicator will stay in its "waiting for claude-bridge" state for the whole session rather than falling back to fetching the numbers itself.


## Tests

`npm run test:unit` for offline tests (`tests/unit-*.mjs`: queue, import, skills). 

`npm test` for the full suite, which adds integration tests that hit APIs (`tests/int-*.{sh,mjs}`: smoke, multi-turn, cache, session-resume, session-rebuild, tool-message). Set `CLAUDE_BRIDGE_TESTING_ALT_MODEL` in `.env.test` for the alt-provider smoke test (e.g. `openrouter/z-ai/glm-4.7-flash`).

Integration tests spawn real `pi` and Claude Code subprocesses, so they need write access to `~/.claude` for CC's session state — a sandbox that blocks it makes the next turn's `--resume` fail with `No conversation found with session ID`. The RPC harness probes for this at startup and fails fast.

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to enable debug output:

- **Bridge log** at `~/.pi/agent/claude-bridge.log` — every provider call, session sync decision, tool result delivery, and CC's stderr. Override location with `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Per-query Claude Code CLI logs** at `~/.pi/agent/cc-cli-logs/<timestamp>-<tag>-<seq>.log` — the CC subprocess's own debug stream, one file per `query()` call. Tags are `provider` (main turn) or `askclaude` (sub-delegation). Useful when a resume fails or CC misbehaves internally — shows the CLI's own view of session loading, API requests, and tool calls.

Diagnostics use `claude-bridge-diag.log` beside the bridge log; `CLAUDE_BRIDGE_DIAG_PATH` selects an explicit destination.
Denied log writes preserve their entries on stderr rather than replacing the provider result.
Inaccessible Claude CLI debug files are omitted without failing the query.
Inside a fence, prefer a workspace-local log destination rather than broader global write permissions.

Fenced Claude subprocesses inherit `CLAUDE_CODE_TMPDIR` from the assigned `TMPDIR` when no explicit Claude temporary directory exists.
The bridge preserves explicit overrides and does not change filesystem grants.

When filing a bug about a session-resume failure (e.g. "No conversation found"), the most useful attachments are the `syncResult:` lines from the bridge log plus the matching `cc-cli-logs/` file for the failing query.

## Compatibility with other extensions

The bridge reconstructs prompt and tool state from Pi's transcript before extracting project instructions and skills.
The existing sanitizer removes recognized inherited Pi boilerplate and exact duplicate forwarded blocks.
This fork does not use an exact-key prompt-capture registry or reject authored text merely for mentioning documentation paths.

The bridge checks projected history before reusing persisted Claude sessions. Changed prefixes trigger rebuilding from Pi's projection rather than raw session entries.
Independent child sessions retain separate imported histories.

During tool continuation, changed history or effective MCP declarations trigger an automatic restart into a rotated Claude session.
The bridge imports completed results rather than re-executing their tools. Recovery requires no attached client.
Recovery allows three restarts per turn. Startup failures, cancellation, or budget exhaustion produce terminal errors rather than indefinite retries.
Retired queries retain their observed usage and estimated costs, matching the existing abort policy when no terminal cost report arrives.

## Known issues

After a Claude Code release, review `getAskClaudeToolPolicy()` in `src/sdk-options.ts`. It gates which Claude Code tools the AskClaude subagent may invoke in `read`, `full`, and `none` modes. Add new agentic tools (PlanMode, Task spawning, and similar tools) to the appropriate policy if subagents should not use them.

**Sessions get rebuilt more often than they need to be, and a rebuild is expensive.** The bridge rewrites Claude Code's session from pi's history whenever pi's messages move underneath it — after an abort, `/compact`, tree navigation, or an API error. Measured over this repo's own bridge log, a rebuild boundary loses the prompt cache roughly 58% of the time against 26% for a plain resume, so an abort-heavy session costs noticeably more than a clean one. Aborts alone are 46% of rebuilds.

**Files Claude Code edits are not carried across a rebuild.** CC records the post-edit contents as an `edited_text_file` attachment; those aren't carried, because they hang off a tool-result record rather than a prompt and so have no stable position to restore them to. The edit itself survives — it's in the history as a tool call and its result — so this costs Claude the file snapshot, not the knowledge that it made the change. `@file` expansions *are* carried.

**On pi 0.86 with bridge 0.7.0 or older, every new session fails.** The symptoms are `WARNING session verify: file missing after save` and then `No conversation found with session ID` on the next turn: pi 0.86 moved the system prompt and tool set into `role:"system"` transcript messages, which the older bridge read as a one-message history. Upgrade the bridge rather than downgrading pi — on 0.86 the old bridge also serves no tools, so a turn that does go through looks normal while the model writes tool calls out as prose instead of calling anything.

**Exported Anthropic environment variables override the Claude Code child (issue #107).** The bridge passes the ambient environment through, so an `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` exported for another gateway (a corporate proxy, LiteLLM) redirects Claude Code as well, and every turn fails with that gateway's auth error. Unset them for the pi process.
