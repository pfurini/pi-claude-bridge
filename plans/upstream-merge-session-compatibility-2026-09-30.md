# Bridge merge compatibility with session control and workflows

The bridge needs session-scoped reusable mirrors, not process-wide ownership or workflow recovery logic.
A mirror caches a Pi conversation inside Claude Code; the mirror never grants control over that conversation.
The proposed merge must scope lifecycle cleanup as well as mirror lookup.
Current native subagents invalidate upstream's assumption that children never emit `session_shutdown`.
Paolo approves D1 on 2026-09-30: reuse mirrors within each live Pi session, with scoped lifecycle cleanup and fork safeguards.

Paolo confirms on 2026-09-30 that this extension supports only his Pi fork.
Stock Pi compatibility is not a design constraint, including fallback code and stock-only CI expectations.
The merge may use direct fork APIs when they simplify ownership, lifecycle routing, or configuration.
The earlier request to preserve both stock documentation template lines still applies to older fork prompts.

## Sources and evidence

| Source | Revision or authority | Evidence |
| --- | --- | --- |
| Bridge target | `personal`, `edf19ed6f3de6cc7f64fe77a3db4ccbfeba3e9d6` | Source reads and one offline lifecycle probe |
| Bridge source | `upstream/main`, `a78a2a5525e96318f8dba7f9fd32ce2191be0136` | Source, commits, tests, issue #101, and PR #128 |
| Pi fork | `personal`, `ab482a64a1b76983ec12413a66a5aa49babb4027` | Current source reads |
| Workflow engine | `change/workflow-engine`, `d64cc9c921a32ed25a2eaae6661165992787ee1a` | Current source and accepted design reads |
| Session-control authority | `/Users/paolof/Developer/ai/_handoffs/2026-09-26-pi-session-control-consolidated.md` | Requirements and rulings D1–D53 |

The workflow root is `/Users/paolof/.openintent/workspaces/pfurini/OpenIntent/worktrees/workflow-engine`.
Pi paths below are relative to `/Users/paolof/Developer/ai/pi`.
Bridge paths below are relative to this repository.
The analysis does not read the retired session-control handoffs or apply the rejected lifetime stash.
The initial compatibility analysis changes neither Pi nor OpenIntent and runs no build or authenticated test.
The subsequently approved D8 implementation changes and rebuilds Pi; OpenIntent remains untouched.

## Three different identities

| Identity | Authority | Bridge consequence |
| --- | --- | --- |
| Pi conversation | `SessionManager.getSessionId()` and projected transcript | Select the matching mirror; never substitute cwd, model, process, or workflow node name. |
| Live session and query lifetime | Pi lifecycle and request cancellation | Retire only the affected queries; reject callbacks from replaced lifetimes. |
| Workflow run, activation, attempt, and host generation | Engine journal and execution host | The bridge neither creates nor infers these identities. |

Session-control owner generations fence control requests, not workflow recovery.
A bridge-local lifetime token fences stale callbacks; the token must not claim to implement the future control generation protocol.
A new process may reconstruct Claude state from Pi history without recovering a workflow or authorizing another attempt.

Sources:
- Handoff sections 3, 6, 7, and 8.
- Workflow `openintent/changes/workflow-engine/design.md:347-388`, D6 and D7.
- Pi `packages/coding-agent/src/core/session-manager.ts:1299`.
- Pi `packages/agent/src/agent.ts:574-583` forwards the agent's session ID.

## Current and planned execution shapes

### Native Pi subagents

Pi builds child `AgentSession` instances from the parent's model runtime, with their own session managers and resource loaders.
Native subagents can therefore share provider execution state while holding different conversations and tool policies.
A completed child can retain its session for another prompt.
Worktree children cannot resume after their worktree is removed or handed over.
The subagent service owns cancellation, retention, and descendant cleanup.

Sources:
- Pi `packages/coding-agent/src/core/fork-builtins/subagents/runner/run.ts:184-209`.
- Pi `packages/coding-agent/src/core/fork-builtins/subagents/service/service.ts:1096-1126`.
- Pi `packages/coding-agent/src/core/fork-builtins/subagents/service/service.ts:765-802,1141-1198`.
- Handoff D18, D19, D21, D25, D26, and D47.

A reusable Claude mirror matches a retained child's session lifetime.
The mirror does not make the child detached, publicly addressable, or independent from its parent.
Making every child call ephemeral remains safe but discards useful continuity between native `resume` calls.

### Workflow workers today

The engine launches a separate Node process running its verified Pi SDK and ordinary RPC mode.
Each worker gets a fresh Pi session, private mutable home, selected resources, and host-controlled accounting.
The current factory rejects `reattach`, `fork`, and fan-out options.
The current factory permits another prompt in the same live worker for controlled continuation or output repair.
Waves 0–6 are complete; general recovery, fan-out, and explicit cross-step continuation remain later-wave work.

Sources:
- Workflow `packages/workflow/src/pi/worker-factory.ts:360-397,481-501,720-806`.
- Workflow `packages/workflow/src/pi/worker-entry.ts:1-16`.
- Workflow `openintent/changes/workflow-engine/tasks.md`, Waves 6–9.

A worker's Claude mirror remains private to that worker process.
Reusing the mirror for an admitted repair prompt does not reuse another worker or authorize a new activation.

### Planned continuation and control

The engine's D13 forks retained predecessor context into a new worker session.
Recovery reattachment sends no initial prompt; the host classifies existing results and effects before authorizing continuation.
The predecessor transcript remains unchanged, and accounting includes only new usage.
A client disconnect removes presentation, not work.
Owner end cancels owned work, while host-crash recovery stays under the engine's journal contract.

Sources:
- Workflow `openintent/changes/workflow-engine/design.md:634-711`, D12 and D13.
- Handoff D1, D5, D12, D21, and section 7's closed lifetime principles.

The bridge must not auto-resume a workflow because a Claude mirror exists.
The bridge must not promote an internal child to a public target or add its own owner registry.

## Confirmed lifecycle incompatibility

Upstream `src/index.ts:2368-2374` clears the whole mirror map and rewrite set on session lifecycle events.
The comment justifies that behavior by asserting that children never emit `session_shutdown`.
Current Pi contradicts that premise.
`teardownChild()` emits the child's shutdown event, waits up to three seconds, and disposes its session and loader.
`SubagentService.shutdown()` invokes bounded teardown across its children.

Sources:
- Pi `packages/coding-agent/src/core/fork-builtins/subagents/runner/run.ts:378-411`.
- Pi `packages/coding-agent/src/core/fork-builtins/subagents/service/service.ts:1141-1198`.
- Pi `packages/coding-agent/src/core/agent-session.ts:2046-2076`.

The fork already has the equivalent problem for its single mirror.
An offline probe creates two bridge extension closures in one module, seeds a parent mirror, and emits the child's shutdown event.
The real handlers clear both the parent mirror and the provider-registration sentinel.
The mocked SDK records zero queries.

Probe: `/tmp/bridge-session-lifecycle-probe-2026-09-30.mjs`.
Command: `node --import tsx /tmp/bridge-session-lifecycle-probe-2026-09-30.mjs`.
Observed result:

```json
{
  "sdkQueries": 0,
  "parentMirrorClearedByChildShutdown": true,
  "providerRegistrationClearedByChildShutdown": true
}
```

The probe proves handler behavior, not a complete native-subagent end-to-end run.
Pi source proves that native teardown emits the relevant event.
The merged suite needs a built-Pi regression joining both paths.

## Required bridge invariants

| Area | Required behavior | Reason |
| --- | --- | --- |
| Mirror lookup | Use Pi session identity and validate history, cwd, and Claude profile before reuse. | Different children and workers must never share conversation state accidentally. |
| Same-session overlap | Keep a single writer per reusable Claude transcript; concurrent calls use isolated imports. | Session identity alone does not prevent simultaneous writers. |
| Lifecycle cleanup | Child shutdown removes only child state and retires only child queries. | Native teardown must not invalidate a parent's mirror or registration. |
| Replacement and reload | Invalidate the replaced session lifetime and fence late callbacks. | A reused conversation ID cannot authorize an old query's completion. |
| Cross-module routing | Forward attributed lifecycle and rewrite events to the provider instance serving that session. | A worktree child's extension instance may differ from its shared provider instance. |
| Registration | Separate provider registration ownership from conversation ownership. | A child closure's shutdown does not mean the shared provider has ended. |
| Accounting | Keep epochs and cumulative-counter baselines inside the owning mirror. | Worker repair and child resume must report only new spending. |
| Fork and import | Build a separate mirror from projected Pi history without modifying the predecessor. | Planned workflow continuation preserves predecessor evidence. |
| Recovery | Retire stale transport and import completed tool results only during an actual Pi continuation request. | Provider transport recovery cannot become workflow retry or unknown-effect replay. |
| Tool scope | Serve only Pi's effective tools after transcript reconstruction. | Worker and native-child policies remain authoritative. |
| Questions | Transport allowed question calls as ordinary Pi tool calls. | Pi and the engine own claims, deadlines, persistence, and answers. |
| Clients | Ignore presentation attachment for query lifetime decisions. | Headless work and detached clients do not imply cancellation. |
| Storage and auth | Preserve request-specific cwd/profile and inherited authentication environment. | Worker isolation must not fall back to studio state or copied credentials. |

These invariants extend D1 beyond textual conflicts into lifecycle handlers that Git merges automatically.
The original preflight counts remain unchanged; the compatibility work expands semantic resolution scope.

## Boundaries that remain outside this merge

The workflow engine must exclude six tools before its work resumes, under handoff D43 and D51:

- `Agent`
- `get_subagent_result`
- `steer_subagent`
- `TaskExecute`
- `TaskOutput`
- `TaskStop`

The current worker policy permits the live tool set when no allowlist exists.
Source: workflow `packages/workflow/src/pi/worker-policy-extension.ts:156-176,220-235`.
The bridge must not hard-code those exclusions, because ordinary Pi sessions legitimately use the six tools.
The bridge should test that tools absent from Pi's effective inventory never appear as callable MCP tools.

Handoff D15 replaces the engine's planned ask-operator tool with `ask_user_question`.
The engine's older D8 prose still names ask-operator; the newer handoff ruling governs the planned amendment.
The bridge must not implement that amendment or add question-specific workflow policy.

The handoff leaves graceful operation cancellation and parts of attachment authentication open.
The bridge merge must not settle those questions by introducing a new control service or recovery API.
Future workflow acceptance must re-qualify approved bridge sources and SDK identity after this merge.
That qualification is distinct from this merge's offline validation and requires separate approval for live calls here.

## Approved D1 (2026-09-30)

Paolo selects reusable mirrors scoped to live Pi sessions, including retained native children.
Retain the fork's history, accounting, profile, and concurrent-writer protections.
Add session-scoped lifecycle cleanup and callback fencing instead of importing upstream's whole-map cleanup.
Keep native child ownership in Pi and workflow execution authority in the engine.

Paolo does not select ephemeral child mirrors, which would rebuild more often during native child resume.
The approved policy requires no new external package or workflow-specific bridge API.

## Offline validation required after approval

1. Parent and two native children retain separate mirrors through interleaved turns.
2. Child shutdown leaves the parent's active query, mirror, accounting, rewrite marks, and provider registration intact.
3. Parent disposal cancels owned children through Pi's existing cascade and leaves no bridge transport running.
4. A retained child resumes its own mirror; a forked or reopened context never rewrites its predecessor's transcript.
5. Same-session overlapping calls cannot share an active writer or corrupt its accounting baseline.
6. Reload or replacement rejects old callbacks, including when the Pi conversation ID stays unchanged.
7. Worktree children preserve their cwd, effective tools, instructions, and Claude storage profile.
8. Worker-style repair prompts account only new usage; failed calls preserve observed usage.
9. Mid-turn compaction imports completed results without re-executing tools or reviving another session's query.
10. Missing tools remain absent, and allowed MCP and question tool names round-trip unchanged.

Existing fork and upstream tests supply the fixtures; built-Pi tests must cover the lifecycle integration.
The analysis establishes compatibility constraints, not validation of unimplemented session-control or future workflow features.

## Implementation finding: children without the bridge extension

The approved implementation passes the native child-shutdown regression when both sessions load the bridge extension.
An additional built-Pi probe removes the bridge extension from the child while retaining the parent's model runtime.
The child still reaches the bridge provider, but Claude receives the process cwd rather than the child's worktree cwd.
The probe makes no real SDK query; the SDK transport remains mocked.

Sources:
- Pi `packages/coding-agent/src/core/fork-builtins/subagents/runner/scope.ts:228-264` disables extensions for isolated children.
- Pi `packages/agent/src/agent.ts:574-583` forwards sessionId but no cwd or agentDir.
- Pi `packages/ai/src/session-resources.ts` exposes provider cleanup by session ID.
- Probe `/tmp/bridge-no-extension-child-probe.mjs`; output `/tmp/bridge-no-extension-child-probe.log`.

The child's ordinary transcript contains a cwd section, but prompt content is not a complete session-metadata contract.
A forced replacement prompt may omit that section.
The bridge now registers Pi's resource-cleanup hook for extension-free child disposal.
Paolo approves D8's typed metadata contract and its Pi companion implementation after this finding.
The rebuilt companion resolves the directory-routing failure without loading extensions or parsing prompts.
`tests/unit-native-child-shutdown.mjs` passes for ordinary, extension-free, and forced-prompt children.
The final bridge suite passes all 580 tests; see `plans/upstream-merge-results-2026-09-30.md`.
