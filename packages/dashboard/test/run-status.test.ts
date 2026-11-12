// Seam: `headerStatus` and `offeredActions`, what the Run view's header says and offers. The status and the error are the API's
// (`GET /api/runs/<runId>`), the one name the Board, the Runs table and `wf status` give the run: a run whose process died is
// `failed`, with the runtime's error and its resume hint. The events only speak during a replay.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRunGraph } from "../run-view/run-graph.js";
import { headerStatus, offeredActions } from "../run-view/run-status.js";
import { cloudAgent, phase, runStart, stamp, step, stepEnd, stepStart, type Draft } from "./run-log.js";

const DEAD_ERROR = 'the process executing the run ended without finishing it; relaunch with resumeRunId="wf-aaaa0001"';

/** A run whose process died while a cloud step was working: its agent is in the log, its attempt never ended, and no run-end follows. */
const deadInCloud: Draft[] = [runStart, phase("Build"), ...step("s1", "plan"), stepStart("s2", "implement", { parentId: "s1" }, { location: "cloud" }), cloudAgent("s2", "bc-1")];
/** The same run, but the process ended it: the step failed and the run-end says so. */
const endedInCloud: Draft[] = [...deadInCloud, stepEnd("s2", "implement", { parentId: "s1" }, { ok: false, errorKind: "agent-error" }), { type: "run-end", status: "failed", error: "implement failed" }];
/** A process died during a local step: nothing in the cloud to cancel. */
const deadLocal: Draft[] = [runStart, phase("Build"), stepStart("s1", "plan")];

const graphOf = (drafts: Draft[], settled = true) => buildRunGraph(stamp(drafts), { settled });

test("a run whose process died reads as the API says: failed, with the API's error and its resume hint", () => {
  const graph = graphOf(deadInCloud);
  const header = headerStatus({ api: { status: "failed", error: DEAD_ERROR }, run: graph.run, replaying: false, settled: true });
  assert.equal(header.key, "failed");
  assert.equal(header.label, "failed");
  assert.equal(header.error, DEAD_ERROR);
  assert.match(header.error ?? "", /resumeRunId=/);
});

test("the API's status wins over the events' for every settled run, and its error is shown", () => {
  const graph = graphOf(endedInCloud);
  assert.deepEqual(headerStatus({ api: { status: "failed", error: "implement failed" }, run: graph.run, replaying: false, settled: true }), { key: "failed", label: "failed", error: "implement failed" });
  const live = graphOf(deadLocal, false);
  assert.equal(headerStatus({ api: { status: "running" }, run: live.run, replaying: false, settled: false }).key, "running");
});

test("before the API answers, the header claims no state", () => {
  const header = headerStatus({ run: buildRunGraph([]).run, replaying: false, settled: false });
  assert.ok(!["running", "finished", "failed", "cancelled"].includes(header.key), `the header says ${header.key} before anyone said so`);
  assert.match(header.label, /looking/i);
});

test("a replay shows the events: replaying while it plays, and what the log says at its end", () => {
  const graph = graphOf(endedInCloud);
  assert.equal(headerStatus({ api: { status: "failed" }, run: graphOf(deadInCloud.slice(0, 3), false).run, replaying: true, settled: false }).key, "replaying");
  assert.equal(headerStatus({ api: { status: "failed" }, run: graph.run, replaying: true, settled: true }).label, "failed");
});

test("a run whose process died with a cloud agent still working offers to cancel that agent; nothing else does", () => {
  assert.deepEqual(offeredActions("failed", graphOf(deadInCloud)), { cancelRun: false, leftCloudAgents: ["bc-1"] });
  assert.deepEqual(offeredActions("failed", graphOf(endedInCloud)), { cancelRun: false, leftCloudAgents: [] }, "the process ended the run and its agents");
  assert.deepEqual(offeredActions("failed", graphOf(deadLocal)), { cancelRun: false, leftCloudAgents: [] }, "no agent in the cloud");
  assert.deepEqual(offeredActions("running", graphOf(deadInCloud, false)), { cancelRun: true, leftCloudAgents: [] }, "a live process cancels its own agents");
  assert.deepEqual(offeredActions(undefined, graphOf(deadInCloud)), { cancelRun: false, leftCloudAgents: [] }, "nothing before the API answers");
});
