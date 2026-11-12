# Cost

Apply the checklist to every step before writing it, then estimate each path. The patterns below explain each item.

## Checklist

- [ ] Every objective decision is code (not an agent step).
- [ ] Optional steps have an explicit condition (tier, size, flag).
- [ ] Every step has an explicit model; the frontier model only where justified; there is escalation on failure.
- [ ] Read-only steps (classify, plan, review, write the PR text) have read-only `tools`, `memo: true` and
  `settingSources: []`; those that read the repository get the context files that matter and exist listed in the
  prompt. `["team","mdm"]` only when the step needs team or MDM hooks (it still loads the skills). Steps that write keep
  the engine default (`["project","team","mdm"]`), so leave `settingSources` out.
- [ ] `tools` is an allowlist; no `"task"` unless the step delegates; `mcpServers` only where used.
- [ ] Prompts: instructions constant first, data last; nothing volatile at the start.
- [ ] Minimal schemas; no mechanical step asks for a long explanation.
- [ ] Large outputs (logs, diffs) truncated or summarized before they become a prompt.
- [ ] Fan-out only of independent items; small items grouped.
- [ ] Loops have a cap; `timeoutMs` and `retries` set; the run's default cap declared in `budget`.
- [ ] A cost estimate per path (below) recorded at the top of the workflow.
- [ ] First real run with low `--max-cents` and `--max-tokens`; `usage` per step reviewed.

## Patterns, in order of impact

### Do not call the model

- **An objective decision is code:** label, count, exit code, diff size. Each `if` that replaces a "decide whether…" is
  one call less.
- **Skip steps conditionally:** a plan only for MED/HIGH, a review only for HIGH or a large diff.
- **Resume through the journal:** never relaunch a failed run from scratch.
- **`memo: true` on read-only steps** (`tools` only read, grep, glob, ls, semSearch…): the same step with the repository
  in the same state (HEAD + local changes + new files) returns the saved result, even in another run. The runtime
  refuses `memo` on a step that can write.

### Right model per step

- **A tier per step, not per workflow.** A cheap model to classify, summarize and fix lint; the frontier model only for
  hard planning and review.
- **Escalate on failure:** try the cheap one, validate **with code**, repeat with the tier above only on failure.
- **Parameters:** prefer low-reasoning variants for mechanical tasks (`model.params`, for example `reasoning_effort`;
  check `npm run models`). Avoid `maxMode` unless needed.

### Minimal fixed context per step

Fixed context is paid on **every** call of **every** step, and it grows with what the agent loads:

| Context source | How to reduce it |
|---|---|
| `settingSources: "project"`: `AGENTS.md`, rules, **skill descriptions**, hooks and the **tools of the project's MCP servers** | `["team","mdm"]` drops `AGENTS.md` but **not** the skills (the SDK loaded the same 58 skills with it and with `"project"`); only `[]` removed them, and it also drops team and MDM hooks. Same prompt with `shell` and `mcp`: 30.4k input tokens with `"project"` against 25.5k with `[]`. For read-only steps `[]` cuts the most: in place of `AGENTS.md`, the code lists in the prompt the context files that matter and exist (patterns, glossary, ADRs). |
| `"user"`: `~/.cursor/agents`, `~/.cursor/skills`, `~/.claude/skills`, the user's MCP | Do not load `user`; 60+ subagents there once added about 10k tokens at the start of every chat. |
| Tool `task`: its description lists name and description of **every custom subagent**, so context grows linearly with their number | An allowlist of `tools` without `"task"`, unless the step must delegate. |
| Tool definitions | An allowlist of `tools`. `[]` = text only (the runtime adds `mcp` when there is a schema). |
| MCP servers per step | Pass `mcpServers` only on the step that uses them. |
| A long `AGENTS.md` | Keep it short. Instructions for one specific step go in that step's prompt. |

### Stable prefix (for the prompt cache)

The provider cache reuses only the **identical prefix**:

- **Fixed instructions first, variable data last.** Declare instructions as module constants
  (`const PLAN_INSTRUCTIONS = "..."`) and build the prompt as `INSTRUCTIONS + "\n\n" + data`.
- **Nothing volatile at the start of the prompt:** no date, run id, round counter or test output before the
  instructions. This also protects the journal and memo, which use the prompt as the key.
- **Same configuration among siblings:** same model, `tools` order, schema and `settingSources` on similar parallel
  steps. New agents with identical configuration read the fixed prefix (~4.2k tokens) from cache.
- **Stable schema:** the schema becomes the `inputSchema` of the `submit_result` tool, which is part of the tool
  definitions.

### Short conversations

- **A new agent per step** (the kit's default) keeps the history small. Each model call rereads the accumulated context
  from cache, on every tool call, read or edit inside a conversation; long conversations multiply the bill.
- **Reuse a conversation only for what depends on it:** the schema re-prompt, for example.
- **Pass summaries between steps, not whole outputs:** use the previous step's structured result (schema) and truncate
  long outputs (for example the last 4,000 characters of test output).

### Lean outputs

Output is the most expensive token. Ask only for the fields the code reads (minimal schema) and never for "explain your
reasoning" on mechanical steps.

### Conscious parallelism

N parallel agents pay the fixed context N times, and nothing guarantees a shared cache between them. Fan out only
independent items, group small items in one step (one agent for 5 small files instead of 5 agents) and keep
`concurrency` low when the cap is tight.

### Always limits

Fix loops with a cap, `timeoutMs` per step, a small `retries` (default 1), `--max-cents` and `--max-tokens` together per
run (each covers the other's blind spot, see runtime-api.md "Caps"), a default cap declared in `budget` (the run's cap
when the caller passes none; pick one that holds the worst case, since an issue's text can push a run there), and cheap
polling in the chat (a cheap model and waits of 45–50 s).

## Estimate before running

For each path of the workflow, in the typical case and the worst case (all retries and fixes), list the agent steps
and each one's model. Example for a coding workflow: LOW with one slice and three reviewers; HIGH with three designs, a
judge, five slices and one fix.

```
cost ≈ Σ steps × estimated_turns × (fixed_context + prompt + average_history) × input_or_cache_price
       + Σ steps × estimated_output × output_price
```

The most reliable estimate is empirical: run each path once with a low cap, note each step's `usage` and cost (`rawCents`
and `chargedCents` of the `step-end` event; the run's `spentCents` sums the larger of the two), and record the range in a
comment at the top of the workflow. Compare with the original flow when converting one, where everything ran on the chat's
model with delegations repeating the fixed context.
