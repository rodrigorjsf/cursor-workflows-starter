// Seam: HTTP. The Cancel action of the dashboard: a POST that needs the CSRF token and ends in the same function `wf cancel`
// and `cancel_workflow` call (`cancelJob`: SIGTERM to the job's process, then a wait for the run to end). The job's process
// is a real child process that behaves like the runtime's: on SIGTERM it writes the run's end, as cancelled, to the log.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type DashboardServer, startDashboard } from "../src/server.js";
import { type Reply, type Sandbox, http, logPath, sandbox, writeRun } from "./support.js";

let box: Sandbox;
let dash: DashboardServer;
const children: ChildProcess[] = [];

beforeEach(async () => {
  box = sandbox();
  dash = await startDashboard({ port: 0, cancelTimeoutMs: 4000 });
});
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await dash.close();
  box.dispose();
});

const START = "2026-11-12T10:00:00.000Z";

/**
 * A process standing in for a job's: its command line carries the job id (the runtime checks that before it signals a pid), and
 * on SIGTERM it appends the run's end to the log as cancelled, the way the runtime's signal handler ends a run. `graceMs` is how
 * long it takes to do so; a process that never gets to is `Infinity`.
 */
async function jobProcess(repo: string, runId: string, jobId: string, graceMs = 0): Promise<ChildProcess> {
  const script = `
    const { appendFileSync } = require("node:fs");
    const [jobId, log, runId, graceMs] = process.argv.slice(1);
    process.on("SIGTERM", () => {
      setTimeout(() => {
        appendFileSync(log, JSON.stringify({ v: 1, ts: new Date().toISOString(), runId, type: "run-end", status: "cancelled", error: "run cancelled by SIGTERM" }) + "\\n");
        process.exit(143);
      }, Number(graceMs));
    });
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", script, jobId, logPath(repo, runId), runId, String(graceMs)], { stdio: ["ignore", "pipe", "ignore"] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout!.once("data", () => resolve()); // the handler is installed
  });
  return child;
}

/** The job record `createJob` writes, naming the process that executes the job. */
function writeJobRecord(repo: string, jobId: string, runId: string, pid: number): void {
  const dir = join(repo, ".workflows", "jobs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${jobId}.json`), JSON.stringify({ jobId, runId, pid, heartbeat: new Date().toISOString() }));
}

/** A run that a job is executing: registered, logged, its record written, its process alive. */
async function runningJob(repo: string, runId: string, jobId: string, graceMs = 0): Promise<ChildProcess> {
  const child = await jobProcess(repo, runId, jobId, graceMs);
  writeRun(box.home, repo, { runId, workflow: "smoke", startedAt: START, phases: ["Ping"], jobId, events: [{ type: "phase", title: "Ping" }], lockedBy: child.pid });
  writeJobRecord(repo, jobId, runId, child.pid!);
  return child;
}

const exited = (child: ChildProcess) => new Promise<number | null>((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once("exit", (code) => resolve(code))));

async function token(): Promise<string> {
  const reply = await http(dash.url, "/api/csrf");
  assert.equal(reply.status, 200);
  return reply.json.csrfToken as string;
}

const cancel = (runId: string, headers: Record<string, string> = {}): Promise<Reply> => http(dash.url, `/api/runs/${runId}/cancel`, { method: "POST", headers });
const withToken = async (): Promise<Record<string, string>> => ({ "x-csrf-token": await token() });

test("the CSRF token is one random value per dashboard, handed to whoever can read an answer of this origin", async () => {
  const first = await http(dash.url, "/api/csrf");
  assert.equal(first.status, 200);
  assert.match(first.json.csrfToken, /^[0-9a-f]{64}$/);
  assert.equal(first.headers["cache-control"], "no-store");
  assert.equal(first.headers["access-control-allow-origin"], undefined, "another origin's script must not be able to read it");
  assert.equal((await http(dash.url, "/api/csrf")).json.csrfToken, first.json.csrfToken);

  const other = await startDashboard({ port: 0 });
  try {
    assert.notEqual((await http(other.url, "/api/csrf")).json.csrfToken, first.json.csrfToken);
  } finally {
    await other.close();
  }
  assert.equal((await http(dash.url, "/api/csrf", { host: "evil.example" })).status, 403, "the host check covers it");
});

test("cancel needs the CSRF token: without it, with a wrong one, or from another origin, nothing is signalled", async () => {
  const repo = box.repo("repo");
  const child = await runningJob(repo, "smoke-aaaa0001", "job-0001");
  const good = await token();
  const refused: Array<[string, Record<string, string>]> = [
    ["no token", {}],
    ["an empty token", { "x-csrf-token": "" }],
    ["a wrong token", { "x-csrf-token": "0".repeat(64) }],
    ["a token of another length", { "x-csrf-token": good.slice(0, 10) }],
    ["a foreign origin", { "x-csrf-token": good, origin: "https://evil.example" }],
    ["a foreign port on the loopback", { "x-csrf-token": good, origin: "http://127.0.0.1:1" }],
    ["a cross-site fetch", { "x-csrf-token": good, "sec-fetch-site": "cross-site" }],
  ];
  for (const [what, headers] of refused) {
    const reply = await cancel("smoke-aaaa0001", headers);
    assert.equal(reply.status, 403, what);
    assert.match(reply.json.error, /csrf/i, what);
  }
  const wrongHost = await http(dash.url, "/api/runs/smoke-aaaa0001/cancel", { method: "POST", host: "evil.example", headers: { "x-csrf-token": good } });
  assert.equal(wrongHost.status, 403);
  assert.equal(wrongHost.text, "host not allowed");

  assert.equal(child.exitCode, null, "the process was never signalled");
  assert.equal((await http(dash.url, "/api/runs/smoke-aaaa0001")).json.status, "running");
});

test("cancel with the token stops the job through cancelJob and moves the run to Cancelled", async () => {
  const repo = box.repo("repo");
  const child = await runningJob(repo, "smoke-aaaa0002", "job-0002");
  const board = async () => {
    const { cards } = (await http(dash.url, "/api/board")).json.boards[0] as { cards: Array<{ runId: string; column: string }> };
    return cards.filter((card) => card.runId === "smoke-aaaa0002").map((card) => card.column);
  };
  assert.deepEqual(await board(), ["phase:Ping"]);

  const reply = await cancel("smoke-aaaa0002", {
    ...(await withToken()),
    origin: dash.url, // a page of the dashboard itself
    "sec-fetch-site": "same-origin",
  });
  assert.equal(reply.status, 200, reply.text);
  assert.equal(reply.json.jobId, "job-0002");
  assert.equal(reply.json.runId, "smoke-aaaa0002");
  assert.equal(reply.json.status, "cancelled");
  assert.match(reply.json.note, /SIGTERM sent to process \d+/);
  assert.equal(await exited(child), 143, "the job's process got SIGTERM");
  assert.match(readFileSync(logPath(repo, "smoke-aaaa0002"), "utf8"), /"status":"cancelled"/);

  assert.equal((await http(dash.url, "/api/runs/smoke-aaaa0002")).json.status, "cancelled");
  assert.deepEqual(await board(), ["cancelled"]);
});

test("a job that is slow to stop is answered as still running, with what was done", async () => {
  const repo = box.repo("repo");
  const slow = await startDashboard({ port: 0, cancelTimeoutMs: 300 });
  try {
    const child = await runningJob(repo, "smoke-aaaa0003", "job-0003", 1500);
    const t = (await http(slow.url, "/api/csrf")).json.csrfToken as string;
    const reply = await http(slow.url, "/api/runs/smoke-aaaa0003/cancel", { method: "POST", headers: { "x-csrf-token": t } });
    assert.equal(reply.status, 200);
    assert.equal(reply.json.status, "running");
    assert.match(reply.json.note, /still stopping/);
    assert.equal(await exited(child), 143, "it does stop");
  } finally {
    await slow.close();
  }
});

test("a resumed run has one job per execution: only the one that is running is cancelled", async () => {
  const repo = box.repo("repo");
  const gone = await jobProcess(repo, "smoke-aaaa0004", "job-a-first"); // the process of the first execution, which has ended but is still there
  const child = await jobProcess(repo, "smoke-aaaa0004", "job-b-resume");
  // the run's log: the first execution (job-old) ended as failed, a resume (job-new) is running
  writeRun(box.home, repo, {
    runId: "smoke-aaaa0004",
    workflow: "smoke",
    startedAt: START,
    jobId: "job-a-first",
    events: [{ type: "run-end", status: "failed", error: "boom" }, { type: "run-start", workflow: "smoke", jobId: "job-b-resume" }],
    lockedBy: child.pid,
  });
  writeJobRecord(repo, "job-a-first", "smoke-aaaa0004", gone.pid!);
  writeJobRecord(repo, "job-b-resume", "smoke-aaaa0004", child.pid!);

  const reply = await cancel("smoke-aaaa0004", await withToken());
  assert.equal(reply.status, 200, reply.text);
  assert.equal(reply.json.jobId, "job-b-resume");
  assert.equal(await exited(child), 143);
  assert.equal(gone.exitCode, null, "the first execution's process was left alone");
});

test("cancel says why it did nothing: an unknown run, a run that is not running, a run no job executes", async () => {
  const repo = box.repo("repo");
  const headers = await withToken();

  const unknown = await cancel("smoke-nope0000", headers);
  assert.equal(unknown.status, 404);
  assert.match(unknown.json.error, /run not found/);

  writeRun(box.home, repo, { runId: "smoke-aaaa0005", workflow: "smoke", startedAt: START, events: [{ type: "run-end", status: "finished", outcomeStatus: "done", result: { status: "done" } }] });
  const finished = await cancel("smoke-aaaa0005", headers);
  assert.equal(finished.status, 409);
  assert.match(finished.json.error, /not running \(finished\)/);

  // `wf run` in a terminal: a process holds the run's lock, and there is no job record to signal
  const terminal = await jobProcess(repo, "smoke-aaaa0006", "no-job");
  writeRun(box.home, repo, { runId: "smoke-aaaa0006", workflow: "smoke", startedAt: START, events: [{ type: "phase", title: "Ping" }], lockedBy: terminal.pid });
  const unowned = await cancel("smoke-aaaa0006", headers);
  assert.equal(unowned.status, 409);
  assert.match(unowned.json.error, /not started as a job/);
  assert.match(unowned.json.error, /Ctrl-C/);
  assert.equal(terminal.exitCode, null, "no signal was sent");
  assert.equal((await http(dash.url, "/api/runs/smoke-aaaa0006")).json.status, "running");
  assert.equal(existsSync(join(repo, ".workflows", "jobs")), false, "looking for the run's job created nothing in the repo");
});

test("cancel does not bring back the state folder of a repo that is gone", async () => {
  const gone = join(box.repo("repo"), "deleted-checkout");
  writeRun(box.home, gone, { runId: "smoke-aaaa0007", workflow: "smoke", startedAt: START, withoutLog: true });
  const reply = await cancel("smoke-aaaa0007", await withToken());
  assert.ok(reply.status === 404 || reply.status === 409, `${reply.status} ${reply.text}`);
  assert.equal(existsSync(join(gone, ".workflows")), false);
});

test("only the cancel route accepts a POST; the cancel route accepts nothing else", async () => {
  for (const path of ["/api/runs", "/api/board", "/api/runs/smoke-aaaa0001", "/api/runs/smoke-aaaa0001/events", "/", "/api/csrf"]) {
    const reply = await http(dash.url, path, { method: "POST", headers: await withToken() });
    assert.equal(reply.status, 405, path);
    assert.equal(reply.headers["allow"], "GET, HEAD", path);
  }
  const get = await http(dash.url, "/api/runs/smoke-aaaa0001/cancel");
  assert.equal(get.status, 405);
  assert.equal(get.headers["allow"], "POST");
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const reply = await http(dash.url, "/api/runs/smoke-aaaa0001/cancel", { method, headers: await withToken() });
    assert.equal(reply.status, 405, method);
  }
});
