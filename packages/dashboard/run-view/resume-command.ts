// The command that resumes a run, for the "copy resume command" action. Pure.
//
// A resume is a new job over the same run: `wf start <workflow> --args '<json>' --resume <runId>`, run in the repo the run lives in
// (its journal is under that repo's `.workflows/`). The job record of the run's latest execution keeps how that job was started
// (`start`: the args and the limit flags), so the command repeats them exactly. A run with no such record (a `wf run` in a
// terminal, or a record an older kit wrote) falls back on the log, which keeps only a hash of the args: when the hash is that of
// empty args (`smoke`, for one) the args are known, `{}`; otherwise the command has a placeholder that is not JSON, and the CLI
// refuses it before it starts anything.
import { readable } from "./run-graph.js";
import { shellQuote } from "./shell.js";

/** Where the args of the first start go. Not valid JSON on purpose: pasted unedited it fails loudly instead of resuming with other args. */
export const ARGS_PLACEHOLDER = "<the args of the first start, as JSON>";

/** What the engine writes as `run-start.argsHash` for args `{}`: the first 16 hex digits of the SHA-256 of `"{}"` (a test runs the engine and pins it). */
export const EMPTY_ARGS_HASH = "44136fa355b3678a";

/** How a job was started, as the API serves it (the runtime's `JobStart`; the browser code does not import the runtime). */
export interface JobStart {
  args: unknown;
  maxCents?: number;
  maxTokens?: number;
  overrides?: Record<string, unknown>;
}

export interface ResumableRun {
  workflow: string;
  runId: string;
  /** The absolute path of the repo the run executes in. */
  repo: string;
  /** The `argsHash` of the run's latest execution, when its log has one. */
  argsHash?: string;
  /** How the latest execution's job was started, when its record says. */
  start?: JobStart;
}

export function resumeCommand({ workflow, runId, repo, argsHash, start }: ResumableRun): string {
  const args = start ? JSON.stringify(start.args ?? {}) : argsHash === EMPTY_ARGS_HASH ? "{}" : ARGS_PLACEHOLDER;
  const flags = [
    ...(start?.maxCents === undefined ? [] : ["--max-cents", String(start.maxCents)]),
    ...(start?.maxTokens === undefined ? [] : ["--max-tokens", String(start.maxTokens)]),
    ...(start?.overrides && Object.keys(start.overrides).length ? ["--overrides", shellQuote(JSON.stringify(start.overrides))] : []),
  ];
  return [`wf start ${shellQuote(workflow)} --args ${shellQuote(args)} --resume ${shellQuote(runId)} --cwd ${shellQuote(repo)}`, ...flags].join(" ");
}

/** The `argsHash` of the latest `run-start` in a run's events: the args a resume has to match are those of the latest execution. Undefined when there is none. */
export function argsHashOf(events: ReadonlyArray<{ type: string; v?: unknown; argsHash?: unknown }>): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "run-start") return readable(event) && typeof event.argsHash === "string" ? event.argsHash : undefined; // a newer version's hash may be another hash
  }
  return undefined;
}

/** Whether a run in this state can be resumed: it stopped without finishing (failed, or cancelled). A finished run has nothing to continue; a running one is still going. */
export const canResume = (status: string | undefined): boolean => status === "failed" || status === "cancelled";
