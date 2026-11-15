// Resuming a stopped run from outside the process that ran it, for a tool that sits next to the runtime: the dashboard's Resume
// button. It starts a new job over the same run (`wf start --resume`) with what the run's latest job was started with: its args, its
// caps and its overrides, read from that job's record (`JobStart`, job-state.ts), so the browser sends nothing but the run's id. It
// starts through the same path as the Start action (`launchJob`, run-start.ts), so the same checks apply and the repository is the one
// the runs index names for the run. The start itself is `launchResume`, which the decision on an `implement-issue` run's proposed seams
// (a resume with other args: workflows/implement-issue/seams-approval.ts) calls too.
//
// A run whose latest execution was no job (`wf run` in a terminal), or whose job record an older kit wrote without a start, has no
// record of its args (the log keeps only their hash): it is refused, and the terminal's resume command is the way. A frozen run
// (its process stopped beating but still holds the run) shows as `failed`, yet a job over it would find the run already executing:
// it is refused until a cancel has killed that process. A run outside the retention (its journal emptied) cannot be resumed from anywhere,
// and is refused here with the engine's own sentence rather than by the job's process, whose refusal the page would never see.
//
// Like run-cancel.ts and run-start.ts, it imports no engine, so the dashboard process that calls it does not load the Cursor SDK.
import { runningJobOf } from "./job-state.js";
import { prunedReason } from "./run-store.js";
import { type StartRunOutcome, launchJob } from "./run-start.js";
import { type RunDetail, type RunViewStatus, readRun } from "./run-view.js";

/** Why a job over a stopped run is not started, beyond what any start refuses (`StartRunOutcome`). */
export type ResumeRefusal =
  /** The run is `failed` because its process stopped beating, but that process is there and holds the run: cancel it first. */
  | { kind: "frozen" }
  /** No job record says how the run's latest execution was started: the run was started by `wf run` in a terminal, or by an older kit. */
  | { kind: "no-start" };

/** What `launchResume` came to: the same outcomes as a start (`started`, or why not), and the two refusals only a resume has. */
export type LaunchResumeOutcome = ResumeRefusal | StartRunOutcome;

export type ResumeRunOutcome =
  /** The runs index has no such run. */
  | { kind: "unknown-run" }
  /** The run is not stopped (it is `running`, or `finished`, or its log cannot be read): there is nothing to resume. Only `failed` and `cancelled` runs resume. */
  | { kind: "not-resumable"; status: RunViewStatus }
  | LaunchResumeOutcome;

/**
 * Starts a job over `run`, which the caller has found stopped and fit to resume: refuses a frozen run, a run outside the retention and a
 * run with no job start, then starts with the caps and overrides of its latest start and with its args, or with `changeArgs` of them
 * (how a decision on a proposal, which is a resume with other args, changes what the run is given).
 */
export async function launchResume(run: RunDetail, changeArgs: (recorded: unknown) => unknown = (recorded) => recorded): Promise<LaunchResumeOutcome> {
  if (runningJobOf(run.repo, run.runId)) return { kind: "frozen" };
  // The engine refuses a run whose journal retention emptied, but inside the job's process, after the answer: say so now.
  const pruned = prunedReason(run.repo, run.runId);
  if (pruned !== undefined) return { kind: "refused", error: pruned };
  if (!run.start) return { kind: "no-start" };
  const { args, maxTokens, maxCents, overrides } = run.start;
  return launchJob(run.repo, run.workflow, { args: changeArgs(args ?? {}), maxTokens, maxCents, overrides, resumeRunId: run.runId });
}

/** Resumes run `runId` as a job, or says why not (see `ResumeRunOutcome`). Never creates a directory in the run's repo before every check has passed. */
export async function resumeRun(runId: string): Promise<ResumeRunOutcome> {
  const run = readRun(runId);
  if (!run) return { kind: "unknown-run" };
  if (run.status !== "failed" && run.status !== "cancelled") return { kind: "not-resumable", status: run.status };
  return launchResume(run);
}
