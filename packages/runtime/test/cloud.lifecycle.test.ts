// Seam 1, the run, for the life of a cloud step: `runWorkflow` with the fake Cursor SDK in cloud mode (which keeps cloud agents
// on a fake server that outlives the process talking to it), a temp repository and a temporary bare repository as its `origin`.
// It holds what makes a cloud step survive the machine: the agent's id in the event log the moment the agent exists, a resume
// that picks the running agent up instead of starting another, a cancellation that reaches the cloud, and a client wait limit
// that is a reattach point. The assertions are on the outcome, the agents the SDK was asked for, the replayed log and the remote.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import "./isolate-home.js";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { calls, cloudRunsOf, costConfig, finishCloudRun, forgetCloudAgent, killCloudClients, lookups, resetCloud, resumes, script, stats } from "@cursor/sdk";
import { createCloudBackend } from "../src/runtime/backend-cloud.js";
import { openDb } from "../src/observability/db.js";
import { reconcile } from "../src/observability/queries.js";
import { runWorkflow } from "../src/runtime/engine.js";
import { cancelRun } from "../src/runtime/run-cancel.js";
import { cancelJob, readJob, writeJob } from "../src/runtime/job-state.js";
import { listRuns, readRun } from "../src/runtime/run-view.js";
import { isAlive } from "../src/runtime/pid.js";
import { createJob } from "../src/runtime/jobs.js";
import type { WorkflowEvent } from "../src/runtime/events.js";
import { abortOpenRuns, eventLogPath, readEventLog, runDirIn } from "../src/runtime/run-store.js";
import { applyGc, directCommands, formatPlan, planGc } from "../workflows/implement-issue/gc.js";
import { clearConfig, configWorkflow, writeGlobalConfig } from "./config-fixtures.js";
import { agentCommits, git, remoteBranches, repoWithRemote } from "./cloud-fixtures.js";
import { ageRunLog } from "./run-fixtures.js";

const root = join(import.meta.dirname, ".tmp", `cloud-lifecycle-${process.pid}`);
const cwd = join(root, "repo");
const remote = join(root, "origin.git");

beforeEach(() => {
  repoWithRemote(cwd, remote);
  writeGlobalConfig({ caps: { allowedLocations: ["local", "cloud"] }, workflows: { cfg: { roles: { review: { location: "cloud" } } } } });
});
afterEach(() => {
  clearConfig(cwd);
  rmSync(root, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
  resetCloud();
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0, cancels: 0, cancelled: 0, turnsDelivered: 0, sends: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined, cloudWaitLimitMs: undefined, lookupFailures: undefined, listRunsDelayMs: undefined });
});

const READ = ["read", "grep"] as const;
const logOf = (runId: string) => readEventLog(eventLogPath(cwd, runId)).events;
const ofType = <T extends WorkflowEvent["type"]>(events: WorkflowEvent[], type: T) => events.filter((e): e is Extract<WorkflowEvent, { type: T }> => e.type === type);
/** The workflow of one read-only cloud step on the `review` role. */
const reviewStep = (extra: Record<string, unknown> = {}) => configWorkflow((ctx) => ctx.agent<string>("look", { role: "review", label: "look", tools: [...READ], retries: 0, ...extra }));

test("the cloud agent's id is in the event log as soon as the agent exists, while its step is still running", async () => {
  let atSend: WorkflowEvent[] = [];
  script.push(() => {
    atSend = logOf("life-1"); // the agent has its message now: the step has not ended
    return { result: "done" };
  });
  const r = await runWorkflow(reviewStep(), {}, { cwd, runId: "life-1" });

  assert.equal(r.status, "finished", r.error);
  assert.equal(ofType(atSend, "step-end").length, 0, "the step was still running");
  const [agent] = ofType(atSend, "cloud-agent");
  assert.ok(agent, "the log already had the agent");
  const [start] = ofType(atSend, "step-start");
  assert.deepEqual([agent.agentId, agent.attemptId, agent.stepId, agent.reattached], ["bc-1", start!.attemptId, start!.stepId, undefined]);
  assert.match(agent.snapshot!.branch, /^wf\/cloud-snapshot\/life-1\/[0-9a-f]{8}$/, "and the snapshot branch the agent starts from, which a resume has to clean up");
  assert.equal(agent.snapshot!.remote, "origin");
  assert.equal(ofType(logOf("life-1"), "step-end")[0]!.agentId, "bc-1", "the step's end names the same agent");
});

/** Waits (up to 5 s) until `condition` holds. */
async function until(condition: () => boolean, what: string) {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(condition(), `timed out waiting for ${what}`);
}

/**
 * Starts `runId` with a cloud agent that never finishes by itself, then "kills the process": the execution is abandoned, as a
 * crash would leave it (its client never hears from the cloud again, its lock is stale), while the agent goes on in the cloud.
 * `end()` lets the abandoned execution unwind, so that nothing outlives the test.
 */
async function crashWhileTheAgentRuns(runId: string, workflow = reviewStep(), jobId?: string) {
  script.push(() => ({ hang: true }));
  const abandoned = new AbortController();
  const execution = runWorkflow(workflow, {}, { cwd, runId, signal: abandoned.signal, jobId });
  const end = async () => {
    abandoned.abort();
    await execution;
  };
  try {
    await until(() => ofType(logOf(runId), "cloud-agent").length === 1 && stats.sends === 1, "the cloud agent to have its message");
  } catch (err) {
    await end(); // nothing may outlive a test that failed here
    throw err;
  }
  killCloudClients();
  rmSync(join(runDirIn(cwd, runId), "run.lock"));
  return { agent: ofType(logOf(runId), "cloud-agent")[0]!, end };
}

test("a resume after a crash reattaches to the cloud agent that is still running instead of creating another, pays for it once, and cleans up the snapshot the crash left", async () => {
  const crashed = await crashWhileTheAgentRuns("life-2");
  try {
    assert.equal(crashed.agent.agentId, "bc-1");
    assert.equal(remoteBranches(remote).length, 1, "the crash left the snapshot branch on the remote");
    const tokensBefore = ofType(logOf("life-2"), "turn").length;
    assert.ok(tokensBefore > 0, "and a turn the dead process had counted, which the ledger holds as spent");
    setTimeout(() => finishCloudRun("bc-1", { result: "from the survivor" }), 60); // the agent finishes while the new process waits

    const r = await runWorkflow(reviewStep(), {}, { cwd, runId: "life-2" });

    assert.equal(r.status, "finished", r.error);
    assert.equal(r.result, "from the survivor", "the answer of the run that was already going");
    assert.equal(calls.length, 1, "no second cloud agent");
    assert.deepEqual(resumes, ["bc-1"]);
    assert.equal(stats.sends, 1, "the step's prompt was not sent again");
    assert.deepEqual([r.spentTokens, r.spentCents], [110, 9], "the agent is paid once: the dead attempt's turns are not added to its usage");
    assert.deepEqual(remoteBranches(remote), [], "the snapshot the dead process left is deleted when the step ends");
    assert.equal(stats.active, 1, "only the zombie's agent object is left (it is not ours to dispose)");

    const second = logOf("life-2").slice(logOf("life-2").findLastIndex((e) => e.type === "run-start"));
    const [again] = ofType(second, "cloud-agent");
    assert.deepEqual([again!.agentId, again!.reattached, again!.snapshot], ["bc-1", true, crashed.agent.snapshot], "the log says this attempt took the agent over, and keeps its snapshot for a second crash");
    const [closed, ended] = ofType(second, "step-end");
    assert.deepEqual([closed!.attemptId, closed!.ok, closed!.chargedCents, closed!.agentId], [crashed.agent.attemptId, false, 0, "bc-1"], "the dead attempt is closed, uncharged");
    assert.deepEqual([ended!.ok, ended!.agentId, ended!.attemptId === crashed.agent.attemptId], [true, "bc-1", false]);
    assert.ok(second.some((e) => e.type === "warning" && /reattached to cloud agent bc-1/.test(e.message)), "and the user is told");
  } finally {
    await crashed.end();
  }
});

test("a reattached cloud agent is charged once in the metrics database, also after a reconcile: the dead attempt it closed is final at no cost", async () => {
  const crashed = await crashWhileTheAgentRuns("life-cost");
  const dbPath = join(root, "metrics.db");
  try {
    setTimeout(() => finishCloudRun("bc-1", { result: "from the survivor" }), 60);
    process.env.WF_METRICS = "on";
    const r = await runWorkflow(reviewStep(), {}, { cwd, runId: "life-cost", metricsDb: dbPath });
    process.env.WF_METRICS = "off";
    assert.equal(r.status, "finished", r.error);

    const db = await openDb(dbPath);
    try {
      const charged = () => (db.prepare("SELECT SUM(charged_cents) AS cents FROM attempts WHERE agent_id = 'bc-1'").get() as { cents: number }).cents;
      assert.equal(charged(), 7, "the attempt that took the agent over pays for its whole usage");
      assert.deepEqual(await reconcile(db), { updated: 0, failed: 0 }, "nothing is left for a reconcile to charge");
      assert.equal(charged(), 7, "so the agent is still paid once");
    } finally {
      db.close();
    }
  } finally {
    process.env.WF_METRICS = "off";
    await crashed.end();
  }
});

test("a reattached step's log holds what the agent answered, as a message: the run it took over has no stream, so the step log would show nothing of the agent", async () => {
  const crashed = await crashWhileTheAgentRuns("life-msg");
  try {
    setTimeout(() => finishCloudRun("bc-1", { result: "from the survivor" }), 60);
    const r = await runWorkflow(reviewStep(), {}, { cwd, runId: "life-msg" });
    assert.equal(r.status, "finished", r.error);

    const events = logOf("life-msg");
    const second = events.slice(events.findLastIndex((e) => e.type === "run-start"));
    const [takeover] = ofType(second, "cloud-agent");
    const said = ofType(second, "content").filter((e) => e.kind === "agent-message");
    assert.deepEqual(said.map((e) => [e.attemptId, e.text]), [[takeover!.attemptId, "from the survivor"]], "one message, in the attempt that took the agent over");
  } finally {
    await crashed.end();
  }
});

test("a resume finds the answer of a cloud agent that finished while no process was watching, without sending anything", async () => {
  const crashed = await crashWhileTheAgentRuns("life-3");
  try {
    finishCloudRun("bc-1", { result: "done while away" });
    const r = await runWorkflow(reviewStep(), {}, { cwd, runId: "life-3" });

    assert.equal(r.status, "finished", r.error);
    assert.equal(r.result, "done while away");
    assert.deepEqual([calls.length, stats.sends, resumes], [1, 1, ["bc-1"]]);
    assert.deepEqual(remoteBranches(remote), []);
  } finally {
    await crashed.end();
  }
});

test("a write step that crashed and is resumed takes its agent over and brings the commits the agent made while no process was watching into the worktree", async () => {
  writeGlobalConfig({ caps: { allowedLocations: ["local", "cloud"] }, workflows: { cfg: { roles: { classify: { location: "cloud" } } } } });
  const writeStep = () => configWorkflow((ctx) => ctx.agent<string>("write it", { role: "classify", label: "write", retries: 0 }));
  const crashed = await crashWhileTheAgentRuns("life-w", writeStep());
  try {
    assert.ok(crashed.agent.snapshot!.commit, "the log keeps the commit the agent started from: what the resume checks the worktree against");
    agentCommits(remote, crashed.agent.snapshot!.branch, { "c.txt": "c\n" }, "agent: add c"); // the agent kept working in the cloud
    finishCloudRun("bc-1", { result: "done while away" });

    const r = await runWorkflow(writeStep(), {}, { cwd, runId: "life-w" });

    assert.equal(r.status, "finished", r.error);
    assert.deepEqual([calls.length, stats.sends, resumes], [1, 1, ["bc-1"]], "the same agent, and nothing sent again");
    assert.equal(readFileSync(join(cwd, "c.txt"), "utf8"), "c\n");
    assert.deepEqual(git(cwd, "log", "--format=%s").trim().split("\n"), ["agent: add c", "init"]);
    assert.deepEqual(remoteBranches(remote), [], "the branch the dead process left goes after the work is fetched");
  } finally {
    await crashed.end();
  }
});

/** What `wf gc` does with the cloud snapshot branches of `remote` with its defaults: a day of grace, and a failed run kept for 14 days. */
const gcSnapshots = async () => {
  const commands = directCommands();
  const plan = await planGc({ cwd, commands, failedAfterDays: 14, snapshots: { remote: "origin", graceHours: 24 } });
  await applyGc(plan, commands);
  return plan;
};

test("wf gc keeps the snapshot branch of a run cut off in the middle of its cloud step: the resume still needs the agent's work on it", async () => {
  writeGlobalConfig({ caps: { allowedLocations: ["local", "cloud"] }, workflows: { cfg: { roles: { classify: { location: "cloud" } } } } });
  const writeStep = () => configWorkflow((ctx) => ctx.agent<string>("write it", { role: "classify", label: "write", retries: 0 }));
  const crashed = await crashWhileTheAgentRuns("life-gc", writeStep());
  try {
    const branch = crashed.agent.snapshot!.branch;
    agentCommits(remote, branch, { "c.txt": "c\n" }, "agent: add c"); // the agent's work is on the snapshot branch, and nowhere else
    const stale = "wf/cloud-snapshot/life-gc/00000000"; // a branch of an earlier step of the same run, which the remote refused to delete
    git(cwd, "push", "-q", "origin", `HEAD:refs/heads/${stale}`);
    ageRunLog(cwd, "life-gc", 3); // past the grace period: only the cut-off step holds the branch

    const kept = await gcSnapshots();
    assert.deepEqual(kept.errors, []);
    assert.deepEqual(kept.remove.map((x) => x.actions.map((a) => a.target)), [[stale]], "the branch of the step that ended is swept, the one of the cut-off step is not");
    assert.deepEqual(remoteBranches(remote), [branch], "gc left the branch");
    assert.match(kept.kept.find((k) => k.branch === branch)?.why ?? "", /cut off in the middle of the cloud step this branch belongs to \(agent bc-1\).*reattaches/);
    assert.match(formatPlan(kept), /kept: branch wf\/cloud-snapshot\/life-gc\/[0-9a-f]{8} on origin: run life-gc was cut off/);

    finishCloudRun("bc-1", { result: "done while away" });
    const r = await runWorkflow(writeStep(), {}, { cwd, runId: "life-gc" });
    assert.equal(r.status, "finished", r.error);
    assert.equal(readFileSync(join(cwd, "c.txt"), "utf8"), "c\n", "the resume still found the agent's work on the branch gc kept");
    assert.deepEqual(remoteBranches(remote), [], "and deleted the branch itself when the step ended");
  } finally {
    await crashed.end();
  }
});

test("wf gc sweeps the snapshot branch of a run that was cut off in its cloud step and never resumed, once its last event is older than gcFailedAfterDays", async () => {
  const crashed = await crashWhileTheAgentRuns("life-gc-old");
  try {
    const branch = crashed.agent.snapshot!.branch;
    ageRunLog(cwd, "life-gc-old", 30);

    const plan = await gcSnapshots();
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.remove.map((x) => [x.runId, x.reason, x.actions.map((a) => [a.target, a.remote, a.result])]), [["life-gc-old", "snapshot", [[branch, "origin", "removed"]]]]);
    assert.deepEqual(remoteBranches(remote), [], "the branch nobody will resume is gone from the remote");
  } finally {
    await crashed.end();
  }
});

test("wf gc keeps, however old, the snapshot branch of a run that was cancelled in the middle of its cloud step: gc keeps a cancelled run because it can be resumed", async () => {
  const crashed = await crashWhileTheAgentRuns("life-gc-cancelled");
  try {
    const branch = crashed.agent.snapshot!.branch;
    abortOpenRuns(() => "cancelled by a second signal", "cancelled"); // the forced stop of a job: the log ends with the run and without the step's end
    assert.deepEqual(ofType(logOf("life-gc-cancelled"), "run-end").map((e) => e.status), ["cancelled"]);
    assert.equal(ofType(logOf("life-gc-cancelled"), "step-end").length, 0, "the step never ended");
    ageRunLog(cwd, "life-gc-cancelled", 60);

    const plan = await gcSnapshots();
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.remove, []);
    assert.deepEqual(remoteBranches(remote), [branch]);
    assert.match(plan.kept.find((k) => k.branch === branch)?.why ?? "", /run life-gc-cancelled was cancelled in the middle of the cloud step this branch belongs to \(agent bc-1\).*can be resumed/);
  } finally {
    await crashed.end();
  }
});

test("a cloud agent the cloud no longer has is replaced by a new one, and both snapshots are cleaned up", async () => {
  const crashed = await crashWhileTheAgentRuns("life-4");
  try {
    forgetCloudAgent("bc-1"); // the first message never reached it, or it was deleted
    const r = await runWorkflow(reviewStep(), {}, { cwd, runId: "life-4" });

    assert.equal(r.status, "finished", r.error);
    assert.deepEqual([calls.length, resumes], [2, ["bc-1"]], "it asked for the old agent first, then created another");
    const second = logOf("life-4").slice(logOf("life-4").findLastIndex((e) => e.type === "run-start"));
    assert.ok(second.some((e) => e.type === "warning" && e.message.includes("cloud agent bc-1, left by an interrupted attempt, is no longer there: starting a new one")));
    const [fresh] = ofType(second, "cloud-agent");
    assert.deepEqual([fresh!.agentId, fresh!.reattached], ["bc-2", undefined]);
    assert.notEqual(fresh!.snapshot!.branch, crashed.agent.snapshot!.branch, "from a snapshot of its own");
    assert.deepEqual(remoteBranches(remote), [], "the branch the crash left and the one this attempt pushed are both gone");
    assert.deepEqual([r.spentTokens, r.spentCents], [220, 9], "what the lost agent's turns reported was real spend and stays counted, next to the new agent's");
    const [closed] = ofType(second, "step-end");
    assert.deepEqual([closed!.attemptId, closed!.ok, closed!.usage?.totalTokens, closed!.agentId], [crashed.agent.attemptId, false, 110, "bc-1"], "the dead attempt closes with the tokens it had reported");
    assert.match(closed!.error!, /replaced its cloud agent bc-1/);
  } finally {
    await crashed.end();
  }
});

test("a cloud agent that cannot be reached is not replaced: the attempt fails and the next one reattaches to the same agent", async () => {
  const crashed = await crashWhileTheAgentRuns("life-5");
  try {
    finishCloudRun("bc-1", { result: "done while away" });
    costConfig.lookupFailures = 1; // the cloud is unreachable for the first lookup only
    const r = await runWorkflow(reviewStep({ retries: 1 }), {}, { cwd, runId: "life-5" });

    assert.equal(r.status, "finished", r.error);
    assert.equal(r.result, "done while away");
    assert.deepEqual([calls.length, resumes], [1, ["bc-1", "bc-1"]], "no second agent was paid for");
    const second = logOf("life-5").slice(logOf("life-5").findLastIndex((e) => e.type === "run-start"));
    const ends = ofType(second, "step-end");
    assert.deepEqual(ends.map((e) => e.ok), [false, false, true], "the attempt that could not reach the agent, the dead one (closed once an attempt had the agent), the one that did");
    assert.match(ends[0]!.error!, /could not reattach to cloud agent bc-1: service unavailable/);
    assert.equal(ends[1]!.attemptId, crashed.agent.attemptId);
    assert.deepEqual(remoteBranches(remote), []);
  } finally {
    await crashed.end();
  }
});

const VERDICT = { type: "object", required: ["verdict"], properties: { verdict: { enum: ["pass", "fail"] } } };

test("a reattached agent whose answer is not a valid result gets the usual follow-up, in its own conversation", async () => {
  const crashed = await crashWhileTheAgentRuns("life-6", reviewStep({ schema: VERDICT }));
  try {
    finishCloudRun("bc-1", { result: "I looked, it passes." }); // no JSON block
    const followUps: string[] = [];
    script.push((_o, msg) => {
      followUps.push(msg);
      return { result: 'Sorry.\n```json\n{"verdict": "pass"}\n```' };
    });
    const r = await runWorkflow(reviewStep({ schema: VERDICT }), {}, { cwd, runId: "life-6" });

    assert.equal(r.status, "finished", r.error);
    assert.deepEqual(r.result, { verdict: "pass" });
    assert.deepEqual([calls.length, stats.sends], [1, 2], "one more message, to the agent that was resumed");
    assert.match(followUps[0]!, /there is no fenced json code block/);
    assert.equal(ofType(logOf("life-6"), "step-end").at(-1)!.schemaReprompts, 1);
  } finally {
    await crashed.end();
  }
});

test("cancelling a run cancels its cloud agents: every running cloud run is cancelled, waited for, and its snapshot deleted", async () => {
  const controller = new AbortController();
  script.push(() => ({ hang: true }), () => ({ hang: true }));
  const workflow = configWorkflow((ctx) => ctx.parallel([() => ctx.agent("one", { role: "review", label: "one", tools: [...READ], retries: 0 }), () => ctx.agent("two", { role: "review", label: "two", tools: [...READ], retries: 0 })]));
  const running = runWorkflow(workflow, {}, { cwd, runId: "life-7", signal: controller.signal });
  await until(() => stats.sends === 2, "both cloud agents to be running");
  assert.equal(remoteBranches(remote).length, 2);
  controller.abort();
  const r = await running;

  assert.equal(r.status, "cancelled");
  assert.equal(stats.cancelled, 2, "both cloud runs were cancelled");
  assert.deepEqual([cloudRunsOf("bc-1").map((x) => x.status), cloudRunsOf("bc-2").map((x) => x.status)], [["cancelled"], ["cancelled"]], "and the cloud agrees");
  const ends = ofType(logOf("life-7"), "step-end");
  assert.deepEqual(ends.map((e) => [e.ok, e.errorKind, e.agentId]).sort(), [[false, "cancelled", "bc-1"], [false, "cancelled", "bc-2"]]);
  assert.deepEqual(remoteBranches(remote), []);
  assert.equal(stats.active, 0);
});

test("a cloud agent the run reattached to is cancelled with the run", async () => {
  const crashed = await crashWhileTheAgentRuns("life-8");
  try {
    const controller = new AbortController();
    const resumed = runWorkflow(reviewStep(), {}, { cwd, runId: "life-8", signal: controller.signal });
    await until(() => ofType(logOf("life-8"), "cloud-agent").length === 2, "the run to reattach");
    controller.abort();
    const r = await resumed;

    assert.equal(r.status, "cancelled");
    assert.equal(stats.cancelled, 1, "the cloud run was cancelled by the new process");
    assert.deepEqual(cloudRunsOf("bc-1").map((x) => x.status), ["cancelled"]);
    assert.deepEqual(remoteBranches(remote), [], "the snapshot the crash left is deleted too");
    const [closed, cancelled] = ofType(logOf("life-8").slice(logOf("life-8").findLastIndex((e) => e.type === "run-start")), "step-end");
    assert.deepEqual([closed!.errorKind, cancelled!.errorKind, cancelled!.agentId], ["exception", "cancelled", "bc-1"]);
  } finally {
    await crashed.end();
  }
});

test("cancelling a run whose process died cancels the cloud agent it left running: nothing keeps spending after the user stops", async () => {
  const crashed = await crashWhileTheAgentRuns("life-dead");
  try {
    const outcome = await cancelRun("life-dead", 100);

    assert.deepEqual(outcome, { kind: "not-running", status: "failed", cancelledAgents: ["bc-1"] }, "no process to signal, but the cloud agent is reached through the Cursor API");
    assert.deepEqual(cloudRunsOf("bc-1").map((x) => x.status), ["cancelled"], "and the cloud agrees");
    assert.equal(stats.cancelled, 1);
  } finally {
    await crashed.end();
  }
});

for (const retries of [0, 1]) {
  test(`a resume after a crash and a cancel starts a new cloud agent: the agent the crash left was cancelled, so there is nothing to reattach to (retries ${retries})`, async () => {
    const runId = `life-cancel-resume-${retries}`;
    const crashed = await crashWhileTheAgentRuns(runId, reviewStep({ retries }));
    try {
      assert.deepEqual((await cancelRun(runId, 100)).cancelledAgents, ["bc-1"]);
      script.push(() => ({ result: "fresh answer" }));

      const r = await runWorkflow(reviewStep({ retries }), {}, { cwd, runId });

      assert.equal(r.status, "finished", r.error);
      assert.equal(r.result, "fresh answer");
      const second = logOf(runId).slice(logOf(runId).findLastIndex((e) => e.type === "run-start"));
      assert.deepEqual(ofType(second, "cloud-agent").map((e) => [e.agentId, e.reattached]), [["bc-2", undefined]], "one new agent, no attempt spent on the cancelled one");
      assert.ok(second.some((e) => e.type === "warning" && e.message.includes("cloud agent bc-1, left by an interrupted attempt, was cancelled: starting a new one")));
      const [closed, ended] = ofType(second, "step-end");
      assert.deepEqual([closed!.attemptId, closed!.ok, closed!.agentId], [crashed.agent.attemptId, false, "bc-1"], "the dead attempt is closed");
      assert.match(closed!.error!, /replaced its cloud agent bc-1/);
      assert.deepEqual([ended!.ok, ended!.agentId], [true, "bc-2"]);
      assert.ok(!second.some((e) => e.type === "step-end" && /run cancelled/.test(e.error ?? "")), "no attempt fails on the cancelled run");
      assert.deepEqual(remoteBranches(remote), [], "both snapshots are cleaned up");
    } finally {
      await crashed.end();
    }
  });
}

test("wf cancel of a job whose process died cancels the cloud agent its run left running, and says so", async () => {
  const crashed = await crashWhileTheAgentRuns("life-dead-job");
  try {
    const dead = spawnSync("true").pid!; // a pid that no process holds any more: the job's process crashed
    createJob(cwd, "cfg", { runId: "life-dead-job", jobId: "dead-job", pid: dead });

    const result = await cancelJob(cwd, "dead-job", 100);

    assert.equal(result!.status, "failed");
    assert.match(result!.note, /already ended .*; cancelled the cloud agent it left running: bc-1/);
    assert.deepEqual(cloudRunsOf("bc-1").map((x) => x.status), ["cancelled"]);
  } finally {
    await crashed.end();
  }
});

/** Makes a heartbeat older than 50 ms stale for the readers, so a test need not wait 30 s. Returns what puts the threshold back. */
function staleAfter50ms(): () => void {
  const staleBefore = process.env.WF_HEARTBEAT_STALE_MS;
  process.env.WF_HEARTBEAT_STALE_MS = "50";
  return () => {
    if (staleBefore === undefined) delete process.env.WF_HEARTBEAT_STALE_MS;
    else process.env.WF_HEARTBEAT_STALE_MS = staleBefore;
  };
}

/** Writes the run's lock as process `pid` holds it: what a process that executes the run leaves while it does. */
const holdLock = (runId: string, pid: number) =>
  writeFileSync(join(runDirIn(cwd, runId), "run.lock"), JSON.stringify({ pid, token: `held-${pid}`, startedAt: new Date().toISOString(), runId }));

/**
 * After `crashWhileTheAgentRuns`, the job of the run as a frozen process leaves it: alive (SIGSTOP) with its job id on its
 * command line, holding the run's lock as a real one does, and a heartbeat older than `WF_HEARTBEAT_STALE_MS`, so `cancelJob`
 * kills it with SIGKILL.
 */
function frozenJob(runId: string, jobId: string) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", jobId], { stdio: "ignore" });
  const restore = staleAfter50ms();
  writeJob(cwd, { jobId, runId, pid: child.pid!, heartbeat: new Date(Date.now() - 60_000).toISOString() });
  holdLock(runId, child.pid!);
  return {
    pid: child.pid!,
    freeze: () => process.kill(child.pid!, "SIGSTOP"),
    end: () => {
      if (isAlive(child.pid!)) process.kill(child.pid!, "SIGKILL"); // a stopped process outlives a failed test otherwise
      restore();
    },
  };
}

/** A live process that is no job's: `sleep`, standing in for whatever got a dead job's pid, or for a new execution's process. */
function bystander() {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  return { pid: child.pid!, end: () => isAlive(child.pid!) && process.kill(child.pid!, "SIGKILL") };
}

test("a run that resumes a crashed job is running in the run view while the new execution holds its lock, before it writes its run-start", async () => {
  const runId = "life-resume-window";
  const crashed = await crashWhileTheAgentRuns(runId, reviewStep(), "crashed-job"); // the latest run-start names crashed-job
  const restore = staleAfter50ms();
  const resuming = bystander();
  try {
    const dead = spawnSync("true").pid!;
    writeJob(cwd, { jobId: "crashed-job", runId, pid: dead, heartbeat: new Date(Date.now() - 60 * 60_000).toISOString() });
    holdLock(runId, resuming.pid); // the resume has taken the run, and not yet announced itself

    const shown = readRun(runId)!;

    assert.equal(shown.status, "running", shown.error);
    assert.equal(shown.error, undefined);
    assert.equal(listRuns().find((r) => r.runId === runId)!.status, "running");
  } finally {
    resuming.end();
    restore();
    await crashed.end();
  }
});

test("a crashed job whose pid another process got is not frozen: cancelling its run cancels the cloud agent the crash left, and leaves that process alone", async () => {
  const runId = "life-pid-reused";
  const crashed = await crashWhileTheAgentRuns(runId, reviewStep(), "reused-job");
  const restore = staleAfter50ms();
  const other = bystander();
  try {
    writeJob(cwd, { jobId: "reused-job", runId, pid: other.pid, heartbeat: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(readRun(runId)!.status, "failed");
    const error = readJob(cwd, "reused-job")!.error!;
    assert.match(error, /^process \d+ ended without finishing the job/, "wf status says the job ended");
    assert.doesNotMatch(error, /no heartbeat/, "never the frozen job's wording, which readers act on");

    const outcome = await cancelRun(runId, 1000);

    assert.deepEqual(outcome, { kind: "not-running", status: "failed", cancelledAgents: ["bc-1"] });
    assert.deepEqual(cloudRunsOf("bc-1").map((x) => x.status), ["cancelled"], "nothing keeps spending");
    assert.ok(isAlive(other.pid), "the process that got the pid was left alone");
  } finally {
    other.end();
    restore();
    await crashed.end();
  }
});

for (const heartbeat of ["stale", "fresh"] as const) {
  test(`wf cancel of a job whose pid another process got (heartbeat ${heartbeat}) cancels the cloud agent its run left, and sends no signal`, async () => {
    const runId = `life-reused-cancel-${heartbeat}`;
    const crashed = await crashWhileTheAgentRuns(runId);
    const restore = staleAfter50ms();
    const other = bystander();
    try {
      const at = heartbeat === "stale" ? Date.now() - 60_000 : Date.now() + 60_000; // "fresh" stays fresh for the whole test
      writeJob(cwd, { jobId: `reused-${heartbeat}`, runId, pid: other.pid, heartbeat: new Date(at).toISOString() });

      const result = await cancelJob(cwd, `reused-${heartbeat}`, 100);

      assert.match(result!.note, /; cancelled the cloud agent it left running: bc-1$/);
      assert.deepEqual(cloudRunsOf("bc-1").map((x) => x.status), ["cancelled"]);
      assert.ok(isAlive(other.pid), "no signal reached the process that got the pid");
    } finally {
      other.end();
      restore();
      await crashed.end();
    }
  });
}

test("cancel_workflow of a frozen job kills its process and cancels the cloud agent its run left: nothing keeps spending after the user stops, and a resume pays for a new agent", async () => {
  const crashed = await crashWhileTheAgentRuns("life-frozen");
  const job = frozenJob("life-frozen", "frozen-job");
  try {
    await until(() => isAlive(job.pid), "the job's process to start");
    job.freeze();

    const killed = await cancelJob(cwd, "frozen-job", 3000);

    assert.equal(isAlive(job.pid), false, "the frozen process is gone");
    assert.equal(killed!.status, "failed", "a killed job never wrote its run's end: it stays failed");
    assert.match(killed!.note, /^process \d+ had no heartbeat and was killed \(SIGKILL\) without undoing the step in progress; the run stays resumable; cancelled the cloud agent it left running: bc-1$/);
    assert.deepEqual(cloudRunsOf("bc-1").map((x) => x.status), ["cancelled"], "the agent stops in the cloud too");
    assert.equal(stats.cancelled, 1);

    // The accepted cost of stopping everything: the resume finds the agent cancelled and starts a new one.
    script.push(() => ({ result: "fresh answer" }));
    const r = await runWorkflow(reviewStep(), {}, { cwd, runId: "life-frozen" });

    assert.equal(r.status, "finished", r.error);
    assert.equal(r.result, "fresh answer");
    const second = logOf("life-frozen").slice(logOf("life-frozen").findLastIndex((e) => e.type === "run-start"));
    assert.deepEqual(ofType(second, "cloud-agent").map((e) => [e.agentId, e.reattached]), [["bc-2", undefined]], "one new agent");
    assert.ok(second.some((e) => e.type === "warning" && e.message.includes("cloud agent bc-1, left by an interrupted attempt, was cancelled: starting a new one")));
  } finally {
    job.end();
    await crashed.end();
  }
});

test("a second cancel_workflow on a frozen job that was killed finds nothing left to cancel: the first one already stopped its cloud agents", async () => {
  const crashed = await crashWhileTheAgentRuns("life-frozen-stop");
  const job = frozenJob("life-frozen-stop", "frozen-stop");
  try {
    await until(() => isAlive(job.pid), "the job's process to start");
    job.freeze();
    await cancelJob(cwd, "frozen-stop", 3000);

    const again = await cancelJob(cwd, "frozen-stop", 100);

    assert.equal(again!.status, "failed", "a dead job stays failed");
    assert.equal(again!.note, "the job already ended (failed); nothing to cancel");
    assert.deepEqual(cloudRunsOf("bc-1").map((x) => x.status), ["cancelled"]);
    assert.equal(stats.cancelled, 1, "nothing is cancelled twice");
  } finally {
    job.end();
    await crashed.end();
  }
});

test("a frozen run is failed in the run view with wf status's error, and cancelling it there kills its process and cancels the cloud agent it left", async () => {
  const runId = "life-frozen-view";
  const crashed = await crashWhileTheAgentRuns(runId, reviewStep(), "frozen-view");
  const job = frozenJob(runId, "frozen-view");
  try {
    await until(() => isAlive(job.pid), "the job's process to start");
    job.freeze();

    const noHeartbeat = new RegExp(`^no heartbeat for \\d+s \\(process ${job.pid}\\); relaunch with resumeRunId="${runId}"$`);
    assert.equal(readJob(cwd, "frozen-view")!.status, "failed");
    assert.match(readJob(cwd, "frozen-view")!.error!, noHeartbeat);
    const shown = readRun(runId)!;
    assert.equal(shown.status, "failed", "the run view says what wf status says");
    assert.match(shown.error!, noHeartbeat);
    assert.equal(listRuns().find((r) => r.runId === runId)!.status, "failed", "and so does the list of runs");

    const outcome = await cancelRun(runId, 3000);

    assert.equal(outcome.kind, "signalled", "the frozen process is still there: it is killed, not passed over");
    assert.match(outcome.kind === "signalled" ? outcome.result.note : "", /killed \(SIGKILL\) .*; cancelled the cloud agent it left running: bc-1$/);
    assert.equal(isAlive(job.pid), false);
    assert.deepEqual(cloudRunsOf("bc-1").map((x) => x.status), ["cancelled"]);
    assert.equal(readRun(runId)!.status, "failed");
    assert.match(readRun(runId)!.error!, /ended without finishing it/, "with the process gone, the run is failed for that reason");
  } finally {
    job.end();
    await crashed.end();
  }
});

test("the client's wait limit is a reattach point, not a failure: the step keeps waiting for the same agent and the same run", async () => {
  costConfig.cloudWaitLimitMs = 30; // the real limit is two hours
  script.push(() => ({ hang: true }));
  const backend = createCloudBackend({ remote: "origin", runId: "life-9", waitFloorMs: 0 }); // no pause between waits: the limit here is 30 ms, not two hours
  const running = runWorkflow(reviewStep(), {}, { cwd, runId: "life-9", backend });
  await until(() => stats.sends === 1, "the cloud agent to have its message");
  setTimeout(() => finishCloudRun("bc-1", { result: "after several waits" }), 150);
  const r = await running;

  assert.equal(r.status, "finished", r.error);
  assert.equal(r.result, "after several waits");
  assert.deepEqual([calls.length, stats.sends, resumes], [1, 1, []], "one agent, one message, no new agent");
  assert.ok(lookups.filter((l) => l.kind === "getRun").length >= 2, "the run was looked up again more than once");
  assert.deepEqual(ofType(logOf("life-9"), "step-end").map((e) => [e.ok, e.errorKind]), [[true, undefined]]);
});

test("a run the cloud itself reports as failed is a failed step even when the client's wait limit came first", async () => {
  costConfig.cloudWaitLimitMs = 30;
  script.push(() => ({ hang: true }));
  const backend = createCloudBackend({ remote: "origin", runId: "life-10", waitFloorMs: 0 });
  const running = runWorkflow(reviewStep(), {}, { cwd, runId: "life-10", backend });
  await until(() => stats.sends === 1, "the cloud agent to have its message");
  setTimeout(() => finishCloudRun("bc-1", { status: "error", error: { message: "the VM died" } }), 100);
  const r = await running;

  assert.equal(r.status, "failed");
  assert.match(r.error!, /run error: the VM died/);
  assert.equal(calls.length, 1, "nothing was started again");
});

test("a cloud agent that could not be reached on any attempt is still the step's agent on the next resume: nothing was closed, so no second agent is created", async () => {
  const crashed = await crashWhileTheAgentRuns("life-11");
  try {
    costConfig.lookupFailures = 2; // both attempts of the step meet an unreachable cloud
    const failed = await runWorkflow(reviewStep({ retries: 1 }), {}, { cwd, runId: "life-11" });
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, /could not reattach to cloud agent bc-1/);
    assert.equal(calls.length, 1, "no replacement was started");
    const afterFailure = logOf("life-11").slice(logOf("life-11").findLastIndex((e) => e.type === "run-start"));
    assert.ok(!ofType(afterFailure, "step-end").some((e) => e.attemptId === crashed.agent.attemptId), "the dead attempt is not closed: the agent is still the step's");

    finishCloudRun("bc-1", { result: "answered meanwhile" });
    const resumed = await runWorkflow(reviewStep(), {}, { cwd, runId: "life-11" });
    assert.equal(resumed.status, "finished", resumed.error);
    assert.equal(resumed.result, "answered meanwhile");
    assert.deepEqual([calls.length, resumed.spentTokens], [1, 110], "still one agent, paid once");
  } finally {
    await crashed.end();
  }
});

test("cancelling a run while it looks for the interrupted agent cancels the run that agent is in", async () => {
  const crashed = await crashWhileTheAgentRuns("life-12");
  try {
    costConfig.listRunsDelayMs = 250; // the lookup is still in flight when the user cancels
    const controller = new AbortController();
    const resumed = runWorkflow(reviewStep(), {}, { cwd, runId: "life-12", signal: controller.signal });
    await until(() => lookups.some((l) => l.kind === "listRuns"), "the run to look the agent up");
    controller.abort();
    const r = await resumed;

    assert.equal(r.status, "cancelled");
    assert.deepEqual(cloudRunsOf("bc-1").map((x) => x.status), ["cancelled"], "the agent's run was cancelled, not left to finish unwatched");
    assert.equal(stats.cancelled, 1);
  } finally {
    await crashed.end();
  }
});
