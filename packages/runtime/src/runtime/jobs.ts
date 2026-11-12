// Jobs: asynchronous execution with state on disk, so the Cursor chat can start a long workflow and ask for the result
// later (MCP calls and the agent's shell have timeouts; an implementation workflow takes minutes). The CLI and the MCP
// server read the same directory, so a job started by one can be queried by the other.
//
// The job record (`.workflows/jobs/<jobId>.json`) holds identity only: job id, run id, pid and heartbeat. Everything else
// (status, phase, recent lines, spend, result) is a projection of the run's event log
// (`.workflows/runs/<runId>/events.jsonl`), computed on every read: one source of truth, and no state file to be left
// half-written.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
  status: "running" | "finished" | "failed";
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
  } else if (state.status === "running" && !isAlive(record.pid)) {
    // The process died without ending the run (crash, MCP server restart, machine shut down).
    state.status = "failed";
    state.error = unfinished(record);
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

/** Runs the workflow in this process for a job that already exists (or creates one). `done` resolves with the job's final state. */
export function startJob<A>(
  def: WorkflowDefinition<A, unknown>,
  args: A,
  opts: RunOptions,
  existing?: JobRecord,
): { job: JobRecord; done: Promise<JobState> } {
  const job = existing ?? createJob(opts.cwd, def.meta.name, opts.runId);
  const beat = () => {
    job.pid = process.pid;
    job.heartbeat = new Date().toISOString();
    writeJob(opts.cwd, job);
  };
  beat();
  const heartbeat = setInterval(beat, HEARTBEAT_MS);
  heartbeat.unref();
  const done = runWorkflow(def, args, { ...opts, runId: job.runId, jobId: job.jobId })
    .then((outcome) => {
      if (outcome.status === "failed" && outcome.refused) {
        job.refused = outcome.error;
        writeJob(opts.cwd, job);
      }
    })
    .finally(() => clearInterval(heartbeat))
    .then(() => readJob(opts.cwd, job.jobId)!);
  return { job, done };
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
