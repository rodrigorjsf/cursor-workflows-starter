# 7.8 · ADR-0008: The job record keeps what the event log cannot

**Status:** accepted · decided in [spec #2](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/2), amended on 2026-11-12 while hardening [spec #5](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/5); supersedes [ADR-0002](0002-event-log-source-of-truth.md)

## Context

[ADR-0002](0002-event-log-source-of-truth.md) made the per-run event log the source of truth and said that the job record
keeps only identity (job id, run id, pid, heartbeat). The record came to hold three facts that are not identity and that
the log cannot hold, so this ADR replaces it. Everything else ADR-0002 decided still holds and is restated below, so that
one file holds the whole decision. The three facts are:

- **How the job was started** (`start`): the workflow's args, the `--max-cents` and `--max-tokens` flags and the
  tighten-only overrides, so that a resume of the run repeats them exactly. The starter (`wf start`, `start_workflow`)
  writes them in its own process, before the job's process exists.
- **Why the job was refused** (`refused`): the runtime refused the job before its run started (invalid args, the run
  already executing, a process that could not be spawned). The run's log is not the job's to write then: it may belong to
  another execution that is executing the run, or not exist at all.
- **That a cancel killed the job's frozen process** (`killedByCancel`): a frozen job (process alive, heartbeat stale)
  cannot handle a signal, so a cancel kills it ([ADR-0007](0007-cancel-stops-cloud-agents.md)). The killed process writes
  nothing more, not even its run's end, so its execution ends exactly as a crash does. A resume needs to tell the two
  apart: `implement-issue` counts a step whose process crashed toward `maxStepCrashes`, and a step that a cancel stopped
  is not a crash.

A run's state used to live in several places that could disagree. The job record was rewritten in place and could be read
half-written. Events carried no timestamp, run id or step id, so nothing richer than the last twenty lines could be built
on them. The budget restarted from zero on every resume. A torn last line in the journal made a run impossible to resume.
Later views (status, kanban, DAG, replay) need complete, ordered data, and they must not each invent their own.

## Decision

Every event of a run is appended to one per-run **event log**, and everything else about the run's progress is derived
from it. The **job record** holds the job's identity and the few facts about the job that its process cannot put in the
log.

- **One append-only file per run**, `.workflows/runs/<runId>/events.jsonl`, one JSON object per line. A resume appends to
  the same file.
- **Every event carries** a schema version, a timestamp and the run id. Step events also carry a step id, a parent id and
  a group id, so the structure of a run (groups, fan-out, fan-in) can be rebuilt from the log alone. Steps served from the
  journal or the memo also emit a start event. The run-start event records the effective config and its provenance.
- **Torn lines are tolerated.** A reader skips a line that is not a valid record, and the next append starts on a fresh
  line. A crash in the middle of a write never makes a run unresumable.
- **Status is a projection.** Job status, phase, recent one-line summaries, spend and result are computed from the log.
  The record can only make a job `failed`: when the job was refused (its reason becomes the error), or when the log shows
  the run not ended and the job's process is dead or its heartbeat is stale. The projection never includes full content.
- **The job record holds identity plus three facts.** Identity is the job id, the run id, the pid and the heartbeat.
  Beside it the record holds `start`, `refused` and `killedByCancel`, each written at a moment when the job's process
  cannot write it into the log: `start` by the starter, before that process exists; `refused` when the job was refused
  before its run started; `killedByCancel` by the canceller of a frozen job, right after it kills the process. A new fact
  about a run's progress goes in the log, not in the record.
- **Killing a frozen job writes nothing in the log.** Its run's end is never written, so the job stays `failed` and the
  run stays resumable, as after a crash. `killedByCancel` changes no status: only a resume reads it (`wasKilledByCancel`),
  for an execution that has no run end, to tell a cancel from a crash.
- **The budget is replayed.** Spent tokens and cents are read back from the log, failed attempts included, so a resume never
  starts from zero. A resume may set a new total cap.
- **Content stays local and bounded.** Prompts, agent text, tool calls and command output live in the local log with known
  secret formats redacted, and are pruned after the last 30 runs or 14 days per repo, metadata kept. That content is never
  sent to the metrics database or its exports, and `wait_workflow` returns one-line summaries only, so polling never
  pushes prompts or secrets into the chat context.
- **Every other state file is replaced atomically** (temp file plus rename), the job record included, and each run is
  registered once in a global index, `~/.cursor-workflows/runs.jsonl`, so later tools can find runs across repositories.

## Consequences

- The dashboard, `wf status`, `wait_workflow` and a future replay read the same data. A new view is a new projection, not
  a new store.
- The schema is a contract. A change to the meaning of a field, or removing one, bumps the schema version; adding a field
  does not.
- The log grows with every step and holds the most sensitive text the kit touches. That is why content has retention and
  redaction, and why it stays out of the metrics database. Redaction covers known secret formats and env var values whose
  names look like keys; it is a safety net, not a guarantee.
- Status needs a read of the log instead of a field lookup. That is the price of having no second copy to keep in sync.
- Events from branches that are still running can follow a group's end event when a fatal error aborts the group: the log
  records what happened, in the order it happened.
- The record is a second store, kept small on purpose: three named facts, each with one writer at a known moment, and none
  of them a copy of something in the log. Code that needs to know how an execution ended reads the execution's run end in
  the log first, and the record's `killedByCancel` only for an execution that has none.
- A job record deleted by hand takes its mark with it: a resume then counts the step the cancel stopped as a crash.

## Considered options

- **Keep a mutable job state file as the source** and treat the log as a side record: two truths, torn reads, and a
  budget that cannot be replayed.
- **Store events in the metrics database (SQLite):** the database is per user and exportable, which is the opposite of the
  privacy rule for content. A binary file is also harder to read after a crash than a text file whose last line can be
  dropped.
- **A service that owns the state:** it would have to run all the time, and the kit's runs must survive without one
  ([ADR-0003](0003-detached-jobs.md)).
- **Write the cancel mark into the event log.** The canceller does not hold the run's lock, and it writes the mark while
  the killed process may still be there, so two processes would append to one log. A run end written for it would project
  the run as `cancelled`, not `failed`, while a killed process, like any process that ended without finishing, writes
  nothing to the log by design ([ADR-0007](0007-cancel-stops-cloud-agents.md)).
- **Keep the mark in a separate file.** A third store, with its own path, writer and cleanup, for one timestamp about one
  job. The job record is already the file that holds a job's own facts, and it is already replaced atomically.

---

[← Anterior: 7.7 · ADR-0007: Cancelling a run stops its cloud agents](0007-cancel-stops-cloud-agents.md) · [Índice](../README.md) · [Próximo: 8.1 · Cursor SDK como motor de workflows determinísticos: relatório de pesquisa →](../research/relatorio-pesquisa.md)
