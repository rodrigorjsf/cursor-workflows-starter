// The read side of the runs: what a tool outside the run's process (the dashboard) shows about a run, projected from the
// run's event log. Nothing here writes: it never creates a directory in a repo, takes a lock or touches a log.
//
// Runs are found through the global runs index (`~/.cursor-workflows/runs.jsonl`), which names each run's repo; the run's
// own state lives in `<repo>/.workflows/runs/<runId>/`. The status is the projection of the run's latest execution, with one
// addition the log cannot make: an execution that never wrote its `run-end` is `running` only while a process holds the
// run's lock. Without one the process died, and the run shows as `failed` with how to resume it, the same as a job does.
import { join } from "node:path";
import type { RunStatus } from "./events.js";
import { projectLatestExecution, resumeHint, withRatio } from "./projection.js";
import { EVENTS_FILE, isRunExecuting, readEventLog, runDirIn } from "./run-store.js";
import { type RunsIndexEntry, readRunsIndex } from "./runs-index.js";
import type { UsageTotals } from "./workflow.js";

/** How a run stands: the status of its latest execution, or `missing` when its log cannot be read or projected (the repo or the run's directory is gone, or the log is damaged). */
export type RunViewStatus = "running" | RunStatus | "missing";

export interface RunSummary {
  runId: string;
  /** Absolute path of the repo the run executes in. */
  repo: string;
  workflow: string;
  status: RunViewStatus;
  /** When the run first started (a resume does not change it), ISO 8601 UTC. */
  startedAt: string;
  /** When the latest execution ended. Absent while it runs. */
  finishedAt?: string;
  /** The phase the latest execution was last in. */
  phase?: string;
  /** Why the run failed or was cancelled; for `missing`, why the log could not be read. */
  error?: string;
  /** How many executions the run has had: 1 plus its resumes. */
  executions: number;
  /** The cost the cap uses, summed over every execution of the run. */
  spentCents: number;
  /** Only what was charged (0 for usage included in the plan). */
  chargedCents: number;
  spentTokens: number;
}

export interface RunDetail extends RunSummary {
  /** The last progress lines of the latest execution. Never prompt or agent output text. */
  recent: string[];
  /** What the workflow returned, once the latest execution finished. */
  result?: unknown;
  usage: UsageTotals & { cacheHitRatio: number | null };
}

const NO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };

function detailOf(entry: RunsIndexEntry): RunDetail {
  const base = { runId: entry.runId, repo: entry.repo, workflow: entry.workflow, startedAt: entry.startedAt };
  const missing = (error: string): RunDetail => ({
    ...base,
    status: "missing",
    error,
    executions: 0,
    spentCents: 0,
    chargedCents: 0,
    spentTokens: 0,
    recent: [],
    usage: withRatio(NO_USAGE),
  });
  const log = join(runDirIn(entry.repo, entry.runId), EVENTS_FILE);
  // A log this code cannot read or project (damage, or events a newer or older kit wrote) is that run's problem: it shows as
  // `missing` with the reason, and never fails the listing of the other runs.
  let events;
  let execution;
  try {
    events = readEventLog(log, { content: false }).events;
    execution = projectLatestExecution(events);
  } catch (err) {
    return missing(`could not read ${log}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!execution) return missing(`no run-start in ${log}`);

  let { status, error } = execution;
  if (status === "running" && !isRunExecuting(entry.repo, entry.runId)) {
    status = "failed";
    error = `the process executing the run ended without finishing it; ${resumeHint(entry.runId)}`;
  }
  const { ledger } = execution;
  return {
    ...base,
    workflow: execution.workflow,
    status,
    finishedAt: execution.finishedAt,
    phase: execution.phase,
    error,
    executions: events.filter((e) => e.type === "run-start").length,
    spentCents: ledger.spentCents,
    chargedCents: ledger.chargedCents,
    spentTokens: ledger.spentTokens,
    recent: execution.recent,
    result: execution.result,
    usage: withRatio(ledger.usage),
  };
}

/** One entry per run, the first line of the index winning (it carries the run's first start). Newest first. */
function indexedRuns(): RunsIndexEntry[] {
  const byId = new Map<string, RunsIndexEntry>();
  for (const entry of readRunsIndex()) if (!byId.has(entry.runId)) byId.set(entry.runId, entry);
  return [...byId.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

/** The runs of every repo, newest first, at most `limit` of them (the logs of older runs are not read). */
export function listRuns(limit = 200): RunSummary[] {
  return indexedRuns()
    .slice(0, limit)
    .map((entry) => {
      const { recent: _recent, result: _result, usage: _usage, ...summary } = detailOf(entry);
      return summary;
    });
}

/** One run with its progress lines, result and token usage. Undefined when the runs index has no such run. */
export function readRun(runId: string): RunDetail | undefined {
  const entry = indexedRuns().find((e) => e.runId === runId);
  return entry && detailOf(entry);
}

/** Where the event log of an indexed run is, whether or not the file exists. Undefined when the runs index has no such run. The run id is only compared with the index, never used as a path. */
export function eventLogOf(runId: string): string | undefined {
  const entry = indexedRuns().find((e) => e.runId === runId);
  return entry && join(runDirIn(entry.repo, entry.runId), EVENTS_FILE);
}
