# Observability

The runtime already measures every step (tokens by type, cost, model, turns, cache). The workflow records what it means
to **deliver**.

## Status → outcome

Return `{ status: "done", ... }` when the run delivered and another explicit status when it did not (`"tests-failed"`,
`"review-blocking"`…). The runtime derives `outcome_class` from it:

- a run that threw or hit a cap → `error`;
- `status` in `done`, `delivered`, `ok`, `success`, `succeeded` → `delivered`;
- a pending status (`pending`, or one added to `PENDING` in the metrics recorder), returned by a checkpoint that waits
  for the human, with `runId` and `next` → `pending` (not a failure);
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

## Reading the numbers

The metrics database is `~/.cursor-workflows/metrics.db` (SQLite). Useful views: `v_attempts` (one row per step
attempt, with `cost_cents`, `cost_source` and `ctx_bucket_k`), `v_runs` (cost and outcome per logical run),
`v_workflow_summary` (cost per delivery), `v_model_summary`, `v_waste` (cost of failed attempts) and `v_savings`
(journal and memo hits). `wf stats` and `npm run dash` summarize them. Group a run's attempts by `label` to see each
step's usage, with `WHERE run_id = '<runId>'`.

Attempts are only inserted, never updated; a resumed run is a new execution of the same `run_id`. A `cost_final = 0`
means the Cursor cost had not settled when the step ended; `wf metrics reconcile` fills it in. Never send the database,
or an export made with `--no-anonymize`, off the user's machine.
