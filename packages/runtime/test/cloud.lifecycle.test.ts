// Seam 1, the run, for the life of a cloud step: `runWorkflow` with the fake Cursor SDK in cloud mode (which keeps cloud agents
// on a fake server that outlives the process talking to it), a temp repository and a temporary bare repository as its `origin`.
// It holds what makes a cloud step survive the machine: the agent's id in the event log the moment the agent exists, a resume
// that picks the running agent up instead of starting another, a cancellation that reaches the cloud, and a client wait limit
// that is a reattach point. The assertions are on the outcome, the agents the SDK was asked for, the replayed log and the remote.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { calls, cloudRunsOf, costConfig, finishCloudRun, forgetCloudAgent, killCloudClients, lookups, resetCloud, resumes, script, stats } from "@cursor/sdk";
import { runWorkflow } from "../src/runtime/engine.js";
import type { WorkflowEvent } from "../src/runtime/events.js";
import { eventLogPath, readEventLog, runDirIn } from "../src/runtime/run-store.js";
import { clearConfig, configWorkflow, writeGlobalConfig } from "./config-fixtures.js";
import { remoteBranches, repoWithRemote } from "./cloud-fixtures.js";

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
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined, cloudWaitLimitMs: undefined, lookupFailures: undefined });
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
async function crashWhileTheAgentRuns(runId: string, workflow = reviewStep()) {
  script.push(() => ({ hang: true }));
  const abandoned = new AbortController();
  const execution = runWorkflow(workflow, {}, { cwd, runId, signal: abandoned.signal });
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
    assert.ok(second.some((e) => e.type === "warning" && /reattaching to cloud agent bc-1/.test(e.message)), "and the user is told");
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
    assert.deepEqual(ends.map((e) => e.ok), [false, false, true], "the dead attempt, the one that could not reach the agent, the one that did");
    assert.match(ends[1]!.error!, /could not reattach to cloud agent bc-1: service unavailable/);
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

test("the client's wait limit is a reattach point, not a failure: the step keeps waiting for the same agent and the same run", async () => {
  costConfig.cloudWaitLimitMs = 30; // the real limit is two hours
  script.push(() => ({ hang: true }));
  const running = runWorkflow(reviewStep(), {}, { cwd, runId: "life-9" });
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
  const running = runWorkflow(reviewStep(), {}, { cwd, runId: "life-10" });
  await until(() => stats.sends === 1, "the cloud agent to have its message");
  setTimeout(() => finishCloudRun("bc-1", { status: "error", error: { message: "the VM died" } }), 100);
  const r = await running;

  assert.equal(r.status, "failed");
  assert.match(r.error!, /run error: the VM died/);
  assert.equal(calls.length, 1, "nothing was started again");
});
