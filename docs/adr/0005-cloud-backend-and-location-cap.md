# 7.5 · ADR-0005: The cloud backend and the location cap

**Status:** accepted · decided in [spec #2](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/2); built by [spec #5](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/5)

## Context

Every step runs as a local agent on the user's machine. Some teams want steps to run as Cursor cloud agents instead: to
offload work, to keep a run going independently of the laptop, and for the isolation of a cloud VM, which local runs lack
(a local fix step was measured editing a file outside the repo, see [8.2 §9](../research/verificacoes-locais.md)).

A cloud agent is not a local agent somewhere else. As verified against the SDK 1.3.1 type declarations and the Cursor docs
during planning, a cloud agent rejects custom tools (the kit's structured-output tool), rejects tool allowlists, ignores
setting sources, and sees only what was pushed to the remote, never the local worktree. Sending a step to the cloud also
means sending the code to a VM, which is a decision about data, not about convenience.

## Decision

**A step's *location* is `local` or `cloud`, chosen per role in config, and cloud is off unless the machine owner turns it
on and the workflow allows it.** The mechanism is part of the config contract from the start, so it is decided and
enforced before any cloud code exists.

- **A global cap.** `allowedLocations` is one of the caps of [ADR-0001](0001-layered-config-with-hard-caps.md). Its default
  is local only. Because a repo file and an MCP override can only tighten caps, a pull request or the chat agent can never
  enable cloud execution. Sending code to a cloud VM is the machine owner's decision.
- **A declared capability per role.** Each role in a workflow's metadata declares `ok`, `read-only` or `never`: whether
  its step can run in the cloud at all, and whether only without writing.
- **Rejected before spending.** The config resolver rejects `cloud` on a role declared `never`, with a message that names the
  role. Whether a step writes is a fact of the step (its `tools`), which the config cannot see, so a cloud step that can write
  on a role declared `read-only` is rejected by the engine, with the same kind of message, before the step's first attempt
  starts. Either way a misconfiguration fails before a token is spent on the step.
- **Agent execution sits behind a seam.** A cloud backend implements the same `AgentBackend` interface as the local one
  (the internal interface is `packages/runtime/src/runtime/backend.ts`; [spec #3](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/3)
  makes it a public extension point), so
  the engine does not know where a step runs. It creates agents with the SDK's cloud options, never passes custom tools,
  tool allowlists or setting sources, and streams turn events like the local backend.
- **The cloud sees a snapshot.** Before a cloud step the engine commits the worktree state to a throwaway branch under the
  workflow's prefix and pushes it to a configurable remote (default `origin`). After a write step it fetches the cloud
  agent's commits and fast-forwards the local worktree; tests keep running locally. Snapshot branches are deleted when the
  step ends and swept by `wf gc`.
- **A write step works on the snapshot branch and its work comes back by fast-forward or not at all.** The cloud agent is
  created to work on the current branch (the snapshot branch) and told to commit there. When its run finishes the engine
  fetches the branch and moves the worktree's branch, index and working files to it, then deletes the snapshot. It refuses,
  changing nothing, when the agent's branch no longer contains the snapshot it started from, when the local branch moved
  meanwhile, when the working files are no longer what was pushed (bringing the work back would overwrite the changes
  made in the meantime), or when the agent adds a file where the worktree has one git ignores; the attempt fails like any
  other and the step's retries apply. A refused attempt changed nothing in the worktree, so neither `revertOnRetry` nor a
  cancellation reverts it: that would undo what the person changed meanwhile. An agent whose run says it pushed only to
  some other branch fails the attempt too, naming it. A worktree that had no changes needs
  no snapshot commit (the snapshot is `HEAD`); one that had changes keeps the snapshot commit in the local history, because
  the agent's commits are built on it. If moving the worktree fails after it began to change the index or the files, the
  engine puts them back as they were before the step, the way it does for a cancelled step. A role a workflow declares
  `never` stays that way until its author declares otherwise: `implement-issue`'s write roles are still `never` (see [#45](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/45)).
- **Structured results keep their contract.** The prompt requires a final fenced JSON block, validated with Ajv and
  corrected by follow-up sends in the same conversation, so workflow code does not change between locations. A role can
  switch (`resultVia: "artifact"`) to a `result.json` file the agent saves in its artifacts directory, downloaded after the
  run and validated the same way, for schemas the text of an answer does not carry reliably.
- **The lifecycle matches the local one.** The cloud agent id is stored in the event log as soon as it exists, so a resume
  or a crash reattaches to the running agent instead of starting another. Cancelling a run cancels its cloud agents, and the
  client's two-hour wait limit is a reattach point, not a failure. Two rules keep a reattach from paying twice: an agent that
  cannot be reached is never replaced (the attempt fails and the next one reattaches again; only a "not found" from the cloud
  means the agent is gone and a new one starts), and a wait that ends in error is checked with the cloud before the step is
  failed, because the client gives up on a run that is still going. Cancelling stops the cloud runs of a run that is executing
  (and one that is still looking for its interrupted agent); a run whose process already died has nothing to signal, and
  cancelling from outside does not call the Cursor API, so the way to stop its agent is to resume the run and cancel it.

## Consequences

- Config can name the location from the first release, and the default (local only) makes it inert until a user opts in.
  Role metadata must declare a cloud capability from the first release too, even though no role can use it yet.
- Cloud is a strict subset of what a local step can do: no memo cache, setting sources ignored (with a warning), no custom
  tools. A role designed for both places has to work within that subset.
- Snapshots create refs on a remote. Teams with heavy CI should exclude the workflow's branch prefix from their pipelines, or
  point snapshots at a fork.
- Cloud steps need a Cursor plan that includes Cloud Agents and a connected code host with write access.
- Cost and tokens come from the cloud usage API and count against the same caps as local steps, so a budget holds across
  locations.

## Considered options

- **Run a whole workflow as one cloud agent.** It would lose the deterministic process, which is the point of the kit.
- **A per-workflow cloud switch.** Too coarse: a read-only classifier and a step that writes code need different answers.
- **A repo-level opt-in without a global cap.** A pull request could then enable it, so the repo would decide where the
  code goes.
- **Let the cloud agent open the PR.** The workflow keeps owning delivery, so the process stays in code.

---

[← Anterior: 7.4 · ADR-0004: npm workspaces and a canonical CLAUDE.md](0004-workspaces-and-claude-md-symlink.md) · [Índice](../README.md) · [Próximo: 8.1 · Cursor SDK como motor de workflows determinísticos: relatório de pesquisa →](../research/relatorio-pesquisa.md)
