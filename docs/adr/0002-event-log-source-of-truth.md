# 7.2 · ADR-0002: The event log is the source of truth

**Status:** superseded by ADR-0008 ([7.8](0008-job-record-keeps-what-the-log-cannot.md)) · decided in [spec #2](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/2)

## Context

A run's state lived in several places that could disagree. The job record was rewritten in place and could be read
half-written. Events carried no timestamp, run id or step id, so nothing richer than the last twenty lines could be built
on them. The budget restarted from zero on every resume. A torn last line in the journal made a run impossible to resume.
Later views (status, kanban, DAG, replay) need complete, ordered data, and they must not each invent their own.

## Decision

Every event of a run is appended to one per-run **event log**, and everything else about the run's progress is derived
from it.

- **One append-only file per run**, `.workflows/runs/<runId>/events.jsonl`, one JSON object per line. A resume appends to
  the same file.
- **Every event carries** a schema version, a timestamp and the run id. Step events also carry a step id, a parent id and
  a group id, so the structure of a run (groups, fan-out, fan-in) can be rebuilt from the log alone. Steps served from the
  journal or the memo also emit a start event. The run-start event records the effective config and its provenance.
- **Torn lines are tolerated.** A reader skips a line that is not a valid record, and the next append starts on a fresh
  line. A crash in the middle of a write never makes a run unresumable.
- **Status is a projection.** Job status, phase, recent one-line summaries and spend are computed from the log. The job
  record keeps only identity (job id, run id, pid, heartbeat). The projection never includes full content.
- **The budget is replayed.** Spent tokens and cents are read back from the log, failed attempts included, so a resume never
  starts from zero. A resume may set a new total cap.
- **Content stays local and bounded.** Prompts, agent text, tool calls and command output live in the local log with known
  secret formats redacted, and are pruned after the last 30 runs or 14 days per repo, metadata kept. That content is never
  sent to the metrics database or its exports, and `wait_workflow` returns one-line summaries only, so polling never
  pushes prompts or secrets into the chat context.
- **Every other state file is replaced atomically** (temp file plus rename), and each run is registered once in a global
  index, `~/.cursor-workflows/runs.jsonl`, so later tools can find runs across repositories.

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

## Considered options

- **Keep a mutable job state file as the source** and treat the log as a side record: two truths, torn reads, and a
  budget that cannot be replayed.
- **Store events in the metrics database (SQLite):** the database is per user and exportable, which is the opposite of the
  privacy rule for content. A binary file is also harder to read after a crash than a text file whose last line can be
  dropped.
- **A service that owns the state:** it would have to run all the time, and the kit's runs must survive without one
  ([ADR-0003](0003-detached-jobs.md)).

---

[← Anterior: 7.1 · ADR-0001: Layered config with hard caps](0001-layered-config-with-hard-caps.md) · [Índice](../README.md) · [Próximo: 7.3 · ADR-0003: Runs are detached processes →](0003-detached-jobs.md)
