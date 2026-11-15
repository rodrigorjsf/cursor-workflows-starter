# 7.10 · ADR-0010: Detached jobs, and how each one is cancelled

**Status:** accepted · decided on 2026-11-14 while hardening [spec #95](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/95) (tickets [#49](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/49) and [#50](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/50)); supersedes [ADR-0003](0003-detached-jobs.md)

## Context

[ADR-0003](0003-detached-jobs.md) made every run a detached process and said what a cancel does: it cancels the active
agent runs, reverts the in-flight write step, marks the job `cancelled` and leaves the run resumable. That was true while
every cancelled job was a running one. Three later changes made it true of one job state only, and none of them replaced
ADR-0003:

- [ADR-0007](0007-cancel-stops-cloud-agents.md) decided that a cancel also cancels the run's cloud agents, whatever state
  the job is in, and that a job whose process is already dead gets no signal at all.
- [ADR-0008](0008-job-record-keeps-what-the-log-cannot.md) recorded that a frozen job (process alive, heartbeat stale)
  cannot handle a signal, so a cancel kills it: nothing is reverted, the run's end is never written, and the job stays
  `failed` instead of ending `cancelled`.
- A frozen job's `ctx.exec` commands outlived the kill. Each runs in a process group of its own and the job's process kills
  it from an exit hook, which a SIGKILL skips, so an orphan test runner or `sleep` kept running after the user cancelled
  ([#49](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/49)).

So ADR-0003 still reads as "a cancel reverts the write step and ends `cancelled`" for every job, and no accepted
decision lists the paths. The book convention forbids rewriting an accepted ADR, so this ADR replaces ADR-0003. What
ADR-0003 decided and still holds is restated below, so that one file holds the whole decision. ADR-0007 and ADR-0008 are
not replaced: they decide the cloud agents and the job record, and this ADR cites them.

## Decision

**Every run is executed by a detached job process, and what a cancel does depends on the state of that process: running,
frozen or dead.**

What ADR-0003 decided, and still holds:

- **The child owns the run.** `start_workflow` and `wf start` spawn a detached child process (a new session, no pipe to the
  starter). It runs the workflow, writes the event log and holds the run lock. The MCP server and the CLI only start a job,
  read its state and ask it to stop, so restarting the server or Cursor leaves the run going.
- **A heartbeat replaces the pid-only check.** The job's process keeps a heartbeat timestamp in the job record, written by a
  worker thread so that a long synchronous call does not delay it. A job whose process is gone, or whose heartbeat is older
  than 30 seconds, is reported `failed` with its run id, so that it can be resumed.
- **One process per run.** The run lock is enforced: a second process asked to execute the same run is refused.
- **SIGINT and SIGTERM cancel the run the process executes.** That covers Ctrl-C on `wf run` and the SIGTERM a job gets
  from `wf cancel`. A second signal while the run is still stopping ends the process at once and closes its runs as
  `cancelled`.
- **The agent in the chat cancels only when the user asks.**
- **Linux and WSL2 only.**

The three states, as the job record, the heartbeat and the run lock show them:

- **Running:** the process is alive and its heartbeat is fresh.
- **Frozen:** the process is alive, is the job's process (its command line carries the job id), holds the run lock and has
  stopped beating. It shows as `failed`, yet it still executes the run.
- **Dead:** the process is gone, or its pid now belongs to another process, or it no longer holds the run lock. The job
  shows as `failed`.

What a cancel does in each (`wf cancel`, `cancel_workflow` and the dashboard's Cancel all go through `cancelJob`):

- **A running job gets SIGTERM.** Its process cancels the agent runs it is waiting on, local and cloud, stops its `ctx.exec`
  commands (SIGTERM to each command's process group, SIGKILL two seconds later), reverts the in-flight write step to its
  state before the step, writes the run's end as `cancelled`, releases the lock and exits. The job ends `cancelled` and the
  run stays resumable.
- **A frozen job is killed, and nothing is reverted.** A process that stopped beating cannot be trusted to handle a signal.
  The kill writes no run end, so the job stays `failed` and the run stays resumable, as after a crash; the job record gets
  `killedByCancel` so that a resume does not count the interrupted step as a crash ([ADR-0008](0008-job-record-keeps-what-the-log-cannot.md)).
  The kill takes everything the job started with it, in this order (`killFrozenJob`, `job-children.ts`):
  1. SIGSTOP to the job's process. "Frozen" only means a stale heartbeat, so the process may still be running. A stopped
     process starts no command and reaps no child, so the groups read next are the groups killed, and their numbers
     cannot have been reused.
  2. SIGKILL to the process group of every `ctx.exec` command the job recorded, and to the process group of every direct
     child the job leads out of its own group (what the SDK's local agent starts for its shell tools, found in `/proc`).
  3. SIGKILL to the job's process, then to the job's own process group (the MCP servers the SDK starts live there).
  4. The recorded groups are deleted, since the killed process cannot do it.

  Once the process is gone, the cloud agents the run left running are cancelled through the Cursor API
  ([ADR-0007](0007-cancel-stops-cloud-agents.md)). A resume then starts a new agent for each and pays for it again.
- **A dead job gets no signal.** There is no process to signal, and a group number read from a record of a dead process may
  belong to an unrelated one by now. Only the cloud agents its event log shows without an end are cancelled, through the
  Cursor API, unless a process is executing the run again. A pid that another process got is a dead job too: that process
  is left alone.

How a job records its commands: when a `ctx.exec` command starts, the job writes an empty file `<jobId>.exec-group.<pgid>`
in the jobs folder, named by the command's process group, and removes it when the command ends. A file per group, and
not a field of the job record: the heartbeat worker rewrites the whole record from a snapshot taken when the job started, so
a field written by the main thread would be overwritten, and a frozen main thread could not write one at all. A record
that cannot be written is a `warning` event, and the command still runs, out of the cancel's reach.

## Consequences

- A cancel means three different things, and the user cannot see the heartbeat that picks among them. The note `wf cancel`
  and `cancel_workflow` return says which one happened: SIGTERM sent, killed without undoing the step in progress, or no
  signal because the job had already ended.
- After the kill of a frozen job nothing keeps running that the job started, and the cancel leaves nothing to clean up by
  hand. The price is that the step in progress is not reverted: what it wrote stays in the worktree, as after a crash.
- A command that outlives a job that crashed is not reached by a later cancel, because a dead job gets no signal. The
  `exec-group` files such a job leaves are tiny, and nothing reads them: job ids are unique.
- The SDK's local agent is not a child process; it runs inside the job's process and dies with it. What it starts survives a
  SIGKILL of the job: its shell commands, spawned detached in a group of their own, and the MCP servers of the project's
  config, spawned in the job's own group. Both facts come from reading SDK 1.3.1, and the kill is tested with stand-ins for
  each, not with a real agent that runs a shell command or a real MCP server.
- Where `/proc` is missing (macOS), the detached children of the SDK's agent are not found: the recorded commands and the job's
  own group still are. On Windows a command has no process group, so nothing is recorded. The kit is tested on Linux only.
- A change to how any path cancels updates this ADR or replaces it. ADR-0003 is no longer the place to read it.

## Considered options

- **Amend ADR-0003 in place.** The change contradicts its cancel bullet, not just clarifies it, and an ADR rewritten in
  place erases why the first decision was taken.
- **Kill only the job and leave its commands running** (the behaviour before this ADR). It keeps the cancel simple, and
  leaves a test runner or a `sleep` running after the user said stop, with nothing in the output to say so.
- **Kill the job's process group alone.** Each `ctx.exec` command leads a group of its own, which is what lets a normal cancel
  reach what the command started, so the job's group does not contain it.
- **Find the commands only by walking `/proc`.** It needs no record, but it depends on a table that macOS lacks and it
  finds what the process table shows, not what the engine started. The record is exact for the commands the engine owns;
  the scan is the second source, for what the SDK starts and the job cannot record.
- **Keep the groups in the job record.** The heartbeat worker would overwrite the field, and ADR-0008 limits the record to
  identity plus three named facts, each with one writer at a known moment.
- **Keep the groups in the run's directory.** That directory belongs to the run store, and a file per group avoids a read-modify-write
  between commands that run in parallel.
- **Signal the frozen process with SIGTERM first and kill it if it does not answer.** A frozen process is the one that
  stopped answering, so the wait would only delay the kill, and a cancel that comes after a silent minute is already
  late.
- **Fall back to `ps` where there is no `/proc`.** A fallback for a platform the kit does not test would be code nobody runs.

---

[← Anterior: 7.9 · ADR-0009: The forge is a seam: GitHub and GitLab](0009-forge-seam-github-and-gitlab.md) · [Índice](../README.md) · [Próximo: 8.1 · Cursor SDK como motor de workflows determinísticos: relatório de pesquisa →](../research/relatorio-pesquisa.md)
