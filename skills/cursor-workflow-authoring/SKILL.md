---
name: cursor-workflow-authoring
description: Use before creating, editing or testing a Cursor SDK workflow (a defineWorkflow module under a kit's workflows/ folder or a repo's .agents/workflows/).
---

# Write a workflow

A workflow is a TypeScript module with `export default defineWorkflow({...})`. It is **deterministic**: code decides
what runs, when it runs and how many times; the model only executes each step. Code makes every decision it can make
(label, count, exit code, diff size).

## Steps

1. **Shape the steps.** Read [references/runtime-api.md](references/runtime-api.md): the skeleton, the `ctx` calls, the
   `agent()` and `exec()` options and how the caps behave. Done when each step has a name, a model, `tools`,
   `settingSources` and, if the code reads its result, a `schema`, and every command the code runs (tests, `git`, `gh` or
   `glab`) goes through `ctx.exec`, never a synchronous call (`execFileSync`).
2. **Pick the patterns.** For each case in the flow, read its section of [references/recipes.md](references/recipes.md):
   routing by label, review by axes, fix until it passes, fan-out with isolation, adversarial verification, cheap read
   step, escalate by budget, invariants between steps, resume with invariants, checkpoint across two runs. Done when
   every case has its recipe in the code.
3. **Apply the rules.** [references/rules.md](references/rules.md) holds the nine rules (prompt as key, schema, code
   verification, model in code, isolated parallel writes, effects in code behind a secrets guard, explicit cuts,
   idempotent effects, composition). Done when each rule holds in the code.
4. **Apply the cost checklist.** [references/cost.md](references/cost.md), to every step. Done when each item is met or
   the exception is in a comment, and the per-path estimate sits at the top of the module.
5. **Instrument.** [references/observability.md](references/observability.md): statuses, metrics, labels. Done when every
   return path has an explicit `status` and every step a `label`.
6. **Test and deliver.** [references/testing.md](references/testing.md): offline tests with the fake SDK, the real-run
   command. Done when its three "Before delivering" items are met.

To place the file, or to use the kit from another repository (MCP config, the plain-object form for a repo workflow),
read [references/target-repos.md](references/target-repos.md).
