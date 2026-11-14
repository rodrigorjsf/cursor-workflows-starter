# Testing and delivery

A workflow is delivered when the three items under "Before delivering" are met.

## Offline tests

Develop and test in the kit checkout: a workflow at `packages/runtime/workflows/<name>.ts` is typechecked and tested
there; its test is `packages/runtime/test/<name>.test.ts`. The package's `tsconfig.test.json` swaps `@cursor/sdk` for a
fake (`test/fake-sdk.ts`) at run time, so tests need no network and no account. `npm run typecheck` does not cover
`.agents/workflows/` or the tests.

Set `process.env.WF_METRICS = "off"` at the top of the test file (or pass `metricsDb: false` to `runWorkflow`) so the
test does not write to the user's metrics database.

Drive the workflow through `runWorkflow(def, args, { cwd })` and assert on the outcome: the result `status`, the
returned fields, the events. Do not assert on internal calls.

### The fake SDK

Import `{ script, calls, stats, costConfig, resetCloud }` from `@cursor/sdk` in the test; the fake is substituted.

- `script.push(fn)` defines what each `send()` does, in order:
  - `() => ({ result: "text" })` simulates free text;
  - `(o) => { o.local.customTools.submit_result.execute(obj, {}); return {}; }` simulates structured output;
  - `() => ({ status: "error" })` simulates a failure;
  - `() => ({ hang: true })` simulates a run that never ends (to test `timeoutMs`).
  With no entry the run finishes with result `"ok"`.
- `calls` holds the options of every `Agent.create` (assert on `tools`, `local.settingSources`, `model`).
- `stats` counts concurrency (`active`, `maxActive`), disposals (`disposed`) and usage reads (`usageReads`).
- `costConfig` sets what `getUsage()` reports: `raw` and `charged` cents (`raw: undefined` for a missing cost),
  `getUsageError` (for example `"feature_unavailable: ..."`), `createErrorCode` (an account without access).
- In an `afterEach`, reset every fake-SDK export the file uses: empty `script` and `calls`, zero `stats`, restore
  `costConfig`, and call `resetCloud()` when the file runs cloud steps (it forgets the fake cloud's agents and the
  `resumes` and `lookups` it recorded). State left by one test leaks into the next.

### Harness for flows with `ctx.parallel`, `gh`, `glab` or `git`

- One dispatcher by `label` in the fake SDK: with `ctx.parallel` the order of `send()` calls varies, and the `script`
  queue follows call order. The agent's name is `<workflow>:<label>`, so strip the `<workflow>:` prefix to get the label.
- A fake `gh` or `glab` on `PATH`, the one of the forge the workflow talks to (a Node script keeping state in JSON). It
  answers only the commands the workflow runs and exits non-zero for any other, so a command the test did not expect
  fails it. For a GitLab test, point `origin` at a `gitlab.com` URL, or at another host declared under `forges` in the
  repo config.
- A temporary git repository with `user.name` and `user.email` set, and a bare repository as `origin`.
- The project's real test command (`node --test`), which the workflow runs through its test runner helper.

### Required coverage

One case for each branch the code decides (tier, skipped step, loop at the cap), one for each returned `status`, one for
each invariant (violation, retry, status) and the resume (after `done` and after a failure in the middle). For every
defect a review finds, write the test that reproduces it before the fix and watch it fail on the old code.

## Before delivering

- **Cost:** every item of the cost checklist met, or the reason for the exception in a comment (cost.md).
- **Offline tests:** the coverage above, with `npm run typecheck` and `npm test` green and the workflow in
  `packages/runtime/workflows/`.
- **A real run with low caps.** It spends quota and may have external effects: run it only if the user asks. Without the
  request, the item is met by handing the user the command, the expected `status` and the cost estimate:
  `npm run wf -- run <name> --args '{...}' --max-cents 100 --max-tokens <N>`, with `<N>` up to the workflow's
  `budget.maxTokens` and both caps always set (the cents cap goes blind when Cursor reports no cost).
  A workflow with an external effect runs with `--cwd` in a disposable repository:
  - with push, PR or comment: a throwaway GitHub repository (`gh repo create <owner>/<new-repo> --private --source .
    --push`), or for a GitLab workflow a throwaway GitLab project (`glab repo create <group>/<new-repo> --private`, then
    point `origin` at it and push; a self-managed host goes under `forges` first), holding a minimal Node project
    (`package.json` with `"test": "node --test"`, `src/math.js` exporting `add`, `test/math.test.js`), a label
    `complexity:low` and one issue ("Add subtract(a, b) to src/math.js", labelled);
  - with commit only: a local `git init` repository with the same files and one commit.

  Done when the run returns the expected `status` and each step's usage (the `step-end` lines on the CLI's stderr, or
  the `v_attempts` rows for the `run_id` grouped by `label`, see observability.md) fits the estimate; if it does not,
  adjust the tiers or the estimate.
