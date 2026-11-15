// What the dashboard's Resume action says to the browser, apart from the HTTP plumbing (server.ts): the runtime's answer to a resume
// (`resumeRun`, observe) turned into a status and a sentence. Pure: no clock, no network, no disk.
//
// The request carries nothing: the run's id is in the address, and what to start is what the run's latest job was started with, which the
// runtime reads from that job's record. Every refusal is a 404 for a run the index does not know and a 409 for the rest: the run exists,
// but is not in a state, or has not got what it takes, to be resumed from here.
import type { ResumeRunOutcome, StartRunOutcome } from "@cursor-workflows/runtime/observe";

type Started = Extract<StartRunOutcome, { kind: "started" }>;

/** What `POST /api/runs/<runId>/resume` answers (202) when the job started. `violations` are what the global caps cut, and is left out when nothing was cut. */
export interface ResumedReply {
  jobId: string;
  runId: string;
  violations?: Started["violations"];
}

/** The status and the body the runtime's answer to a resume becomes. A resume that worked is 202: the job runs on its own, and the run shows `running` a moment later. */
export function resumeReply(outcome: ResumeRunOutcome): { status: number; body: ResumedReply | { error: string } } {
  switch (outcome.kind) {
    case "started":
      return { status: 202, body: { jobId: outcome.jobId, runId: outcome.runId, ...(outcome.violations.length > 0 ? { violations: outcome.violations } : {}) } };
    case "unknown-run":
      return { status: 404, body: { error: "run not found" } };
    case "not-resumable":
      return { status: 409, body: { error: `the run is ${outcome.status}; only a failed or cancelled run can be resumed` } };
    case "frozen":
      return { status: 409, body: { error: "the run's process stopped beating but still holds the run; cancel the run first, then resume it" } };
    case "no-start":
      return { status: 409, body: { error: "the run was not started as a job (wf run in a terminal, or by an older kit), so the dashboard does not know the args to resume it with; resume it from the terminal with the copied resume command" } };
    case "unknown-repo":
      return { status: 409, body: { error: "the run's repository is no longer on this machine" } };
    case "unknown-workflow":
      return { status: 409, body: { error: `the run's repository no longer lists its workflow; it lists: ${outcome.available.join(", ") || "no workflows"}` } };
    case "invalid-args":
    case "refused":
      return { status: 409, body: { error: outcome.error } };
  }
}
