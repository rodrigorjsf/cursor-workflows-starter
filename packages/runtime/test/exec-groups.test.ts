// Seam: the engine's `ctx.exec`, read at the record a cancel reads. A run executed as a job records the process group of each
// command it has live in the jobs folder, and drops it when the command ends; a run with no job records nothing. Real commands and
// real process groups, with the fake Cursor SDK standing in for the SDK the engine imports; the kill itself is
// frozen-cancel.process.test.ts.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { runWorkflow } from "../src/runtime/engine.js";
import { recordedExecGroups } from "../src/runtime/job-children.js";
import { createJob } from "../src/runtime/jobs.js";
import { jobsDirIn } from "../src/runtime/job-state.js";
import { defineWorkflow } from "../src/runtime/workflow.js";
import { waitFor } from "./wait-for.js";

const sandbox = mkdtempSync(join(tmpdir(), "wf-exec-groups-"));
let leaked: number | undefined;
afterEach(() => {
  if (leaked !== undefined) {
    try {
      process.kill(-leaked, "SIGKILL"); // a sleep a failing test left running
    } catch {
      /* already gone */
    }
    leaked = undefined;
  }
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

/** A workflow whose one command writes its pid to `pidFile` and becomes a `sleep` that lasts until it is stopped. */
const sleeping = (pidFile: string) =>
  defineWorkflow({
    meta: { name: "sleeping", description: "one long ctx.exec" },
    run: (ctx) => ctx.exec("sh", ["-c", 'echo $$ > "$1"; exec sleep 600', "sh", pidFile], { timeoutMs: 30 * 60_000 }),
  });

/** The pid in `file`, once the command wrote it. */
const pidIn = (file: string) =>
  waitFor("the command to write its pid", () => {
    try {
      const pid = Number(readFileSync(file, "utf8").trim());
      return Number.isInteger(pid) && pid > 1 ? pid : undefined;
    } catch {
      return undefined; // not written yet
    }
  });

test("a job records the process group of a live ctx.exec command, and drops it when the command ends", async () => {
  const cwd = mkdtempSync(join(sandbox, "repo-"));
  createJob(cwd, "sleeping", { runId: "run-live", jobId: "job-live" });
  const pidFile = join(cwd, "pid");
  const controller = new AbortController();
  const done = runWorkflow(sleeping(pidFile), {}, { cwd, runId: "run-live", jobId: "job-live", signal: controller.signal });
  const pid = (leaked = await pidIn(pidFile));

  assert.deepEqual(recordedExecGroups(jobsDirIn(cwd), "job-live"), [pid], "the command leads its own process group: its group is its pid");

  controller.abort();
  assert.equal((await done).status, "cancelled");
  assert.deepEqual(recordedExecGroups(jobsDirIn(cwd), "job-live"), [], "the command ended: nothing is left to kill");
});

test("a job drops the record of a command that ends by itself, whatever its exit code", async () => {
  const cwd = mkdtempSync(join(sandbox, "repo-"));
  createJob(cwd, "failing", { runId: "run-ended", jobId: "job-ended" });
  const failing = defineWorkflow({ meta: { name: "failing", description: "a command that fails" }, run: (ctx) => ctx.exec("sh", ["-c", "exit 3"]) });
  const outcome = await runWorkflow(failing, {}, { cwd, runId: "run-ended", jobId: "job-ended" });
  assert.equal(outcome.status, "finished");
  assert.equal((outcome.result as { exitCode: number }).exitCode, 3);
  assert.deepEqual(recordedExecGroups(jobsDirIn(cwd), "job-ended"), []);
});

test("a run with no job records nothing, and creates no jobs folder", async () => {
  const cwd = mkdtempSync(join(sandbox, "repo-"));
  const quick = defineWorkflow({ meta: { name: "quick", description: "a command that ends" }, run: (ctx) => ctx.exec("true") });
  assert.equal((await runWorkflow(quick, {}, { cwd, runId: "run-no-job" })).status, "finished");
  assert.equal(existsSync(jobsDirIn(cwd)), false);
});
