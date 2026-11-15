// What starts a job: the job record (`createJob`) and the detached process that runs it (`spawnJob`), with no engine. The CLI,
// the MCP server and the dashboard's Start action all start a job here, and the last one must not load the Cursor SDK the
// engine pulls in (jobs.ts, which re-exports these, holds what runs a job and does import it).
//
// Every job runs in its own detached process: whoever starts it only writes the record and spawns `wf run --job`, then reads its
// state and asks it to stop (`cancelJob`, job-state.ts). Restarting the server or the terminal leaves the run going.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LimitOverrides } from "../config/index.js";
import { type JobRecord, type JobStart, jobLogPath, jobRefusal, writeJob } from "./job-state.js";
import { newRunId, plainName } from "./state.js";
import { PRIVATE_FILE } from "./state-files.js";

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

/** The caps do not allow this job to start now (`jobRefusal` says why): nothing was written and no process started. */
export class JobRefusedError extends Error {}

export interface SpawnJobOptions {
  cwd: string;
  /** The workflow's name (`meta.name`). */
  workflow: string;
  /** The `caps.maxRunningJobs` in force (`null`: no cap). Required, so that no door that starts a job can forget the cap. */
  maxRunningJobs: number | null;
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
 * job's log file. Where it cannot be started, the job is recorded as refused, with the reason. Throws `JobRefusedError`, before
 * anything is written, when the job is already running or too many jobs run (`jobRefusal`).
 */
export function spawnJob(o: SpawnJobOptions): { job: JobRecord; log: string } {
  const refusal = jobRefusal(o.cwd, o.workflow, o.args ?? {}, o.maxRunningJobs);
  if (refusal !== undefined) throw new JobRefusedError(refusal);
  const start: JobStart = {
    workflow: o.workflow,
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
  const out = openSync(log, "a", PRIVATE_FILE);
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
