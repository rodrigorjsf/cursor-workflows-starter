// Seam 2, the process: a workflow's command (`ctx.exec`) must not freeze the job's process. The `wf` CLI is a real child
// process against the fake Cursor SDK, a temporary repo and a temporary home directory. While a long command runs, status
// shows it and cancel, SIGTERM included, stops it at once: the job's event loop is free, and nothing the command started
// is left running.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ContentEvent, WorkflowEvent } from "../src/runtime/events.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";

const PACKAGE = join(import.meta.dirname, "..");
let sandbox: string;
let repo: string;
let env: Record<string, string>;
const strays: number[] = []; // processes the tests started and must not leave behind

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-exec-proc-"));
  repo = join(sandbox, "repo");
  const workflow = (name: string, body: string) =>
    writeFileSync(join(repo, ".agents", "workflows", `${name}.mjs`), `export default {\n  meta: { name: "${name}", description: "${name} fixture" },\n  ${body}\n};\n`);
  mkdirSync(join(repo, ".agents", "workflows"), { recursive: true });
  // a command that prints its child's pid and then waits for it (a minute)
  workflow("napper", `async run(ctx) { const r = await ctx.exec("bash", ["-c", "sleep 60 & echo $!; wait"], { label: "nap", timeoutMs: 120000 }); return { status: "done", exitCode: r.exitCode }; }`);
  // the same, but it ignores SIGTERM: only a SIGKILL ends it
  workflow("stubborn-nap", `async run(ctx) { await ctx.exec("bash", ["-c", "trap '' TERM; sleep 60 & echo $!; wait"], { label: "nap", timeoutMs: 120000 }); return { status: "done" }; }`);
  // a command that outlives its timeout
  workflow("overrun", `async run(ctx) { const r = await ctx.exec("bash", ["-c", "sleep 60"], { label: "nap", timeoutMs: 300 }); return { status: r.timedOut ? "timed-out" : "done" }; }`);
  env = {
    ...(getDefaultEnvironment() as Record<string, string>),
    TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"),
    WF_HOME: join(sandbox, "home"),
    WF_METRICS: "off",
    WF_CWD: repo,
  };
});
afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

const tsx = (script: string) => ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", script)];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until<T>(what: string, read: () => T | undefined | false, ms = 30_000): Promise<T> {
  for (const stop = performance.now() + ms; ; await sleep(50)) {
    const value = read();
    if (value) return value;
    if (performance.now() > stop) throw new Error(`timed out waiting for ${what}`);
  }
}

/** Runs `wf <args>` in the temporary repo and returns its stdout parsed as JSON. */
function wf(...args: string[]): Record<string, any> {
  const r = spawnSync(process.execPath, [...tsx("cli.ts"), ...args, "--cwd", repo], { env, encoding: "utf8" });
  return JSON.parse(r.stdout);
}
const jobRecord = (jobId: string) => JSON.parse(readFileSync(join(repo, ".workflows", "jobs", `${jobId}.json`), "utf8")) as { pid: number; runId: string };
const eventsOf = (runId: string): WorkflowEvent[] => readEventLog(eventLogPath(repo, runId)).events;
const commandStarted = (runId: string) => eventsOf(runId).some((e) => e.type === "exec-start" && e.label === "nap");
/** The pid the command printed, which is its child's: read from the log, as a dashboard would read the output. */
const printedPid = (runId: string): number | undefined => {
  const out = eventsOf(runId).find((e): e is ContentEvent => e.type === "content" && e.kind === "command-output");
  return out?.text ? Number(out.text.trim()) : undefined;
};

test("while a long command runs, status shows it as the step in progress, and cancel stops it and everything it started", async () => {
  const started = wf("start", "napper");
  await until("the command to start", () => commandStarted(started.runId));
  const child = await until("the command's child pid in the log", () => printedPid(started.runId));
  strays.push(child);
  assert.ok(alive(child));

  const state = wf("status", started.jobId);
  assert.equal(state.status, "running");
  assert.ok(state.recent.some((line: string) => /^▶ nap \[bash\]$/.test(line)), `the running command is in the progress lines: ${state.recent}`);

  const cancelledAt = performance.now();
  const cancelled = wf("cancel", started.jobId);
  assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
  assert.ok(performance.now() - cancelledAt < 10_000, `cancel took ${performance.now() - cancelledAt} ms: the job's process was free to answer the signal`);
  assert.match(cancelled.error, new RegExp(`resumeRunId="${started.runId}"`));
  const end = eventsOf(started.runId).findLast((e) => e.type === "exec-end");
  assert.ok(end && end.type === "exec-end" && end.outcome === "cancelled");
  await until("the command's child to be gone", () => !alive(child), 5_000);
  await until("the job's process to be gone", () => !alive(jobRecord(started.jobId).pid), 5_000);
});

test("a command that outlives its timeout fails its node, not the run: status shows how it ended", async () => {
  const started = wf("start", "overrun");
  const done = wf("wait", started.jobId, "--timeout", "60");
  assert.equal(done.status, "finished", JSON.stringify(done));
  assert.deepEqual(done.result, { status: "timed-out" });
  assert.ok(done.recent.some((line: string) => /^✗ nap \(timeout, 0\.\ds\)$/.test(line)), `the node's end is in the progress lines: ${done.recent}`);
});

test("a second SIGTERM ends the job at once and takes down the command that ignored the first one", async () => {
  const started = wf("start", "stubborn-nap");
  await until("the command to start", () => commandStarted(started.runId));
  const child = await until("the command's child pid in the log", () => printedPid(started.runId));
  strays.push(child);
  const { pid } = jobRecord(started.jobId);

  process.kill(pid, "SIGTERM"); // the command ignores SIGTERM: the run is stopping, for up to two seconds
  await until("the job to take the first signal", () => readFileSync(started.log, "utf8").includes("[wf] SIGTERM: cancelling the run"));
  assert.ok(alive(pid) && alive(child), "still stopping");
  process.kill(pid, "SIGTERM");
  await until("the job's process to exit", () => !alive(pid), 3_000);
  await until("the command's child to be gone", () => !alive(child), 3_000);
  const end = eventsOf(started.runId).findLast((e) => e.type === "run-end");
  assert.ok(end && end.type === "run-end" && end.status === "cancelled");
});
