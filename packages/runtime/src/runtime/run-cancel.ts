// Cancelling a run from outside the process that executes it: the dashboard's Cancel button. It finds the job that executes
// the run and hands it to `cancelJob`, the function `wf cancel` and `cancel_workflow` call: the same SIGTERM, the same wait
// for the run to end, the same notes. A run no job executes (`wf run` in a terminal) is not cancelled from here: there is no
// record of its process to signal, and the terminal owns it.
import { type CancelResult, cancelJob, runningJobOf } from "./job-state.js";
import { type RunViewStatus, readRun } from "./run-view.js";

export type CancelRunOutcome =
  /** The runs index has no such run. */
  | { kind: "unknown-run" }
  /** The run is not executing (it ended, or its process died, or its log cannot be read): nothing to cancel. */
  | { kind: "not-running"; status: RunViewStatus }
  /** A process executes the run, but not as a job: `wf run` in a terminal. */
  | { kind: "no-job" }
  /** The job was asked to cancel and waited for. `result.status` says where it stands: `cancelled`, or still `running` when it takes longer than the wait. */
  | { kind: "cancelled"; result: CancelResult };

/** Cancels run `runId`, waiting up to `timeoutMs` for it to stop. Never creates a directory in the run's repo. */
export async function cancelRun(runId: string, timeoutMs: number): Promise<CancelRunOutcome> {
  const run = readRun(runId);
  if (!run) return { kind: "unknown-run" };
  if (run.status !== "running") return { kind: "not-running", status: run.status };
  const job = runningJobOf(run.repo, runId);
  const result = job && (await cancelJob(run.repo, job.jobId, timeoutMs));
  return result ? { kind: "cancelled", result } : { kind: "no-job" };
}
