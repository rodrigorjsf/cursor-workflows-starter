// Jobs: asynchronous execution with state on disk, so the Cursor chat can start a long workflow and ask for the result
// later (MCP calls and the agent's shell have timeouts; an implementation workflow takes minutes). The CLI and the MCP
// server read the same directory, so a job started by one can be queried by the other.
//
// Every job runs in its own detached process (`spawnJob`): the MCP server and the CLI only start it, read its state and
// ask it to stop (`cancelJob`). Restarting Cursor or the MCP server leaves the run going. The process keeps a heartbeat
// in the job record; a job whose heartbeat goes stale, or whose process is gone, is reported as failed with its run id.
//
// The job record (`.workflows/jobs/<jobId>.json`) holds identity only: job id, run id, pid and heartbeat. Everything else
// (status, phase, recent lines, spend, result) is a projection of the run's event log
// (`.workflows/runs/<runId>/events.jsonl`), computed on every read: one source of truth, and no state file to be left
// half-written.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { LimitOverrides } from "../config/index.js";
import { type RunOptions, newRunId, runWorkflow } from "./engine.js";
import { type ExecutionState, type Ledger, projectExecution, replayLedger, withRatio } from "./projection.js";
import { abortOpenRuns, eventLogPath, readEventLog } from "./run-store.js";
import { stateDir } from "./state.js";
import { writeFileAtomic } from "./state-files.js";
import type { WorkflowDefinition } from "./workflow.js";

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
  status: "running" | "finished" | "failed" | "cancelled";
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
function fromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function jobsDir(cwd: string): string {
  return stateDir(cwd, "jobs");
}

export function jobLogPath(cwd: string, jobId: string): string {
  return join(jobsDir(cwd), `${jobId}.log`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The job record on disk (identity only), without the projection. */
export function readJobRecord(cwd: string, jobId: string): JobRecord | undefined {
  const file = join(jobsDir(cwd), `${jobId}.json`);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as JobRecord;
  } catch {
    return undefined; // not a record this runtime wrote
  }
}

const unfinished = (record: JobRecord): string => `processo ${record.pid} terminou sem concluir o job; relance com resumeRunId="${record.runId}"`;

/** The state of the job: the record plus the projection of the run's log. Only reads. */
function jobStateOf(cwd: string, record: JobRecord): JobState {
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
  } else if (state.status === "running") {
    const silentMs = Date.now() - Date.parse(record.heartbeat);
    if (!isAlive(record.pid)) {
      // The process died without ending the run (crash, machine shut down).
      state.status = "failed";
      state.error = unfinished(record);
    } else if (silentMs > fromEnv("WF_HEARTBEAT_STALE_MS", HEARTBEAT_STALE_MS)) {
      // Alive, or a recycled pid, but it has not said so for too long: frozen, stopped, or not the job's process any more.
      state.status = "failed";
      state.error = `sem sinal de vida há ${Math.round(silentMs / 1000)}s (processo ${record.pid}); relance com resumeRunId="${record.runId}"`;
    }
  }
  return state;
}

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

/** Writes the record. Only the identity fields reach the disk, even when `record` is a `JobState`. */
export function writeJob(cwd: string, record: JobRecord): void {
  const { jobId, runId, pid, heartbeat, refused } = record;
  writeFileAtomic(join(jobsDir(cwd), `${jobId}.json`), JSON.stringify({ jobId, runId, pid, heartbeat, ...(refused === undefined ? {} : { refused }) }, null, 2));
}

/** Creates the job record before the run (the CLI `start` writes it in the parent, before the spawn). */
export function createJob(cwd: string, workflow: string, runId?: string, jobId: string = randomUUID().slice(0, 8), pid = process.pid): JobRecord {
  // Date and time stay in the record, not in the workflow: the script must be deterministic for the resume.
  const record: JobRecord = { jobId, runId: runId ?? newRunId(workflow), pid, heartbeat: new Date().toISOString() };
  writeJob(cwd, record);
  return record;
}

/**
 * Process handlers for the MCP server and the CLI. The official cookbook (dag-task-runner) warns that the SDK fires
 * unawaited promises while the agent starts; without a handler a rejection takes the process down and the jobs stay
 * "running" forever.
 */
export function installCrashHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[wf] unhandledRejection ignorada: ${reason instanceof Error ? reason.message : String(reason)}\n`);
  });
  process.on("uncaughtException", (err) => {
    // A job's state comes from the run's log: end this process's runs in it, with the reason and how to resume.
    abortOpenRuns((runId) => `crash: ${err.message}; relance com resumeRunId="${runId}"`);
    process.stderr.write(`[wf] uncaughtException: ${err.stack ?? err.message}\n`);
    process.exit(1);
  });
}

/**
 * Keeps the job's heartbeat fresh until `stop()`. The beat is written by a worker thread, so a main thread blocked in a
 * synchronous call (a long test run) does not make a live job look dead. Falls back to a timer on the main thread when
 * the worker cannot run.
 */
function startHeartbeat(cwd: string, job: JobRecord): { stop(): Promise<void> } {
  const intervalMs = fromEnv("WF_HEARTBEAT_MS", HEARTBEAT_MS);
  const beat = () => {
    job.pid = process.pid;
    job.heartbeat = new Date().toISOString();
    writeJob(cwd, job);
  };
  beat();
  let timer: NodeJS.Timeout | undefined;
  const onMainThread = () => {
    timer ??= setInterval(beat, intervalMs);
    timer.unref();
  };
  let worker: Worker | undefined;
  try {
    worker = new Worker(new URL("./heartbeat-worker.mjs", import.meta.url), {
      workerData: { file: join(jobsDir(cwd), `${job.jobId}.json`), record: { jobId: job.jobId, runId: job.runId, pid: process.pid }, intervalMs },
      execArgv: [], // plain JavaScript: no TypeScript loader needed in the worker
    });
    worker.unref();
    worker.once("error", onMainThread);
  } catch {
    onMainThread();
  }
  return {
    async stop() {
      if (timer) clearInterval(timer);
      await worker?.terminate();
    },
  };
}

/** Runs the workflow in this process for a job that already exists (or creates one). `done` resolves with the job's final state. */
export function startJob<A>(
  def: WorkflowDefinition<A, unknown>,
  args: A,
  opts: RunOptions,
  existing?: JobRecord,
): { job: JobRecord; done: Promise<JobState> } {
  const job = existing ?? createJob(opts.cwd, def.meta.name, opts.runId);
  const heartbeat = startHeartbeat(opts.cwd, job);
  const done = (async () => {
    try {
      const outcome = await runWorkflow(def, args, { ...opts, runId: job.runId, jobId: job.jobId });
      await heartbeat.stop(); // before the record is written again: the worker writes it too
      if (outcome.status === "failed" && outcome.refused) {
        job.refused = outcome.error;
        writeJob(opts.cwd, job);
      }
    } finally {
      await heartbeat.stop();
    }
    return readJob(opts.cwd, job.jobId)!;
  })();
  return { job, done };
}

export interface SpawnJobOptions {
  cwd: string;
  /** The workflow's name (`meta.name`). */
  workflow: string;
  /** The workflow's args: they go to the process as JSON. */
  args: unknown;
  /** The run to resume (a new job over an existing run). */
  resumeRunId?: string;
  /** The flag layer of the config, as the command line wrote them (`--max-cents`, `--max-tokens`). */
  maxCents?: string;
  maxTokens?: string;
  /** The chat's overrides: the process applies them as the tighten-only layer of the config. */
  overrides?: LimitOverrides;
}

/**
 * Starts a job in a detached process (`wf run <workflow> --job <jobId>`, a new session, no pipe to the caller) and returns
 * at once. The process outlives the caller: the MCP server can be restarted, the terminal closed. Its output goes to the
 * job's log file. Where it cannot be started, the job is recorded as refused, with the reason.
 */
export function spawnJob(o: SpawnJobOptions): { job: JobRecord; log: string } {
  const job = createJob(o.cwd, o.workflow, o.resumeRunId);
  const log = jobLogPath(o.cwd, job.jobId);
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url)); // the runtime's own CLI, wherever the kit is installed
  const flags = [
    ...(o.maxCents === undefined ? [] : ["--max-cents", o.maxCents]),
    ...(o.maxTokens === undefined ? [] : ["--max-tokens", o.maxTokens]),
    ...(o.overrides && Object.keys(o.overrides).length ? ["--overrides", JSON.stringify(o.overrides)] : []),
  ];
  const out = openSync(log, "a");
  try {
    const child = spawn(process.execPath, [...process.execArgv, cli, "run", o.workflow, "--args", JSON.stringify(o.args ?? {}), "--cwd", o.cwd, "--job", job.jobId, ...flags], {
      detached: true,
      stdio: ["ignore", out, out],
      cwd: o.cwd,
      env: process.env,
    });
    child.once("error", (err) => writeJob(o.cwd, { ...job, refused: `não foi possível iniciar o processo do job: ${err.message}` }));
    child.unref();
    // The record was born with this process's pid; the child's replaces it (the child also writes its own when it starts).
    if (child.pid) writeJob(o.cwd, Object.assign(job, { pid: child.pid }));
  } finally {
    closeSync(out); // the child holds its own copy
  }
  return { job, log };
}

/** True when `record.pid` is the process of this job and not another one that got the number: its command line carries the job id. */
function isJobProcess(record: JobRecord): boolean {
  if (!existsSync("/proc/self/cmdline")) return true; // a platform without /proc cannot tell
  try {
    return readFileSync(`/proc/${record.pid}/cmdline`, "utf8").split("\0").includes(record.jobId);
  } catch {
    return false;
  }
}

/** What `cancelJob` returns: the job's state afterwards, and what the cancellation did (or why it did nothing). */
export interface CancelResult extends JobState {
  note: string;
}

/**
 * Asks the job's process to cancel (SIGTERM: the process cancels the active agent runs, reverts the in-flight write step,
 * writes the run's end and exits) and waits up to `timeoutMs` for the job to leave `running`. A job that already ended is
 * left alone, and so is a process that is not the job's. Undefined when there is no such job.
 */
export async function cancelJob(cwd: string, jobId: string, timeoutMs: number): Promise<CancelResult | undefined> {
  const record = readJobRecord(cwd, jobId);
  if (!record) return undefined;
  const before = jobStateOf(cwd, record);
  if (before.status !== "running") return { ...before, note: `o job já terminou (${before.status}); nada a cancelar` };
  if (!isJobProcess(record)) return { ...before, note: `o processo ${record.pid} não é o processo do job (o pid foi reaproveitado?); nenhum sinal enviado` };
  try {
    process.kill(record.pid, "SIGTERM");
  } catch (err) {
    return { ...before, note: `não foi possível sinalizar o processo ${record.pid}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let state: JobState = before;
  for (const deadline = Date.now() + timeoutMs; state.status === "running" && Date.now() < deadline; ) {
    await new Promise((r) => setTimeout(r, 200));
    state = readJob(cwd, jobId) ?? state;
  }
  return { ...state, note: state.status === "running" ? `SIGTERM enviado ao processo ${record.pid}, que ainda está encerrando; confira com wait_workflow` : `SIGTERM enviado ao processo ${record.pid}` };
}

/**
 * Makes SIGINT and SIGTERM cancel the run this process executes, the same as `wf cancel`: returns the signal to hand to
 * `runWorkflow`. A second signal while the run is still stopping ends the process at once, closing the runs it was
 * executing in their logs as cancelled.
 */
export function cancelOnSignals(): AbortSignal {
  const controller = new AbortController();
  const handle = (name: NodeJS.Signals, exitCode: number) => () => {
    if (!controller.signal.aborted) {
      process.stderr.write(`[wf] ${name}: cancelando o run; envie o sinal de novo para sair já\n`);
      controller.abort();
      return;
    }
    abortOpenRuns((runId) => `run cancelado à força por um segundo ${name}; relance com resumeRunId="${runId}"`, "cancelled");
    process.exit(exitCode);
  };
  process.on("SIGINT", handle("SIGINT", 130));
  process.on("SIGTERM", handle("SIGTERM", 143));
  return controller.signal;
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
