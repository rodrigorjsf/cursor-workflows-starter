# 7.3 · ADR-0003: Runs are detached processes

**Status:** accepted · decided in [spec #2](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/2)

## Context

A job ran inside the MCP server process. Restarting Cursor killed the run, and a long test run froze the server, which
could no longer answer a status query. There was no way to cancel a run, and the only way to tell a dead run from a live
one was to check that its pid still existed.

## Decision

**`start_workflow` always spawns a detached child process, and the MCP server only reads state.**

- **The child owns the run.** It runs the workflow, writes the event log and holds the run lock. Killing or restarting the
  MCP server (or Cursor) leaves the run going, and a restarted server reports it by reading the run's files.
- **A heartbeat replaces the pid-only check.** A running job updates a heartbeat timestamp. A job whose heartbeat is stale
  is reported as `failed` with its run id, so it can be resumed, instead of showing `running` forever.
- **Cancel is a first-class operation.** A new `cancel_workflow` MCP tool and a `wf cancel` command cancel the active agent
  runs, revert the in-flight write step, mark the job `cancelled` and leave the run resumable. `SIGINT` and `SIGTERM` on the
  run process do the same, so killing a terminal never leaves orphaned agent runs or a job stuck in `running`.
- **One process per run.** The run lock is enforced: a second process asked to execute the same run is refused.
- **The agent in the chat cancels only when the user asks.** The `run-workflow` skill documents the tool and does not call
  it on its own judgement.

## Consequences

- Runs survive Cursor restarts, and long test runs cannot freeze the server.
- The MCP server holds no run state, so it can be restarted, replaced or run twice without effect on a run.
- A crashed child is noticed after the heartbeat goes stale, not at the instant it dies. The window is the price of not
  keeping a supervising process.
- A cancelled run is resumable, which is only safe because a write step is reverted to its pre-step state on cancel.
- The guard against a step starting another workflow ([3.1](../internals/01-arquitetura.md)) still applies: the detached
  child is a workflow run like any other.
- The behaviour is specified and tested for Linux and WSL2 only. Other platforms are out of scope.

## Considered options

- **Keep jobs in the server process and rely on resume** (the status quo): every Cursor restart costs a manual resume, and
  the server stays blockable.
- **A long-lived daemon that runs all jobs:** one more thing to install, start, upgrade and debug, and a single point of
  failure for every run.
- **A platform service manager (systemd, launchd):** platform-specific, and a heavier install than "clone and run".

---

[← Anterior: 7.2 · ADR-0002: The event log is the source of truth](0002-event-log-source-of-truth.md) · [Índice](../README.md) · [Próximo: 7.4 · ADR-0004: npm workspaces and a canonical CLAUDE.md →](0004-workspaces-and-claude-md-symlink.md)
