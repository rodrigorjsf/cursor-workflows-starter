// implement-issue's crash limit against real process deaths: each execution is a job in its own process
// (implement-issue-job.ts), stopped in the middle of its red write step. A frozen job that `cancelJob` kills (SIGKILL, the
// path of `wf cancel`, `cancel_workflow` and the dashboard for a job with no heartbeat) was cancelled, not crashed: no number
// of those uses up `maxStepCrashes`. A process that dies on its own is a crash, also when its job is cancelled after it died.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { cancelJob } from "../src/runtime/job-state.js";
import { isAlive } from "../src/runtime/pid.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { fx, issue, run, setup, teardown } from "./implement-issue.fixture.js";

beforeEach(setup);
afterEach(() => {
  for (const child of children.splice(0)) if (child.pid && isAlive(child.pid)) process.kill(child.pid, "SIGKILL");
  teardown();
});

const children: ChildProcess[] = [];
const progressOf = (runId: string) => JSON.parse(readFileSync(join(fx.repo, ".workflows", "runs", runId, "tdd-progress.json"), "utf8"));
const res = (r: { result?: unknown }) => r.result as Record<string, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts job `jobId`, an execution of run `runId`, and waits until it is in its red write step, running the suite. */
async function inRedStep(runId: string, jobId: string): Promise<number> {
  const env: NodeJS.ProcessEnv = { ...process.env, TSX_TSCONFIG_PATH: join(import.meta.dirname, "..", "tsconfig.test.json") };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(import.meta.dirname, "implement-issue-job.ts"), fx.repo, jobId, runId], { env, stdio: "ignore" });
  children.push(child);
  for (const stop = Date.now() + 60_000; Date.now() < stop; await sleep(50)) {
    const events = readEventLog(eventLogPath(fx.repo, runId), { content: false }).events;
    const start = events.findLastIndex((e) => e.type === "run-start");
    const mine = start >= 0 && events[start]!.type === "run-start" && (events[start] as { jobId?: string }).jobId === jobId;
    if (mine && events.slice(start).some((e) => e.type === "exec-start" && e.label.startsWith("suite:red")) && progressOf(runId).inFlight) return child.pid!;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`job ${jobId} ended before its red step (${child.exitCode ?? child.signalCode})`);
  }
  throw new Error(`timed out waiting for job ${jobId} to run its red suite`);
}

/** Freezes the job's process (alive, no heartbeat) and cancels the job, as `wf cancel` does: the cancel kills it. */
async function freezeAndCancel(pid: number, jobId: string) {
  process.kill(pid, "SIGSTOP");
  const staleBefore = process.env.WF_HEARTBEAT_STALE_MS;
  process.env.WF_HEARTBEAT_STALE_MS = "50"; // the readers' threshold, so the test need not wait 30 s
  try {
    await sleep(150);
    const cancelled = await cancelJob(fx.repo, jobId, 5000);
    assert.match(cancelled!.note, /had no heartbeat and was killed \(SIGKILL\)/, JSON.stringify(cancelled));
    assert.equal(cancelled!.status, "failed", "the killed job never wrote its run's end");
  } finally {
    if (staleBefore === undefined) delete process.env.WF_HEARTBEAT_STALE_MS;
    else process.env.WF_HEARTBEAT_STALE_MS = staleBefore;
  }
  assert.ok(!isAlive(pid), "the frozen process is gone");
}

/** Kills the job's process with no cancel: a crash. */
async function crash(pid: number) {
  process.kill(pid, "SIGKILL");
  for (const stop = Date.now() + 5000; isAlive(pid) && Date.now() < stop; ) await sleep(20);
  assert.ok(!isAlive(pid), "the process is gone");
}

test("a frozen job cancelled in the middle of a write step is not a crash: more cancels and resumes than the crash limit, and the run still finishes", async () => {
  issue(["complexity:low"]);
  const runId = "implement-issue-frozencancel";
  for (const n of [1, 2, 3]) {
    const pid = await inRedStep(runId, `frozen-${n}`);
    const logged = readEventLog(eventLogPath(fx.repo, runId), { content: false }).events.length;
    await freezeAndCancel(pid, `frozen-${n}`);
    const after = readEventLog(eventLogPath(fx.repo, runId), { content: false }).events.slice(logged);
    assert.ok(!after.some((e) => e.type === "run-end"), "the cancel writes nothing to the log: the killed execution has no run end");
  }
  const resumed = await run({}, runId);
  assert.equal(res(resumed).status, "done", JSON.stringify(res(resumed)));
  assert.deepEqual(progressOf(runId).crashes ?? {}, {}, "no cancel counted as a crash");
});

test("a process that dies in the middle of a write step is a crash, also when its job is cancelled after it died: the third one ends the run step-crash-loop", async () => {
  issue(["complexity:low"]);
  const runId = "implement-issue-realcrash";
  await crash(await inRedStep(runId, "crash-1"));
  const pid = await inRedStep(runId, "crash-2");
  await crash(pid);
  const late = await cancelJob(fx.repo, "crash-2", 1000); // `wf cancel` on a job that already died: it only cancels left cloud agents
  assert.match(late!.note, /^the job already ended/, JSON.stringify(late));
  await crash(await inRedStep(runId, "crash-3"));
  const stopped = await run({}, runId);
  assert.equal(res(stopped).status, "step-crash-loop", JSON.stringify(res(stopped)));
  assert.equal(res(stopped).crashes, 3);
  assert.match(res(stopped).step, /^red:/);
});
