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
- **Rejected before spending.** The config resolver rejects `cloud` on a role declared `never`, and cloud writes on a role
  declared `read-only`, with a message that names the role. A misconfiguration fails before a token is spent.
- **Agent execution sits behind a seam.** A cloud backend implements the same `AgentBackend` interface as the local one
  (the interface comes from [spec #3](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/3)), so
  the engine does not know where a step runs. It creates agents with the SDK's cloud options, never passes custom tools,
  tool allowlists or setting sources, and streams turn events like the local backend.
- **The cloud sees a snapshot.** Before a cloud step the engine commits the worktree state to a throwaway branch under the
  workflow's prefix and pushes it to a configurable remote (default `origin`). After a write step it fetches the cloud
  agent's commits and fast-forwards the local worktree; tests keep running locally. Snapshot branches are deleted when the
  step ends and swept by `wf gc`.
- **Structured results keep their contract.** The prompt requires a final fenced JSON block, validated with Ajv and
  corrected by follow-up sends in the same conversation, so workflow code does not change between locations.
- **The lifecycle matches the local one.** The cloud agent id is stored in the event log as soon as it exists, so a resume
  or a crash reattaches to the running agent instead of starting another. Cancelling a run cancels its cloud agents, and the
  client's two-hour wait limit is a reattach point, not a failure.

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
