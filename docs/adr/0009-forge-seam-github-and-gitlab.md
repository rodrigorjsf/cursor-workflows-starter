# 7.9 · ADR-0009: The forge is a seam: GitHub and GitLab

**Status:** accepted · decided on 2026-11-13 in a design session; the specs that deliver it are linked from their issues

**Amended:** 2026-11-13: a `wf/` branch on the origin that no run of this repo owns has no record to read, so `wf gc` asks the forge of the origin's host for its PR; the rule "a run keeps its forge" stays for every branch a run owns.

## Context

The kit opened pull requests, read issues and commented on them only through the GitHub CLI (`gh`). `gh` was called
directly in four places: the `implement-issue` workflow, `wf gc` (which asks a PR's state before it deletes a remote
branch), `wf doctor` (`gh auth status`) and the dashboard (a PR's state badge, for `github.com` URLs only). Users whose
repositories live on GitLab (gitlab.com or a self-managed instance) could not use the built-in workflows at all.

`glab`, the GitLab CLI, does not mirror `gh` one to one (verified against glab v1.130.0):

- `glab issue note` has no body-file flag and reads stdin, which the runtime's command runner never feeds.
- `glab issue view -c` returns the notes paginated, 20 per page, so a check for an existing comment can miss it.
- `glab mr view <branch>` fails, with prompts off, when a branch has more than one MR; `gh pr view` takes the latest.
- `glab mr view <url>` resolves the cwd's repository before it reads the URL, so it fails outside a GitLab checkout,
  which is where the dashboard runs.
- An MR has a fourth state, `locked`, and `glab mr create -H` names the head *repository*, not the branch.
- GitLab runs **quick actions** (`/close`, `/merge`, ...) written at the start of a line in an MR description or a note.

## Decision

The **forge** (the service that hosts the user's repository, its issues and its PRs) is a seam inside the runtime, with
one implementation per forge: GitHub through `gh`, GitLab through `glab`.

- **Detection by host.** The forge is the one of the `origin` remote's host: `github.com` is GitHub, `gitlab.com` is
  GitLab. Any other host must be declared in a `forges` map (`{ "git.example.com": "gitlab" }`) in the layered config
  ([ADR-0001](0001-layered-config-with-hard-caps.md)); an unknown, undeclared host is an error, never a guess. A `repo`
  argument naming another host decides by that host.
- **A run keeps its forge.** A run records the forge it resolved; `wf gc` reads it from there and never detects again, so
  a later config or remote change cannot send a deletion decision's state query to the wrong CLI. A record without the
  field is GitHub.
- **`glab api` where the CLI falls short.** Notes (paginated), comments (`-F body=@file`), the latest MR of a branch and
  an MR by URL go through the GitLab REST API via `glab api`; the rest uses glab's own commands. glab keeps the login.
- **"PR" stays the kit's term** on both forges: the persisted fields (`prUrl`, `PrState`) do not change, and only the
  interface shows `MR !9`. `opened` and `locked` map to `OPEN`, so `wf gc` never treats a live MR as finished.
- **The seam is internal.** The built-in workflow, `wf gc` and `wf doctor` use it; the `observe` entry point exports only
  "the state of a PR by URL" for the dashboard. Workflows written by users keep calling `gh` or `glab` through `ctx.exec`.
- **Model text cannot act on GitLab.** Text from a model that goes into an MR or a note has the known quick-action names
  at the start of a line neutralized, like the GitHub closing keywords already are.
- **One doctor check, `forge`,** replaces `gh`: it checks the CLI of the cwd's forge, and passes outside a repository.

## Consequences

- GitLab users get the same capabilities as GitHub users: issue in, MR out, `wf gc`, `wf doctor` and the dashboard badge.
- The dashboard asks only hosts the user is logged in to with glab (it reads the host names of glab's config, never its
  tokens), plus `github.com` and `gitlab.com`.
- The doctor check id changes from `gh` to `forge`: a breaking change for anything that parses `wf doctor --json`, shipped
  with a version bump and the skills that read it.
- GitLab code paths are tested offline with a fake `glab`. Its outputs come from fixtures recorded against a real GitLab
  CE in Docker by an opt-in script, outside `npm run check`.
- Cloud steps on a GitLab repository rely on Cursor's own GitLab support; the kit restricts no host there but does not
  validate it.

## Considered options

- **A `forge` key per repository** instead of a host map: the same self-managed host would be repeated in every repo; the
  map in the repo layer covers that case already.
- **`ctx.forge` as public API** for user workflows: portable workflows, but a new public surface with no workflow asking
  for it yet.
- **An `if` at every call site:** two forges in four places, with the GC's safety logic duplicated.
- **Only glab's high-level commands:** fewer lines, but the pagination, multi-MR and outside-a-checkout gaps stay.
- **A neutral term ("change request")** with renamed fields: breaks reading the event logs and progress files of earlier
  runs, for a word.

---

[← Anterior: 7.8 · ADR-0008: The job record keeps what the event log cannot](0008-job-record-keeps-what-the-log-cannot.md) · [Índice](../README.md) · [Próximo: 8.1 · Cursor SDK como motor de workflows determinísticos: relatório de pesquisa →](../research/relatorio-pesquisa.md)
