---
name: run-workflow
description: "Use before calling start_workflow or wf start: starts a deterministic workflow and follows the job to its result (/run-workflow <name> <args>)."
---

# Run a workflow

The workflow already defines the steps, each step's model, the reviews and the stop criteria in code. Your role is to
**start, follow and relay**: whatever the job returns (progress, result, failure, approval request) reaches the user
as it came, and fixing or approving is their decision. While the job runs, the files belong to the workflow and your
only calls are the waits in step 3.

The runtime's messages are in English, the same from the MCP server and from the CLI. This skill quotes the ones it
matches, in code spans; match them verbatim.

## Steps

1. Build `name` and `args` from the request. Example: `/run-workflow implement-issue 123` →
   `name: "implement-issue"`, `args: { "issue": 123 }`. The step ends with every `required` arg in hand.
   - If the exact name or the args format is unclear, call `list_workflows` (MCP server `workflows`) and follow the
     returned `argsSchema`. If a `required` arg is missing, ask the user.
   - A `resumeRunId` in the request is a parameter of `start_workflow`, next to `args`. Inside `args` it does not
     resume: `implement-issue` (`additionalProperties: false`) fails with `invalid args`, and a workflow without
     that guard starts from scratch, without the journal.
2. Call `start_workflow` with `{ name, args }` (and `resumeRunId`, if any). The step ends with the `jobId` in hand; a
   return with `error` (one that starts with `unknown workflow: `, an invalid config with its file and field path, or a
   kit outside the version range the repo declares) goes back to step 1, or to the user for the config and the kit
   version: tell them to run `wf doctor`.
   - A return with `dashboardUrl` is this run's live page on the dashboard, which also shows every other run of every
     repo (Board and Runs, one link away). Open it in Cursor's built-in browser, in one tab per conversation (a later
     start points that tab at its own link), and tell the user the link. A page that fails to load just
     after the dashboard started loads on a reload a second later (WSL2 needs that long to forward a new port to
     Windows). Where there is no built-in browser (Claude Code, Codex), give the user the link and let them open it.
     A `dashboardWarning` is the reason the dashboard could not start: relay it once and carry on, since the run does
     not depend on it. A return with neither means the user turned auto-start off: go on to step 3.
   - When the user asks for a tighter budget for this run, pass `overrides` (`maxTokens`, `maxCents`,
     `maxTokensPerStep`, `concurrency`). They only tighten: a looser value comes back in `violations` and has no
     effect, so tell the user. Any other key fails the start with an error that starts with `unknown override: `.
3. Chain `wait_workflow` calls with `{ jobId, timeoutSec: 45 }`, one right after the other, until `status` is no
   longer `running`. A return with `error` and no `status` (`job not found`) also ends the wait: relay the error
   and the `jobId` to the user.
   - On each return, show the user the current `phase` and the new lines of `recent`, in one or two lines.
   - Note the cost warnings (`getUsage() failed`, attempt cost not yet reported) for step 4: `recent` keeps only the
     20 most recent events.
   - If the harness asks for approval on every wait, tell the user they can allow `wait_workflow` and
     `get_workflow_status`: in Cursor, in the Run Mode allowlist; in Claude Code, in `permissions.allow`, as
     `mcp__workflows__wait_workflow` and `mcp__workflows__get_workflow_status`.
4. When `status` is `finished`, present the cost and the `result` according to `result.status`. Cost: `spentCents`
   (what the cents cap counts) and `chargedCents` (only what was charged; 0 for usage included in the plan). With a
   cost warning noted, `spentCents` did not count every attempt; `spentCents: 0` with `getUsage() failed` is an
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
   - `invalid args`: fix the args from the `argsSchema` (step 1) and start a new run, without `resumeRunId`.
   - `The account's plan does not give access` or `Cursor usage limit reached`: a resume would fail the same way; the
     step ends with the relay.
   - `Cost cap reached` or `Token cap reached`: the cap is a total for the run, and a resume starts from
     what the run already spent. The same cap stops it at the same step. The token cap also cancels the steps that are
     running when it is crossed (their `step-end` carries `errorKind: "budget"`). Tell the user that continuing takes a
     higher total cap: `--resume <runId> --max-cents <new total>` on the CLI, or a higher `WF_MAX_CENTS` /
     `WF_MAX_TOKENS` in the `env` of the `workflows` server in `mcp.json`. The user decides.
   - `Step token cap reached`: one step went over its own `maxTokensPerStep` and was cancelled, with no retry. A resume
     runs it again under the same cap. Tell the user the cap is in the config files (`.agents/workflows/config.json`,
     or the global `~/.cursor-workflows/config.json`); only the user raises it, and a global cap may forbid it.
   - `already running`: another process is still executing that run, so a second execution is refused. Do not
     resume again; follow the job that is already running (`wait_workflow` or `get_workflow_status` with its
     `jobId`), and tell the user if you do not have it.
   - Anything else (a step that failed, a process that died or stopped answering: `ended without finishing the job`,
     `no heartbeat`): offer to relaunch **resuming**: `start_workflow` with the same `name` and `args` and
     `resumeRunId` equal to the job's `runId`. Completed steps are not repeated.
     With `no heartbeat` the process may still be alive and holding the run; if the resume then returns
     `already running`, ask the user whether to cancel the job (`cancel_workflow` kills a frozen process with
     SIGKILL), then resume. Say first that this cancel also cancels the cloud agents the run left running, so the
     resume starts a new cloud agent for each of those steps and pays for it again (see "Cancelling").
     A run with cloud steps may have left cloud agents running when its process died or froze, and they keep spending
     until cancelled. If the user wants the run stopped rather than resumed, call `cancel_workflow` on the failed job:
     it cancels those agents, after killing the process if it froze (see "Cancelling"). The job stays `failed` and the
     run stays resumable; tell the user what a later resume then costs (see "Cancelling").
   On a relaunch, go back to step 3 with the new `jobId`.
6. When `status` is `cancelled`, the run was stopped on purpose. Relay that with the `runId`, and offer to resume it
   as in step 5 if the user wants to continue; the steps it finished are not repeated.

## Cancelling

Cancel when the user asks to stop the run, and at that request only: whether a run is going badly is the user's
judgement. Call `cancel_workflow` with `{ jobId }`. It stops the active agent runs, reverts the step that was writing
to the state it had before the step, and returns the job with `status: "cancelled"` (step 6). A stuck or already
ended job is handled as the notes below say, and stays `failed`.

- A `note` that starts with `the job already ended`: the job's process was gone, so no step was stopped or reverted.
  The runtime still cancels any cloud agents the run left running. Relay the note as it came: it ends with
  `nothing to cancel`, or names the agents after `cancelled the cloud agent it left running:` (`agents` when there are
  several), or names one it `could not reach` and says to resume the run and cancel it.
- A `note` that says the process is not the job's (`is not the job's process (was the pid reused?)`): the job's
  process ended and another process got its pid. No signal was sent, and no step was stopped or reverted. As for a job
  that already ended, the runtime cancels the cloud agents the run left running, and the note ends the same three ways:
  `nothing to cancel`, the agents after `cancelled the cloud agent it left running:`, or one it `could not reach`.
  Relay the note as it came. The job can still show `running` until its heartbeat goes stale (30 s by default); chain
  `wait_workflow` (step 3) and it ends `failed`.
- A `note` that starts with `process <pid> had no heartbeat and was killed (SIGKILL)`: the process was frozen, so it
  was killed without undoing the step in progress, and the run stays resumable. The job stays `failed`. Once the
  process is gone, the runtime cancels the cloud agents the run left running, as for a job that already ended: the note
  goes on to name them after `cancelled the cloud agent it left running:`, or names one it `could not reach`. Relay it.
  In the rare case the process `has not exited yet`, the note says those agents were not cancelled: call
  `cancel_workflow` on the same `jobId` once more after a few seconds.
- A `note` that starts with `could not signal process`: relay it. Nothing was cancelled.
- `status` still `running` after the call: the process is stopping; chain `wait_workflow` (step 3) until it ends.
- A resume after any cancel whose note names cloud agents after `cancelled the cloud agent it left running:`, whichever
  note above it is, does not reattach to them. It starts a new cloud agent for each of those steps, at new cost, and
  the work of the cancelled agents is lost; the log warns
  `cloud agent <id>, left by an interrupted attempt, was cancelled: starting a new one`. Tell the user before
  resuming. Only when no cancel named an agent does the resume reattach to it, and use its answer if its run already
  finished.

## Without the MCP server

If the `workflows` tools are not available, use the CLI from the terminal. The `argsSchema` from step 1 lives in the
`meta` of the workflow file (a file in the kit's built-in `workflows/` folder or in the repository's
`.agents/workflows/`): `wf list` returns only the name and description. The CLI writes the same job state and the
same messages, so steps 3 to 6 apply equally, with `--resume <runId>` in place of `resumeRunId` (relaunch with
`start`, also when `next` shows `run`). An unknown name fails with an error that starts with `unknown workflow: `
(the CLI adds ``. Use `wf list`.``; back to step 1), and an unknown job returns an error that starts with
`job not found` (step 3). Caps set in the `env` of the `workflows` server in `mcp.json` do not reach the shell, but
the config files (global caps, repo config) do: pass `--max-cents` and `--max-tokens` to tighten this run further.

```bash
wf start <name> --args '<json>' --max-cents <N> --max-tokens <N> [--resume <runId>]   # returns {jobId, runId, log}
wf wait <jobId> --timeout 240   # repeat until status != running
wf cancel <jobId>               # only when the user asks to stop; a running job ends cancelled, a stuck or ended one stays failed
```

In Claude Code, run the `wait` with `timeout: 250000` on the Bash tool: its default (120000 ms) cuts the 240 s wait.

`wf` is the command the kit's installer puts on the PATH. Add `--cwd` with the repository root (where the MCP server
keeps the jobs) when the shell is not in it. If `wf` is not found, ask the user to follow the `cursor-workflows-setup`
skill. Inside the kit's own checkout, `npm run wf --` is the same command.
