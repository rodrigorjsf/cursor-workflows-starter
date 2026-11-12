// The read side of the runs: what a tool outside the run's process (the dashboard) shows about a run, projected from the
// run's event log. Nothing here writes: it never creates a directory in a repo, takes a lock or touches a log.
//
// Runs are found through the global runs index (`~/.cursor-workflows/runs.jsonl`), which names each run's repo; the run's
// own state lives in `<repo>/.workflows/runs/<runId>/`. The status is the projection of the run's latest execution, with what
// the log cannot say, the rule `wf status` applies to a job: an execution that never wrote its `run-end` is `running` only
// while a process holds the run's lock and, for a run started as a job, while that job is not frozen (its own process holds
// the lock with a stale heartbeat). Without a process the process died; a frozen job still holds the lock. Either way the
// run shows as `failed` with how to resume it, the same as its job does. A lock held by another process than the job's is a
// new execution that has not written its run-start yet (a resume): the run is `running`.
import { statSync } from "node:fs";
import { join } from "node:path";
import type { RunStatus } from "./events.js";
import { type JobStart, readJobStart, silentJobError } from "./job-state.js";
import type { OutcomeClass } from "./outcome.js";
import { type ExecutionState, type RunCard, boundedPhase, latestCard, projectLatestExecution, resumeHint, runPhases, withRatio } from "./projection.js";
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
  /** The phases of the run, in order: the ones its workflow declared, then any other it entered. The Board's columns. */
  phases: string[];
  /** How the latest execution's ending is classed: `delivered`, `failed` (the workflow said it did not deliver), `error`, `cancelled`, `pending` (waiting for someone to approve) or `unknown` (the result names no status). Absent while it runs, and for `missing`. */
  outcome?: OutcomeClass;
  /** What the workflow chose to show on the run's card (`ctx.card`): the latest one. Absent when it never set one. */
  card?: RunCard;
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
  /** How the latest execution's job was started (args and limit flags), from its record in the run's repo: what an exact resume repeats. Absent for a `wf run` in a terminal (no job), and for a record an older kit wrote. */
  start?: JobStart;
}

const NO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };

/** Where the run's event log is, whether or not the file exists. */
const logOf = (entry: RunsIndexEntry): string => join(runDirIn(entry.repo, entry.runId), EVENTS_FILE);

/** What a run's event log says, projected: the part of `detailOf` that costs a read of the whole log. */
type Projected = { execution: ExecutionState; executions: number; phases: string[]; card?: RunCard; jobId?: string } | { error: string };

/** The projections of the logs read so far, by the log's size and modification time. */
const projections = new Map<string, { stamp: string; projected: Projected }>();
const MAX_PROJECTIONS = 500;

/**
 * The projection of a log. A log is read again only when its size or its modification time changed: the Board polls every few
 * seconds, and the log of a finished run never changes. An append moves both, and so does the retention pass that rewrites a log.
 * A log that is not there is never remembered.
 */
function projectLog(log: string): Projected {
  let stamp: string | undefined;
  try {
    const stat = statSync(log);
    stamp = `${stat.size}:${Math.round(stat.mtimeMs)}`; // whole milliseconds, rounded as `Stats.mtime` is: what a `Date` can restore
  } catch {
    stamp = undefined;
  }
  const known = projections.get(log);
  if (stamp !== undefined && known?.stamp === stamp) return known.projected;

  // A log this code cannot read or project (damage, or events a newer or older kit wrote) is that run's problem: it shows as
  // `missing` with the reason, and never fails the listing of the other runs.
  let projected: Projected;
  try {
    const events = readEventLog(log, { content: false }).events;
    const execution = projectLatestExecution(events);
    const latestStart = events.findLast((e) => e.type === "run-start");
    const jobId = latestStart?.type === "run-start" && typeof latestStart.jobId === "string" ? latestStart.jobId : undefined;
    projected = execution
      ? { execution, executions: events.filter((e) => e.type === "run-start").length, phases: runPhases(events), card: latestCard(events), jobId }
      : { error: `no run-start in ${log}` };
  } catch (err) {
    projected = { error: `could not read ${log}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (stamp !== undefined) {
    projections.delete(log); // re-inserted: the Map's order is the order of the latest reads
    projections.set(log, { stamp, projected });
    if (projections.size > MAX_PROJECTIONS) projections.delete(projections.keys().next().value!);
  }
  return projected;
}

function detailOf(entry: RunsIndexEntry): RunDetail {
  const base = { runId: entry.runId, repo: entry.repo, workflow: entry.workflow, startedAt: entry.startedAt };
  const missing = (error: string): RunDetail => ({
    ...base,
    status: "missing",
    error,
    phases: [],
    executions: 0,
    spentCents: 0,
    chargedCents: 0,
    spentTokens: 0,
    recent: [],
    usage: withRatio(NO_USAGE),
  });
  const projected = projectLog(logOf(entry));
  if ("error" in projected) return missing(projected.error);
  const { execution } = projected;

  let { status, error } = execution;
  if (status === "running") {
    // The rule `wf status` applies to the run's job: a process that is gone, or a frozen job (`silentJobError`), has failed it.
    if (!isRunExecuting(entry.repo, entry.runId)) {
      status = "failed";
      error = `the process executing the run ended without finishing it; ${resumeHint(entry.runId)}`;
    } else {
      const silent = projected.jobId === undefined ? undefined : silentJobError(entry.repo, projected.jobId, entry.runId);
      if (silent !== undefined) {
        status = "failed";
        error = silent;
      }
    }
  }
  const { ledger } = execution;
  return {
    ...base,
    workflow: execution.workflow,
    status,
    finishedAt: execution.finishedAt,
    phase: execution.phase === undefined ? undefined : boundedPhase(execution.phase),
    phases: [...projected.phases],
    outcome: execution.outcome,
    card: projected.card && structuredClone(projected.card),
    error,
    executions: projected.executions,
    spentCents: ledger.spentCents,
    chargedCents: ledger.chargedCents,
    spentTokens: ledger.spentTokens,
    recent: [...execution.recent],
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

/** The run's entry in the runs index. Undefined when the index has no such run. The run id is only compared with the index, never used as a path. */
function indexedRun(runId: string): RunsIndexEntry | undefined {
  return indexedRuns().find((e) => e.runId === runId);
}

/** One run with its progress lines, result and token usage. Undefined when the runs index has no such run. */
export function readRun(runId: string): RunDetail | undefined {
  const entry = indexedRun(runId);
  if (!entry) return undefined;
  const detail = detailOf(entry);
  const projected = projectLog(logOf(entry)); // already projected by `detailOf`: no second read of the log
  const start = "jobId" in projected && projected.jobId !== undefined ? readJobStart(entry.repo, projected.jobId) : undefined;
  return start ? { ...detail, start } : detail;
}

/** Where the event log of an indexed run is, whether or not the file exists. Undefined when the runs index has no such run. */
export function eventLogOf(runId: string): string | undefined {
  const entry = indexedRun(runId);
  return entry && logOf(entry);
}
