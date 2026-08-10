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

## Provider

Use `/model` to select `claude-bridge/claude-fable-5`, `claude-bridge/claude-opus-5`, `claude-bridge/claude-opus-4-8`, `claude-bridge/claude-opus-4-7`, `claude-bridge/claude-opus-4-6`, `claude-bridge/claude-sonnet-5`, `claude-bridge/claude-sonnet-4-6`, or `claude-bridge/claude-haiku-4-5`.

Behind the scenes, pi's tools are bridged to Claude Code but it should all work like normal in pi. Bash commands get a 120-second default timeout (matching Claude Code's default) since pi's bash has no timeout by default. Skills in pi are copied over to Claude Code's system prompt so should work as they would with any other pi provider. Steering works mid-turn: a message sent while Claude is running a tool reaches it at that tool boundary, not after the whole turn finishes.

**1M Context:** Opus 5, Opus 4.7, and Opus 4.8 get 1M context by default. Opus 5 is native 1M: it is requested by its bare model ID and depends on neither `provider.plan` nor `provider.longContextExtraUsage`. Opus 4.6 only gets 1M if you're on a Max plan or pay for Extra Usage. Sonnet 4.6 only gets 1M if you pay for Extra Usage. You will need to set `provider.plan` and/or `provider.longContextExtraUsage` for 1M context in Opus 4.6/Sonnet 4.6 as described in [Configuration](#configuration).

**Model shortcuts:** `opus` selects Opus 5. Opus 4.8, 4.7, and 4.6 remain selectable by their full IDs for pinning and rollback.

## AskClaude Tool

Opt-in: set `askClaude.enabled` to `true` (see [Configuration](#configuration)). Available when using any non-claude-bridge provider. Pi's LLM can delegate tasks to Claude Code and wait for it to answer a question or perform a task. Examples of how to use:

- "Ask Claude to plan a fix"
- "If you get stuck, ask claude for help"
- "Ask claude to review the plan in @foo.md, implement it, then ask an isolated=true claude to review the implementation"
- "Ask claude to poke holes in this theory"
- "Find all the places in the codebase that handle auth"

You could also create skills or add something to AGENTS.md to e.g. "Always call Ask Claude to review complicated feature implementations before considering the task complete."

### Parameters

- **`prompt`** — the question or task for Claude Code
- **`mode`** — `read` (default, read files and search/fetch on web), `none` (no file access), or `full` (read+write+bash). Set `allowFullMode: false` to disable full mode.
- **`model`** — `opus` (default, resolves to Opus 5), `sonnet`, `haiku`, or a full model ID
- **`thinking`** — effort level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Levels resolve per model, the same way they do for the provider: on models with a distinct top-but-one tier (Opus 5, Opus 4.8, Opus 4.7, Sonnet 5, Fable 5) `xhigh` means the literal `xhigh` tier, and `max` is the maximum. On models with no separate `xhigh` tier (Opus 4.6, Sonnet 4.6, Haiku 4.5) `xhigh` and `max` both request the maximum.
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
- `appendSystemPrompt` — append pi's project context files (global and ancestor `AGENTS.md` / `CLAUDE.md`) and skills (default `true`). This covers pi's own content only. On the provider path a short `# Harness corrections` block is appended regardless of this setting, because Claude Code's preset prompt otherwise names tools and a model ID that do not exist here. AskClaude receives corrections only when it is already forwarding a skills block. Regardless of this setting, prompts forwarded from a pi-subagents `prompt_mode: "append"` session have pi's own harness boilerplate (and duplicate context/skills blocks) stripped before reaching Claude Code, since Anthropic routes requests carrying that signature to metered usage. See [diag/SYSTEM-PROMPTS.md](diag/SYSTEM-PROMPTS.md).
- `settingSources` — which Claude Code settings tiers the spawned binary loads (`user`/`project`/`local`). Default `[]`: no `settings.json` of any tier and no `CLAUDE.md` of Claude Code's own, so pi's forwarded context block is the only channel for project rules. Independent of `appendSystemPrompt`. (The bridge also excludes `**/CLAUDE.md` on every spawn path, so opting a tier back in for its `settings.json` — e.g. Bedrock/Vertex `apiKeyHelper` — does not re-admit a native CLAUDE.md.)
- `strictMcpConfig` — block MCP servers from the isolated profile's `.claude.json` and project `.mcp.json` (default `true`). Cloud MCP (Gmail/Drive via claude.ai OAuth) is always blocked.
- `autoMemoryEnabled` — enable Claude Code's auto-memory system (default `false`). The default off both sets the SDK settings layer and passes `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` to the subprocess; opting in drops both.
- `claudeConfigDir` — absolute path to the Claude Code filesystem profile (default `~/.pi/agent/claude`). Each config file is validated on its own, so an invalid or relative value warns and falls back to the next valid setting (a bad project value falls back to your global one, not to the default). An inherited `CLAUDE_CONFIG_DIR` does not override this setting.
- `pathToClaudeCodeExecutable` — path to the `claude` binary. Useful if your OS/filesystem has the SDK's bundled musl/glibc binaries in a place where they can't run. For example, with Nix you can set the binary to e.g. `"/home/you/.nix-profile/bin/claude"`.


**Startup notice:** the first interactive session to reach Claude Code lists whichever of `provider.plan` and `askClaude.enabled` you have left unset, then records `startupNoticeShown` (the date, `YYYY-MM-DD`) in the global config so it doesn't nag again.

**Extension providers and models.json:** pi's `modelOverrides` in `~/.pi/agent/models.json` do not currently apply to extension-registered providers (like claude-bridge). Overriding `contextWindow` or other fields requires editing `src/models.ts` directly.

## Tests

`npm run test:unit` for offline tests (`tests/unit-*.mjs`: queue, import, skills). 

`npm test` for the full suite, which adds integration tests that hit APIs (`tests/int-*.{sh,mjs}`: smoke, multi-turn, cache, session-resume, session-rebuild, tool-message). Set `CLAUDE_BRIDGE_TESTING_ALT_MODEL` in `.env.test` for the alt-provider smoke test (e.g. `openrouter/z-ai/glm-4.7-flash`).

Integration tests spawn real `pi` and Claude Code subprocesses, so they need write access to `~/.claude` for CC's session state — a sandbox that blocks it makes the next turn's `--resume` fail with `No conversation found with session ID`. The RPC harness probes for this at startup and fails fast.

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to enable debug output:

- **Bridge log** at `~/.pi/agent/claude-bridge.log` — every provider call, session sync decision, tool result delivery, and CC's stderr. Override location with `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Per-query Claude Code CLI logs** at `~/.pi/agent/cc-cli-logs/<timestamp>-<tag>-<seq>.log` — the CC subprocess's own debug stream, one file per `query()` call. Tags are `provider` (main turn) or `askclaude` (sub-delegation). Useful when a resume fails or CC misbehaves internally — shows the CLI's own view of session loading, API requests, and tool calls.

When filing a bug about a session-resume failure (e.g. "No conversation found"), the most useful attachments are the `syncResult:` lines from the bridge log plus the matching `cc-cli-logs/` file for the failing query.

## Known issues

After a Claude Code release, review `getAskClaudeToolPolicy()` in `src/sdk-options.ts`. It gates which Claude Code tools the AskClaude subagent may invoke in `read`, `full`, and `none` modes. Add new agentic tools (PlanMode, Task spawning, and similar tools) to the appropriate policy if subagents should not use them.

**Sessions get rebuilt more often than they need to be, and a rebuild is expensive.** The bridge rewrites Claude Code's session from pi's history whenever pi's messages move underneath it — after an abort, `/compact`, tree navigation, or an API error. Measured over this repo's own bridge log, a rebuild boundary loses the prompt cache roughly 58% of the time against 26% for a plain resume, so an abort-heavy session costs noticeably more than a clean one. Aborts alone are 46% of rebuilds.

**Files Claude Code edits are not carried across a rebuild.** CC records the post-edit contents as an `edited_text_file` attachment; those aren't carried, because they hang off a tool-result record rather than a prompt and so have no stable position to restore them to. The edit itself survives — it's in the history as a tool call and its result — so this costs Claude the file snapshot, not the knowledge that it made the change. `@file` expansions *are* carried.
