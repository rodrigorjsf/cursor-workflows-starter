// The state of the jobs of a repo, read from disk, and the cancellation of a job: everything about a job that does not need
// the engine. The dashboard cancels a run through this module (`observe`), so it must stay free of the engine and, with it,
// of the Cursor SDK: `jobs.ts` adds what starts a job. See there for what a job is.
//
// The job record (`.workflows/jobs/<jobId>.json`) holds identity only: job id, run id, pid and heartbeat. Everything else
// (status, phase, recent lines, spend, result) is a projection of the run's event log
// (`.workflows/runs/<runId>/events.jsonl`), computed on every read: one source of truth, and no state file to be left
// half-written.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunStatus } from "./events.js";
import { type ExecutionState, type Ledger, projectExecution, replayLedger, resumeHint, withRatio } from "./projection.js";
import { commandLineHas, isAlive } from "./pid.js";
import { eventLogPath, readEventLog } from "./run-store.js";
import { stateDir } from "./state.js";
import { writeFileAtomic } from "./state-files.js";

/** What is on disk: the identity of the job. */
export interface JobRecord {
  jobId: string;
  /** Written at the start: lets the run be resumed with the same journal even if the process dies. */
  runId: string;
  /** The process that executes the job; used to detect an orphaned job. */
  pid: number;
  /** The last moment the job's process declared itself alive (ISO 8601). */
  heartbeat: string;
  /**
   * Only when the runtime refused the job before its run started (invalid args, run already executing): the reason. The
   * run's log is not the job's to write in that case (it may belong to another execution), so the reason is kept here.
   */
  refused?: string;
}

/** What `wf status`, `wf jobs`, `get_workflow_status` and `wait_workflow` return: the record plus the projection of the log. */
export interface JobState {
  jobId: string;
  runId: string;
  pid: number;
  heartbeat: string;
  /** The workflow's `meta.name`. Absent until the job's process has started the run. */
  workflow?: string;
  status: "running" | RunStatus;
  startedAt?: string;
  finishedAt?: string;
  phase?: string;
  /** The last progress lines, one line each. Never prompt or agent output text. */
  recent: string[];
  result?: unknown;
  error?: string;
  /** The cost the cap uses: Σ max(raw, charged). Accumulates across resumes. */
  spentCents: number;
  /** Only what was charged (0 for usage included in the plan). */
  chargedCents: number;
  spentTokens: number;
  usage: Ledger["usage"] & { cacheHitRatio: number | null };
}

/** How often a job's process refreshes the heartbeat in its record. */
export const HEARTBEAT_MS = 5_000;
/** How long a running job may go without a heartbeat before it is reported as failed. */
export const HEARTBEAT_STALE_MS = 30_000;

/** A positive number from the environment, or `fallback`. `WF_HEARTBEAT_MS` and `WF_HEARTBEAT_STALE_MS` exist so tests do not wait for real intervals. */
export function fromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Where a repo's job records are, whether or not the folder exists: nothing is created. */
export const jobsDirIn = (cwd: string): string => join(cwd, ".workflows", "jobs");

/** The folder of the job records of `cwd`; makes it if it is not there. */
export function jobsDir(cwd: string): string {
  return stateDir(cwd, "jobs");
}

export function jobLogPath(cwd: string, jobId: string): string {
  return join(jobsDir(cwd), `${jobId}.log`);
}

/** The job record in `file` (identity only), without the projection. Undefined when the file is not there or is not a record this runtime wrote. */
function parseJobRecord(file: string): JobRecord | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as JobRecord;
  } catch {
    return undefined;
  }
}

/** The job record on disk (identity only), without the projection. */
export function readJobRecord(cwd: string, jobId: string): JobRecord | undefined {
  return parseJobRecord(join(jobsDir(cwd), `${jobId}.json`));
}

/** What a running job's process is doing: `gone` (not there), `silent` (there, but its heartbeat stopped), or `alive`. */
type Liveness = "alive" | "silent" | "gone";

/**
 * The state of the job: the record plus the projection of the run's log. Only reads. `liveness` is set only for a run
 * the log shows as not ended (and not refused): whether its process is still doing the job decides `failed`.
 */
function inspect(cwd: string, record: JobRecord): { state: JobState; liveness?: Liveness } {
  const { events } = readEventLog(eventLogPath(cwd, record.runId), { content: false });
  const execution: ExecutionState | undefined = projectExecution(events, record.jobId);
  const ledger = execution?.ledger ?? replayLedger(events);
  const state: JobState = {
    jobId: record.jobId,
    runId: record.runId,
    pid: record.pid,
    heartbeat: record.heartbeat,
    workflow: execution?.workflow,
    status: execution?.status ?? "running",
    startedAt: execution?.startedAt,
    finishedAt: execution?.finishedAt,
    phase: execution?.phase,
    recent: execution?.recent ?? [],
    result: execution?.result,
    error: execution?.error,
    spentCents: ledger.spentCents,
    chargedCents: ledger.chargedCents,
    spentTokens: ledger.spentTokens,
    usage: withRatio(ledger.usage),
  };
  if (record.refused !== undefined) {
    state.status = "failed";
    state.error = record.refused;
    return { state };
  }
  if (state.status !== "running") return { state };
  const silentMs = Date.now() - Date.parse(record.heartbeat);
  if (!isAlive(record.pid)) {
    // The process died without ending the run (crash, machine shut down).
    state.status = "failed";
    state.error = `process ${record.pid} ended without finishing the job; ${resumeHint(record.runId)}`;
    return { state, liveness: "gone" };
  }
  if (silentMs > fromEnv("WF_HEARTBEAT_STALE_MS", HEARTBEAT_STALE_MS)) {
    // Alive, or a recycled pid, but it has not said so for too long: frozen, stopped, or not the job's process any more.
    state.status = "failed";
    state.error = `no heartbeat for ${Math.round(silentMs / 1000)}s (process ${record.pid}); ${resumeHint(record.runId)}`;
    return { state, liveness: "silent" };
  }
  return { state, liveness: "alive" };
}

const jobStateOf = (cwd: string, record: JobRecord): JobState => inspect(cwd, record).state;

export function readJob(cwd: string, jobId: string): JobState | undefined {
  const record = readJobRecord(cwd, jobId);
  return record && jobStateOf(cwd, record);
}

export function listJobs(cwd: string): JobState[] {
  return readdirSync(jobsDir(cwd))
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJob(cwd, f.slice(0, -5)))
    .filter((j): j is JobState => Boolean(j));
}

/**
 * The job that is executing run `runId` of the repo `cwd`: the one of its jobs whose process is still there, beating or not. A
 * run has one job per execution (a resume is a new job over the same run) and the earlier ones have ended. A job whose process
 * stopped beating is reported `failed` by `readJob`, yet it still executes the run (it holds its lock): it is this function's
 * answer too, and `cancelJob` kills it. Undefined when no job's process is there, which is also the case of a run that a
 * terminal executes (`wf run`: no job). Reads the job records without creating the jobs folder.
 */
export function runningJobOf(cwd: string, runId: string): JobState | undefined {
  const dir = jobsDirIn(cwd);
  if (!existsSync(dir)) return undefined;
  for (const file of readdirSync(dir)) {
    const record = file.endsWith(".json") ? parseJobRecord(join(dir, file)) : undefined;
    if (record?.runId !== runId) continue;
    const { state, liveness } = inspect(cwd, record);
    if (liveness === "alive" || liveness === "silent") return state;
  }
  return undefined;
}

/** Writes the record. Only the identity fields reach the disk, even when `record` is a `JobState`. */
export function writeJob(cwd: string, record: JobRecord): void {
  const { jobId, runId, pid, heartbeat, refused } = record;
  writeFileAtomic(join(jobsDir(cwd), `${jobId}.json`), JSON.stringify({ jobId, runId, pid, heartbeat, ...(refused === undefined ? {} : { refused }) }, null, 2));
}

/** True when `record.pid` is the process of this job and not another one that got the number: its command line carries the job id. */
function isJobProcess(record: JobRecord): boolean {
  return commandLineHas(record.pid, (arg) => arg === record.jobId);
}

/** What `cancelJob` returns: the job's state afterwards, and what the cancellation did (or why it did nothing). */
export interface CancelResult extends JobState {
  note: string;
}

/**
 * Asks the job's process to cancel (SIGTERM: the process cancels the active agent runs, reverts the in-flight write step,
 * writes the run's end and exits) and waits up to `timeoutMs` for the job to leave `running`. A process that has stopped
 * answering (its heartbeat is stale, so the job already shows as failed) cannot handle a signal: it is killed, which frees
 * the run for a resume but cannot revert the step. A job that already ended is left alone, and so is a process that is not
 * the job's. Undefined when there is no such job.
 */
export async function cancelJob(cwd: string, jobId: string, timeoutMs: number): Promise<CancelResult | undefined> {
  const record = readJobRecord(cwd, jobId);
  if (!record) return undefined;
  const { state: before, liveness } = inspect(cwd, record);
  if (liveness === undefined || liveness === "gone") return { ...before, note: `the job already ended (${before.status}); nothing to cancel` };
  if (!isJobProcess(record)) return { ...before, note: `process ${record.pid} is not the job's process (was the pid reused?); no signal sent` };
  const signal = liveness === "silent" ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(record.pid, signal);
  } catch (err) {
    return { ...before, note: `could not signal process ${record.pid}: ${err instanceof Error ? err.message : String(err)}` };
  }
  // A killed process never writes the run's end: the wait is for it to be gone. A cancelled one: for the job to leave `running`.
  const stopping = (state: JobState) => (signal === "SIGKILL" ? isAlive(record.pid) : state.status === "running");
  let state: JobState = before;
  for (const deadline = Date.now() + timeoutMs; stopping(state) && Date.now() < deadline; ) {
    await new Promise((r) => setTimeout(r, 200));
    state = readJob(cwd, jobId) ?? state;
  }
  if (signal === "SIGKILL") {
    return { ...state, note: `process ${record.pid} had no heartbeat and was killed (SIGKILL) without undoing the step in progress; the run stays resumable` };
  }
  return { ...state, note: state.status === "running" ? `SIGTERM sent to process ${record.pid}, which is still stopping; check with wait_workflow` : `SIGTERM sent to process ${record.pid}` };
}

/** Waits up to `timeoutMs` for the job to end; returns its current state (ended or not). */
export async function waitJob(cwd: string, jobId: string, timeoutMs: number): Promise<JobState | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = readJob(cwd, jobId);
    if (!job || job.status !== "running" || Date.now() >= deadline) return job;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
