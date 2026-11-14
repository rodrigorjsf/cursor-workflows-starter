// Seam: real job processes. A job is a child process (test/exec-job.ts, started the way `wf run --job` starts one) against the
// fake Cursor SDK, a temporary repo and a throwaway home. `cancelJob`, the call behind `wf cancel`, `cancel_workflow` and the
// dashboard's cancel, kills it when it is frozen (alive, heartbeat stale). Nothing else is replaced: the commands are real
// `sleep` processes, and the assertions read the process table.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { cancelJob, readJob } from "../src/runtime/job-state.js";
import { isAlive } from "../src/runtime/pid.js";
import { waitFor } from "./wait-for.js";

const sandbox = mkdtempSync(join(tmpdir(), "wf-frozen-cancel-"));
const children: ChildProcess[] = [];
const sleepers = new Set<number>();
afterEach(() => {
  for (const child of children.splice(0)) if (child.pid && isAlive(child.pid)) process.kill(child.pid, "SIGKILL");
  for (const pid of sleepers) {
    try {
      process.kill(-pid, "SIGKILL"); // a sleep a failing test left running
    } catch {
      /* already gone */
    }
  }
  sleepers.clear();
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

/** True while `pid` is a process that can still run: a zombie that nobody has reaped yet is dead. */
function running(pid: number): boolean {
  if (!isAlive(pid)) return false;
  try {
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return !existsSync("/proc/self/stat"); // where /proc is, a pid with no entry is gone; where it is not, kill(0) is all there is
  }
}

/** The pid the fixture wrote to `file` once its `sleep` runs; the sleep is added to those the test cleans up. */
async function sleepPid(job: ChildProcess, file: string): Promise<number> {
  const pid = await waitFor(`the sleep that writes ${file}`, () => {
    if (job.exitCode !== null || job.signalCode !== null) throw new Error(`the job process ended early (${job.exitCode ?? job.signalCode})`);
    try {
      const n = Number(readFileSync(file, "utf8").trim());
      return Number.isInteger(n) && n > 1 ? n : undefined;
    } catch {
      return undefined; // the file is not there yet
    }
  });
  sleepers.add(pid);
  return pid;
}

/** Starts job `jobId` in its own process, in a repo of its own, and returns once its `sleep` runs. */
async function startJob(jobId: string, mode?: "detached") {
  const repo = mkdtempSync(join(sandbox, "repo-"));
  const pidDir = mkdtempSync(join(sandbox, "pids-"));
  const env = { ...process.env, TSX_TSCONFIG_PATH: join(import.meta.dirname, "..", "tsconfig.test.json") };
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(import.meta.dirname, "exec-job.ts"), repo, jobId, `run-${jobId}`, pidDir, ...(mode ? [mode] : [])], { env, stdio: "ignore" });
  children.push(child);
  return { repo, pid: child.pid!, exec: await sleepPid(child, join(pidDir, "exec.pid")), ...(mode ? { detached: await sleepPid(child, join(pidDir, "detached.pid")) } : {}) };
}

/** Freezes the job's process (alive, no heartbeat) and cancels the job, as `wf cancel` does: the cancel kills it. */
async function freezeAndCancel(job: { repo: string; pid: number }, jobId: string) {
  process.kill(job.pid, "SIGSTOP");
  const staleBefore = process.env.WF_HEARTBEAT_STALE_MS;
  process.env.WF_HEARTBEAT_STALE_MS = "50"; // the readers' threshold, so the test need not wait 30 s
  try {
    await waitFor("the stopped job to show as frozen", () => readJob(job.repo, jobId)?.error?.startsWith("no heartbeat"));
    const cancelled = await cancelJob(job.repo, jobId, 30_000);
    assert.match(cancelled!.note, /had no heartbeat and was killed \(SIGKILL\)/, JSON.stringify(cancelled));
  } finally {
    if (staleBefore === undefined) delete process.env.WF_HEARTBEAT_STALE_MS;
    else process.env.WF_HEARTBEAT_STALE_MS = staleBefore;
  }
  await waitFor("the frozen process to be gone", () => !running(job.pid));
}

test("cancelling a frozen job kills the command it started through ctx.exec: no sleep outlives the cancel", async () => {
  const job = await startJob("frozen-exec");
  assert.ok(running(job.exec), "the sleep runs before the cancel");
  await freezeAndCancel(job, "frozen-exec");
  await waitFor("the sleep started by ctx.exec to be gone", () => !running(job.exec));
});

test("cancelling a frozen job kills a command the process spawned itself in its own process group, as the SDK's local agent spawns its shell commands", async () => {
  const job = await startJob("frozen-detached", "detached");
  assert.ok(running(job.detached!), "the detached sleep runs before the cancel");
  await freezeAndCancel(job, "frozen-detached");
  await waitFor("the sleep started by ctx.exec to be gone", () => !running(job.exec));
  await waitFor("the detached sleep to be gone", () => !running(job.detached!));
});

test("cancelling a frozen job leaves alone a process in a group of its own that is not the job's child", async () => {
  const bystander = spawn("sleep", ["600"], { detached: true, stdio: "ignore" }); // a child of this test, leading its own group
  bystander.unref();
  sleepers.add(bystander.pid!);
  const job = await startJob("frozen-bystander", "detached");
  await freezeAndCancel(job, "frozen-bystander");
  await waitFor("the job's own sleeps to be gone", () => !running(job.exec) && !running(job.detached!));
  assert.ok(running(bystander.pid!), "the bystander's sleep still runs");
});
