// Seam 2, the process: a second process that tries to execute a run id that is already being executed is refused.
// The first process is a real child (test/hold-run.ts) running against the fake Cursor SDK.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { type ChildProcess, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { calls, script } from "@cursor/sdk";
import { runWorkflow } from "../src/runtime/engine.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { defineWorkflow } from "../src/runtime/workflow.js";

const cwd = join(import.meta.dirname, ".tmp", `run-lock-${process.pid}`);
let child: ChildProcess | undefined;
afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  rmSync(cwd, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
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
  assert.match(refused.error!, new RegExp(`^já está em execução: o run shared-run pertence ao processo ${proc.pid} `));
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
  assert.match(overlapping.error!, /^já está em execução: o run same-process /);
  assert.equal((await slow).status, "finished");

  const after = await runWorkflow(quick, {}, { cwd, runId: "same-process" });
  assert.equal(after.status, "finished", "the finished run released its lock");
});
