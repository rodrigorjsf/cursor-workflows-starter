// Seam: HTTP. The seams decision of the dashboard, `POST /api/runs/<runId>/seams/approve` and `.../seams/replace`, and the proposal that
// `GET /api/runs/<runId>` offers for it: the gate they share with cancel, the body each takes, and every state of a run that they refuse
// with a sentence. The runs are written the way the runtime writes them (a log that ends at the proposal, its progress file, a job
// record), and a refusal is asserted by what it leaves behind: no job record, no new execution. The decisions that start a job, with
// real job processes, are in seams.process.test.ts.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type DashboardServer, startDashboard } from "../src/server.js";
import { ECHO_WORKFLOW, type Reply, SEAMS_PLAN, type Sandbox, appendLog, eventLine, http, postWithToken, repoWithWorkflows, runDetail, sandbox, seamsProposedRun, writeRun } from "./support.js";

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

const RUN = "implement-issue-aaaa0001";
const START = "2026-11-12T10:00:00.000Z";

/** A repo the runs index knows. */
const knownRepo = (): string => repoWithWorkflows(box, "repo", { "echo.mjs": ECHO_WORKFLOW });

const approve = (runId: string, body: unknown, headers?: Record<string, string>): Promise<Reply> => postWithToken(dash.url, `/api/runs/${runId}/seams/approve`, headers, body);
const replace = (runId: string, body: unknown, headers?: Record<string, string>): Promise<Reply> => postWithToken(dash.url, `/api/runs/${runId}/seams/replace`, headers, body);
/** The job records of a repo: what a start leaves behind, which a refusal must not. */
const jobFiles = (repo: string): string[] => {
  try {
    return readdirSync(join(repo, ".workflows", "jobs"));
  } catch {
    return [];
  }
};
/** The digest the page would send: what the run's own detail says its proposal is. */
const digestOf = async (runId: string): Promise<string> => (await runDetail(dash.url, runId)).seamsProposal.digest;

test("a run that stopped at its seams proposal shows it in its detail: the seams, the slices, the test command, and the digest an approval names", async () => {
  const repo = knownRepo();
  seamsProposedRun(box, repo, RUN);
  const detail = await runDetail(dash.url, RUN);

  assert.equal(detail.status, "finished");
  const { digest, ...proposal } = detail.seamsProposal;
  assert.deepEqual(proposal, { stop: "seams-proposed", seams: SEAMS_PLAN.seams, slices: SEAMS_PLAN.slices, testCommand: SEAMS_PLAN.testCommand });
  assert.match(digest, /^[0-9a-f]{16}$/);
});

test("a run that waits for no decision shows no proposal: finished for good, failed, and a run of another workflow", async () => {
  const repo = knownRepo();
  writeRun(box.home, repo, { runId: "echo-aaaa0002", workflow: "echo", startedAt: START, events: [{ type: "run-end", status: "finished", outcomeStatus: "done", result: { status: "done" } }] });
  writeRun(box.home, repo, { runId: "echo-aaaa0003", workflow: "echo", startedAt: START, events: [{ type: "run-end", status: "failed", error: "boom" }] });
  writeRun(box.home, repo, { runId: "echo-aaaa0004", workflow: "echo", startedAt: START, events: [{ type: "run-end", status: "finished", outcomeStatus: "seams-proposed", result: { status: "seams-proposed" } }] });

  for (const runId of ["echo-aaaa0002", "echo-aaaa0003", "echo-aaaa0004"]) {
    const detail = await runDetail(dash.url, runId);
    assert.equal("seamsProposal" in detail, false, runId);
  }
});

test("a proposal at the test command is shown with the command the planner chose, as a proposal of its own", async () => {
  const repo = knownRepo();
  seamsProposedRun(box, repo, RUN, { stop: "test-command-proposed", plan: { ...SEAMS_PLAN, testCommand: "touch PWNED" } });
  const { seamsProposal } = await runDetail(dash.url, RUN);
  assert.equal(seamsProposal.stop, "test-command-proposed");
  assert.equal(seamsProposal.testCommand, "touch PWNED");
});

test("a test command the person typed when the run started is the one shown, because it is the one that runs", async () => {
  const repo = knownRepo();
  seamsProposedRun(box, repo, RUN, { start: { workflow: "implement-issue", args: { issue: 7, testCommand: "npm run mine" }, maxTokens: 1, maxCents: 1 } });
  assert.equal((await runDetail(dash.url, RUN)).seamsProposal.testCommand, "npm run mine");
});

test("approve and replace need the CSRF token and a same-origin request: without it, nothing is started", async () => {
  const repo = knownRepo();
  seamsProposedRun(box, repo, RUN);
  const digest = await digestOf(RUN);
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
    for (const [action, reply] of [["approve", await approve(RUN, { digest }, headers)], ["replace", await replace(RUN, { seams: ["math.negate(a)"] }, headers)]] as const) {
      assert.equal(reply.status, 403, `${action}: ${what}`);
      assert.match(reply.json.error, /csrf/i, `${action}: ${what}`);
    }
  }
  for (const action of ["approve", "replace"]) {
    const wrongHost = await http(dash.url, `/api/runs/${RUN}/seams/${action}`, { method: "POST", host: "evil.example", headers: { "x-csrf-token": good }, body: { digest, seams: ["a"] } });
    assert.equal(wrongHost.status, 403, action);
    assert.equal(wrongHost.text, "host not allowed", action);
  }

  assert.deepEqual(jobFiles(repo), ["job-0001.json"], "no job was started");
  assert.equal((await runDetail(dash.url, RUN)).executions, 1);
});

test("approve and replace are POST only", async () => {
  const repo = knownRepo();
  seamsProposedRun(box, repo, RUN);
  for (const action of ["approve", "replace"]) {
    const reply = await http(dash.url, `/api/runs/${RUN}/seams/${action}`);
    assert.equal(reply.status, 405, action);
    assert.equal(reply.headers.allow, "POST", action);
  }
});

test("a run the runs index does not know is not found", async () => {
  for (const reply of [await approve("implement-issue-nope0000", { digest: "0".repeat(16) }), await replace("implement-issue-nope0000", { seams: ["a"] })]) {
    assert.equal(reply.status, 404);
    assert.deepEqual(reply.json, { error: "run not found" });
  }
});

test("a run that waits for no decision is refused with 409 by both actions, and nothing is started", async () => {
  const repo = knownRepo();
  writeRun(box.home, repo, { runId: "implement-issue-aaaa0002", workflow: "implement-issue", startedAt: START, events: [{ type: "run-end", status: "finished", outcomeStatus: "done", result: { status: "done" } }] }); // delivered
  writeRun(box.home, repo, { runId: "implement-issue-aaaa0003", workflow: "implement-issue", startedAt: START, events: [{ type: "run-end", status: "failed", error: "boom" }] });
  const running = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); // a process that holds the run's lock: it runs
  children.push(running);
  writeRun(box.home, repo, { runId: "implement-issue-aaaa0004", workflow: "implement-issue", startedAt: START, lockedBy: running.pid });
  writeRun(box.home, repo, { runId: "implement-issue-aaaa0005", workflow: "implement-issue", startedAt: START, withoutLog: true });
  writeRun(box.home, repo, { runId: "echo-aaaa0006", workflow: "echo", startedAt: START, events: [{ type: "run-end", status: "finished", outcomeStatus: "seams-proposed", result: { status: "seams-proposed" } }] });
  const before = jobFiles(repo);

  for (const runId of ["implement-issue-aaaa0002", "implement-issue-aaaa0003", "implement-issue-aaaa0004", "implement-issue-aaaa0005", "echo-aaaa0006"]) {
    for (const [action, reply] of [["approve", await approve(runId, { digest: "0".repeat(16) })], ["replace", await replace(runId, { seams: ["math.negate(a)"] })]] as const) {
      assert.equal(reply.status, 409, `${action} ${runId}`);
      assert.match(reply.json.error, /^the run waits for no decision on its seams/, `${action} ${runId}`);
    }
  }
  assert.deepEqual(jobFiles(repo), before, "no job was started");
});

test("a run whose latest execution went on after the proposal waits for no decision: the second click of a double click is refused", async () => {
  const repo = knownRepo();
  seamsProposedRun(box, repo, RUN);
  const first = await runDetail(dash.url, RUN);
  assert.ok(first.seamsProposal, "the run waited for a decision");
  // a resume appended its `run-start` to the log: the latest execution is not at the proposal any more
  appendLog(repo, RUN, `${eventLine(RUN, "2026-11-12T10:05:00.000Z", { type: "run-start", workflow: "implement-issue", jobId: "job-0002" })}\n`);

  assert.equal((await runDetail(dash.url, RUN)).seamsProposal, undefined);
  const reply = await replace(RUN, { seams: ["a"] });
  assert.equal(reply.status, 409);
  assert.match(reply.json.error, /^the run waits for no decision on its seams/);
  assert.deepEqual(jobFiles(repo), ["job-0001.json"], "no job was started");
});

test("an approval that names another proposal than the run's is refused: a page cannot approve a plan it did not show", async () => {
  const repo = knownRepo();
  seamsProposedRun(box, repo, RUN);
  const shown = await digestOf(RUN);
  // the run was planned again since the page was loaded: its plan holds another test command
  seamsProposedRun(box, repo, "implement-issue-aaaa0008", { plan: { ...SEAMS_PLAN, testCommand: "touch PWNED" } });
  const other = await digestOf("implement-issue-aaaa0008");
  assert.notEqual(shown, other);

  const reply = await approve("implement-issue-aaaa0008", { digest: shown });
  assert.equal(reply.status, 409);
  assert.match(reply.json.error, /^the proposal changed since this page showed it/);
  assert.equal((await runDetail(dash.url, "implement-issue-aaaa0008")).executions, 1);
});

test("a run that no job started, or whose job record says nothing of how, is refused with the way to decide from the terminal", async () => {
  const repo = knownRepo();
  seamsProposedRun(box, repo, RUN, { start: undefined }); // a record an older kit wrote: no `start`
  const digest = await digestOf(RUN);
  const before = jobFiles(repo);

  for (const [action, reply] of [["approve", await approve(RUN, { digest })], ["replace", await replace(RUN, { seams: ["math.negate(a)"] })]] as const) {
    assert.equal(reply.status, 409, action);
    assert.match(reply.json.error, /^the run was not started as a job /, action);
    assert.match(reply.json.error, /relaunch command of the seams comment on the issue$/, action);
  }
  assert.deepEqual(jobFiles(repo), before, "no job was started");
});

test("an approval without its digest, or with one that is not text, is a bad request: it names no proposal", async () => {
  const repo = knownRepo();
  seamsProposedRun(box, repo, RUN);
  for (const [what, body] of [["no body", undefined], ["an empty body", ""], ["no digest", {}], ["a digest that is not text", { digest: 7 }], ["an empty digest", { digest: "" }], ["not JSON", "{"], ["an array", []]] as const) {
    const reply = await approve(RUN, body);
    assert.equal(reply.status, 400, what);
    assert.equal(typeof reply.json.error, "string", what);
  }
  assert.match((await approve(RUN, {})).json.error, /^digest is required/);
  assert.deepEqual(jobFiles(repo), ["job-0001.json"], "no job was started");
});

test("a replacement with no seams is a bad request, whatever way it is empty", async () => {
  const repo = knownRepo();
  seamsProposedRun(box, repo, RUN);
  for (const [what, body] of [["no seams key", {}], ["an empty list", { seams: [] }], ["blank entries only", { seams: ["", "   ", "\t"] }]] as const) {
    const reply = await replace(RUN, body);
    assert.equal(reply.status, 400, what);
    assert.match(reply.json.error, /^seams must list at least one seam/, what);
  }
  for (const [what, body] of [["no body", undefined], ["not JSON", "{"], ["an array", []]] as const) {
    const reply = await replace(RUN, body);
    assert.equal(reply.status, 400, what);
    assert.equal(typeof reply.json.error, "string", what);
  }
  assert.deepEqual(jobFiles(repo), ["job-0001.json"], "no job was started");
});

test("a replacement whose seams are not a list of text is a bad request", async () => {
  const repo = knownRepo();
  seamsProposedRun(box, repo, RUN);
  for (const [what, body] of [["a string", { seams: "math.negate(a)" }], ["numbers", { seams: [1, 2] }], ["a mixed list", { seams: ["a", null] }], ["objects", { seams: [{ name: "a" }] }]] as const) {
    const reply = await replace(RUN, body);
    assert.equal(reply.status, 400, what);
    assert.match(reply.json.error, /^seams must be a list of text/, what);
  }
});

test("a request body larger than the limit is refused, and nothing is started", async () => {
  const repo = knownRepo();
  seamsProposedRun(box, repo, RUN);
  const reply = await replace(RUN, { seams: ["x".repeat(100_000)] });
  assert.equal(reply.status, 400);
  assert.match(reply.json.error, /^the request body is larger than \d+ bytes/);
  assert.deepEqual(jobFiles(repo), ["job-0001.json"], "no job was started");
});
