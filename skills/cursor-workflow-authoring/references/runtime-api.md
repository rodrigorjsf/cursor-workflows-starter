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
| `ctx.exec(command, args, opts)` | Runs a command (tests, `git`, `gh`) and returns `{ ok, exitCode, timedOut, tail, error? }`. Asynchronous, killed at its timeout, logged. See "`exec()` options" below. |
| `ctx.phase(title)` / `ctx.log(message)` | Progress, shown by `wait_workflow` and on the CLI. |
| `ctx.metric(name, value)` | An outcome or difficulty signal of the run, written to the `metrics` table (observability.md). |
| `ctx.card({ title, subtitle?, links?, badges? })` | What the run's card shows on the dashboard's Board. `links` is `[{ label, url }]` and `badges` is a list of short strings. Call it again to update the card: the Board shows the latest one. A link to a GitHub pull request also shows whether the pull request is open, merged or closed. A run that never calls it still has a card, titled with the run id. |
| `ctx.args`, `ctx.cwd`, `ctx.runId` | Input, repository and run id (the same on resume). |
| `ctx.settings` | The workflow's own tunable settings (`meta.settings`) as the config resolved them for this run: the code default, or what the global or repo file set under `workflows.<name>.settings`. A copy; read fresh at every run start. |
| `ctx.budget` | `remainingCents()` (`Infinity` without a cents cap), `spentCents()`, `chargedCents()`, `spentTokens()`, `usage()` (tokens by type), `maxCents`, `maxTokens`. Spend is the run's total: a resume starts from what earlier executions spent, failed attempts included. |

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
| `settingSources` | Which config layers the step loads: `"project"` (AGENTS.md, rules, skills, hooks, project MCP), `"team"`, `"mdm"`, `"user"`, `"plugins"`, `"all"` (the global cap `allowedSettingSources` leaves `"all"` out by default). Default when omitted: `["project","team","mdm"]`. Every layer adds fixed context to every call (cost.md). |
| `memo` | Result cache across runs, keyed by prompt, model, schema, tools, context and repository state. Accepted only with read-only `tools`. |
| `revertOnRetry` | Before each retry of a step that can write, puts `cwd` back as it was when the step started (files created are deleted, files changed are restored, the index is unstaged). Default off. Use it only when no other step writes in that directory at the same time (a worktree of the step's own): the undo restores the whole directory. In a directory that is not a git repository the retry runs anyway, with a warning. |
| `sandbox` | Turns on the SDK's local sandbox for shell calls (Linux needs `bubblewrap`). Untested here; leave it off. |

## `exec()`: commands the workflow runs itself

Every command a workflow runs goes through `ctx.exec(command, args?, opts?)`, never through `execFileSync`, `execSync`
or `spawnSync`: a synchronous call freezes the whole process while it runs, so a cancel signal waits behind it, nothing
can time it out, and its output is invisible. `npm test` fails when a workflow file calls one of them.

```ts
const tests = await ctx.exec("bash", ["-c", "npm test"], { label: "tests", cwd: worktree, timeoutMs: 15 * 60_000 });
if (!tests.ok) { /* tests.exitCode, tests.timedOut, tests.tail: the last 32768 characters of stdout and stderr */ }
```

| Option | Meaning |
|---|---|
| `label` | Name of the command in progress and in the event log. Default: the command's name. |
| `phase` | Groups progress, like `agent()`'s. Default: the last `ctx.phase`. |
| `timeoutMs` | The command is killed after this long: SIGTERM to its whole process group, SIGKILL two seconds later. Default: `workflows.<name>.execTimeoutMs` in the config files, 10 minutes when unset. Give a network command (`git push`, `gh`) a short one. |
| `cwd` | Working directory. Default: the run's cwd. |
| `env` | Variables added to the process's own environment. A variable set to `undefined` is removed from the command's (`{ NODE_TEST_CONTEXT: undefined }`). |

- There is **no shell**: `command` and its `args` go to the program as they are. Use `["bash", ["-c", line]]` when you
  need one (`bash -c`, not `bash -lc`: rules.md, rule 3). The command has no stdin and no controlling terminal, so a
  `git push` that would ask for credentials fails at once instead of waiting; a stalled network call is the timeout's job.
- A command that exits non-zero, times out (`timedOut: true`, `exitCode: null`) or cannot start (`error` says why) is a
  **result**, not an exception: the code decides what it means. A cancelled run kills the command and throws, so the
  workflow does not go on.
- The output is streamed into the run's event log as `content` events (stdout and stderr apart), with the same
  redaction, size cut and retention as an agent's content, and each call is a step node of the run, with a step id, a
  parent id and a group id. `tail` is the real output, not redacted: do not paste it into anything that leaves the
  machine without the secrets guard (rules.md, rule 6).
- A resume runs the command again: `exec` is not journaled. Keep the effects idempotent (rules.md, rule 8).

## Definition fields

- `meta`: `name` (stable), `description` (one line), `whenToUse` (triggers the chat agent reads), `phases`,
  `argsSchema` (validated with Ajv before the run; a mismatch fails the run with `invalid args`), `roles`
  (`{ name, cloud, defaults?, envAliases?, description? }[]`: the named kinds of step, such as `classify` or
  `implement.low`; their names are the keys users configure under `workflows.<name>.roles`, so choose them as a public
  contract. `cloud` is `ok`, `read-only` or `never`; `defaults` holds the role's `model`, `timeoutMs`, `retries`,
  `schemaRetries`, `settingSources`), `settings` (`{ name: codeDefault }`: the workflow's own tunable limits, read
  from `ctx.settings`; users tune them under `workflows.<name>.settings`, and a name you did not declare is a config
  error, so choose the names as a public contract).
- `defaults`: `model`, `timeoutMs`, `retries`, `schemaRetries`, `tools`, `sandbox`, applied to every `agent()` call that
  does not override them.
- `budget`: `{ maxTokens?, maxCents? }`, the cap when nothing in the config sets one; an explicit `null` turns a cap off.

## Locations: where a role's steps run

- A step runs `local` (the default) or `cloud`. The user chooses per role in the config (`workflows.<name>.roles.<role>.location`),
  never in workflow code, and only if the global `caps.allowedLocations` lists `cloud` (the default is local only: sending code to a
  cloud VM is the machine owner's decision). A role the caps do not let into the cloud runs locally and the request is a violation.
- You declare what each role can do there with `cloud` in `meta.roles`: `ok` (as it is), `read-only` (only when the step cannot
  write: give it read-only `tools`) or `never` (it needs the local worktree). A config that sends a `never` role to the cloud is
  rejected before the run starts; a `read-only` role whose step can write fails before it spends anything.
- A cloud step is a strict subset of a local one. The engine pushes a throwaway snapshot of the step's worktree (uncommitted
  changes included) to the `cloud.remote` remote (default `origin`) and deletes it when the step ends. The cloud agent gets no custom
  tools, no `tools` allowlist (the prompt tells it the step is read-only) and no setting sources (it warns), and the memo cache is
  skipped. `schema` still works: the agent ends its answer with a fenced `json` block, validated like a `submit_result` call and
  corrected by the same `schemaRetries`; a role whose config sets `resultVia: "artifact"` has it save a `result.json` artifact
  instead, which the engine downloads after the run. Design roles for both places: self-contained prompts, a `schema` the model
  can fill from the repository alone.
- A step that can write runs in the cloud too, on a role declared `ok`. The cloud agent commits on the snapshot branch (it is told
  to, even if your prompt says not to run git commands), and when it finishes the engine fetches the branch and fast-forwards the
  worktree to it, so commands you run afterwards with `ctx.exec` (the tests) see its work. It is a fast-forward or nothing: if the
  agent rewrote the history, the local branch moved, or the working files changed while it ran, the step fails (without a retry, which
  would pay for a new agent) and the worktree is left as it was. An agent that commits nothing changes nothing. Uncommitted changes the worktree had are committed in a snapshot
  commit that stays in the local history.
- Tokens and cost come from the cloud usage API and count against the same caps as a local step's.
- A cloud step outlives the process. The engine writes the cloud agent's id to the event log (`cloud-agent`) the moment the agent
  exists; if the process dies and the run is resumed, the step reattaches to that agent and takes the answer of the run it already
  has instead of paying for another (code that changes the step's prompt or options starts a new step, and the old agent finishes
  unwatched unless the run is cancelled). Cancelling a running run cancels its cloud runs. Cancelling a run whose process already
  died (`wf cancel`, `cancel_workflow`, the dashboard's cancel route) cancels, through the Cursor API, the cloud runs of the agents
  its log shows without an end. The client stops waiting for a cloud run after two hours: the engine asks
  the cloud, and a run still going is waited for again, so only the step's `timeoutMs` bounds a long step.

## Caps

- The run's limits are layered: code defaults (`budget`, `defaults`, role defaults) < the global file
  `~/.cursor-workflows/config.json` < the repo file `.agents/workflows/config.json` < env (`WF_MAX_TOKENS`,
  `WF_MAX_CENTS`) < flags (`--max-tokens`, `--max-cents`) < the `overrides` of `start_workflow`. The global `caps` then
  clamp the result: a lower number or a narrower list wins. The repo file and `overrides` can only tighten them; a
  request that does not is reported as a violation and ignored. `wf config show [workflow]` prints the effective values
  and where each came from.
- The token caps (the run's `maxTokens` and a step's `maxTokensPerStep`, set per role or label in the config) are
  checked on every turn while a step runs: the turn that takes the step (all its attempts together) or the run (resumes
  included) strictly above the cap cancels the SDK run at once, and the attempt fails as `errorKind: "budget"` with no
  retry. A step over its own cap fails alone (an `agent()` error, `null` in `parallel`); the run's cap cancels every
  active step, starts none, and ends the run with `Token cap reached` (even if the workflow code catches the step's
  error and carries on). A step that already used its whole cap gets no further attempt. The overshoot is at most one turn per
  active step. The SDK reports usage only at the end of a turn and a turn can be the agent's whole loop, so keep a short
  `timeoutMs` on steps that write. The cents cap is checked only **before** each step and retry (cost arrives after the
  step).
- `maxCents` is compared with `spentCents()`: per attempt, the larger of the raw cost and the charged cost. The charged
  cost alone is 0 for usage included in the plan, bring-your-own-key and credits.
- A cap is a total for the run. A resume passed a cap (`--max-cents`, `--max-tokens`) sets the new total, so extending a
  run that stopped on its cap takes a cap above what it already spent.
- The cents cap goes **blind** when the cost never arrives: `getUsage()` failing (`403 feature_unavailable` on local
  agents of some plans), a cost still unsettled after the step, or per-request billing (raw cost 0). The engine then
  emits a warning and counts the attempt's tokens from the `turn-ended` events, so the tokens cap keeps working.
  Always set both caps.
- The cents cap, the tokens cap, the plan's usage limit (a non-retryable `RateLimitError`) and an account without SDK
  access (`plan_required`) abort the whole run, also inside `parallel` and `pipeline`.
