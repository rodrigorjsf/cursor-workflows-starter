// Seam: real job processes. A job is a child process (test/exec-job.ts, started detached the way `wf run --job` starts one) against
// the fake Cursor SDK, a temporary repo and a throwaway home. `cancelJob`, the call behind `wf cancel`, `cancel_workflow` and the
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
import { recordedExecGroups } from "../src/runtime/job-children.js";
import { cancelJob, jobsDirIn, readJob } from "../src/runtime/job-state.js";
import { isAlive } from "../src/runtime/pid.js";
import { killGroup, pidIn } from "./sleeper.js";
import { waitFor } from "./wait-for.js";

const sandbox = mkdtempSync(join(tmpdir(), "wf-frozen-cancel-"));
const leaders = new Set<number>(); // the process groups the tests started: killed in afterEach, whatever the test did
afterEach(() => {
  for (const pid of leaders) killGroup(pid);
  leaders.clear();
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

/** Starts `command` as a process group leader of its own, so the afterEach reaches everything it left. */
function detach(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  leaders.add(child.pid!);
  return child;
}

/** Starts job `jobId` in its own process, in a repo of its own, and returns once its `sleep` (and `other`, when asked for) runs. */
async function startJob(jobId: string, mode?: "detached" | "grouped") {
  const repo = mkdtempSync(join(sandbox, "repo-"));
  const pidDir = mkdtempSync(join(sandbox, "pids-"));
  const env = { ...process.env, TSX_TSCONFIG_PATH: join(import.meta.dirname, "..", "tsconfig.test.json") };
  const child = detach(process.execPath, ["--import", import.meta.resolve("tsx"), join(import.meta.dirname, "exec-job.ts"), repo, jobId, `run-${jobId}`, pidDir, ...(mode ? [mode] : [])]);
  const stillThere = () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the job process ended early (${child.exitCode ?? child.signalCode})`);
  };
  const exec = await pidIn(join(pidDir, "exec.pid"), stillThere);
  const other = mode ? await pidIn(join(pidDir, "other.pid"), stillThere) : undefined;
  for (const pid of [exec, other]) if (pid !== undefined) leaders.add(pid);
  return { repo, pid: child.pid!, exec, other: other! };
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
  assert.deepEqual(recordedExecGroups(jobsDirIn(job.repo), "frozen-exec"), [job.exec], "the job recorded the command's group");
  await freezeAndCancel(job, "frozen-exec");
  await waitFor("the sleep started by ctx.exec to be gone", () => !running(job.exec));
  assert.deepEqual(recordedExecGroups(jobsDirIn(job.repo), "frozen-exec"), [], "the killed job cannot drop its record: the cancel does");
});

test("cancelling a frozen job kills a command the process spawned itself in its own process group, as the SDK's local agent spawns its shell commands", async () => {
  const job = await startJob("frozen-detached", "detached");
  assert.ok(running(job.other), "the detached sleep runs before the cancel");
  await freezeAndCancel(job, "frozen-detached");
  await waitFor("the sleep started by ctx.exec to be gone", () => !running(job.exec));
  await waitFor("the detached sleep to be gone", () => !running(job.other));
});

test("cancelling a frozen job kills a command the process spawned in its own group, as the SDK starts the MCP servers of an agent", async () => {
  const job = await startJob("frozen-grouped", "grouped");
  assert.ok(running(job.other), "the sleep in the job's group runs before the cancel");
  await freezeAndCancel(job, "frozen-grouped");
  await waitFor("the sleep in the job's group to be gone", () => !running(job.other));
});

test("cancelling a frozen job leaves alone a process in a group of its own that is not the job's child", async () => {
  const bystander = detach("sleep", ["600"]).pid!; // a child of this test, leading its own group
  const job = await startJob("frozen-bystander", "detached");
  await freezeAndCancel(job, "frozen-bystander");
  await waitFor("the job's own sleeps to be gone", () => !running(job.exec) && !running(job.other));
  assert.ok(running(bystander), "the bystander's sleep still runs");
});
