// The state of the jobs of a repo, read from disk, and the cancellation of a job: everything about a job that does not need
// the engine. The dashboard cancels a run through this module (`observe`), so it must stay free of the engine and, with it,
// of the Cursor SDK: `jobs.ts` adds what starts a job. See there for what a job is.
//
// The job record (`.workflows/jobs/<jobId>.json`) holds the job's identity (job id, run id, pid and heartbeat) and only the
// facts the job's process cannot put in the run's log (ADR-0008): how the job was started (args and limit flags), so a resume
// can repeat it exactly, why the runtime refused it before its run started, and when a cancel killed its frozen process.
// Everything else (status, phase, recent lines, spend, result) is a projection of the run's event log
// (`.workflows/runs/<runId>/events.jsonl`), computed on every read: one source of truth for the run's progress, and no
// state file to be left half-written.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LimitOverrides } from "../config/index.js";
import { cancelLeftCloudAgents, leftAgentsNote } from "./cloud-cancel.js";
import type { RunStatus } from "./events.js";
import { type ExecutionState, type Ledger, projectExecution, replayLedger, resumeHint, withRatio } from "./projection.js";
import { commandLineHas, isAlive } from "./pid.js";
import { eventLogPath, readEventLog, runLockHolder } from "./run-store.js";
import { isPlainName, stateDir } from "./state.js";
import { writeFileAtomic } from "./state-files.js";

/** How a job was started: what `wf start` (or `start_workflow`) was given, which a resume of its run gives again. */
export interface JobStart {
  /** The workflow's args. */
  args: unknown;
  /** The flag layer of the config (`--max-cents`, `--max-tokens`). */
  maxCents?: number;
  maxTokens?: number;
  /** The tighten-only overrides (`--overrides`, `start_workflow`'s `overrides`). */
  overrides?: LimitOverrides;
}

/** What is on disk: the identity of the job, and the facts its process cannot put in the run's log (ADR-0008). */
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
  /** How the job was started. Absent in records an older kit wrote. */
  start?: JobStart;
  /**
   * Only when a cancel killed the job's frozen process (`cancelJob`, SIGKILL): when (ISO 8601). The killed process writes
   * no run end, so this is what tells its execution's end from a crash; the job stays `failed` all the same.
   */
  killedByCancel?: string;
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

/**
 * The job record in `file` (identity and the facts the log cannot hold), without the projection. Undefined when the file is
 * not there or is not a record this runtime wrote, which is also the case of a record whose run id is not a plain name
 * (`isPlainName`): that id becomes the path of the run's log, and it must not lead out of the runs folder.
 */
function parseJobRecord(file: string): JobRecord | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as JobRecord | null;
    return isPlainName(record?.runId) ? record : undefined;
  } catch {
    return undefined;
  }
}

/** How job `jobId` of `repo` was started, from its record. Only reads: nothing is created. Undefined when the id is not a plain name, or the record is not there or has no `start`. */
export function readJobStart(repo: string, jobId: string): JobStart | undefined {
  if (!isPlainName(jobId)) return undefined;
  const start = parseJobRecord(join(jobsDirIn(repo), `${jobId}.json`))?.start;
  return start && typeof start === "object" && "args" in start ? start : undefined;
}

/**
 * The job record on disk (identity and the facts the log cannot hold), without the projection. Undefined when the id is not
 * a plain name (`isPlainName`: the id comes from the chat or the command line, and must not lead out of the jobs folder) or
 * the record is not there.
 */
export function readJobRecord(cwd: string, jobId: string): JobRecord | undefined {
  if (!isPlainName(jobId)) return undefined;
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
  if (!isAlive(record.pid)) {
    // The process died without ending the run (crash, machine shut down).
    state.status = "failed";
    state.error = `process ${record.pid} ended without finishing the job; ${resumeHint(record.runId)}`;
    return { state, liveness: "gone" };
  }
  const silent = silenceOf(record);
  if (silent === undefined) return { state, liveness: "alive" };
  state.status = "failed";
  if (isFrozen(cwd, record)) {
    state.error = silent;
    return { state, liveness: "silent" };
  }
  // The pid is there but does not execute the job: the job's process ended, and another process got the number (or the run).
  // Worded as a dead process is, never `no heartbeat`: readers take that prefix for a frozen job, which a cancel must kill.
  state.error = `process ${record.pid} ended without finishing the job (the pid is now another process's); ${resumeHint(record.runId)}`;
  return { state, liveness: "gone" };
}

/**
 * How long the job's process has not said it is alive, when that is longer than `WF_HEARTBEAT_STALE_MS` (30 s): the error a
 * frozen job (`isFrozen`) is `failed` with. Undefined while the heartbeat is fresh. Says nothing of whether the pid is still
 * the job's process.
 */
function silenceOf(record: JobRecord): string | undefined {
  const silentMs = Date.now() - Date.parse(record.heartbeat);
  if (!(silentMs > fromEnv("WF_HEARTBEAT_STALE_MS", HEARTBEAT_STALE_MS))) return undefined;
  return `no heartbeat for ${Math.round(silentMs / 1000)}s (process ${record.pid}); ${resumeHint(record.runId)}`;
}

/**
 * Is the job frozen: its process is there, is the job's (`isJobProcess`), still holds the run's lock, and has stopped beating
 * (`silenceOf`)? A frozen job shows as `failed`, yet it still executes its run: a cancel kills it. Nothing else with a stale
 * heartbeat is frozen: a dead pid is a job that ended (a crash), and a live pid that is not the job's process, or not the
 * one that holds the run, is another process (one that got the pid, or a new execution of the run that took its lock).
 */
function isFrozen(cwd: string, record: JobRecord): boolean {
  return isAlive(record.pid) && silenceOf(record) !== undefined && isJobProcess(record) && runLockHolder(cwd, record.runId) === record.pid;
}

/**
 * What `wf status` says of job `jobId` of `repo` when it is frozen (`isFrozen`), for the run view: a run whose lock a frozen
 * job still holds is `failed` there with this error, the status `wf status` gives its job. Undefined when the job is not
 * frozen (its heartbeat is fresh, its process is gone, or the pid or the run's lock is another process's), and when the id
 * is not a plain name or the record is not there or is another run's. Only reads.
 */
export function silentJobError(repo: string, jobId: string, runId: string): string | undefined {
  if (!isPlainName(jobId)) return undefined;
  const record = parseJobRecord(join(jobsDirIn(repo), `${jobId}.json`));
  if (record?.runId !== runId || typeof record.heartbeat !== "string" || typeof record.pid !== "number") return undefined;
  return isFrozen(repo, record) ? silenceOf(record) : undefined;
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
 * The job that is executing run `runId` of the repo `cwd`: the one of its jobs whose process is still there and beating, or
 * frozen (`isFrozen`). A run has one job per execution (a resume is a new job over the same run) and the earlier ones have
 * ended. A frozen job is reported `failed` by `readJob`, yet it still executes the run (it holds its lock): it is this
 * function's answer too, and `cancelJob` kills it. A stale job whose pid another process got is not: it ended. Undefined when
 * no job executes the run, which is also the case of a run that a terminal executes (`wf run`: no job). Reads the job records
 * without creating the jobs folder.
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

/** Writes the record. Only the `JobRecord` fields reach the disk, even when `record` is a `JobState`: never the projection. */
export function writeJob(cwd: string, record: JobRecord): void {
  const { jobId, runId, pid, heartbeat, refused, start, killedByCancel } = record;
  const optional = { refused, start, killedByCancel };
  for (const key of Object.keys(optional) as Array<keyof typeof optional>) if (optional[key] === undefined) delete optional[key];
  writeFileAtomic(join(jobsDir(cwd), `${jobId}.json`), JSON.stringify({ jobId, runId, pid, heartbeat, ...optional }, null, 2));
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
 * the run for a resume but cannot revert the step, and its record is marked (`killedByCancel`) so the resume does not take
 * that end for a crash; once it is gone, the cloud agents its run left running are cancelled
 * through the Cursor API, and a resume afterwards starts a new agent in place of each, at new cost. A job whose process
 * already ended gets no signal: those agents are cancelled the same way. So does a job whose pid another process got: the
 * job's process ended, and the other process is left alone. Either way the job stays `failed`, its run's end never written.
 * Undefined when there is no such job.
 */
export async function cancelJob(cwd: string, jobId: string, timeoutMs: number): Promise<CancelResult | undefined> {
  const record = readJobRecord(cwd, jobId);
  if (!record) return undefined;
  const { state: before, liveness } = inspect(cwd, record);
  // A process that is gone cannot cancel the cloud agents its run left running: they are reached through the Cursor API.
  if (liveness === undefined || liveness === "gone") {
    const left = leftAgentsNote(await cancelLeftCloudAgents(cwd, record.runId));
    return { ...before, note: `the job already ended (${before.status})${left || "; nothing to cancel"}` };
  }
  // A fresh heartbeat on a pid that is another process's (`inspect` checks the process only once the heartbeat is stale): the
  // job's process ended, as above. Its run's lock tells `cancelLeftCloudAgents` whether some process still executes the run.
  if (!isJobProcess(record)) {
    const left = leftAgentsNote(await cancelLeftCloudAgents(cwd, record.runId));
    return { ...before, note: `process ${record.pid} is not the job's process (was the pid reused?): the job ended, no signal sent${left || "; nothing to cancel"}` };
  }
  const signal = liveness === "silent" ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(record.pid, signal);
  } catch (err) {
    return { ...before, note: `could not signal process ${record.pid}: ${err instanceof Error ? err.message : String(err)}` };
  }
  // The killed process writes no run end and runs no code again (not even its heartbeat): the record says the cancel killed
  // it, so a resume tells this end from a crash (`wasKilledByCancel`). Written now, not once the process is gone: a process
  // that outlives the wait is still killed, and a second cancel finds it gone and marks nothing.
  if (signal === "SIGKILL") writeJob(cwd, { ...record, killedByCancel: new Date().toISOString() });
  // A killed process never writes the run's end: the wait is for it to be gone. A cancelled one: for the job to leave `running`.
  const stopping = (state: JobState) => (signal === "SIGKILL" ? isAlive(record.pid) : state.status === "running");
  let state: JobState = before;
  for (const deadline = Date.now() + timeoutMs; stopping(state) && Date.now() < deadline; ) {
    await new Promise((r) => setTimeout(r, 200));
    state = readJob(cwd, jobId) ?? state;
  }
  // A killed process cannot cancel its own cloud agents: once it is gone they are reached through the Cursor API, as for a job
  // whose process had already ended. A cancel stops everything that spends (spec #5 story 13), also when the user cancelled
  // only to free the run for a resume: that resume starts a new agent for each step whose agent this cancelled, at new cost.
  // While the process is still there it holds the run, and `cancelLeftCloudAgents` leaves a run a process executes alone.
  if (signal === "SIGKILL") {
    const left = stopping(state)
      ? `; process ${record.pid} has not exited yet, so the cloud agents its run left running were not cancelled: cancel this job again once it is gone`
      : leftAgentsNote(await cancelLeftCloudAgents(cwd, record.runId));
    return { ...state, note: `process ${record.pid} had no heartbeat and was killed (SIGKILL) without undoing the step in progress; the run stays resumable${left}` };
  }
  return { ...state, note: state.status === "running" ? `SIGTERM sent to process ${record.pid}, which is still stopping; check with wait_workflow` : `SIGTERM sent to process ${record.pid}` };
}

/**
 * Did a cancel kill job `jobId` of `repo` (`cancelJob` on a frozen job)? Its execution then ended with no run end, as after a
 * crash, but it was cancelled. False for a job whose process died on its own, also when it was cancelled afterwards, and when
 * the id is not a plain name or the record is not there. Only reads: nothing is created.
 */
export function wasKilledByCancel(repo: string, jobId: string): boolean {
  if (!isPlainName(jobId)) return false;
  return typeof parseJobRecord(join(jobsDirIn(repo), `${jobId}.json`))?.killedByCancel === "string";
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
