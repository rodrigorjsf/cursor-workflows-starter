// Seam 2, the process: detached jobs, heartbeat and cancellation. The `wf` CLI and the MCP server are real child processes
// against the fake Cursor SDK, a temporary repo and a temporary home directory. A prompt with `[fake:hang]` makes the fake
// agent run hang until it is cancelled.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createJob } from "../src/runtime/jobs.js";
import { writeJob } from "../src/runtime/job-state.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";

const PACKAGE = join(import.meta.dirname, "..");
let sandbox: string;
let repo: string;
let env: Record<string, string>;
const strays: number[] = []; // processes the tests started and must not leave behind

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-detached-"));
  repo = join(sandbox, "repo");
  const workflow = (name: string, body: string) =>
    writeFileSync(join(repo, ".agents", "workflows", `${name}.mjs`), `export default {\n  meta: { name: "${name}", description: "${name} fixture" },\n  defaults: { model: { id: "m" } },\n  ${body}\n};\n`);
  mkdirSync(join(repo, ".agents", "workflows"), { recursive: true });
  // takes a while on its own, then finishes: lives longer than a killed MCP server
  workflow("delayed", `async run(ctx) { await new Promise((r) => setTimeout(r, 1500)); await ctx.agent("quick", { label: "q" }); return { status: "done" }; }`);
  // one step that hangs until the run is cancelled
  workflow("hold", `async run(ctx) { return ctx.agent("[fake:hang] hold", { label: "hold", retries: 0, timeoutMs: 120000 }); }`);
  // the same, but cancelling takes 5 s
  workflow("stubborn", `async run(ctx) { return ctx.agent("[fake:hang] [fake:slow-cancel] hold", { label: "hold", retries: 0, timeoutMs: 120000 }); }`);
  // a first step that completes, then a second that hangs (args.hang) or completes
  workflow(
    "twostep",
    `async run(ctx) { await ctx.agent("one", { label: "one" }); await ctx.agent(ctx.args.hang ? "[fake:hang] two" : "two", { label: "two", retries: 0, timeoutMs: 120000 }); return { status: "done" }; }`,
  );
  env = {
    ...(getDefaultEnvironment() as Record<string, string>),
    TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"),
    WF_HOME: join(sandbox, "home"),
    WF_METRICS: "off",
    WF_DASH_AUTOSTART: "off", // the tests must not leave a dashboard behind
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
  for (const stop = Date.now() + ms; ; await sleep(50)) {
    const value = read();
    if (value) return value;
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
  }
}

/** Runs `wf <args>` in the temporary repo and returns its stdout parsed as JSON. */
function wf(...args: string[]): Record<string, any> {
  const r = spawnSync(process.execPath, [...tsx("cli.ts"), ...args, "--cwd", repo], { env, encoding: "utf8" });
  return JSON.parse(r.stdout);
}
const jobRecord = (jobId: string) => JSON.parse(readFileSync(join(repo, ".workflows", "jobs", `${jobId}.json`), "utf8")) as { pid: number; runId: string; heartbeat: string };
const eventsOf = (runId: string) => readEventLog(eventLogPath(repo, runId)).events;
const stepStarted = (runId: string) => eventsOf(runId).some((e) => e.type === "step-start" && !e.cached && e.label === "hold");

/** Starts an MCP server, hands `use` a way to call its tools and the server's pid, and closes it (which kills it) afterwards. */
async function withServer<T>(use: (call: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>, serverPid: number) => Promise<T>): Promise<T> {
  const client = new Client({ name: "detached-test", version: "0.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: tsx("mcp-server.ts"), cwd: repo, env });
  try {
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text) as Record<string, any>;
    return await use(call, transport.pid!);
  } finally {
    await client.close();
  }
}

test("start_workflow runs the job in a detached process: killing the MCP server leaves the run going, and a restarted server reports it", async () => {
  const { jobId, serverPid } = await withServer(async (call, serverPid) => {
    const started = await call("start_workflow", { name: "delayed" });
    assert.match(started.jobId, /^[0-9a-f]{8}$/);
    return { jobId: started.jobId as string, serverPid };
  }); // the server is gone from here on
  await until("the MCP server to be gone", () => !alive(serverPid));

  const record = jobRecord(jobId);
  assert.notEqual(record.pid, serverPid, "the job belongs to its own process, not to the server");
  assert.ok(alive(record.pid), "the run outlived the server");

  const state = await withServer(async (call) => {
    let current = await call("get_workflow_status", { jobId });
    for (const stop = Date.now() + 40_000; current.status === "running" && Date.now() < stop; ) current = await call("wait_workflow", { jobId, timeoutSec: 5 });
    return current;
  });
  assert.equal(state.status, "finished", JSON.stringify(state));
  assert.deepEqual(state.result, { status: "done" });
});

test("wf cancel stops the active agent run and marks the job cancelled; the run is resumable and reuses its finished steps", async () => {
  const started = wf("start", "twostep", "--args", '{"hang":true}');
  await until("the second step to start", () => eventsOf(started.runId).some((e) => e.type === "step-start" && e.label === "two"));

  const cancelled = wf("cancel", started.jobId);
  assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
  assert.equal(cancelled.runId, started.runId);
  assert.match(cancelled.error, new RegExp(`resumeRunId="${started.runId}"`));
  assert.equal(wf("status", started.jobId).status, "cancelled");
  assert.deepEqual(wf("jobs").find((j: any) => j.jobId === started.jobId)?.status, "cancelled");
  const stepEnd = eventsOf(started.runId).findLast((e) => e.type === "step-end");
  assert.ok(stepEnd && stepEnd.type === "step-end" && stepEnd.errorKind === "cancelled");
  await until("the job's process to be gone", () => !alive(jobRecord(started.jobId).pid));

  const resumed = wf("start", "twostep", "--args", "{}", "--resume", started.runId);
  const done = wf("wait", resumed.jobId, "--timeout", "60");
  assert.equal(done.status, "finished", JSON.stringify(done));
  assert.ok(done.recent.includes("✓ one (journal)"), `the finished step was not repeated: ${done.recent}`);
});

test("cancel_workflow cancels from another MCP server than the one that started the job", async () => {
  const jobId = await withServer(async (call) => (await call("start_workflow", { name: "hold" })).jobId as string);
  const runId = jobRecord(jobId).runId;
  await until("the step to start", () => stepStarted(runId));

  const result = await withServer(async (call) => {
    const tools = await call("get_workflow_status", { jobId });
    assert.equal(tools.status, "running");
    return call("cancel_workflow", { jobId });
  });
  assert.equal(result.status, "cancelled", JSON.stringify(result));
  assert.equal(result.runId, runId);
  assert.deepEqual((await withServer((call) => call("wait_workflow", { jobId, timeoutSec: 5 }))).status, "cancelled");
});

test("cancelling a job that already ended changes nothing and says so; an unknown job is an error", () => {
  const started = wf("start", "twostep", "--args", "{}");
  const done = wf("wait", started.jobId, "--timeout", "60");
  assert.equal(done.status, "finished");
  const again = wf("cancel", started.jobId);
  assert.equal(again.status, "finished");
  assert.match(again.note, /already ended/);
  // An unknown job is an error like any other: one line on stderr (the MCP server's wording first), nothing on stdout, exit 1.
  for (const args of [["cancel", "nope"], ["wait", "nope", "--timeout", "0"], ["status", "nope"]]) {
    const r = spawnSync(process.execPath, [...tsx("cli.ts"), ...args, "--cwd", repo], { env, encoding: "utf8" });
    assert.equal(r.status, 1, `${args[0]}: ${r.stderr}`);
    assert.equal(r.stdout, "", args[0]);
    assert.equal(r.stderr, "job not found: nope\n", args[0]);
  }
});

test("cancel does not signal a process that is not the job's (a recycled pid)", async () => {
  const bystander = spawn("sleep", ["60"], { stdio: "ignore" });
  strays.push(bystander.pid!);
  const record = createJob(repo, "hold", { runId: "run-recycled", jobId: "recycled" }); // fresh heartbeat, a live pid... that is not a job process
  writeJob(repo, { ...record, pid: bystander.pid! });

  const result = wf("cancel", "recycled");
  assert.equal(result.status, "running");
  assert.match(result.note, /is not the job's process/);
  assert.ok(alive(bystander.pid!), "the bystander was left alone");
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`${signal} on a job's process does the same as cancel: the run is cancelled, the job says so, nothing is left running`, async () => {
    const started = wf("start", "hold");
    await until("the step to start", () => stepStarted(started.runId));
    const { pid } = jobRecord(started.jobId);

    process.kill(pid, signal);
    const state = await until("the job to be cancelled", () => {
      const s = wf("status", started.jobId);
      return s.status === "running" ? undefined : s;
    });
    assert.equal(state.status, "cancelled", JSON.stringify(state));
    await until("the process to exit", () => !alive(pid));
    const end = eventsOf(started.runId).findLast((e) => e.type === "run-end");
    assert.ok(end && end.type === "run-end" && end.status === "cancelled");
    assert.equal(eventsOf(started.runId).filter((e) => e.type === "step-end").length, 1, "the step was ended in the log");
  });
}

test("Ctrl-C on a foreground `wf run` cancels the run, prints the outcome and exits 130", async () => {
  const proc: ChildProcess = spawn(process.execPath, [...tsx("cli.ts"), "run", "hold", "--cwd", repo], { env, stdio: ["ignore", "pipe", "pipe"] });
  strays.push(proc.pid!);
  let stdout = "";
  let stderr = "";
  proc.stdout!.on("data", (c: Buffer) => (stdout += c));
  proc.stderr!.on("data", (c: Buffer) => (stderr += c));
  await until("the step to start", () => /"type":"step-start"/.test(stderr));
  const exited = new Promise<number | null>((resolve) => proc.once("exit", resolve));
  proc.kill("SIGINT");
  assert.equal(await exited, 130);
  const outcome = JSON.parse(stdout);
  assert.equal(outcome.status, "cancelled");
  assert.match(outcome.error, /resumeRunId=/);
});

test("a second signal while the run is still stopping ends the process at once, with the run closed as cancelled in its log", async () => {
  const started = wf("start", "stubborn");
  await until("the step to start", () => stepStarted(started.runId));
  const { pid } = jobRecord(started.jobId);

  process.kill(pid, "SIGTERM"); // the fake agent run takes 5 s to cancel
  await until("the job to take the first signal", () => readFileSync(started.log, "utf8").includes("[wf] SIGTERM: cancelling the run"));
  assert.ok(alive(pid), "still stopping");
  const signalledAt = Date.now();
  process.kill(pid, "SIGTERM");
  await until("the process to exit", () => !alive(pid), 3000);
  assert.ok(Date.now() - signalledAt < 3000);
  const end = eventsOf(started.runId).findLast((e) => e.type === "run-end");
  assert.ok(end && end.type === "run-end" && end.status === "cancelled", "the log says cancelled, not a crash");
  assert.equal(wf("status", started.jobId).status, "cancelled");
});

test("a frozen job (alive, heartbeat stale) shows as failed with its run id; cancel kills it, and the run can then be resumed", async () => {
  const started = wf("start", "twostep", "--args", '{"hang":true}');
  await until("the second step to start", () => eventsOf(started.runId).some((e) => e.type === "step-start" && e.label === "two"));
  const { pid } = jobRecord(started.jobId);

  process.kill(pid, "SIGSTOP"); // the whole process stops: no step progress, no heartbeat
  const staleAfter = { ...env, WF_HEARTBEAT_STALE_MS: "1500" }; // the readers' threshold, so the test need not wait 30 s
  const read = (...args: string[]) => JSON.parse(spawnSync(process.execPath, [...tsx("cli.ts"), ...args, "--cwd", repo], { env: staleAfter, encoding: "utf8" }).stdout) as Record<string, any>;
  const frozen = await until("the job to show as failed", () => {
    const state = read("status", started.jobId);
    return state.status === "failed" ? state : undefined;
  });
  assert.equal(frozen.runId, started.runId);
  assert.match(frozen.error, /no heartbeat/);
  assert.match(frozen.error, new RegExp(`resumeRunId="${started.runId}"`));
  assert.ok(alive(pid), "the process is still there, holding the run");

  const cancelled = read("cancel", started.jobId);
  assert.match(cancelled.note, /killed \(SIGKILL\)/);
  assert.ok(!alive(pid));
  const resumed = wf("start", "twostep", "--args", "{}", "--resume", started.runId);
  const done = wf("wait", resumed.jobId, "--timeout", "60");
  assert.equal(done.status, "finished", `the stale lock of the killed process does not block the resume: ${JSON.stringify(done)}`);
});

test("a --timeout that is not a number of seconds is an error, not a wait that returns at once", () => {
  for (const command of ["wait", "cancel"]) {
    const r = spawnSync(process.execPath, [...tsx("cli.ts"), command, "anyjob", "--timeout", "soon", "--cwd", repo], { env, encoding: "utf8" });
    assert.equal(r.status, 2, `${command}: a usage error`);
    assert.match(r.stderr, /--timeout must be a number of seconds/, command);
  }
});
