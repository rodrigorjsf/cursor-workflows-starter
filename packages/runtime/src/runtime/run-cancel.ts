// Cancelling a run from outside the process that executes it: the dashboard's Cancel button. It finds the job that executes
// the run and hands it to `cancelJob`, the function `wf cancel` and `cancel_workflow` call: the same SIGTERM, the same wait
// for the run to end, the same notes. A run no job executes (`wf run` in a terminal) is not cancelled from here: there is no
// record of its process to signal, and the terminal owns it. A run whose process died has nothing to signal, but the cloud
// agents it left running are cancelled through the Cursor API (`cancelLeftCloudAgents`). A frozen run (its job's process is
// there but stopped beating) shows as `failed`, yet its process still holds it: `cancelJob` kills that process (SIGKILL) and
// then cancels the cloud agents the run left, as `wf cancel` does.
import { cancelLeftCloudAgents } from "./cloud-cancel.js";
import { type CancelResult, cancelJob, runningJobOf } from "./job-state.js";
import { type RunViewStatus, readRun } from "./run-view.js";

export type CancelRunOutcome =
  /** The runs index has no such run. */
  | { kind: "unknown-run" }
  /** The run is not executing (it ended, or its process died, or its log cannot be read): no process to signal. `cancelledAgents` are the cloud agents a dead process left running, whose runs were cancelled; `cloudErrors` the ones that could not be reached. */
  | { kind: "not-running"; status: RunViewStatus; cancelledAgents: string[]; cloudErrors?: Array<{ agentId: string; error: string }> }
  /** A process executes the run, but not as a job: `wf run` in a terminal. */
  | { kind: "no-job" }
  /** The job was asked to cancel (SIGTERM), or killed when frozen (SIGKILL), and waited for. `result.status` says where it stands: `cancelled`, still `running` when it takes longer than the wait, or `failed` for a frozen job that was killed. */
  | { kind: "signalled"; result: CancelResult };

/** Cancels run `runId`, waiting up to `timeoutMs` for it to stop. Never creates a directory in the run's repo. */
export async function cancelRun(runId: string, timeoutMs: number): Promise<CancelRunOutcome> {
  const run = readRun(runId);
  if (!run) return { kind: "unknown-run" };
  // A `failed` run may still have a process: a frozen one, which holds the run until it is killed.
  const job = run.status === "running" || run.status === "failed" ? runningJobOf(run.repo, runId) : undefined;
  const result = job && (await cancelJob(run.repo, job.jobId, timeoutMs));
  if (result) return { kind: "signalled", result };
  if (run.status === "running") return { kind: "no-job" };
  const left = await cancelLeftCloudAgents(run.repo, runId);
  return { kind: "not-running", status: run.status, cancelledAgents: left.cancelled, ...(left.failed.length > 0 && { cloudErrors: left.failed }) };
}
