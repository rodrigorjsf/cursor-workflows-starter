# Runtime API

Everything a workflow module touches: the skeleton, the `ctx` calls, the `agent()` options, the definition fields
and how the caps behave.

## Skeleton

```ts
// Cost per path (see cost.md, "Estimate before running"): steps × model, typical and worst case.
import { defineWorkflow } from "../src/runtime/workflow.js"; // kit workflows only; a repo workflow exports a plain object (target-repos.md)

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
    // One step per file in the same cwd; steps that edit common files need one worktree per item (rules.md, rule 5).
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

## Context (`ctx`)

| Call | What it does |
|---|---|
| `ctx.agent(prompt, opts)` | Creates a new Cursor SDK agent and runs one step. With `schema`, returns the validated object (the agent must call `submit_result`). Without `schema`, returns the final text. **Throws** if it fails after `retries`. |
| `ctx.parallel(thunks)` | Barrier: runs in parallel and waits for all. An item that fails becomes `null`. |
| `ctx.pipeline(items, ...stages)` | No barrier: each item goes through the stages independently. A stage that fails drops the item (`null`) and skips its later stages. A stage receives `(previousResult, item, index)`. |
| `ctx.phase(title)` / `ctx.log(message)` | Progress, shown by `wait_workflow` and on the CLI. |
| `ctx.metric(name, value)` | An outcome or difficulty signal of the run, written to the `metrics` table (observability.md). |
| `ctx.args`, `ctx.cwd`, `ctx.runId` | Input, repository and run id (the same on resume). |
| `ctx.budget` | `remainingCents()` (`Infinity` without a cents cap), `spentCents()`, `chargedCents()`, `spentTokens()`, `usage()` (tokens by type), `maxCents`, `maxTokens`. |

## `agent()` options

| Option | Meaning |
|---|---|
| `label` | Name of the step in progress and metrics. Always set it; without one the runtime uses a hash. |
| `role` | One of `meta.roles`. The config files and `WF_MODEL_<ROLE>` set the step's model, timeout, retries, schema retries and setting sources by role; they win over the other options of the call, and the role's own `defaults` lose to them. A role the workflow does not declare fails the step. |
| `phase` | Groups progress; use it inside `parallel`/`pipeline` instead of the global `ctx.phase`. |
| `model` | `{ id, params? }`. Required for local agents; falls back to `defaults.model`. The SDK checks the id against the account catalog: an unknown id fails the step. `npm run models` lists the ids. |
| `schema` | JSON Schema with `type: "object"` at the root. Turns the step into a structured one. |
| `cwd` | Working directory of the step (a git worktree the workflow created). Default: the run's cwd. |
| `tools` / `disallowedTools` | Allowlist / denylist of native tools (`read`, `grep`, `glob`, `ls`, `semSearch`, `shell`, `edit`, `task`, `mcp`…). With a `schema` the runtime adds `mcp`. `[]` means text only. |
| `agents` | Inline subagents for this step (`{ name: { description, prompt, model } }`); needs `"task"` in `tools`. |
| `mcpServers` | MCP servers for this step only. |
| `timeoutMs` | Time limit of each send (the request and each schema re-prompt get their own). Default 20 min. |
| `retries` | Extra attempts when the run ends in error or is cancelled. Default 1. |
| `schemaRetries` | Re-prompts when the agent skips `submit_result` or sends invalid JSON. Default 2. |
| `settingSources` | Which config layers the step loads: `"project"` (AGENTS.md, rules, skills, hooks, project MCP), `"team"`, `"mdm"`, `"user"`. Default when omitted: `["project","team","mdm"]`. Every layer adds fixed context to every call (cost.md). |
| `memo` | Result cache across runs, keyed by prompt, model, schema, tools, context and repository state. Accepted only with read-only `tools`. |
| `sandbox` | Turns on the SDK's local sandbox for shell calls (Linux needs `bubblewrap`). Untested here; leave it off. |

## Definition fields

- `meta`: `name` (stable), `description` (one line), `whenToUse` (triggers the chat agent reads), `phases`,
  `argsSchema` (validated with Ajv before the run; a mismatch fails the run with `args inválidos`), `roles`
  (`{ name, cloud, defaults?, envAliases?, description? }[]`: the named kinds of step, such as `classify` or
  `implement.low`; their names are the keys users configure under `workflows.<name>.roles`, so choose them as a public
  contract. `cloud` is `ok`, `read-only` or `never`; `defaults` holds the role's `model`, `timeoutMs`, `retries`,
  `schemaRetries`, `settingSources`).
- `defaults`: `model`, `timeoutMs`, `retries`, `schemaRetries`, `tools`, `sandbox`, applied to every `agent()` call that
  does not override them.
- `budget`: `{ maxTokens?, maxCents? }`, the cap when nothing in the config sets one; an explicit `null` turns a cap off.

## Caps

- The run's limits are layered: code defaults (`budget`, `defaults`, role defaults) < the global file
  `~/.cursor-workflows/config.json` < the repo file `.agents/workflows/config.json` < env (`WF_MAX_TOKENS`,
  `WF_MAX_CENTS`) < flags (`--max-tokens`, `--max-cents`) < the `overrides` of `start_workflow`. The global `caps` then
  clamp the result: a lower number or a narrower list wins. The repo file and `overrides` can only tighten them; a
  request that does not is reported as a violation and ignored. `wf config show [workflow]` prints the effective values
  and where each came from.
- A cap is checked **before** each step and each retry. A step that already started is not interrupted, and a step has
  no token cap of its own, so the overshoot can reach concurrency × one step. For tight caps use low `concurrency` and
  a short `timeoutMs` on steps that write.
- `maxCents` is compared with `spentCents()`: per attempt, the larger of the raw cost and the charged cost. The charged
  cost alone is 0 for usage included in the plan, bring-your-own-key and credits.
- The cents cap goes **blind** when the cost never arrives: `getUsage()` failing (`403 feature_unavailable` on local
  agents of some plans), a cost still unsettled after the step, or per-request billing (raw cost 0). The engine then
  emits a warning and counts the attempt's tokens from the `turn-ended` events, so the tokens cap keeps working.
  Always set both caps.
- The cents cap, the tokens cap, the plan's usage limit (a non-retryable `RateLimitError`) and an account without SDK
  access (`plan_required`) abort the whole run, also inside `parallel` and `pipeline`.
