# 7.11 · ADR-0011: The npm package is a bootstrapper for the tag install

**Status:** accepted, not built yet · decided on 2026-11-15 while triaging [#8](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/8)

## Context

The kit installs by cloning a release tag into `~/.cursor-workflows/kit` (`scripts/install.sh --tag`). The installer
refuses a tag whose GitHub release is not immutable and fetches tags without `--force`, and it installs the dependencies with
`--ignore-scripts`. `wf upgrade` moves that clone to a newer tag. Every repo's committed MCP config names the clone through
`${userHome}`. [ADR-0004](0004-workspaces-and-claude-md-symlink.md) has the runtime resolve its assets relative to that
install location.

The request was a one-line install with npm's semver: `npx cursor-workflows init`. The runtime cannot be published as it
stands. Its packages are `private`, it exports raw TypeScript run through `tsx`, and it declares no `bin`. A name on the
public npm registry is also hard to take back once users run it.

## Decision

**The npm package `cursor-workflows` is a thin bootstrapper. It runs the tag installer it ships and then `wf init`. The kit
keeps living in the cloned tag.**

- **Package.** `cursor-workflows`, without a scope, in its own workspace. Plain JavaScript with no build, no dependencies and no
  install scripts. The `@cursor-workflows` npm org is reserved so the package has a scope to move to if the unscoped name
  is ever disputed.
- **Lockstep versions.** `cursor-workflows@X.Y.Z` installs tag `vX.Y.Z`, so npm's semver is the kit's semver. Its version
  moves with the kit's, and a test fails when the two differ.
- **The installer it runs is the one it ships.** The tarball carries a copy of `scripts/install.sh` from the same tag,
  and a test fails if the copy differs from the source. npm provenance covers the script, and the script still checks
  that the release is immutable before it clones.
- **`init` installs only when there is no kit.** With no kit, it installs the tag and runs `wf init` in the current
  directory. When a kit exists, it does not touch the kit: it runs `wf init` and warns when the kit's version differs from
  the package's, naming `wf upgrade`. The bootstrapper never moves a clone, never downgrades and never touches a `--dev`
  install. `wf upgrade` stays the one path that moves an installed kit.
- **Consent before acting.** Before it does anything, the bootstrapper prints a plan. The plan lists each action that writes
  outside the package, with its path and its reason: the clone, the `wf` shim, the global skill links, the default config,
  and the files `wf init` edits. It asks once, `[y/N]`, and N is the default. Without a TTY it refuses unless `--yes` is
  given, and the refusal prints the same plan. `install.sh` and `wf upgrade` are unchanged.
- **`init` asks no delivery question.** The install guide asks the user for the delivery defaults of
  [ADR-0012](0012-delivery-modes.md) with the host's question tool. The bootstrapper has no agent to ask, so it writes none
  of them, the code defaults stand, and its plan says so.
- **Release from CI.** Pushing a `v*` tag runs a workflow that runs the full check, compares the package version with the
  tag, creates the immutable GitHub release, and only then runs `npm publish --provenance` with npm trusted publishing
  (OIDC, no stored token). The release must exist before the package, because the installer refuses a tag that has no
  immutable release.

## Consequences

- There are two ways in, `curl | bash` and `npx`, and one kit layout. Neither `${userHome}`, `wf upgrade`, the skill links nor
  ADR-0004 changes.
- The bootstrapper still needs `bash`, `git` and `node` on the PATH, like the tag install. Windows without WSL stays
  unsupported.
- The code that runs is still the git tag. npm provenance proves only who built the bootstrapper and the installer copy.
  The installer's immutable-release check guards the kit itself.
- The release workflow needs `contents: write` to create the release, a wider permission than `ci.yml` has.
- A test pins the bootstrapper's actions to the approved plan, so an action added later without consent fails the suite.
- The account steps are human: reserving the name and the org, configuring the trusted publisher, and possibly a first
  manual publish if npm requires the package to exist before a trusted publisher can be set.

## Considered options

- **Publish the runtime as a full npm install channel.** The kit would live in a global `node_modules` or the npx cache. That
  needs a JS build or `tsx` as a shipped loader, a `bin`, a second way to link skills, an MCP config that points there, and a
  `wf upgrade` that knows two layouts. It means two installers to maintain for the same one-command gain.
- **Replace the tag install with npm.** One channel, but it throws away the immutable-tag check that already guards
  installs and upgrades.
- **Fetch `install.sh` from the tag at run time.** A smaller tarball, but one more unverified download in the chain.
- **Always install the newest GitHub release.** The package would rarely need republishing, and its version would mean
  nothing.
- **Let `init` move an existing kit to the package's tag.** It delegates to the installer, which would silently downgrade a
  newer kit.
- **Ask once per action.** It is finer-grained, but refusing one prompt midway leaves a half-installed kit.
- **Publish from the maintainer's machine.** It needs a local npm token, and provenance is generated only on a supported CI.

---

[← Anterior: 7.10 · ADR-0010: Detached jobs, and how each one is cancelled](0010-detached-jobs-and-how-each-is-cancelled.md) · [Índice](../README.md) · [Próximo: 7.12 · ADR-0012: Delivery modes: the main tree by default, a worktree on request →](0012-delivery-modes.md)
