// Seam 1 and 2: a running job keeps a heartbeat, and a job whose heartbeat is stale is reported as failed with its run id.
// The in-process tests use the job record on disk and `readJob`; the last one runs a real child process.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { calls, script, stats } from "@cursor/sdk";
import { createJob, startJob } from "../src/runtime/jobs.js";
import { jobsDir, readJob, writeJob } from "../src/runtime/job-state.js";
import { defineWorkflow } from "../src/runtime/workflow.js";

const cwd = mkdtempSync(join(tmpdir(), "wf-heartbeat-"));
let child: ChildProcess | undefined;
const savedEnv = { ...process.env };
afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0, cancelled: 0 });
  for (const key of ["WF_HEARTBEAT_MS", "WF_HEARTBEAT_STALE_MS"]) delete process.env[key];
  Object.assign(process.env, savedEnv);
});
after(() => rmSync(cwd, { recursive: true, force: true }));

const heartbeatOnDisk = (jobId: string) => (JSON.parse(readFileSync(join(jobsDir(cwd), `${jobId}.json`), "utf8")) as { heartbeat: string }).heartbeat;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a job whose pid is alive but whose heartbeat is stale is reported as failed, with its run id for resume", () => {
  // pid: this process, which is alive but is not the job's process and holds no run: the job ended. A frozen job (its own
  // process, holding the run) says `no heartbeat` instead: detached.process.test.ts and cloud.lifecycle.test.ts cover it.
  const record = createJob(cwd, "w", { runId: "run-stale", jobId: "job-stale" });
  writeJob(cwd, { ...record, heartbeat: new Date(Date.now() - 5 * 60_000).toISOString() });
  const state = readJob(cwd, "job-stale")!;
  assert.equal(state.status, "failed");
  assert.equal(state.runId, "run-stale");
  assert.match(state.error!, /resumeRunId="run-stale"/);
  assert.match(state.error!, /ended without finishing the job/);
});

test("a job with a fresh heartbeat and a live process is running", () => {
  createJob(cwd, "w", { runId: "run-fresh", jobId: "job-fresh" });
  assert.equal(readJob(cwd, "job-fresh")!.status, "running");
});

test("the heartbeat of a running job is refreshed while it runs", async () => {
  process.env.WF_HEARTBEAT_MS = "50";
  script.push(() => ({ hang: true }));
  const wf = defineWorkflow({
    meta: { name: "beating", description: "beats" },
    defaults: { model: { id: "m" } },
    run: (ctx) => ctx.agent("hold", { label: "hold", retries: 0, timeoutMs: 400 }),
  });
  const { job, done } = startJob(wf, {}, { cwd });
  const first = heartbeatOnDisk(job.jobId);
  await sleep(300);
  const later = heartbeatOnDisk(job.jobId);
  await done;
  assert.ok(Date.parse(later) - Date.parse(first) >= 150, `the heartbeat moved from ${first} to ${later}`);
});

test("the heartbeat keeps beating while the process is blocked in a synchronous call, so a long test run is not mistaken for a crash", async () => {
  const env = { ...process.env, TSX_TSCONFIG_PATH: join(import.meta.dirname, "..", "tsconfig.test.json"), WF_HEARTBEAT_MS: "100" };
  child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(import.meta.dirname, "blocked-job.ts"), cwd, "job-blocked", "run-blocked"], { env, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    child!.once("exit", (code) => reject(new Error(`the child exited early with code ${code}`)));
    child!.stdout!.on("data", (chunk: Buffer) => chunk.toString().includes("blocking") && resolve());
  });
  process.env.WF_HEARTBEAT_STALE_MS = "600"; // shorter than the 1.5 s the child blocks for
  const seen = new Set<string>();
  for (const stop = Date.now() + 1200; Date.now() < stop; await sleep(100)) seen.add(readJob(cwd, "job-blocked")!.status);
  assert.deepEqual([...seen], ["running"], "stale for 1.2 s of main-thread silence would show failed; the worker thread keeps it running");
});
