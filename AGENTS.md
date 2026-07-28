# Agent Guidelines

## Restricted Actions

Do **not** auto-commit.

Do **not** interact with the public without explicit permission. For example, do not open PRs or comment on github issues unless I say so.

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
you need to know what pi's API offers: the fork carries commits that published
`0.82.1` does not, and both report the same version, so a registry install would
silently give you an older surface under the same number.

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
three devDependencies to the registry `0.82.1` and drops the lockfile. Each job
asserts which pi it actually got, because the two share a version number and no
version check can tell them apart. Both jobs only compile and unit-test; nothing
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
