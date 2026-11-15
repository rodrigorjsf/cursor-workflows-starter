// Seam: HTTP, with the job as a real process. A resume from the dashboard (`POST /api/runs/<runId>/resume`) starts the runtime's own
// detached job process over the same run, with the args, caps and overrides the run's latest job was started with. The runs are real:
// a workflow file in a throwaway repo, started through the dashboard or `wf start`, stopped by a cancel (or by its own throw), then
// resumed; the tests wait for what the run's log and its job record say. Nothing reaches the Cursor API (the job gets the fake SDK).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { waitFor } from "../../runtime/test/wait-for.js";
import { resumeRun } from "../run-view/run-actions.js";
import { type DashboardServer, startDashboard } from "../src/server.js";
import { JOB_WAIT, RESUMABLE_WORKFLOW, type Sandbox, eventsOfRun, http, jobPidOf, jobProcesses, postWithToken, processAlive, repoWithWorkflows, sandbox, startRequest } from "./support.js";

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

/** Caps with room: the fake SDK charges 9 cents an attempt, and a resumed run starts from what the first execution spent. */
const CAPS = { maxTokens: 500_000, maxCents: 200 };

/** A repo the runs index knows, with the `resumable` workflow. */
const knownRepo = (): string => repoWithWorkflows(box, "repo", { "resumable.mjs": RESUMABLE_WORKFLOW });

const runOf = async (runId: string) => (await http(dash.url, `/api/runs/${runId}`)).json;
const jobRecordOf = (repo: string, jobId: string) => JSON.parse(readFileSync(join(repo, ".workflows", "jobs", `${jobId}.json`), "utf8")) as { start?: unknown };

/** Starts `resumable` through the dashboard with `args` and the caps, and returns where its run is. */
async function startThroughDashboard(repo: string, args: Record<string, unknown>) {
  const reply = await startRequest(dash.url, { repo, workflow: "resumable", args, ...CAPS });
  assert.equal(reply.status, 202, reply.text);
  const { jobId, runId } = reply.json as { jobId: string; runId: string };
  jobs.track(repo, jobId);
  return { jobId, runId };
}

/** Cancels the run through the dashboard once its second step runs, and waits until the run says `cancelled` and its job's process is gone, so that the run's lock is free for a resume. */
async function cancelOnceHanging(repo: string, run: { jobId: string; runId: string }): Promise<void> {
  await waitFor("the second step to start", () => eventsOfRun(repo, run.runId).some((e) => e.type === "step-start" && e.label === "two"), JOB_WAIT);
  const cancelled = await postWithToken(dash.url, `/api/runs/${run.runId}/cancel`);
  assert.equal(cancelled.status, 200, cancelled.text);
  await waitFor("the run to be cancelled", async () => (await runOf(run.runId)).status === "cancelled", JOB_WAIT);
  await waitFor("the cancelled job's process to be gone", () => !processAlive(jobPidOf(repo, run.jobId)), JOB_WAIT);
}

test("resuming a cancelled run that was started as a job starts a job over the same run with the recorded args and caps, and the run goes back to running", async () => {
  const repo = knownRepo();
  const first = await startThroughDashboard(repo, { hang: true });
  await cancelOnceHanging(repo, first);

  const reply = await postWithToken(dash.url, `/api/runs/${first.runId}/resume`);
  assert.equal(reply.status, 202, reply.text);
  const { jobId, runId } = reply.json as { jobId: string; runId: string };
  jobs.track(repo, jobId);
  assert.equal(runId, first.runId, "the same run, not a new one");
  assert.notEqual(jobId, first.jobId, "a resume is a new job");

  const resumed = await waitFor("the resumed run to be running", async () => {
    const detail = await runOf(first.runId);
    return detail.status === "running" && detail.executions === 2 ? detail : undefined;
  }, JOB_WAIT);
  const recorded = { workflow: "resumable", args: { hang: true }, ...CAPS };
  assert.deepEqual(jobRecordOf(repo, jobId).start, recorded, "the new job's record keeps the start it repeated");
  assert.deepEqual(resumed.start, recorded, "the run's latest start is the resume's");

  const [, secondStart] = eventsOfRun(repo, first.runId).filter((e) => e.type === "run-start");
  assert.deepEqual([secondStart!.config.limits.maxTokens, secondStart!.config.limits.maxCents], [CAPS.maxTokens, CAPS.maxCents], "the resumed execution runs under the recorded caps");
  const stepOnes = eventsOfRun(repo, first.runId).filter((e) => e.type === "step-start" && e.label === "one");
  assert.deepEqual(stepOnes.map((e) => Boolean(e.cached)), [false, true], "the step that finished before the cancel is replayed from the journal, not run again");
});

test("a failed run is resumed the same way: a new execution of the same run, with the recorded args", async () => {
  const repo = knownRepo();
  const first = await startThroughDashboard(repo, { fail: true });
  await waitFor("the run to fail", async () => (await runOf(first.runId)).status === "failed", JOB_WAIT);
  await waitFor("the failed job's process to be gone", () => !processAlive(jobPidOf(repo, first.jobId)), JOB_WAIT);

  // through the browser's own client (it takes the CSRF token itself), as the Resume button does
  const resumed = await resumeRun(first.runId, dash.url);
  assert.ok(resumed.ok, resumed.ok ? "" : resumed.error);
  jobs.track(repo, resumed.jobId);

  const again = await waitFor("the second execution to fail the same way", async () => {
    const detail = await runOf(first.runId);
    return detail.executions === 2 && detail.status === "failed" ? detail : undefined;
  }, JOB_WAIT);
  assert.equal(again.runId, first.runId);
  assert.deepEqual(again.start, { workflow: "resumable", args: { fail: true }, ...CAPS });
});

test("a run started from a terminal with caps and overrides resumes with all three: the job record is what a resume repeats", async () => {
  const repo = knownRepo();
  const cli = join(import.meta.dirname, "..", "..", "runtime", "src", "cli.ts");
  const started = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), cli, "start", "resumable", "--args", '{"hang":true}', "--cwd", repo, "--max-cents", "300", "--max-tokens", "600000", "--overrides", '{"maxCents":100}'],
    { encoding: "utf8", env: process.env },
  );
  assert.equal(started.status, 0, started.stderr);
  const first = JSON.parse(started.stdout) as { jobId: string; runId: string };
  jobs.track(repo, first.jobId);
  await cancelOnceHanging(repo, first);

  const reply = await postWithToken(dash.url, `/api/runs/${first.runId}/resume`);
  assert.equal(reply.status, 202, reply.text);
  const { jobId } = reply.json as { jobId: string };
  jobs.track(repo, jobId);

  await waitFor("the resumed run to be running", async () => {
    const detail = await runOf(first.runId);
    return detail.status === "running" && detail.executions === 2;
  }, JOB_WAIT);
  const recorded = { workflow: "resumable", args: { hang: true }, maxCents: 300, maxTokens: 600_000, overrides: { maxCents: 100 } };
  assert.deepEqual(jobRecordOf(repo, jobId).start, recorded);
  const [, secondStart] = eventsOfRun(repo, first.runId).filter((e) => e.type === "run-start");
  assert.deepEqual([secondStart!.config.limits.maxTokens, secondStart!.config.limits.maxCents], [600_000, 100], "the override still tightens the cap the flag gave");
});
