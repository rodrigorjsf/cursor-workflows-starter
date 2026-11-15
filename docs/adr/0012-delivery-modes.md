# 7.12 · ADR-0012: Delivery modes: the main tree by default, a worktree on request

**Status:** accepted, not built yet · decided on 2026-11-15 after the first `implement-issue` run from the Cursor IDE (validation [#21](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/21))

## Context

`implement-issue` always worked in a worktree of its own, under `.workflows/worktrees/`, on a `wf/issue-<n>-<id>` branch.
The worktree keeps the user's tree out of the run, and it lets runs go in parallel. When the workflow ran from the Cursor
IDE, the user's window stayed on `main`. Nothing the run did was visible in the editor. The worktree sits inside an ignored
folder, and the result named it only as a path. The workflow also opened a PR only when the run asked for one
(`openPr: false` by default), so the run ended with a branch that nobody could see.

The kit is used from the IDE, where the user watches the agent work. Isolation is still worth having when runs go in
parallel or the user keeps working in the same folder.

## Decision

**A writing workflow has two delivery modes. By default the main tree is used: the run's branch is checked out in the
user's own folder. A worktree is used only on request, per run or in the config. A PR is opened by default.**

- **Two settings.** `implement-issue` declares `worktree` (default `false`) and `openPr` (default `true`) in `meta.settings`.
  The global and repo config files set them (`workflows.implement-issue.settings`), and the run's args override both.
  Precedence: args > repo > global > code default. `wf start` has the shortcuts `--worktree` and `--no-pr`.
- **Main-tree mode.**
  - The run starts from the checked-out HEAD, creates the run's branch and checks it out in the user's tree.
  - A dirty tree refuses the start. The refusal lists the changed files and explains why: they would be committed into
    the PR, or reverted by a write step. The user resolves them first.
  - While the job runs, the tree belongs to the workflow. An edit the user saves meanwhile can be reverted by a write
    step or committed by the delivery.
  - Only one main-tree run per repo runs at a time. A second start is refused and the refusal names `--worktree`.
  - When the run ends, the tree stays on the run's branch so the user can review it.
  - A resume follows the same rules: it refuses a dirty tree, then checks out the run's branch again if the user left it.
  - Cancel and revert act on the user's tree, as they act on a worktree. `wf gc` never touches the main tree or a branch
    the run did not create.
- **Worktree mode.** It is the previous behavior. The chat skill opens the worktree folder in a new Cursor window, where
  the host can do that, and names the path where it cannot.
- **Code index.** Before the first step, in either mode, `codegraph init` runs when the tree has no `.codegraph/`, and
  `codegraph sync` runs when it does. `.codegraph/` is excluded through `.git/info/exclude`, so the delivery never commits
  it. A missing `codegraph` or a failing one is a `warning` event, never a failure.
- **Defaults are chosen at install.** The install guide and the setup skill ask the user for both defaults with the host's
  question tool. They write the answers to the global config through `wf config set`, which validates the value against
  the schema. They also explain how one repo overrides them.

## Consequences

- From the IDE, the user sees the branch, the commits and the files change in the folder they have open. The run ends with
  a PR link.
- Main-tree runs are serialized per repo, and they need a clean tree. Anyone who wants parallel runs or keeps editing asks
  for a worktree.
- Code that reverts or cleans up now runs against the user's folder in the default mode. The cancel paths of
  [ADR-0010](0010-detached-jobs-and-how-each-is-cancelled.md) stay the same, but what they revert is now the user's tree.
- The kit had no users besides its maintainer when this changed, so existing installs get no migration. A later change of a
  default must plan one.

## Considered options

- **Worktree only (the previous behavior).** It is isolated and parallel, and invisible from the IDE, which is where the kit
  is used.
- **Main tree only.** It is visible, but it gives up parallel runs and protection against a user who keeps editing.
- **Main tree, with a stash of a dirty tree that is restored at the end.** A cancel or a crash can lose the stash, and the
  user's own work would be the thing lost.
- **Fall back to a worktree when a main-tree run is already going.** The user who watches the tree would not know where the
  second run went.
- **Start from the default branch fetched from `origin` instead of HEAD.** It discards the local commits the user meant the
  run to build on.

---

[← Anterior: 7.11 · ADR-0011: The npm package is a bootstrapper for the tag install](0011-npm-bootstrapper.md) · [Índice](../README.md) · [Próximo: 8.1 · Cursor SDK como motor de workflows determinísticos: relatório de pesquisa →](../research/relatorio-pesquisa.md)
