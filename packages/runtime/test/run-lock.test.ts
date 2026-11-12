// Seam 2, the process: a second process that tries to execute a run id that is already being executed is refused.
// The first process is a real child (test/hold-run.ts) running against the fake Cursor SDK.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { calls, costConfig, script, stats } from "@cursor/sdk";
import { runWorkflow } from "../src/runtime/engine.js";
import { NamedLockedError, acquireNamedLock, eventLogPath, processIdentity, readEventLog, runDirPath } from "../src/runtime/run-store.js";
import { defineWorkflow } from "../src/runtime/workflow.js";

const cwd = join(import.meta.dirname, ".tmp", `run-lock-${process.pid}`);
let child: ChildProcess | undefined;
afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  rmSync(cwd, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined });
});

/** Starts hold-run.ts and resolves once its run is executing a step. */
function holdRun(runId: string): Promise<ChildProcess> {
  const proc = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(import.meta.dirname, "hold-run.ts"), cwd, runId], {
    env: { ...process.env, TSX_TSCONFIG_PATH: join(import.meta.dirname, "..", "tsconfig.test.json") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  child = proc;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the child run did not start within 30 s")), 30_000);
    proc.once("exit", (code) => reject(new Error(`the child exited early with code ${code}`)));
    proc.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("started")) {
        clearTimeout(timer);
        resolve(proc);
      }
    });
  });
}

const quick = defineWorkflow({ meta: { name: "held", description: "quick" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent("hold", { label: "hold" }) });

test("a second process executing the same run id is refused with a clear message, and the log is left alone", async () => {
  const proc = await holdRun("shared-run");
  const refused = await runWorkflow(quick, {}, { cwd, runId: "shared-run" });
  assert.equal(refused.status, "failed");
  assert.match(refused.error!, new RegExp(`^already running: run shared-run belongs to process ${proc.pid} `));
  assert.equal(calls.length, 0, "the refused process starts no agent");

  const { events } = readEventLog(eventLogPath(cwd, "shared-run"));
  assert.equal(events.filter((e) => e.type === "run-start").length, 1, "only the owner of the lock writes to the run's log");
});

test("the lock of a process that died is stale: the run can be executed again", async () => {
  const proc = await holdRun("orphan-run");
  proc.kill("SIGKILL"); // no chance to release the lock
  await new Promise((resolve) => proc.once("exit", resolve));

  const resumed = await runWorkflow(quick, {}, { cwd, runId: "orphan-run" });
  assert.equal(resumed.status, "finished", resumed.error);
});

test("two executions of the same run id in one process cannot overlap either, and the lock is released when a run ends", async () => {
  script.push(() => new Promise((resolve) => setTimeout(() => resolve({}), 300)));
  const slow = runWorkflow(quick, {}, { cwd, runId: "same-process" });
  const overlapping = await runWorkflow(quick, {}, { cwd, runId: "same-process" });
  assert.equal(overlapping.status, "failed");
  assert.match(overlapping.error!, /^already running: run same-process /);
  assert.equal((await slow).status, "finished");

  const after = await runWorkflow(quick, {}, { cwd, runId: "same-process" });
  assert.equal(after.status, "finished", "the finished run released its lock");
});

/** Writes a lock file the way a process of an earlier boot would have left it, for a pid that is alive now. */
function leftoverLock(runId: string, lock: Record<string, unknown>): void {
  const dir = join(runDirPath(cwd, runId));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.lock"), JSON.stringify({ pid: process.ppid, token: "left-over", startedAt: "2020-01-01T00:00:00.000Z", ...lock }));
}

const hasProc = existsSync("/proc/self/stat");

test("a lock whose pid now belongs to another process (recycled after a crash or reboot) is stale", { skip: !hasProc && "needs /proc" }, async () => {
  leftoverLock("recycled", { identity: "a-boot-that-is-gone:1" });
  const r = await runWorkflow(quick, {}, { cwd, runId: "recycled" });
  assert.equal(r.status, "finished", r.error);
});

test("a lock held by a live process with the same identity is respected, and the message says how to clear a stale one", { skip: !hasProc && "needs /proc" }, async () => {
  leftoverLock("alive-holder", { identity: processIdentity(process.ppid) });
  const r = await runWorkflow(quick, {}, { cwd, runId: "alive-holder" });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /^already running: run alive-holder belongs to process \d+ /);
  assert.match(r.error!, /run\.lock/, "names the file to delete when the process is gone");
});

// The repo-wide named locks (`.workflows/locks/<name>.lock`), which implement-issue uses to keep one active run per issue.

test("a named lock refuses a second holder with the first one's run id, and is free again once released", () => {
  const release = acquireNamedLock(cwd, "issue-7", "run-a");
  assert.throws(() => acquireNamedLock(cwd, "issue-7", "run-b"), (err) => err instanceof NamedLockedError && err.holderRunId === "run-a" && /^issue-7 already has an active run: run-a /.test(err.message));
  acquireNamedLock(cwd, "issue-8", "run-b")(); // another name is another lock
  release();
  acquireNamedLock(cwd, "issue-7", "run-b")();
});

test("a named lock takes a plain name only: it becomes a file name", () => {
  for (const name of ["../escape", "a/b", "a b", ""]) assert.throws(() => acquireNamedLock(cwd, name, "run-a"), /invalid lock name/, JSON.stringify(name));
  assert.ok(!existsSync(join(cwd, ".workflows", "escape.lock")));
});
