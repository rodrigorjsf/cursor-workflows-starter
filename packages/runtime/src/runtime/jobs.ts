// Jobs: asynchronous execution with state on disk, so the Cursor chat can start a long workflow and ask for the result
// later (MCP calls and the agent's shell have timeouts; an implementation workflow takes minutes). The CLI and the MCP
// server read the same directory, so a job started by one can be queried by the other.
//
// Every job runs in its own detached process (`spawnJob`): the MCP server and the CLI only start it, read its state and
// ask it to stop (`cancelJob`). Restarting Cursor or the MCP server leaves the run going. The process keeps a heartbeat
// in the job record; a job whose heartbeat goes stale, or whose process is gone, is reported as failed with its run id.
//
// What a job is on disk, and how to read, wait for and cancel one, is in job-state.ts (no engine). What starts a job, the record
// and the detached process (`createJob`, `spawnJob`), is in job-spawn.ts (no engine either), and is re-exported here. This file
// adds what runs a job, inside its process.

import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { type RunOptions, runWorkflow } from "./engine.js";
import { createJob } from "./job-spawn.js";
import { HEARTBEAT_MS, type JobRecord, type JobState, fromEnv, jobsDir, readJob, writeJob } from "./job-state.js";
import { resumeHint } from "./projection.js";
import { abortOpenRuns } from "./run-store.js";
import type { WorkflowDefinition } from "./workflow.js";

export { JobRefusedError, type NewJob, type SpawnJobOptions, createJob, spawnJob } from "./job-spawn.js";

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
