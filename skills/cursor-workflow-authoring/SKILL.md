---
name: cursor-workflow-authoring
description: Cursor SDK defineWorkflow workflows (packages/runtime/workflows/*.ts, .agents/workflows/*.ts). Use before creating, editing or testing one.
---

# Write a workflow

A workflow is a TypeScript module in `packages/runtime/workflows/<name>.ts` (built into the kit) or
`.agents/workflows/<name>.ts` (in the target repository, which wins on a repeated name), with
`export default defineWorkflow({...})`. Helper modules go in the `<name>/` subfolder, because the runtime imports
every `.ts`, `.js` and `.mjs` at the first level. In `.agents/workflows/` of a repository with the kit installed
elsewhere, the skeleton's relative import does not resolve: follow form B of `docs/04-invocacao-no-cursor-ide.md`
(the object exported directly, `import type` only, developed and tested in the kit).

The workflow is **deterministic**: the code decides what runs, when it runs and how many times; the model only
executes each step. If code can make a decision (label, count, test passed or not, diff size), code **must** make it.

## Skeleton

```ts
// Cost per path (docs/08-custos-e-cache.md §7): steps × model, typical and worst case.
import { defineWorkflow } from "../src/runtime/workflow.js";

const LIST = "List the files that the target below involves.";  // instructions in constants: stable prefix
const PROCESS = "Process the file below.";

export default defineWorkflow<{ target: string }>({
  meta: {
    name: "my-flow",                         // `name` of start_workflow (MCP) and of `wf run <name>` (CLI)
    description: "One line.",
    whenToUse: "When the user asks for X.",  // the chat agent reads this
    phases: [{ title: "Discover" }, { title: "Execute" }],
    argsSchema: { type: "object", required: ["target"], properties: { target: { type: "string" } } },
  },
  defaults: { model: { id: "composer-2.5" }, timeoutMs: 20 * 60_000 },
  budget: { maxTokens: 1_000_000 },          // default cap; --max-tokens replaces it
  async run(ctx) {
    ctx.phase("Discover");
    const found = await ctx.agent<{ files: string[] }>(`${LIST}\n\n${ctx.args.target}`, {
      label: "list",
      tools: ["read", "grep", "glob", "ls"],
      settingSources: [],
      memo: true,
      schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } },
    });
    ctx.phase("Execute");
    // One step per file in the same cwd; steps that edit common files need one worktree per item (rule 5).
    const out = await ctx.pipeline(found.files, (f: string) =>
      ctx.agent(`${PROCESS}\n\n${f}`, { label: `process:${f}`, phase: "Execute" }));
    const failed = found.files.filter((_, i) => out[i] === null);
    ctx.metric("files", found.files.length);
    ctx.metric("failures", failed.length);
    if (failed.length) return { status: "items-failed", failed };
    return { status: "done", processed: found.files.length };
  },
});
```

## Context API

| Call | What it does |
|---|---|
| `ctx.agent(prompt, opts)` | Creates a new Cursor SDK agent and runs a step. With `schema`, returns the validated object (the agent must call `submit_result`). Without `schema`, returns the final text. **Throws** if it fails after `retries`. |
| `ctx.parallel(thunks)` | Barrier: runs in parallel and waits for all. An item that fails becomes `null`. |
| `ctx.pipeline(items, ...stages)` | No barrier: each item goes through the stages independently. A stage that fails drops the item (`null`). |
| `ctx.phase(t)` / `ctx.log(m)` | Progress, shown in `wait_workflow` and in the CLI. |
| `ctx.metric(name, value)` | A signal of the run's outcome or difficulty, written to the `metrics` table (see Observability). |
| `ctx.args`, `ctx.cwd`, `ctx.runId` | Input, repository and run id (the same on resume). |
| `ctx.budget` | `remainingCents()`, `spentCents()`, `chargedCents()`, `spentTokens()` and `usage()`, to downgrade the model or stop before the cap. Before escalating by it, read the `Escalonar o modelo por orçamento` recipe: the signal in cents may never drop. |

The cents cap, the tokens cap, the plan's usage limit (a non-retryable `RateLimitError`) and an account without SDK
access (`plan_required`) abort the whole run, also inside `parallel` and `pipeline`.

`agent()` options: the `AgentCallOptions` interface in `packages/runtime/src/runtime/workflow.ts` documents the
options and the restrictions (`memo` only with read `tools`; `schema` with `type: "object"` at the root). The default
`settingSources`, when the step passes none, is in `RunOptions` (`packages/runtime/src/runtime/engine.ts`).

## Rules

1. **Prompt and options are the step's key.** The journal (resume) recognizes a step by the hash of the prompt and of
   the `fingerprint` of `agentCall` in `packages/runtime/src/runtime/engine.ts` (model, schema, `cwd`, `tools`,
   `disallowedTools`, `agents`, `settingSources`), plus the order in which that hash appears in the run; `label`,
   `timeoutMs`, `mcpServers` and `sandbox` stay out; the `memo` and the provider cache also depend on the prompt.
   Build the prompt with the instructions in module constants and only deterministic data: `args`, step results and
   what the code computes from them and from disk (test output, diff). A date enters through `args`, not through
   `Date.now()`. Give the worktree a path derived from the item, like the branch in
   `packages/runtime/workflows/implement-issue.ts`. Two calls that must be distinct (the same step in different
   rounds) carry the round in the prompt.
2. **A schema on every step whose result the code reads**, with only the fields it reads. Free text only at the end,
   or for the human.
3. **Verification is code.** Run tests, lint and `git diff` with `execFileSync` inside the workflow; the exit code
   decides the next step. Fix loops always have a cap (`for (round = 1; round <= N; ...)`).
4. **The model is chosen in code.** Use a `tier → ModelSelection` map and confirm each ID with `npm run models`: an ID
   outside the account's catalog makes the step fail. Auto is `default`; with it, the metrics record `default`, not
   the model the Router chose, so compare models with explicit IDs.
5. **Parallel writes only with isolation.** Two simultaneous steps cannot edit the same files. Create a `git
   worktree` per item and pass it in `cwd`.
6. **External effects stay in code.** Commit, push, opening a PR and commenting on an issue are done with `gh` or
   `git` in the workflow, after the checks. Everything that leaves the machine first goes through the secrets guard
   of `packages/runtime/workflows/implement-issue.ts`: the staged diff since the base, before the commit
   (`findStagedSecret`, which also blocks `auth.json` and `.env`), and every text (PR body, comment), before
   publishing (`findSecretInText`).
7. **Cuts and failures are always explicit.** When limiting coverage (top-N, sampling), record with `ctx.log` what was
   left out. `ctx.parallel` and `ctx.pipeline` turn failures into `null`: when the result is required (a mandatory
   review, for example), check the `null`s and end the run with an explicit failure `status`.
8. **Idempotent effects.** A resume re-executes the code outside the agent steps, and the journal returns a step's
   result, not its effect on disk. Protect commit (`git diff --cached --quiet`), push and PR creation (`gh pr view`
   before `gh pr create`). If the code checks the disk between steps, keep the progress per item (recipe
   `Resume com invariantes`).
9. **Compose with shared TypeScript functions**, called from `run`.

## Observability

The runtime already measures each step; the workflow records whether the run **delivered** (how each `status` becomes
an `outcome_class` and how to query the numbers: `docs/09-observabilidade.md` §3, §4 and §6):

- **Status:** return `{ status: "done", ... }` when it delivered and another explicit status when it did not
  (`"tests-failed"`, `"review-blocking"`…). A checkpoint that waits for the human returns `status: "pending"`, or a
  status added to `PENDING` in `packages/runtime/src/observability/recorder.ts`, with `runId` and `next` (recipe
  `Checkpoint em dois runs`). Any other name counts as a failure in cost per delivery.
- **`ctx.metric(name, value)`** for the outcome signals (tests passed, review findings, diff lines) and for the
  **difficulty covariate** (e.g. `tier`). Without it, comparing models mixes easy and hard tasks.
- **An explicit `label`** on every step. Without a label, the runtime uses a hash, and the per-step analysis becomes
  unreadable.

## Cost

Before writing the first step, read the checklist in `docs/08-custos-e-cache.md` §6 and apply each item to every
step. It is the single source of the cost rules (`memo`, `settingSources`, `tools` allowlist, stable prefix, minimal
schema, truncation, fan-out, default cap); the reason for each is in §4.1–4.8.

## Recipes

The recipes in `docs/05-escrevendo-workflows.md` (the `Receitas` section) carry the code of each pattern. Read the
one for your case before writing the step:

- **routing by label** (`Roteamento por label → modelo`): the tier, and with it the model, comes from an input datum (label,
  diff size);
- **fix until it passes** (`Corrigir até passar (com teto)`): a fix loop that ends on an exit code;
- **fan-out with isolation** (`Fan-out com isolamento`): the same work on independent items;
- **adversarial verification** (`Verificação adversarial`): a claim that only holds if it survives parallel
  refuters;
- **cheap, reusable read step** (`Etapa de leitura barata e reaproveitável`): classify, plan or review without
  editing;
- **escalate the model by budget** (`Escalonar o modelo por orçamento`): the tier drops with the run's spend
  (escalating on failure is `docs/08-custos-e-cache.md` §4.2);
- **invariants between steps** (`Invariantes entre etapas`): a process rule that the code checks (red before green, only test files
  change);
- **checkpoint** (`Checkpoint em dois runs`): the flow needs a human's approval in the middle;
- **resume with invariants** (`Resume com invariantes`): the code between steps depends on the disk state;
- **review by axes** (`Review em eixos`): parallel reviewers whose findings the code routes.

## Before delivering

The workflow is delivered only with all three items met:

- **Cost:** every item of the checklist in `docs/08-custos-e-cache.md` §6 met, or the reason for the exception in a
  comment.
- **Offline tests:** `packages/runtime/test/<name>.test.ts` with the fake SDK (recipes and harness in
  `docs/05-escrevendo-workflows.md`, the `Testando` section), with one case per branch the code decides (tier,
  skipped step, loop at the cap), one per returned `status`, one per invariant (violation, retry, status) and the
  resume (after `done` and after a failure in the middle). `npm run typecheck` and `npm test` green, with the
  workflow in `packages/runtime/workflows/`: the typecheck `tsconfig.json` does not include `.agents/workflows/` or
  the tests.
- **A real run with low caps.** It spends quota and may have external effects: run it only if the user asks. Without
  the request, the item is met by handing the user the command, the expected `status` and the estimate (step 6 of
  `/skill-to-workflow`):
  `npm run wf -- run <name> --args '{...}' --max-cents 100 --max-tokens <N>`, with `<N>` up to the workflow's
  `budget.maxTokens` and always with both caps (the cents cap goes blind when Cursor reports no cost;
  `docs/02-configuracao-inicial.md` §3). A workflow with an external effect runs with `--cwd` in a disposable
  repository: with push, PR or comment, `scripts/verify/setup-sandbox-repo.sh <owner/new-repo>` creates one on
  GitHub, with an issue; with commit only, the local repository from `scripts/verify/setup-probe-repo.sh` is enough.
  Done when the run returns the expected `status` and each step's usage (the `step-end` lines on the CLI's stderr, or
  the `v_attempts` rows with the `run_id`, grouped by `label`: `docs/09-observabilidade.md` §3 and §4) fits the
  estimate; if it does not, adjust the tiers or the estimate.
