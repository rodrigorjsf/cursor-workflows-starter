# Recipes

One recipe per pattern. Read the one for your case before writing the step, and pass every recipe through the cost
checklist (cost.md). Names such as `MODELS`, `issueBlock`, `snapshotTree` or `runTests` are helpers you write in the
workflow module; the recipe says what each does. A helper that runs a command (`runTests`, `snapshotTree`) is async: it
goes through `ctx.exec`.

## Routing by label → model

The tier, and with it the model, comes from an input datum (a label, a diff size); a cheap classifier step runs only
when no datum decides.

```ts
const tier = issue.labels.map((l) => LABEL_TIERS[l.name.toLowerCase()]).find(Boolean)
  ?? (await ctx.agent<{ tier: Tier }>(`${CLASSIFY_INSTRUCTIONS}\n\n${issueBlock(issue)}`, {
    label: "classify", model: MODELS.CLASSIFY, tools: [], settingSources: [], memo: true, schema: TIER_SCHEMA,
  })).tier;
await ctx.agent(task, { model: MODELS[tier], cwd: worktree, schema: IMPL_SCHEMA });
```

## Review by axes

Parallel reviewers, one per axis (for example Standards, Spec and Security), each with the schema of its own finding
categories. The code computes the input (the diff since the base), checks that every reviewer ran, and decides what
blocks and where each finding goes; the reports are never merged.

```ts
const diff = diffSinceBase(worktree, baseCommit);                       // computed by code, truncated
const reports = await ctx.parallel(AXES.map((axis) => () =>
  ctx.agent(`${AXIS_INSTRUCTIONS[axis]}\n\n## Round ${round}\n\n## Diff\n${diff}`, {
    label: `review:${axis}:${round}`, model: MODELS.REVIEW, cwd: worktree,
    tools: ["read", "grep", "glob", "ls"], settingSources: [], schema: AXIS_SCHEMAS[axis], memo: true,
  })));
if (reports.some((r) => r === null)) return { status: "review-failed" };  // a required review never becomes "no findings"
const byAxis = Object.fromEntries(AXES.map((a, i) => [a, reports[i]]));    // one report per axis
const b = blockingOf(byAxis); // e.g. missing/wrong → extra TDD slice; hard/blocking → refactor; judgement and notes → PR body
```

The round goes in the prompt (journal key, rule 1). After the fix, re-review only the axes that blocked.

## Fix until it passes (with a cap)

```ts
let t = await runTests(cmd, worktree);
for (let round = 1; t.kind === "failed" && round <= 2; round++) {   // a timeout is not a code failure
  await ctx.agent(`${FIX_INSTRUCTIONS}\n\n## Round ${round}\n\n## Test output\n${t.output}`, {
    label: `fix-${round}`, model: MODELS.HIGH, cwd: worktree, schema: IMPL_SCHEMA,
  });
  t = await runTests(cmd, worktree);
}
if (!t.ok) return { status: t.kind === "failed" ? "tests-failed" : `tests-${t.kind}`, output: t.output };
```

`runTests` runs the project's test command with `ctx.exec` (`bash -c`, with a time limit) and returns `kind` (`passed`,
`failed`, `timeout`) plus the end of the `output`. The run is a command node in the event log. It unsets
`NODE_TEST_CONTEXT`, which makes a nested `node --test` exit 0 even when it fails.

## Fan-out with isolation

```ts
await ctx.pipeline(files, async (file: string, _item, i) => {
  const wt = createWorktree(`wf/migrate-${file.replace(/[^\w.-]+/g, "-")}`); // git worktree add; path derived from the item
  return ctx.agent(`Migrate ${file} to TS.`, { cwd: wt, label: file, phase: "Migrate", schema: IMPL_SCHEMA });
}, (r, file) => verify(file, r));                         // per-item verification, no barrier
```

Fan out only independent items and group small ones into one step.

## Adversarial verification

A claim holds only if it survives parallel refuters.

```ts
const REFUTE = "Try to REFUTE the claim below. When in doubt, refuted=true."; // constant: stable prefix
const votes = await ctx.parallel([0, 1, 2].map((v) => () =>
  ctx.agent(`${REFUTE}\n\n## Claim\n${claim}\n\n## Voter ${v}`, {      // the voter in the prompt: distinct votes
    label: `v${v}`, model: MODELS.CLASSIFY, tools: ["read", "grep", "glob", "ls"], settingSources: [], schema: VERDICT, memo: true,
  })));
const survives = votes.filter(Boolean).filter((x) => !x!.refuted).length >= 2;
```

## Cheap, reusable read step

Classify, plan or review without editing.

```ts
const PLAN_INSTRUCTIONS = "Read the code and write a plan... Do not edit files."; // constant: stable prefix
const plan = await ctx.agent(`${PLAN_INSTRUCTIONS}\n\n${issueBlock(issue)}`, {
  model: MODELS.MED,
  tools: ["read", "grep", "glob", "ls", "semSearch"], // read-only, no "task"
  settingSources: [],                                 // no AGENTS.md or skills: list the context files that exist in the prompt
  schema: PLAN_SCHEMA,
  memo: true,                                         // same repo state → zero cost on the next run
});
await ctx.agent(`${CLASSIFY_INSTRUCTIONS}\n\n${text}`, {
  model: MODELS.CLASSIFY, tools: [], settingSources: [], schema: TIER_SCHEMA, memo: true, // [] cuts the skills
});
```

## Escalate the model by budget

```ts
const model = ctx.budget.remainingCents() < 100 ? MODELS.MED : MODELS.HIGH;
```

`remainingCents()` is the cents cap minus `spentCents()`, and `Infinity` without a cents cap. Where the cost never
reaches the kit (`getUsage()` failing with `feature_unavailable`, per-request billing), `remainingCents()` does not
fall: escalate by `ctx.budget.spentTokens()`. Escalating on failure is a cost pattern (cost.md, "Right model per
step").

## Invariants between steps

A process rule the model would police by itself ("red before green", "touch only test files", "the test is the
specification") becomes an **invariant** the code checks between two steps. The pieces:

- **Who touched what:** `snapshotTree` takes a git tree object of the worktree (it also sees `git add`, `stash`,
  `commit` and `skip-worktree` done by the agent) before and after the step; `changesBetween` lists the differences,
  with no rename detection (a moved file shows as deleted plus created).
- **Observable state:** the code runs the command and checks the expected result with `runTests`: only `failed` counts
  as red.
- **What stays locked:** in code steps (green, fix, refactor), the files matching the test globs and the runner
  configuration (the `package.json` scripts and the `jest`, `vitest`, `mocha`, `ava`, `c8`, `nyc` fields); in green and
  fix, also the slice's own test file (hash kept from the red step). Without the lock, the green step would switch the
  test off instead of implementing. In the red step the code discards what the step changed outside test files
  (`restorePaths`) and checks the red with the test alone: a model once implemented together with the test on both
  attempts. Deleting a test is a violation.
- **Violation:** `revertTo` undoes the step. In red and green a retry carries the problem in the prompt and, on the
  second violation, the run ends with a status of its own (`tdd-violation`, `test-not-red`); in fix and refactor the
  first violation ends the run (`tdd-violation`). The result carries the reason in `reason`.
- **Start:** the invariant holds before the first item (green suite, else `baseline-red`).

```ts
const before = await snapshotTree(worktree);
await ctx.agent(`${TEST_INSTRUCTIONS}\n\n${sliceBlock}`, { label: `test-${n}`, cwd: worktree, schema: TEST_SCHEMA });
const changed = await changesBetween(worktree, before, await snapshotTree(worktree));
if (changed.some((c) => !isTestFile(c.path) || c.status === "D")) { await revertTo(worktree, before); /* retry */ }
const red = await runTests(testCommand, worktree);
if (red.kind === "timeout") { await revertTo(worktree, before); /* end: tests-timeout */ }
if (red.kind === "passed") { /* the test is not red: retry, or alreadySatisfied with the evidence */ }
```

## Resume with invariants

The journal returns a step's **result**, not its effect on disk, and the code between steps runs again over the disk as
it is. An invariant comparing before and after would be wrong on a reused step, and an interrupted step would leave
half-made edits. So:

- keep the progress per item (and the outputs that become evidence) in `.workflows/runs/<runId>/<name>-progress.json`,
  outside the versioned tree, with each item's key derived from its content, not from its position;
- mark the write step in progress before calling it and, on resume, go back to the snapshot from before it; a step that
  fails is undone before the error rises;
- put a sequence number in the prompt of every write step, so the journal never returns an old write;
- keep the review reports per round, so a resume does not ask for a new review of a different diff;
- reuse the existing branch on resume (no `worktree add -B`, which would reset it) and run the suite again before the
  commit.

## Checkpoint across two runs

The runtime does not pause to ask. When the flow needs a human's approval in the middle, the same workflow runs twice:

1. Run 1 goes up to the result to approve, stores it in the run's progress and returns a pending status (for example
   `seams-proposed`) with `runId` and `next`, the resume command. Add the status to `PENDING` in the metrics recorder;
   outside it the run counts as a failure in cost per delivery (observability.md).
2. The code publishes the result where the human decides: for example a comment on the issue with a marker and the
   `runId` (once per run), the CLI command (`--resume <runId>`, args in escaped single quotes) and the chat path
   (`resumeRunId`). The text passes the secrets guard first.
3. Run 2 is the resume with the approval arg (for example `approveSeams: true`) and executes **the stored result**,
   not a recomputed one: an edited issue or a new context file would change the planner's prompt and the plan. A human
   edit (`seams: [...]`) redoes the step with the edit in the prompt. The stored result is found only with the same
   `runId` and repository, because progress lives in `<cwd>/.workflows/runs/<runId>/`: run 2 from the same directory
   (or the same `--cwd`) as run 1. Without a stored result, stop with `seams-not-proposed` rather than approve a plan
   nobody saw.
4. The `run-workflow` skill treats any result with `next` the same way: it shows the result, asks the user and
   relaunches only with their approval.
