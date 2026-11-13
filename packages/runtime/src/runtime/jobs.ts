// Jobs: asynchronous execution with state on disk, so the Cursor chat can start a long workflow and ask for the result
// later (MCP calls and the agent's shell have timeouts; an implementation workflow takes minutes). The CLI and the MCP
// server read the same directory, so a job started by one can be queried by the other.
//
// Every job runs in its own detached process (`spawnJob`): the MCP server and the CLI only start it, read its state and
// ask it to stop (`cancelJob`). Restarting Cursor or the MCP server leaves the run going. The process keeps a heartbeat
// in the job record; a job whose heartbeat goes stale, or whose process is gone, is reported as failed with its run id.
//
// What a job is on disk, and how to read, wait for and cancel one, is in job-state.ts (no engine): this file adds what starts a job.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { LimitOverrides } from "../config/index.js";
import { type RunOptions, newRunId, runWorkflow } from "./engine.js";
import { HEARTBEAT_MS, type JobRecord, type JobStart, type JobState, fromEnv, jobLogPath, jobsDir, readJob, writeJob } from "./job-state.js";
import { resumeHint } from "./projection.js";
import { abortOpenRuns } from "./run-store.js";
import { plainName } from "./state.js";
import type { WorkflowDefinition } from "./workflow.js";

/** What a new job record may be given; the rest is generated: a new run id, a random job id, this process's pid. */
export interface NewJob {
  /** The run to execute: given to resume it, or a new one. */
  runId?: string;
  jobId?: string;
  pid?: number;
  /** How the job was started, kept so a resume can repeat it. */
  start?: JobStart;
}

/**
 * Creates the job record before the run (the CLI `start` writes it in the parent, before the spawn). Throws an `invalid runId`
 * error, before anything is written, when the run to resume is not a plain name (`isPlainName`): it becomes a path.
 */
export function createJob(cwd: string, workflow: string, { runId, jobId = randomUUID().slice(0, 8), pid = process.pid, start }: NewJob = {}): JobRecord {
  if (runId !== undefined) plainName(runId, "runId");
  // Date and time stay in the record, not in the workflow: the script must be deterministic for the resume.
  const record: JobRecord = { jobId, runId: runId ?? newRunId(workflow), pid, heartbeat: new Date().toISOString(), ...(start ? { start } : {}) };
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
    process.stderr.write(`[wf] unhandledRejection ignored: ${reason instanceof Error ? reason.message : String(reason)}\n`);
  });
  process.on("uncaughtException", (err) => {
    // A job's state comes from the run's log: end this process's runs in it, with the reason and how to resume.
    abortOpenRuns((runId) => `crash: ${err.message}; ${resumeHint(runId)}`);
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
      workerData: { file: join(jobsDir(cwd), `${job.jobId}.json`), record: { ...job }, intervalMs }, // the whole record: the worker rewrites it with a new heartbeat, so it never drops a field
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
  const job = existing ?? createJob(opts.cwd, def.meta.name, { runId: opts.runId });
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
  /** The flag layer of the config (`--max-cents`, `--max-tokens`). */
  maxCents?: number;
  maxTokens?: number;
  /** The chat's overrides: the process applies them as the tighten-only layer of the config. */
  overrides?: LimitOverrides;
}

/**
 * Starts a job in a detached process (`wf run <workflow> --job <jobId>`, a new session, no pipe to the caller) and returns
 * at once. The process outlives the caller: the MCP server can be restarted, the terminal closed. Its output goes to the
 * job's log file. Where it cannot be started, the job is recorded as refused, with the reason.
 */
export function spawnJob(o: SpawnJobOptions): { job: JobRecord; log: string } {
  const start: JobStart = {
    args: o.args ?? {},
    ...(o.maxCents === undefined ? {} : { maxCents: o.maxCents }),
    ...(o.maxTokens === undefined ? {} : { maxTokens: o.maxTokens }),
    ...(o.overrides && Object.keys(o.overrides).length ? { overrides: o.overrides } : {}),
  };
  const job = createJob(o.cwd, o.workflow, { runId: o.resumeRunId, start });
  const log = jobLogPath(o.cwd, job.jobId);
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url)); // the runtime's own CLI, wherever the kit is installed
  const flags = [
    ...(o.maxCents === undefined ? [] : ["--max-cents", String(o.maxCents)]),
    ...(o.maxTokens === undefined ? [] : ["--max-tokens", String(o.maxTokens)]),
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
    child.once("error", (err) => writeJob(o.cwd, { ...job, refused: `could not start the job's process: ${err.message}` }));
    child.unref();
    // The record was born with this process's pid; the child's replaces it (the child also writes its own when it starts).
    if (child.pid) writeJob(o.cwd, Object.assign(job, { pid: child.pid }));
  } finally {
    closeSync(out); // the child holds its own copy
  }
  return { job, log };
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
      process.stderr.write(`[wf] ${name}: cancelling the run; send the signal again to exit now\n`);
      controller.abort();
      return;
    }
    abortOpenRuns((runId) => `run cancelled by force by a second ${name}; ${resumeHint(runId)}`, "cancelled");
    process.exit(exitCode);
  };
  process.on("SIGINT", handle("SIGINT", 130));
  process.on("SIGTERM", handle("SIGTERM", 143));
  return controller.signal;
}
