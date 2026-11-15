// Seam: HTTP. The Resume action of the dashboard, `POST /api/runs/<runId>/resume`: the gate it shares with cancel, and every state of a
// run that it refuses to resume, each with a sentence. The runs are written the way the runtime writes them (a log, a job record), and
// the refusals are asserted by what they leave behind: no job record, no new execution. The resume that works, with real job processes,
// is in resume.process.test.ts.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { resumeRun } from "../run-view/run-actions.js";
import { type DashboardServer, startDashboard } from "../src/server.js";
import { ECHO_WORKFLOW, type Reply, type Sandbox, http, postWithToken, repoWithWorkflows, sandbox, writeJobRecord, writeRun } from "./support.js";

let box: Sandbox;
let dash: DashboardServer;
const children: ChildProcess[] = [];

beforeEach(async () => {
  box = sandbox();
  dash = await startDashboard({ port: 0 });
});
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await dash.close();
  box.dispose();
});

const START = "2026-11-12T10:00:00.000Z";
const CAPS = { maxTokens: 50_000, maxCents: 20 };
const FAILED = { type: "run-end", status: "failed", error: "boom" };

/** A repo the runs index knows, with the `echo` workflow, which takes an `issue`. */
const knownRepo = (): string => repoWithWorkflows(box, "repo", { "echo.mjs": ECHO_WORKFLOW });

const resume = (runId: string, headers?: Record<string, string>): Promise<Reply> => postWithToken(dash.url, `/api/runs/${runId}/resume`, headers);
const runOf = async (runId: string) => (await http(dash.url, `/api/runs/${runId}`)).json;
/** The job records of a repo: what a start leaves behind, which a refusal must not. */
const jobFiles = (repo: string): string[] => {
  try {
    return readdirSync(join(repo, ".workflows", "jobs"));
  } catch {
    return [];
  }
};

/** A process that stays until the test ends, standing in for the one that executes a run: it holds the run's lock where a fixture says so. `jobId` goes on its command line, as the runtime's job process has it (it checks that before it takes a pid for the job's). */
function liveProcess(...args: string[]): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args], { stdio: "ignore" });
  children.push(child);
  return child;
}

/** A run of `echo` that stopped (`events` end it), started by the job `job-0001`, whose record says `start`. */
function stoppedRun(repo: string, runId: string, start: unknown, events: Array<{ type: string } & Record<string, unknown>> = [FAILED]): void {
  writeRun(box.home, repo, { runId, workflow: "echo", startedAt: START, jobId: "job-0001", events });
  writeJobRecord(repo, { jobId: "job-0001", runId, start });
}

test("resume needs the CSRF token and a same-origin request: without it, nothing is started", async () => {
  const repo = knownRepo();
  stoppedRun(repo, "echo-aaaa0001", { workflow: "echo", args: { issue: 7 }, ...CAPS });
  const good = ((await http(dash.url, "/api/csrf")).json as { csrfToken: string }).csrfToken;
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
    const reply = await resume("echo-aaaa0001", headers);
    assert.equal(reply.status, 403, what);
    assert.match(reply.json.error, /csrf/i, what);
  }
  const wrongHost = await http(dash.url, "/api/runs/echo-aaaa0001/resume", { method: "POST", host: "evil.example", headers: { "x-csrf-token": good } });
  assert.equal(wrongHost.status, 403);
  assert.equal(wrongHost.text, "host not allowed");

  assert.deepEqual(jobFiles(repo), ["job-0001.json"], "no job was started");
  assert.equal((await runOf("echo-aaaa0001")).status, "failed");
});

test("a run the runs index does not know is not found", async () => {
  const reply = await resume("echo-nope0000");
  assert.equal(reply.status, 404);
  assert.deepEqual(reply.json, { error: "run not found" });
});

test("a run that is running, finished or unreadable is refused with its status: there is nothing to resume", async () => {
  const repo = knownRepo();
  writeRun(box.home, repo, { runId: "echo-aaaa0002", workflow: "echo", startedAt: START, lockedBy: liveProcess().pid }); // a process holds it: it runs
  stoppedRun(repo, "echo-aaaa0003", { workflow: "echo", args: { issue: 7 }, ...CAPS }, [{ type: "run-end", status: "finished" }]);
  writeRun(box.home, repo, { runId: "echo-aaaa0004", workflow: "echo", startedAt: START, withoutLog: true });
  const before = jobFiles(repo);

  for (const [runId, status] of [["echo-aaaa0002", "running"], ["echo-aaaa0003", "finished"], ["echo-aaaa0004", "missing"]] as const) {
    const reply = await resume(runId);
    assert.equal(reply.status, 409, runId);
    assert.equal(reply.json.error, `the run is ${status}; only a failed or cancelled run can be resumed`, runId);
  }
  assert.deepEqual(jobFiles(repo), before, "no job was started");
});

test("a run that no job started, or whose job record says nothing of how, is refused with the way to resume it from the terminal", async () => {
  const repo = knownRepo();
  writeRun(box.home, repo, { runId: "echo-aaaa0005", workflow: "echo", startedAt: START, events: [FAILED] }); // `wf run` in a terminal: its run-start names no job
  stoppedRun(repo, "echo-aaaa0006", undefined); // a record an older kit wrote: no `start`
  const before = jobFiles(repo);

  for (const runId of ["echo-aaaa0005", "echo-aaaa0006"]) {
    const reply = await resume(runId);
    assert.equal(reply.status, 409, runId);
    assert.match(reply.json.error, /^the run was not started as a job /, runId);
    assert.match(reply.json.error, /resume it from the terminal with the copied resume command$/, runId);
  }
  assert.deepEqual(jobFiles(repo), before, "no job was started");
});

test("a frozen run, whose process stopped beating but still holds it, is refused until it is cancelled", async () => {
  const repo = knownRepo();
  const frozen = liveProcess("job-0001"); // alive and holding the run, while its job record's heartbeat is long past
  writeRun(box.home, repo, { runId: "echo-aaaa0007", workflow: "echo", startedAt: START, jobId: "job-0001", lockedBy: frozen.pid });
  writeJobRecord(repo, { jobId: "job-0001", runId: "echo-aaaa0007", start: { workflow: "echo", args: { issue: 7 }, ...CAPS }, pid: frozen.pid });
  const shown = await runOf("echo-aaaa0007");
  assert.equal(shown.status, "failed", "the Run view shows a frozen run as failed");
  assert.match(shown.error, /^no heartbeat for /);

  const reply = await resume("echo-aaaa0007");
  assert.equal(reply.status, 409);
  assert.equal(reply.json.error, "the run's process stopped beating but still holds the run; cancel the run first, then resume it");
  assert.deepEqual(jobFiles(repo), ["job-0001.json"], "no job was started");
});

test("what the start path refuses on a start, it refuses on a resume: a workflow the repository no longer lists, args the workflow no longer accepts", async () => {
  const repo = knownRepo();
  writeRun(box.home, repo, { runId: "echo-aaaa0008", workflow: "retired", startedAt: START, jobId: "job-0008", events: [FAILED] });
  writeJobRecord(repo, { jobId: "job-0008", runId: "echo-aaaa0008", start: { workflow: "retired", args: {}, ...CAPS } });
  stoppedRun(repo, "echo-aaaa0009", { workflow: "echo", args: { issue: "seven" }, ...CAPS });
  const before = jobFiles(repo);

  const gone = await resume("echo-aaaa0008");
  assert.equal(gone.status, 409);
  assert.match(gone.json.error, /^the run's repository no longer lists its workflow; it lists: .*\becho\b/);
  const invalid = await resume("echo-aaaa0009");
  assert.equal(invalid.status, 409);
  assert.match(invalid.json.error, /^invalid args: .*\/issue must be integer/);
  assert.deepEqual(jobFiles(repo), before, "no job was started");
});

test("resume is a POST: a GET of its address is refused, and says which method is allowed", async () => {
  const reply = await http(dash.url, "/api/runs/echo-aaaa0001/resume");
  assert.equal(reply.status, 405);
  assert.equal(reply.headers.allow, "POST");
});

test("the browser's own client takes the token itself and reports a refusal as data, with the server's sentence", async () => {
  const repo = knownRepo();
  writeRun(box.home, repo, { runId: "echo-aaaa0010", workflow: "echo", startedAt: START, events: [FAILED] }); // no job started it
  assert.deepEqual(await resumeRun("echo-nope0000", dash.url), { ok: false, error: "run not found" });
  const terminal = await resumeRun("echo-aaaa0010", dash.url);
  assert.equal(terminal.ok, false);
  assert.match(terminal.ok ? "" : terminal.error, /resume it from the terminal with the copied resume command$/);
  const gone = await resumeRun("echo-aaaa0010", "http://127.0.0.1:1");
  assert.equal(gone.ok, false, "a dashboard that does not answer is data too");
  assert.match(gone.ok ? "" : gone.error, /^could not reach the dashboard: /);
});
