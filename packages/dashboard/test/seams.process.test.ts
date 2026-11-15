// Seam: HTTP, with the job as a real process. A decision on the proposed seams from the dashboard (`POST /api/runs/<runId>/seams/approve`
// and `.../seams/replace`) starts the runtime's own detached job process over the run that stopped at its proposal, with the args and caps
// its latest job was started with and the decision on top: `approveSeams: true`, or `seams: [...]`. The run is real: a stand-in for
// `implement-issue` (SEAMS_WORKFLOW, in the repo's `.agents/workflows/`, which shadows the kit's workflow of the name) is started through
// the dashboard, stops at its proposal as the real one does, and is decided; the tests wait for what the run's log and its job record say.
// The real workflow's side (the plan it stores, the comment it posts when it resumes) is tested in the runtime. Nothing reaches the Cursor API.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { waitFor } from "../../runtime/test/wait-for.js";
import { approveSeams, replaceSeams } from "../run-view/run-actions.js";
import { type DashboardServer, startDashboard } from "../src/server.js";
import { JOB_WAIT, SEAMS_WORKFLOW, type Sandbox, jobProcesses, jobRecordOf, postWithToken, repoWithWorkflows, runDetail, sandbox, startRequest } from "./support.js";

let box: Sandbox;
let dash: DashboardServer;
let jobs: ReturnType<typeof jobProcesses>;

beforeEach(async () => {
  box = sandbox();
  jobs = jobProcesses();
  dash = await startDashboard({ port: 0 });
});
afterEach(async () => {
  jobs.restore();
  await dash.close();
  box.dispose();
});

const CAPS = { maxTokens: 500_000, maxCents: 200 };

/** A repo the runs index knows, with a stand-in for `implement-issue`. */
const knownRepo = (): string => repoWithWorkflows(box, "repo", { "implement-issue.mjs": SEAMS_WORKFLOW });

const runOf = (runId: string) => runDetail(dash.url, runId);

/** Starts the stand-in through the dashboard for issue 7 with the caps, and waits until its run stopped at the seams proposal; returns the run and the proposal the page would show. */
async function proposed(repo: string, extra: Record<string, unknown> = {}) {
  const reply = await startRequest(dash.url, { repo, workflow: "implement-issue", args: { issue: 7, ...extra }, ...CAPS });
  assert.equal(reply.status, 202, reply.text);
  const { jobId, runId } = reply.json as { jobId: string; runId: string };
  jobs.track(repo, jobId);
  const shown = await waitFor("the run to stop at its seams proposal", async () => (await runOf(runId)).seamsProposal, JOB_WAIT);
  return { runId, jobId, shown };
}

/** Waits for the run's `n`th execution to end, and returns the run. */
const executionEnded = (runId: string, n: number) =>
  waitFor(`execution ${n} of the run to end`, async () => {
    const detail = await runOf(runId);
    return detail.executions === n && detail.status === "finished" ? detail : undefined;
  }, JOB_WAIT);

test("approving the proposal resumes the run with its args and caps plus approveSeams: true, and the run goes on", async () => {
  const repo = knownRepo();
  const { runId, jobId, shown } = await proposed(repo);
  assert.equal(shown.stop, "seams-proposed");

  const reply = await postWithToken(dash.url, `/api/runs/${runId}/seams/approve`, undefined, { digest: shown.digest });
  assert.equal(reply.status, 202, reply.text);
  assert.equal(reply.json.runId, runId, "the same run, not a new one");
  assert.notEqual(reply.json.jobId, jobId, "a decision is a new job");
  jobs.track(repo, reply.json.jobId);

  const gone = await executionEnded(runId, 2);
  assert.deepEqual(gone.result, { status: "done", args: { issue: 7, approveSeams: true } }, "the resumed run was given the decision and nothing else");
  assert.equal(gone.seamsProposal, undefined, "a run that went on waits for nothing");
  const recorded = { workflow: "implement-issue", args: { issue: 7, approveSeams: true }, ...CAPS };
  assert.deepEqual(jobRecordOf(repo, reply.json.jobId).start, recorded, "the new job's record keeps the caps it repeated");
});

test("replacing the seams resumes the run with seams: [...], the given ones trimmed, and the run plans again", async () => {
  const repo = knownRepo();
  const { runId } = await proposed(repo);

  const reply = await postWithToken(dash.url, `/api/runs/${runId}/seams/replace`, undefined, { seams: ["  math.negate(a)  ", "", "math.abs(a)"] });
  assert.equal(reply.status, 202, reply.text);
  jobs.track(repo, reply.json.jobId);

  const gone = await executionEnded(runId, 2);
  assert.equal(gone.result.status, "test-command-proposed", "with no test command typed, the planner's waits for a decision of its own");
  assert.deepEqual(jobRecordOf(repo, reply.json.jobId).start, { workflow: "implement-issue", args: { issue: 7, seams: ["math.negate(a)", "math.abs(a)"] }, ...CAPS });
});

test("a replacement stops again at the test command the planner chose, and approving that one runs the plan without the replaced seams", async () => {
  const repo = knownRepo();
  const { runId } = await proposed(repo);
  const replaced = await postWithToken(dash.url, `/api/runs/${runId}/seams/replace`, undefined, { seams: ["math.negate(a)"] });
  assert.equal(replaced.status, 202, replaced.text);
  jobs.track(repo, replaced.json.jobId);
  const stopped = await waitFor("the run to stop at the planner's test command", async () => {
    const detail = await runOf(runId);
    return detail.executions === 2 ? detail.seamsProposal : undefined;
  }, JOB_WAIT);
  assert.equal(stopped.stop, "test-command-proposed");
  assert.equal(stopped.testCommand, "echo chosen-by-the-planner");

  const approved = await postWithToken(dash.url, `/api/runs/${runId}/seams/approve`, undefined, { digest: stopped.digest });
  assert.equal(approved.status, 202, approved.text);
  jobs.track(repo, approved.json.jobId);
  const gone = await executionEnded(runId, 3);
  assert.deepEqual(gone.result.args, { issue: 7, approveSeams: true }, "the seams of the replacement are dropped, as the workflow's own relaunch line does: the stored plan holds them");
});

test("an approval of the first proposal, sent after the run stopped at another one, is refused and starts nothing", async () => {
  const repo = knownRepo();
  const { runId, shown } = await proposed(repo);
  const replaced = await postWithToken(dash.url, `/api/runs/${runId}/seams/replace`, undefined, { seams: ["math.negate(a)"] });
  jobs.track(repo, replaced.json.jobId);
  await waitFor("the run to stop at the planner's test command", async () => (await runOf(runId)).seamsProposal?.stop === "test-command-proposed", JOB_WAIT);

  const stale = await postWithToken(dash.url, `/api/runs/${runId}/seams/approve`, undefined, { digest: shown.digest });
  assert.equal(stale.status, 409, stale.text);
  assert.match(stale.json.error, /^the proposal changed since this page showed it/);
  assert.equal((await runOf(runId)).executions, 2, "no third execution");
});

test("a decision made through the browser's own client starts the job, and a second one on the same page is refused", async () => {
  const repo = knownRepo();
  const { runId, shown } = await proposed(repo);

  const sent = await approveSeams(runId, shown.digest, dash.url);
  assert.ok(sent.ok, sent.ok ? "" : sent.error);
  jobs.track(repo, sent.jobId);
  await executionEnded(runId, 2);

  const again = await approveSeams(runId, shown.digest, dash.url);
  assert.equal(again.ok, false);
  assert.match(again.ok ? "" : again.error, /^the run waits for no decision on its seams/);
  const replaced = await replaceSeams(runId, ["math.negate(a)"], dash.url);
  assert.equal(replaced.ok, false, "nor can the run be re-planned once it went on");
  assert.equal((await runOf(runId)).executions, 2, "the run was resumed once");
});
