// The command that resumes a run, for the "copy resume command" action. Pure.
//
// A resume is a new job over the same run: `wf start <workflow> --args '<json>' --resume <runId>`, run in the repo the run lives in
// (its journal is under that repo's `.workflows/`). The run's log keeps a hash of the args, never the args, so the command cannot
// carry them: it has a placeholder that is not JSON, and the CLI refuses it before it starts anything.
import { shellQuote } from "./shell.js";

/** Where the args of the first start go. Not valid JSON on purpose: pasted unedited it fails loudly instead of resuming with other args. */
export const ARGS_PLACEHOLDER = "<the args of the first start, as JSON>";

export interface ResumableRun {
  workflow: string;
  runId: string;
  /** The absolute path of the repo the run executes in. */
  repo: string;
}

export function resumeCommand({ workflow, runId, repo }: ResumableRun): string {
  return `wf start ${shellQuote(workflow)} --args ${shellQuote(ARGS_PLACEHOLDER)} --resume ${shellQuote(runId)} --cwd ${shellQuote(repo)}`;
}

/** Whether a run in this state can be resumed: it stopped without finishing (failed, or cancelled). A finished run has nothing to continue; a running one is still going. */
export const canResume = (status: string | undefined): boolean => status === "failed" || status === "cancelled";
