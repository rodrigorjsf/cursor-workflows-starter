---
name: skill-to-workflow
description: Converts existing skills and subagents into a deterministic workflow of this kit, with an offline test and a cost report.
disable-model-invocation: true
---

# Convert skills and subagents into a workflow

**Input:** paths to one or more `SKILL.md` files (`.agents/skills/`, `.cursor/skills/`, `.claude/skills/`,
`.codex/skills/`, or a third-party skill in a plugin cache or another repository), subagent files
(`.cursor/agents/*.md`, `.claude/agents/*.md`, `.codex/agents/*.md`) and, if they exist, instructions (`AGENTS.md`,
`CLAUDE.md`, `.cursor/rules/`), commands or hooks that take part in the flow.

**Output:** `packages/runtime/workflows/<name>.ts` in the kit, where typecheck and tests run, with prompts and checks
in a `packages/runtime/workflows/<name>/` folder when the module grows; `packages/runtime/test/<name>.test.ts`; a row in
the credits table of the kit's book chapter on the idea and its references (vision part, chapter 1.2) when the origin
is third-party; and a conversion report in the chat. If the flow comes from another repository (kit installed elsewhere),
step 5 ends by copying the workflow to `.agents/workflows/` there. The kit's built-in `implement-issue` workflow is a
finished conversion of four skills (`tdd`, `codebase-design`, `code-review` and `pr`).

The references next to this file carry everything the steps apply: [runtime-api.md](references/runtime-api.md) (the
runtime API), [rules.md](references/rules.md), [recipes.md](references/recipes.md),
[cost.md](references/cost.md), [observability.md](references/observability.md),
[testing.md](references/testing.md), [target-repos.md](references/target-repos.md),
[harness-discovery.md](references/harness-discovery.md) and [origin-cases.md](references/origin-cases.md). Read each
where a step names it.

## Step 1: inventory (read-only)

Read each indicated file and everything it references: scripts, templates, other skills (`tdd` calls
`codebase-design`), the reference files next to the `SKILL.md`, other agents, MCP servers and, in a third-party skill,
its license and credits. Build this table:

| Unit | Path | Type | Current trigger | Harnesses that discover it today | Inputs | Outputs | Tools | Model | External effects |
|---|---|---|---|---|---|---|---|---|---|

For "Harnesses that discover it today", use the matrix in [harness-discovery.md](references/harness-discovery.md) and
check whether `.claude/skills/` has links to `.agents/skills/`: with them, Claude Code also discovers the skill. For a skill from a plugin or
another repository, note where it is installed and which harness loads it. This column feeds the report's parity item
(step 6).

The fields come from these sources:

- **Skill**: the numbered steps, the conditions ("if X, do Y"), the scripts called and `disable-model-invocation`
  (whether the skill was explicit or relied on the model to trigger).
- **Subagent**: `name`, `description`, `model` and the body as the prompt, plus each harness's fields (section
  "Origin subagent" of [origin-cases.md](references/origin-cases.md)).

If the origin talks to the user, cites another skill, has reference files next to the `SKILL.md` or conditional
reading ("read X, if it exists"), fires sub-agents in parallel, is third-party or includes a subagent, read the
matching case section in [origin-cases.md](references/origin-cases.md) before step 2.

Done when every file the inputs reference has a row in the table or is cited in the row of whatever references it.

## Step 2: find the implicit decisions

List every decision that **the model** makes today. Typical signals:

- "when relevant", "if necessary", "use the X subagent to…" (delegation decided by the model);
- a loop with no cap: "repeat until…", "fix until it passes";
- "check that the tests pass" (verification done by whoever generated the code);
- an imperative process rule that the model polices itself ("red before green", "only touch test files", "do not
  merge the reports"): becomes an **invariant** checked by the code between steps;
- "confirm with the user", "ask": becomes `args`, a **checkpoint**, or stays a skill (section "Conversation with the
  user" of [origin-cases.md](references/origin-cases.md));
- an implicit model choice, when everything inherits the chat's model.

For each decision, propose the code rule that replaces it: a field, a label, a count, an exit code or a schema. If no
objective rule is possible, it becomes a `ctx.agent` step with a `schema` (a cheap classifier), and the **code** acts
on the answer.

Done when every conditional, loop, delegation, verification, imperative rule, request to the user and model choice in
the steps and `description`s of the inventory has a row with the adopted rule.

## Step 3: map to the runtime

The recipes cited are in [recipes.md](references/recipes.md).

| Origin | Destination |
|---|---|
| General instructions (`CLAUDE.md`, `.cursor/rules/`) used by the flow | What is common goes to `AGENTS.md`, which the steps that write load through the engine default (`["project","team","mdm"]`). Read-only steps keep `[]` and get the files that matter in the prompt |
| Skill step executed by the model | `ctx.agent(prompt, { schema, tools, model })`. The prompt is the step's text, in an instructions constant, plus the explicit inputs |
| Subagent called by delegation | `ctx.agent(subagentBody + task, { model, tools })`; the delegation condition becomes code (step 2) |
| Several independent subagents, or sub-agents the skill itself fires in parallel | `ctx.parallel` (barrier) or `ctx.pipeline` (per item); the code checks the minimum number of results, and the skill's aggregation becomes code or a judge step |
| Another skill cited by the skill ("call skill X") | Section "Another skill cited and reference files" of [origin-cases.md](references/origin-cases.md) |
| Script called by the skill (lint, tests, build) | `execFileSync` in the workflow; the result decides the next step |
| Imperative process rule | Recipe "Invariants between steps" |
| Human approval of an intermediate result | Recipe "Checkpoint across two runs" |
| Loop with no cap | `for (let round = 1; round <= N && !ok; round++)` |
| Review/critique | Recipe "Review by axes": one step per axis, a schema with the skill's own finding categories, routing in code |
| End-of-turn hook that reopens the loop (Cursor: `stop`/`subagentStop` with `followup_message`; Claude Code: `Stop`/`SubagentStop` with `decision: "block"` and `reason`, or exit 2) | An explicit loop in the workflow, with a cap; the hook is no longer needed |
| External effect (commit, PR, comment) | Code at the end, after the checks. The real output the skill asks for in the artifact (a failing test, then passing) is captured by the code; the agent writes only the judgment text |
| Subagent the workflow wants to delegate *inside* a step | `agents: { name: { description, prompt, model } }` in the step option, with `"task"` in the `tools` allowlist (the tool that fires subagents) |
| Subagent frontmatter field (`readonly`, `model: inherit`, `isolation`, `maxTurns`, `effort`, `tools`…) | Section "Origin subagent" of [origin-cases.md](references/origin-cases.md) |

Done when every row of the inventory and every decision from step 2 has a destination in this table or in a table of
[origin-cases.md](references/origin-cases.md), or goes into the list of what was not converted (step 6), with the reason.

## Step 4: optimize cost (mandatory)

Before generating, apply **all** the items of the cost checklist in [cost.md](references/cost.md) to each step and
record the decision in a table, one row per step:

| Step | Model (tier) | `tools` | `settingSources` | `memo` | Stable prefix | Minimal schema | Loop/timeout |
|---|---|---|---|---|---|---|---|

A checklist item without a column (optional-step condition, truncation, fan-out, `mcpServers`, default cap) goes in as
a note on the row; an item that does not apply gets `n/a` and the reason. The first real run is left to the user
(step 6).

Then **estimate the cost per path** ("Estimate before running" in [cost.md](references/cost.md)): for each combination of branches (e.g. LOW with
one slice; HIGH with three designs, a judge and one fix), count the agent steps and each one's model, in the typical
case and the worst case (all retries and fixes). Compare with the original flow, where everything ran on the chat's
model, with delegations that repeat the fixed context.

Done when every step has a row, every cell has a decision or `n/a` with a reason, and every path has an estimate.

## Step 5: generate

1. Write `packages/runtime/workflows/<name>.ts` following [runtime-api.md](references/runtime-api.md),
   [rules.md](references/rules.md) and [recipes.md](references/recipes.md), with the instrumentation of
   [observability.md](references/observability.md) and the Cost and Offline tests items of "Before delivering" in
   [testing.md](references/testing.md) (the real run is left to the user, step 6). At the top,
   comment the table and the cost estimate from step 4. `meta.whenToUse` is read by the chat agent: write it with the
   original flow's triggers (the skill's `description`, if the model invoked it; the request that led the user to type
   `/name`, if it did not; the requested work, when several skills become a single flow).
2. Write `packages/runtime/test/<name>.test.ts` with the cases of "Offline tests" under "Before delivering" in
   [testing.md](references/testing.md); the branches are the ones the step 2 rules created in the code.
3. Run `npm run typecheck` and `npm test` until both pass.
4. If the flow comes from another repository, copy `packages/runtime/workflows/<name>.ts` and, if it exists, the
   `packages/runtime/workflows/<name>/` folder to `.agents/workflows/` there, replacing `defineWorkflow({...})` and the
   relative runtime import with `export default { meta, defaults, budget, async run(ctx) { ... } }`, the same object
   (type-only imports may stay), as in [target-repos.md](references/target-repos.md).
5. Keep the original skills and subagents intact: deleting them is the user's decision, after comparing the two flows.

Done when every "Offline tests" case under "Before delivering" has a test (the branches are the ones the step 2 rules
created in the code), the last run of `npm run typecheck` and `npm test` passed, the copy from item 4 is in
`.agents/workflows/` of the origin repository (flow from another repository) and the originals are as they were.

## Step 6: report in the chat

- The step 1 table and the list of implicit decisions, with the rule adopted for each.
- **Cost:** the step 4 table, the estimate per path and what changed from the original (steps eliminated by code,
  downgraded models, steps with memo, reduced context).
- What was **not** converted and why: for example, an open conversation with the user, which stays a skill.
- **Credits:** origin, version, author and license of each third-party skill and of whoever it credits.
- **Parity:** from the "Harnesses that discover it today" column, where the flow ran and where it now runs (every
  harness with the `workflows` MCP). For each harness that did not discover the origin, say what it needs to fire the
  workflow (in Claude Code: approve the `.mcp.json` server and, for `/run-workflow`, link the skill folder into
  `.claude/skills/`). If the origin had Claude Code hooks in `.claude/settings.json`, warn that their `PreToolUse` hooks
  also run in the steps with `settingSources: ["project"]` (parity table in
  [harness-discovery.md](references/harness-discovery.md)).
- **Original:** for a skill of the repository itself that the model still invokes, suggest `disable-model-invocation:
  true` or replacing the body with "use /run-workflow <name>".
- **First real run**, which is the user's because the workflow may have external effects: the command from "A real run
  with low caps" under "Before delivering" in [testing.md](references/testing.md), with `--cwd` in the origin repository when the
  flow comes from another repository (in a disposable copy of it, if there is an external effect).
  Then compare the cost per step with the estimate (`npm run stats` or `npm run dash`) and adjust the tiers, starting
  with the two most expensive steps. With a few runs accumulated, compare cost per delivery with the original flow.

Done when the report has the seven items above, and an item that does not apply (Credits for an origin in the
repository itself, Original for a third-party skill) says `n/a` and the reason.
