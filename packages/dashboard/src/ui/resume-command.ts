// The command that resumes a run, for the "copy resume command" action. Pure.
//
// A resume is a new job over the same run: `wf start <workflow> --args '<json>' --resume <runId>`, run in the repo the run lives in
// (its journal is under that repo's `.workflows/`). The run's log keeps a hash of the args, never the args, so the command cannot
// carry them, with one exception: when the hash is that of empty args (`smoke`, for one) the args are known, `{}`. Otherwise the
// command has a placeholder that is not JSON, and the CLI refuses it before it starts anything. The command does not carry the
// caps (`--max-cents`, `--max-tokens`) the first start had either: the log does not hold the flags.
import { shellQuote } from "./shell.js";

/** Where the args of the first start go. Not valid JSON on purpose: pasted unedited it fails loudly instead of resuming with other args. */
export const ARGS_PLACEHOLDER = "<the args of the first start, as JSON>";

/** What the engine writes as `run-start.argsHash` for args `{}`: the first 16 hex digits of the SHA-256 of `"{}"` (a test runs the engine and pins it). */
export const EMPTY_ARGS_HASH = "44136fa355b3678a";

export interface ResumableRun {
  workflow: string;
  runId: string;
  /** The absolute path of the repo the run executes in. */
  repo: string;
  /** The `argsHash` of the run's latest execution, when its log has one. */
  argsHash?: string;
}


export function resumeCommand({ workflow, runId, repo, argsHash }: ResumableRun): string {
  const args = argsHash === EMPTY_ARGS_HASH ? "{}" : ARGS_PLACEHOLDER;
  return `wf start ${shellQuote(workflow)} --args ${shellQuote(args)} --resume ${shellQuote(runId)} --cwd ${shellQuote(repo)}`;
}

/** The `argsHash` of the latest `run-start` in a run's events: the args a resume has to match are those of the latest execution. Undefined when there is none. */
export function argsHashOf(events: ReadonlyArray<{ type: string; argsHash?: unknown }>): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "run-start") return typeof event.argsHash === "string" ? event.argsHash : undefined;
  }
  return undefined;
}

/** Whether a run in this state can be resumed: it stopped without finishing (failed, or cancelled). A finished run has nothing to continue; a running one is still going. */
export const canResume = (status: string | undefined): boolean => status === "failed" || status === "cancelled";
