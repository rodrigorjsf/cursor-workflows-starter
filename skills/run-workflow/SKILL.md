---
name: run-workflow
description: "Use before calling start_workflow or wf start: starts a deterministic workflow and follows the job to its result (/run-workflow <name> <args>)."
---

# Run a workflow

The workflow already defines the steps, each step's model, the reviews and the stop criteria in code. Your role is to
**start, follow and relay**: whatever the job returns (progress, result, failure, approval request) reaches the user
as it came, and fixing or approving is their decision. While the job runs, the files belong to the workflow and your
only calls are the waits in step 3.

The runtime's messages are in Portuguese. This skill quotes the ones it matches, in code spans; match them verbatim.

## Steps

1. Build `name` and `args` from the request. Example: `/run-workflow implement-issue 123` →
   `name: "implement-issue"`, `args: { "issue": 123 }`. The step ends with every `required` arg in hand.
   - If the exact name or the args format is unclear, call `list_workflows` (MCP server `workflows`) and follow the
     returned `argsSchema`. If a `required` arg is missing, ask the user.
   - A `resumeRunId` in the request is a parameter of `start_workflow`, next to `args`. Inside `args` it does not
     resume: `implement-issue` (`additionalProperties: false`) fails with `args inválidos`, and a workflow without
     that guard starts from scratch, without the journal.
2. Call `start_workflow` with `{ name, args }` (and `resumeRunId`, if any). The step ends with the `jobId` in hand; a
   return with `error` (`workflow desconhecido`, or an invalid config with its file and field path) goes back to
   step 1, or to the user for the config.
   - When the user asks for a tighter budget for this run, pass `overrides` (`maxTokens`, `maxCents`,
     `maxTokensPerStep`, `concurrency`). They only tighten: a looser value comes back in `violations` and has no
     effect, so tell the user.
3. Chain `wait_workflow` calls with `{ jobId, timeoutSec: 45 }`, one right after the other, until `status` is no
   longer `running`. A return with `error` and no `status` (`job não encontrado`) also ends the wait: relay the error
   and the `jobId` to the user.
   - On each return, show the user the current `phase` and the new lines of `recent`, in one or two lines.
   - Note the cost warnings (`getUsage() falhou`, attempt cost not yet reported) for step 4: `recent` keeps only the
     20 most recent events.
   - If the harness asks for approval on every wait, tell the user they can allow `wait_workflow` and
     `get_workflow_status`: in Cursor, in the Run Mode allowlist; in Claude Code, in `permissions.allow`, as
     `mcp__workflows__wait_workflow` and `mcp__workflows__get_workflow_status`.
4. When `status` is `finished`, present the cost and the `result` according to `result.status`. Cost: `spentCents`
   (what the cents cap counts) and `chargedCents` (only what was charged; 0 for usage included in the plan). With a
   cost warning noted, `spentCents` did not count every attempt; `spentCents: 0` with `getUsage() falhou` is an
   **unknown** cost, not zero: say so and report `spentTokens` instead.
   - `done`: what was done, what was left out (in `implement-issue`, `deferred`: postponed slices; the PR then only
     references the issue) and the branch or PR.
   - A result with `next` (a checkpoint, such as `implement-issue`'s `seams-proposed` on MED/HIGH issues): the
     workflow stopped waiting for a user decision. Show what the result brings for them to decide (in
     `implement-issue`, `seams` and `slices`) and ask. With their approval, call `start_workflow` with the same
     `name`, the `args` plus the approval args from the JSON after `--args` in the `next` command (in
     `implement-issue`, `approveSeams: true`, or `seams: [...]` with the ones they ask for) and `resumeRunId` equal
     to `result.runId`; then go back to step 3 with the new `jobId`.
   - `secret-blocked`: relay the `reason` (the rule that fired, without the secret) and leave the inspection of the
     `worktree` (when present: the block at the seams comment brings none) to the user, so the secret stays out of
     the chat.
   - Anything else: the workflow ended **without delivering**. Relay the status and whatever the result brings
     (`output`, `findings`, `worktree`).
5. When `status` is `failed`, relay the `error` and follow its beginning:
   - `args inválidos`: fix the args from the `argsSchema` (step 1) and start a new run, without `resumeRunId`.
   - `O plano da conta não dá acesso` or `Limite de uso do Cursor atingido`: a resume would fail the same way; the
     step ends with the relay.
   - `Teto de custo atingido` or `Teto de tokens atingido`: the cap is a total for the run, and a resume starts from
     what the run already spent. The same cap stops it at the same step. Tell the user that continuing takes a higher
     total cap: `--resume <runId> --max-cents <new total>` on the CLI, or a higher `WF_MAX_CENTS` / `WF_MAX_TOKENS` in the
     `env` of the `workflows` server in `mcp.json`. The user decides.
   - `já está em execução`: another process is still executing that run, so a second execution is refused. Do not
     resume again; follow the job that is already running (`wait_workflow` or `get_workflow_status` with its
     `jobId`), and tell the user if you do not have it.
   - Anything else (a step that failed, a process that died or stopped answering: `terminou sem concluir o job`,
     `sem sinal de vida`): offer to relaunch **resuming**: `start_workflow` with the same `name` and `args` and
     `resumeRunId` equal to the job's `runId`. Completed steps are not repeated.
     With `sem sinal de vida` the process may still be alive and holding the run; if the resume then returns
     `já está em execução`, ask the user whether to cancel the job (`cancel_workflow` ends a frozen process), then resume.
   On a relaunch, go back to step 3 with the new `jobId`.
6. When `status` is `cancelled`, the run was stopped on purpose. Relay that with the `runId`, and offer to resume it
   as in step 5 if the user wants to continue; the steps it finished are not repeated.

## Cancelling

Cancel when the user asks to stop the run, and at that request only: whether a run is going badly is the user's
judgement. Call `cancel_workflow` with `{ jobId }`. It stops the active agent runs, reverts the step that was writing
to the state it had before the step, and returns the job with `status: "cancelled"` (step 6).

- A `note` that the job already ended, or that the process is not the job's: relay it. Nothing was cancelled.
- `status` still `running` after the call: the process is stopping; chain `wait_workflow` (step 3) until it ends.

## Without the MCP server

If the `workflows` tools are not available, use the CLI from the terminal. The `argsSchema` from step 1 lives in the
`meta` of the workflow file (a file in the kit's built-in `workflows/` folder or in the repository's
`.agents/workflows/`): `wf list` returns only the name and description. The CLI writes the same job state, so steps 3 to 5 apply equally,
with `--resume <runId>` in place of `resumeRunId` (relaunch with `start`, also when `next` shows `run`). The MCP caps
live in the `env` of the `workflows` server in `mcp.json` and do not reach the shell: pass the values of
`WF_MAX_CENTS` and `WF_MAX_TOKENS` as `--max-cents` and `--max-tokens`.

```bash
npm run wf -- start <name> --args '<json>' --max-cents <N> --max-tokens <N> [--resume <runId>]   # returns {jobId, runId, log}
npm run wf -- wait <jobId> --timeout 240   # repeat until status != running
npm run wf -- cancel <jobId>               # only when the user asks to stop; returns the job with status cancelled
```

In Claude Code, run the `wait` with `timeout: 250000` on the Bash tool: its default (120000 ms) cuts the 240 s wait.

In a repository that uses a kit installed elsewhere, there is no `wf` script: replace `npm run wf --` with
`<kit>/node_modules/.bin/tsx <kit>/packages/runtime/src/cli.ts` and add `--cwd` with the repository root (where the
MCP server keeps the jobs). `<kit>` comes from the `command` of the `workflows` server in `.cursor/mcp.json` or
`.mcp.json`, with `${userHome}` replaced by `$HOME`.
