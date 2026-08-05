#!/usr/bin/env node
// SKIPPED (recorded, per plan §Commit 1): reaping a subagent's parked Claude Code
// child on host session_shutdown.
//
// What this would prove, end to end: a subagent AgentSession that shares the host
// modelRuntime (runtimeOf(ctx.modelRegistry) -> createAgentSession({ modelRuntime,
// customTools:[SlowTool], noExtensions:true, ... })) parks a real CC child at a
// tool boundary under a run that then SETTLES (not aborts). With the child parked,
// harness.stop() drives the host through session_shutdown; the owner-gated reaper
// must interrupt+close that child so it dies rather than reparenting and billing.
//
// Why it is skipped rather than implemented:
//   1. The pure reaper (interrupt+close, drain, set emptied, per-context isolation)
//      and the ownership gate (non-owner no-op) are fully covered by the mandatory
//      unit test tests/unit-reap-live-queries.mjs.
//   2. The "host shutdown must take a parked CC child with it" mechanism — the same
//      session_shutdown -> teardown path this reaper hooks — is already exercised
//      against a live CC child by tests/int-shutdown-kills-cc.mjs.
//   3. The remaining delta (a settled-run subagent context surviving to
//      host-shutdown time) needs a fixture that builds the fork, wires a subagent
//      AgentSession onto the host modelRuntime via a fixture extension, and parks a
//      real CC child under a settled run. That fixture is the subject of Commit 2's
//      root fix, after which few contexts survive to host-shutdown at all; building
//      it here (real Claude API + quota) buys little over 1+2 and is deferred.
//
// To implement later: reuse tests/fixtures/slow-tool-extension.ts, reach the host
// modelRuntime through ctx.modelRegistry from a fixture extension, create the
// subagent session, await one turn to settle, then harness.stop() and assert the
// child PID is gone from the process table (mirror int-shutdown-kills-cc.mjs).

import { test } from "node:test";

test("host session_shutdown reaps a subagent's parked CC child", { skip: "covered by unit-reap-live-queries.mjs + int-shutdown-kills-cc.mjs; full subagent fixture deferred (see header)" }, () => {});
