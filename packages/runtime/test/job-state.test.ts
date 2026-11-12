// Seam 1, the run: a job's status, phase, recent lines and spend are a projection of the run's event log. The job record
// on disk holds only identity. Asserts on `readJob` / `listJobs` / `waitJob` output and on the files written, with the
// fake Cursor SDK.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { calls, costConfig, script, stats } from "@cursor/sdk";
import { runWorkflow } from "../src/runtime/engine.js";
import { jobsDir, listJobs, readJob, startJob, waitJob, writeJob } from "../src/runtime/jobs.js";
import { defineWorkflow } from "../src/runtime/workflow.js";

const cwd = join(import.meta.dirname, ".tmp", `job-state-${process.pid}`); // one directory per test process
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined });
});

/** Waits for something a run does in the background. */
async function until(condition: () => boolean, ms = 3000): Promise<void> {
  for (const deadline = Date.now() + ms; !condition(); await new Promise((r) => setTimeout(r, 5))) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the run");
  }
}

const recordOnDisk = (jobId: string) => JSON.parse(readFileSync(join(jobsDir(cwd), `${jobId}.json`), "utf8")) as Record<string, unknown>;

test("the job record holds only identity; status, phase, recent lines, spend and result are projected from the event log", async () => {
  const wf = defineWorkflow({
    meta: { name: "projected", description: "projected" },
    defaults: { model: { id: "m" } },
    async run(ctx) {
      ctx.phase("plan");
      ctx.log("hello");
      await ctx.agent("do it", { label: "do" });
      return { status: "done", n: 1 };
    },
  });
  const { job, done } = startJob(wf, {}, { cwd });
  await done;

  assert.deepEqual(Object.keys(recordOnDisk(job.jobId)).sort(), ["heartbeat", "jobId", "pid", "runId"], "the record holds identity only");

  const view = readJob(cwd, job.jobId)!;
  assert.equal(view.jobId, job.jobId);
  assert.equal(view.runId, job.runId);
  assert.equal(view.workflow, "projected");
  assert.equal(view.status, "finished");
  assert.equal(view.phase, "plan");
  assert.deepEqual(view.result, { status: "done", n: 1 });
  assert.deepEqual(view.recent, ["== plan", "hello", "▶ do [m]", "✓ do 9¢ cache-read 60"]);
  assert.equal(view.spentCents, 9);
  assert.equal(view.chargedCents, 7);
  assert.equal(view.spentTokens, 110);
  assert.equal(view.usage?.totalTokens, 110);
  assert.match(view.startedAt!, /^\d{4}-\d\d-\d\dT/);
  assert.match(view.finishedAt!, /^\d{4}-\d\d-\d\dT/);
});

test("a job that is still running projects as running, with the phase and lines so far", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  script.push(async () => {
    await gate;
    return { status: "finished", result: "ok" };
  });
  const wf = defineWorkflow({
    meta: { name: "slow", description: "slow" },
    defaults: { model: { id: "m" } },
    async run(ctx) {
      ctx.phase("work");
      return ctx.agent("slow step", { label: "slow" });
    },
  });
  const { job, done } = startJob(wf, {}, { cwd });
  try {
    await until(() => readJob(cwd, job.jobId)!.recent.includes("▶ slow [m]"));
    const view = readJob(cwd, job.jobId)!;
    assert.equal(view.status, "running");
    assert.equal(view.phase, "work");
    assert.deepEqual(view.recent, ["== work", "▶ slow [m]"]);
    assert.equal(view.finishedAt, undefined);
  } finally {
    release();
  }
  await done;
  assert.equal(readJob(cwd, job.jobId)!.status, "finished");
});

test("a job whose run failed projects the error", async () => {
  const wf = defineWorkflow({
    meta: { name: "boom", description: "boom" },
    async run() {
      throw new Error("deu ruim");
    },
  });
  const { job, done } = startJob(wf, {}, { cwd });
  await done;
  const view = readJob(cwd, job.jobId)!;
  assert.equal(view.status, "failed");
  assert.equal(view.error, "deu ruim");
});

test("a job whose process died without ending the run projects as failed, with the run id to resume", async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.on("exit", resolve));
  writeJob(cwd, { jobId: "dead", runId: "run-dead", pid: child.pid!, heartbeat: new Date().toISOString() });
  const view = readJob(cwd, "dead")!;
  assert.equal(view.status, "failed");
  assert.match(view.error!, /resumeRunId="run-dead"/);
  assert.deepEqual(readdirSync(jobsDir(cwd)), ["dead.json"], "reading a job writes nothing");
});

test("listJobs and waitJob return the projected state", async () => {
  const wf = defineWorkflow({ meta: { name: "quick", description: "quick" }, async run() { return "x"; } });
  const { job, done } = startJob(wf, {}, { cwd });
  await done;
  assert.deepEqual(listJobs(cwd).map((j) => [j.jobId, j.status, j.workflow]), [[job.jobId, "finished", "quick"]]);
  const waited = await waitJob(cwd, job.jobId, 1000);
  assert.equal(waited?.status, "finished");
  assert.equal(await waitJob(cwd, "nope", 10), undefined);
});

test("a job the runtime refuses before the run starts projects as failed, with the reason", async () => {
  const wf = defineWorkflow({
    meta: { name: "strict", description: "strict", argsSchema: { type: "object", required: ["n"], properties: { n: { type: "number" } } } },
    async run() {
      return "x";
    },
  });
  const invalid = startJob(wf, {}, { cwd });
  const state = await invalid.done;
  assert.equal(state.status, "failed");
  assert.match(state.error!, /invalid args/);

  let release!: () => void;
  script.push(() => new Promise((resolve) => (release = () => resolve({ status: "finished", result: "ok" }))));
  const slow = defineWorkflow({ meta: { name: "slow", description: "slow" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent("hold", { label: "hold" }) });
  const first = startJob(slow, {}, { cwd });
  try {
    await until(() => readJob(cwd, first.job.jobId)!.recent.includes("▶ hold [m]"));
    const second = await startJob(slow, {}, { cwd, runId: first.job.runId }).done;
    assert.equal(second.status, "failed");
    assert.match(second.error!, /already running/);
    assert.equal(readJob(cwd, first.job.jobId)!.status, "running", "the job that holds the run is unaffected");
  } finally {
    release();
  }
  assert.equal((await first.done).status, "finished");
});

/** Runs crash-job.ts to its end: a job whose only step ran one turn, then the process died of an uncaught exception. */
async function crashAJob(jobId: string, runId: string): Promise<void> {
  const proc = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(import.meta.dirname, "crash-job.ts"), cwd, jobId, runId], {
    env: { ...process.env, TSX_TSCONFIG_PATH: join(import.meta.dirname, "..", "tsconfig.test.json") },
    stdio: ["ignore", "ignore", "ignore"],
  });
  assert.equal(await new Promise((resolve) => proc.on("exit", resolve)), 1);
}

test("a process that crashes ends its run in the log: the job projects as failed with the crash and the run id to resume", async () => {
  await crashAJob("crashed", "run-crashed");
  const view = readJob(cwd, "crashed")!;
  assert.equal(view.status, "failed");
  assert.equal(view.error, 'crash: boom; relaunch with resumeRunId="run-crashed"');
  assert.ok(view.finishedAt, "the run is closed in the log");
});

test("recent lines are one-line summaries: no prompt, agent message, tool call or command output, and a long log line is cut", async () => {
  script.push(() => ({
    status: "finished",
    result: "OUTPUT-MARKER final answer",
    deltas: [
      { type: "text-delta", text: "AGENT-TEXT-MARKER" },
      { type: "tool-call-started", callId: "c1", modelCallId: "m1", toolCall: { type: "shell", args: { command: "echo TOOL-ARGS-MARKER" } } },
      { type: "tool-call-completed", callId: "c1", modelCallId: "m1", toolCall: { type: "shell", args: { command: "echo TOOL-ARGS-MARKER" }, result: { status: "success", value: { exitCode: 0, signal: "", stdout: "COMMAND-OUTPUT-MARKER\n", stderr: "", executionTime: 1 } } } },
      { type: "turn-ended", usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 20 } },
    ],
  }));
  const wf = defineWorkflow({
    meta: { name: "summaries", description: "summaries" },
    defaults: { model: { id: "m" } },
    async run(ctx) {
      ctx.log(`first line\nsecond line ${"x".repeat(500)}`);
      return ctx.agent("PROMPT-MARKER please do the thing", { label: "work" });
    },
  });
  const { job, done } = startJob(wf, {}, { cwd });
  await done;
  const { recent } = readJob(cwd, job.jobId)!;
  assert.ok(recent.length >= 3);
  for (const line of recent) {
    assert.ok(!line.includes("\n"), `one line: ${JSON.stringify(line)}`);
    assert.ok(line.length <= 200, `short: ${line.length} chars`);
    assert.doesNotMatch(line, /MARKER/, "no content");
  }
  assert.match(recent[0]!, /^first line second line x+…$/, "line breaks collapse and a long line is cut");
  assert.doesNotMatch(JSON.stringify(readJob(cwd, job.jobId)), /PROMPT-MARKER|AGENT-TEXT-MARKER|TOOL-ARGS-MARKER|COMMAND-OUTPUT-MARKER/, "the whole job state carries no step content");
  assert.equal(readJob(cwd, job.jobId)!.result, "OUTPUT-MARKER final answer", "only what the workflow itself returned is the result");
});

test("a workflow result that looks like a content event does not hide the run's end from the projection", async () => {
  const wf = defineWorkflow({ meta: { name: "lookalike", description: "lookalike" }, async run() { return { type: "content", note: "mine" }; } });
  const { job, done } = startJob(wf, {}, { cwd });
  await done;
  const view = readJob(cwd, job.jobId)!;
  assert.equal(view.status, "finished");
  assert.deepEqual(view.result, { type: "content", note: "mine" });
});

test("the tokens of an attempt that died mid-step still count: the job shows them and a resume starts from them", async () => {
  await crashAJob("crashed", "run-crashed");
  const view = readJob(cwd, "crashed")!;
  assert.equal(view.spentTokens, 110, "the turn the attempt finished before the crash was paid for");
  assert.equal(view.spentCents, 0, "its cost never reached the log, so only tokens are known");
  assert.equal(view.usage.inputTokens, 100);

  const other = defineWorkflow({ meta: { name: "after", description: "after" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent("a different step", { label: "after" }) });
  const resumed = await runWorkflow(other, {}, { cwd, runId: "run-crashed" });
  assert.equal(resumed.status, "finished", resumed.error);
  assert.deepEqual([resumed.spentTokens, resumed.spentCents], [220, 9], "110 from the attempt that died + 110 from the new one");
});
