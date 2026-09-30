# Pi provider session context (proposed)

The companion change gives providers authoritative session directories without requiring an extension inside every child.
Pi's existing session stream wrapper already captures the required values and composes provider request options.
The proposal adds one typed, local request field at that boundary.
The bridge consumes the field and uses Pi's existing resource-cleanup API.
Paolo approves implementation, focused offline validation, and `npm run build:offline` on 2026-09-30.

## Evidence

Pi revision: `ab482a64a1b76983ec12413a66a5aa49babb4027` on `personal`.
Pi root: `/Users/paolof/Developer/ai/pi`.

| Source | Relevant behavior |
| --- | --- |
| `packages/coding-agent/src/core/sdk.ts:344-380` | `buildRequestOptions` already composes session-owned signal, retry, timeout, and header settings. |
| `packages/coding-agent/src/core/sdk.ts:429-443` | `sessionStreamFn` sends those options through the selected `ModelRuntime`. |
| `packages/coding-agent/src/core/agent-session-services.ts:223-244` | Service-created sessions use `createAgentSession`, so workflow workers use the same wrapper. |
| `packages/coding-agent/src/core/default-stream-fn.ts` | Bare calls dispatch through the selected session's stream wrapper; ambiguous ownership already fails. |
| `packages/coding-agent/src/core/model-runtime.ts:733-763` | Virtual routing and provider preparation preserve request options. |
| `packages/ai/src/types.ts:214-244` | `sessionId` currently names provider caching/routing; `metadata` can enter vendor requests. |
| `packages/ai/src/session-resources.ts` | Providers can subscribe to session disposal without extension lifecycle handlers. |
| `packages/coding-agent/src/core/agent-session.ts:2131` | Core disposal calls `cleanupSessionResources(this.sessionId)`. |
| `docs/adr/ADR-0003-fork-first-merge-hygiene.md` | New logic belongs in fork-owned modules; hot files receive thin call sites. |

The failing bridge probe is `/tmp/bridge-no-extension-child-probe.mjs`.
The probe shares a model runtime between two built-Pi sessions and omits the bridge extension from the child.
The mocked SDK receives the process cwd instead of the child's worktree cwd.
The probe performs no authenticated request.

## Proposed public contract

Add a fork-owned `packages/ai/src/provider-session-context.ts`:

```ts
export interface ProviderSessionContext {
  readonly ownerSessionId: string;
  readonly cwd: string;
  readonly agentDir: string;
}
```

Add `sessionContext?: ProviderSessionContext` to chat `StreamOptions` and export the type through the package's public type surface.
Use a short type import and property addition in `types.ts`; no `agent-loop.ts` change is required.

Contract:

- `ownerSessionId` names the `AgentSession` whose stream wrapper serves the request.
- `cwd` and `agentDir` come from that session's construction inputs.
- The wrapper creates a fresh readonly snapshot for each request.
- The wrapper overrides caller-supplied `sessionContext`; callers cannot impersonate another session through the bound wrapper.
- Existing `options.sessionId` remains unchanged as the request's caching/routing identity.
- Compaction, summaries, and bare calls can use routing IDs different from `ownerSessionId`.
- The field is local provider execution metadata, not model input, telemetry baggage, an HTTP header, or vendor request metadata.
- Direct low-level provider callers without an `AgentSession` may supply the field explicitly.
- Callers that do not execute inside a local session may omit the field.
- The field contains no credentials, generation token, authorization grant, or workflow identity.

Do not reuse `StreamOptions.metadata`, which has vendor-facing semantics.
Do not derive directories from rendered prompts or change extension isolation.

## Pi implementation

1. Add the type module and public export.
2. Add the optional `StreamOptions.sessionContext` property.
3. Add a small fork-owned request-context helper under `packages/coding-agent/src/core/` if construction needs more than a simple object literal.
4. Populate the field in `sdk.ts`'s existing `buildRequestOptions`, after spreading caller options.
5. Read the current `sessionManager.getSessionId()` on each call rather than capturing its initial value.
6. Preserve cache warming, provider hooks, cancellation, auth preparation, and virtual routing behavior.
7. Document the local-only field and its distinction from routing `sessionId`.

Expected runtime footprint is the existing SDK options wrapper plus the public optional type.
The proposal adds no global session registry, AsyncLocalStorage layer, host protocol, or dependency.
Raw `new AgentSession` construction with a caller-owned custom stream remains the caller's responsibility.
The focused source review must verify that path before finalizing its documentation.

## Bridge integration

- Use `sessionContext.cwd` and `sessionContext.agentDir` before any extension-bound metadata.
- Resolve configuration for the serving session's directories without changing the registered model policy.
- Associate transport cleanup with `ownerSessionId`, distinct from any explicit request routing ID.
- Keep mirror identity separate from lifecycle ownership for summary and low-level auxiliary calls.
- Use `registerSessionResourceCleanup` for children that load no bridge extension.
- Preserve early `session_shutdown` retirement for bound extension lifetimes and late-callback guards.
- Refuse an unbound request lacking authoritative directories rather than silently using process cwd.
- Preserve direct AskClaude directory inputs from its extension context.

The implementation must not treat an auxiliary call's history as permission to overwrite the owner's main conversation.
No workflow retry, public child control, or additional provider-capability probe enters the bridge.

## Validation

All tests use fake providers or mocked Claude transport.

Pi checks:

1. Parent and child share one model runtime but providers receive different owner IDs and directories.
2. A child with no extensions still receives its own metadata.
3. Forced replacement prompts cannot erase or alter execution metadata.
4. Supplied routing IDs remain unchanged, including summary IDs and bare scoped calls.
5. Caller-supplied false directory metadata cannot override a bound session's metadata.
6. Session replacement uses the current session identity.
7. Virtual routing and provider composition preserve the field.
8. Builtin request payloads and headers do not serialize the field.
9. Existing SDK options, default-stream dispatch, summary-auth, and disposal regressions remain green.

Primary test locations:
- `packages/coding-agent/test/sdk-stream-options.test.ts`.
- A focused new fork test for session context and extension-free children.
- Existing default-stream and model-runtime option suites identified during implementation.
- Focused mocked transport tests under `packages/ai/test/` for local metadata exclusion.

Run `npm run check` in Pi and the focused test files, following Pi's `AGENTS.md`.
Do not run Pi's full vitest suite or authenticated tests.
A rebuilt Pi is required before the bridge sees the new declarations and runtime field.
The proposed build command is `npm run build:offline` at the Pi root, only after explicit approval.

Bridge checks:
- Promote the extension-free child probe into a permanent passing built-Pi regression.
- Add a forced-prompt variant and cleanup isolation coverage.
- Run `npm run typecheck` and `npm run test:unit`.

## Workspace and finalization

The proposed workspace is the existing `../pi` checkout on `personal`, because this bridge links its built packages directly.
Recheck Pi's working tree and HEAD before any edit; preserve every unrelated change.
Stage no Pi file, commit nothing, and push nothing without separate approval.
The companion change must land in `pfurini/pi@personal` before bridge CI can rely on the new contract.
Until then, local tests may validate rebuilt uncommitted Pi code, but remote readiness remains blocked.
