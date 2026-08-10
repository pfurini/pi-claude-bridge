# Agent Guidelines

## Restricted Actions

Do **not** auto-commit.

Do **not** interact with the public without explicit permission. For example, do not open PRs or comment on github issues unless I say so.

## Claims about how Claude Code behaves

`~/.claude/projects/**` is **not** evidence of what CC does. The bridge writes into
the same files and CC re-serializes imported records under synthetic ids, so a scan
of that directory largely reflects our own output handed back to us — 352 of 1,810
files hold both shapes. Before asserting "CC does X" from disk, split by provenance
(CC-live records carry a real `requestId`/`promptId`; ours carry
`msg_syn_*`/`req_syn_*`) and regroup by `message.id`, since CC stores one content
block per record while cc-session-io stores one record per message.
`diag/audit-transcripts.mjs` does both.

Better still, prove it with a live probe. `tests/int-cc-contracts.mjs` pins each
undocumented behavior we depend on against the installed CC/SDK and is the right
home for a new assumption; `diag/capture-proxy.mjs` captures the actual request
bodies when the question is what CC sends. `claude-code-rip/` lags the installed
CLI by an unknown margin, so read it for mechanism, never for current behavior:
what it gates, defaults, or omits may already have changed. And before
reverse-engineering an SDK option at all, grep
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — it documents every
settings field, several of which solve problems the CC source makes look
intractable.

The same skepticism applies to any *rate* computed from the debug log. Before
believing one, check the metric against a case whose answer you know: the
cache-break scanner counted a request's uncached `input` as if the next request
should read it back, which turned every tool-heavy turn into a false break and
manufactured a dose-response that looked like a real finding.

Bin by era before comparing groups. A correlation computed over a window that
straddles the onset of the phenomenon will credit whatever else changed. Three
independent analyses agreed one account state was safe on 5,611 clean requests —
every one of which predated the first failure; switching to that state reproduced
the failure in five minutes.

Five wrong conclusions across two sessions came from skipping the above.

## Changelog

Maintain an entry in the `## UNRELEASED` section at the top of `CHANGELOG.md` for every significant change, using the existing format:

```
- **Tag: summary** — detail
```

Do not add changelog entries for docs-only changes. If multiple entries in the UNRELEASED section pertain to the same feature, try to combine them into one entry,

Tags: `Add`, `Fix`, `Refactor`, `Tests`, `Bump`, `Deprecate`, `Remove`.

## Release

No build step — the package ships `src` TypeScript as-is (see `files` in `package.json`). To cut version `X.Y.Z`:

1. **Changelog** — rename the `## UNRELEASED` section to `## X.Y.Z — YYYY-MM-DD`.
2. **Bump** — set `version` to `X.Y.Z` in `package.json`.
3. **Commit** — `git commit -m "Release X.Y.Z"` (changelog + package.json only).
4. **Tag** — `git tag vX.Y.Z` (note the `v` prefix).
5. **Push commit and tag together** — `git push --follow-tags`. 
6. **Publish** — `npm login` and `npm publish`.

## Pi dependency

The three `@earendil-works/pi-*` devDependencies are `file:` links to the local
fork at `../pi`, not registry installs. Check the fork, not `node_modules`, when
you need to know what pi's API offers: the fork carries commits stock pi does
not (verified against registry `0.84.1`, which lacks `ExtensionAPI.cwd`,
`ExtensionAPI.agentDir`, `ExtensionContext.agentDir`, `ExecOutputTruncation`,
the `piForkCapabilities` marker, and `default-stream-fn`). Fork and registry
both report `0.84.1`, so a registry install — even at the newest version —
silently gives you an older API surface under an identical version number.

- The fork must be built before its API changes reach `tsc`. Types come from
  `dist/*.d.ts`, and the build is order-dependent — run `npm run build:offline`
  at the fork root, not `npm run build` in one package.
- `npm ci` fails anywhere `../pi` is absent. That is the intended trade: this
  extension targets the fork. `peerDependencies` stays at `>=0.82.1` so the
  published package still installs against stock pi, and the optional-property
  reads in `loadDirs()` and `sessionAgentDir()` are what let it degrade there.
- Integration tests spawn `pi` from `PATH`, which already resolves to the fork's
  `dist/cli.js`. Only `typecheck` and the unit tests read `node_modules`.

CI (`.github/workflows/ci.yml`) runs both sides: a `fork` job that checks out
`pfurini/pi` as a sibling and builds it, and a `stock` job that rewrites the
three devDependencies to the registry `0.82.1` (the peer floor) and drops the
lockfile. Each job asserts which pi it actually got by probing for
`ExtensionAPI.agentDir` rather than by version, because the fork and the latest
registry release share a version number, so no version check can tell them
apart. Both jobs only compile and unit-test; nothing
in the unit suite loads an extension through pi's loader, so neither observes
`loadDirs()` actually falling back at runtime. That needs an integration run.

Other extensions on this machine do not need the same treatment. Pi loads
extension source into its own process and never resolves `@earendil-works/*`
from an extension's `node_modules`, so they already run on the fork. Link the
fork only in a repo that *uses* fork-only API — currently `ExtensionAPI.cwd`,
`ExtensionAPI.agentDir`, `ExtensionContext.agentDir`, and the optional `pi.exec`
truncation members. The fork's delta is additive, so code written against the
published types compiles and behaves identically on it.

## Tests

Smoke tests typically need to run outside a sandbox because they access local pi/Claude settings and auth state.
