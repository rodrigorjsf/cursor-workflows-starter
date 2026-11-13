# Observability

The runtime already measures every step (tokens by type, cost, model, turns, cache). The workflow records what it means
to **deliver**.

## Status → outcome

Return `{ status: "done", ... }` when the run delivered and another explicit status when it did not (`"tests-failed"`,
`"review-blocking"`…). The runtime derives `outcome_class` from it:

- a run that was cancelled (`cancel_workflow`, `wf cancel`, Ctrl-C) → `cancelled`;
- a run that threw or hit a cap → `error`;
- `status` in `done`, `delivered`, `ok`, `success`, `succeeded` → `delivered`;
- a pending status (`pending`, `seams-proposed`, or one added to `PENDING` in the runtime's `outcome.ts`), returned by
  a checkpoint that waits for the human, with `runId` and `next` → `pending` (not a failure);
- any other `status` → `failed`;
- no `status` → `unknown`.

Cost per delivery divides all spend, failed runs included, by the delivered runs, so an unexpected status name counts as
a failure there.

## Metrics and labels

- `ctx.metric(name, value)` for outcome signals (tests passed, review findings, diff lines) and for the **difficulty
  covariate** (for example `tier`). Without it, comparing models mixes easy and hard tasks.

  ```ts
  ctx.metric("tier", tier);
  ctx.metric("tests_passed", tests.ok ? 1 : 0);
  ctx.metric("diff_lines", diffLines);
  ctx.metric("review_blocking", blocking.length);
  ```

- An explicit `label` on every step (`"plan"`, `"implement"`). Without one the runtime uses `step-<hash>`, which avoids
  leaking prompt content and also makes per-step analysis unreadable.
- To validate delivery later (the PR accepted or rejected): `wf metrics mark <runId> accepted|rejected`.

## The run's event log

Every event of a run is appended to `<repo>/.workflows/runs/<runId>/events.jsonl`, one JSON object per line. The log is
the run's source of truth, and a resume appends to the same file. Each new run also registers itself, once, in the
global index `~/.cursor-workflows/runs.jsonl` (run id, repo path, workflow, start time); a resume adds no line.

- Every event has `v` (schema version), `ts` and `runId`. Step events (`step-start`, `turn`, `step-end`) add `stepId`,
  `parentId` and `groupId`; `parallel` and `pipeline` calls emit a `group-start` and `group-end` pair. A reader can
  rebuild the run's structure from the log alone.
- A step served from the journal or the memo emits `step-start` and `step-end` with `cached` set to `"journal"` or
  `"memo"`. Its `stepId` is the same on every execution of the run.
- Step content (prompts, what the agent said, tool calls, shell output) is in the log as `content` events, and nowhere
  else: not in the metrics database or its exports, and not in what `wait_workflow` shows. Known secret formats and the
  values of environment variables named like `KEY`, `TOKEN`, `SECRET` or `PASSWORD` are replaced with `[REDACTED]`
  before it is written. A step's result gets the same redaction before it reaches the journal, the memo and the
  workflow itself: `ctx.agent` returns `[REDACTED]` where the agent wrote a secret, on the first run and on a resume.
  When a run starts, the `text` of the content of runs beyond the last 30 or older than 14 days is
  deleted; the events around it stay.
- `wait_workflow` and `wf status` are projections of the log: `recent` holds at most 20 one-line summaries, never prompt or
  output text. `result` is whatever the workflow returned, so return structured facts, not raw agent text.
- Warnings to relay on a resume: `the workflow code changed` (the resumed run mixes two versions of the workflow) and
  `the last line of the event log was incomplete` or `the last line of the journal was incomplete` (a crash
  tore that line; the affected step runs again).
- One process executes a run id at a time: starting it again while it runs fails with `already running`.

## Reading the numbers

The metrics database is `~/.cursor-workflows/metrics.db` (SQLite). Useful views: `v_attempts` (one row per step
attempt, with `cost_cents`, `cost_source` and `ctx_bucket_k`), `v_runs` (cost and outcome per logical run),
`v_workflow_summary` (cost per delivery), `v_model_summary`, `v_waste` (cost of failed attempts) and `v_savings`
(journal and memo hits). `wf stats` and `npm run dash` summarize them. Group a run's attempts by `label` to see each
step's usage, with `WHERE run_id = '<runId>'`.

Attempts are only inserted, never updated; a resumed run is a new execution of the same `run_id`. A `cost_final = 0`
means the Cursor cost had not settled when the step ended; `wf metrics reconcile` fills it in. Never send the database,
or an export made with `--no-anonymize`, off the user's machine.
