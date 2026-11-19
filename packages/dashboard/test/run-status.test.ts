// Seam: `headerStatus` and `offeredActions`, what the Run view's header says and offers. The status and the error are the API's
// (`GET /api/runs/<runId>`), the one name the Board, the Runs table and `wf status` give the run: a run whose process died is
// `failed`, with the runtime's error and its resume hint. The events only speak during a replay.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRunGraph, executionsOf } from "../run-view/run-graph.js";
import { ExecutionPicker, RunCost, RunView } from "../run-view/RunView.js";
import { executionNote, headerStatus, offeredActions, runElapsed } from "../run-view/run-status.js";
import { render, textOf } from "./render.js";
import { cloudAgent, execEnd, execStart, phase, runStart, sandboxRun, stamp, step, stepEnd, stepStart, type Draft } from "./run-log.js";

const DEAD_ERROR = 'the process executing the run ended without finishing it; relaunch with resumeRunId="wf-aaaa0001"';
/** What the API says of a run whose process is alive but stopped beating (`silentJobError`): `failed`, with this error. */
const FROZEN_ERROR = 'no heartbeat for 95s (process 4242); relaunch with resumeRunId="wf-aaaa0001"';

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

test("a replay says replaying while it plays, and at its end names the run as the API does: a dead run is failed, not a second name", () => {
  const graph = graphOf(endedInCloud);
  assert.equal(headerStatus({ api: { status: "failed" }, run: graphOf(deadInCloud.slice(0, 3), false).run, replaying: true, settled: false }).key, "replaying");
  assert.equal(headerStatus({ api: { status: "failed" }, run: graph.run, replaying: true, settled: true }).label, "failed");
  const dead = graphOf(deadInCloud);
  assert.equal(dead.run.status, "interrupted", "the events alone only say they stopped");
  assert.deepEqual(headerStatus({ api: { status: "failed", error: DEAD_ERROR }, run: dead.run, replaying: true, settled: true }), { key: "failed", label: "failed", error: DEAD_ERROR });
});

test("a run whose process died with a cloud agent still working offers to cancel that agent; nothing else does", () => {
  assert.deepEqual(offeredActions("failed", graphOf(deadInCloud), DEAD_ERROR), { cancelRun: false, frozen: false, leftCloudAgents: ["bc-1"] });
  assert.deepEqual(offeredActions("failed", graphOf(endedInCloud), "implement failed"), { cancelRun: false, frozen: false, leftCloudAgents: [] }, "the process ended the run and its agents");
  assert.deepEqual(offeredActions("failed", graphOf(deadLocal), DEAD_ERROR), { cancelRun: false, frozen: false, leftCloudAgents: [] }, "no agent in the cloud");
  assert.deepEqual(offeredActions("running", graphOf(deadInCloud, false)), { cancelRun: true, frozen: false, leftCloudAgents: [] }, "a live process cancels its own agents");
  assert.deepEqual(offeredActions(undefined, graphOf(deadInCloud)), { cancelRun: false, frozen: false, leftCloudAgents: [] }, "nothing before the API answers");
});

test("a frozen run (process alive, no heartbeat) is failed in the API, and offers Cancel run: the cancel kills the process and cancels its cloud agents", () => {
  assert.deepEqual(offeredActions("failed", graphOf(deadLocal), FROZEN_ERROR), { cancelRun: true, frozen: true, leftCloudAgents: [] }, "only local steps: still a way to free the run");
  assert.deepEqual(
    offeredActions("failed", graphOf(deadInCloud), FROZEN_ERROR),
    { cancelRun: true, frozen: true, leftCloudAgents: [] },
    "the same route kills the process and then cancels the agents it left: one button, not Cancel cloud agent",
  );
  assert.equal(offeredActions("failed", graphOf(deadLocal), `the run failed: ${FROZEN_ERROR}`).cancelRun, false, "only an error that starts with the runtime's words");
});

test("the header's duration follows the Runs table's rule: to the run-end, to now while it runs, and none for a run over without a run-end", () => {
  const start = "2026-01-10T10:00:00.000Z";
  const now = Date.parse("2026-01-10T10:05:00.000Z");
  assert.equal(runElapsed({ startedAt: start, endedAt: "2026-01-10T10:01:00.000Z" }, true, now), 60_000, "a run that ended");
  assert.equal(runElapsed({ startedAt: start }, false, now), 300_000, "a live run, or a replay part-way through, runs to now");
  assert.equal(runElapsed({ startedAt: start }, true, now), undefined, "a run whose process died did not record its end: the Runs table writes — for it");
  assert.equal(runElapsed({}, false, now), undefined, "no start yet");
});

const costed = (stepId: string, extra: Record<string, unknown>): Draft[] => [stepStart(stepId, stepId), stepEnd(stepId, stepId, {}, { usage: { totalTokens: 1000 }, ...extra })];
const unreported = { costFinal: false, rawCents: 0, chargedCents: 0 };
const finalCost = { costFinal: true, rawCents: 9, chargedCents: 7 };
const costOf = (drafts: Draft[]) => textOf(render(RunCost, { run: graphOf(drafts).run }));

test("a run whose attempts all reported their cost as not final, with 0 charged, reads as unknown and still has its tokens", () => {
  const drafts = [runStart, ...costed("s-a", unreported), ...costed("s-b", unreported)];
  assert.equal(costOf(drafts), "unknown");
  assert.equal(graphOf(drafts).run.tokens, 2000);
});

test("an unknown cost is marked like every other missing value, and says why", () => {
  const html = render(RunCost, { run: graphOf([runStart, ...costed("s-a", unreported)]).run });
  assert.match(html, /class="none"/);
  assert.match(html, /title="Cursor did not report the cost/);
});

test("a run with a final cost shows that cost", () => {
  const html = render(RunCost, { run: graphOf([runStart, ...costed("s-a", finalCost), ...costed("s-b", finalCost)]).run });
  assert.equal(textOf(html), "18¢");
  assert.doesNotMatch(html, /class="none"/);
});

test("a final cost of 0 is 0, not unknown", () => {
  assert.equal(costOf([runStart, ...costed("s-a", { costFinal: true, rawCents: 0, chargedCents: 0 })]), "0¢");
  assert.equal(costOf([runStart, stepStart("s-a", "plan")]), "0¢", "nothing has been charged or reported yet");
});

test("one attempt that did not report its cost leaves the run's 0 unknown; once something was charged, the run shows what it was charged", () => {
  assert.equal(costOf([runStart, ...costed("s-a", { costFinal: true, rawCents: 0, chargedCents: 0 }), ...costed("s-b", unreported)]), "unknown");
  assert.equal(costOf([runStart, ...costed("s-a", finalCost), ...costed("s-b", unreported)]), "9¢");
});

test("a log from before events said whether the cost was final reads as final", () => {
  assert.equal(costOf([runStart, ...costed("s-a", { rawCents: 0, chargedCents: 0 })]), "0¢");
});

const firstExecutionOf = (drafts: Draft[]) => {
  const events = stamp(drafts);
  const [first] = executionsOf(events);
  return buildRunGraph(events.slice(first!.from, first!.to), { settled: true });
};
const failedCommand: Draft[] = [execStart("x-1", "gh issue view"), execEnd("x-1", "gh issue view", {}, { ok: false, exitCode: 1 })];

test("an execution that failed says what failed in it, by the labels of its failed commands and steps and how each ended", () => {
  assert.equal(executionNote(firstExecutionOf([runStart, ...failedCommand, { type: "run-end", status: "failed" }, runStart]), 1), "Execution 1 failed: gh issue view (exit 1)");
  const sandbox = sandboxRun();
  const [first] = executionsOf(sandbox);
  assert.equal(executionNote(buildRunGraph(sandbox.slice(first!.from, first!.to), { settled: true }), 1), "Execution 1 failed: gh issue view (exit 1)");

  const twice = [runStart, ...failedCommand, execStart("x-2", "git push"), execEnd("x-2", "git push", {}, { ok: false, outcome: "timeout", exitCode: undefined }), { type: "run-end", status: "failed" }, runStart];
  assert.equal(executionNote(firstExecutionOf(twice), 1), "Execution 1 failed: gh issue view (exit 1), git push (timeout)");
});

test("an execution that failed with nothing failed in it gives the run's error, and one that did not fail says nothing", () => {
  assert.equal(executionNote(firstExecutionOf([runStart, { type: "run-end", status: "failed", error: "budget exceeded" }, runStart]), 1), "Execution 1 failed: budget exceeded");
  assert.equal(executionNote(firstExecutionOf([runStart, { type: "run-end", status: "failed" }, runStart]), 1), "Execution 1 failed");
  assert.equal(executionNote(firstExecutionOf([runStart, ...step("s-a", "plan"), { type: "run-end", status: "finished" }, runStart]), 1), undefined);
});

test("an execution that was cancelled or stopped says so under that word", () => {
  assert.equal(executionNote(firstExecutionOf([runStart, { type: "run-end", status: "cancelled" }, runStart]), 1), "Execution 1 cancelled");
  assert.equal(executionNote(firstExecutionOf([runStart, ...failedCommand.slice(0, 1), runStart]), 2), "Execution 2 stopped", "no run-end: its process went away");
});

test("the execution picker is a labelled list of every execution, 'Execution 1 / 2', with the one on show chosen", () => {
  const html = render(ExecutionPicker, { count: 2, current: 1, onPick: () => {} });
  assert.match(html, /<select[^>]*aria-label="Execution shown"/);
  assert.deepEqual([...html.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]), ["Execution 1 / 2", "Execution 2 / 2"]);
  assert.match(html, /<option value="1" selected="">Execution 2 \/ 2/);
  assert.doesNotMatch(html, /role=/, "nothing to say about it");
});

test("the execution picker carries the note of the execution on show, and is not there for a run with one execution", () => {
  const html = render(ExecutionPicker, { count: 2, current: 0, note: "Execution 1 failed: gh issue view (exit 1)", onPick: () => {} });
  assert.match(html, /<p[^>]*role="alert"[^>]*>Execution 1 failed: gh issue view \(exit 1\)<\/p>/);
  assert.equal(render(ExecutionPicker, { count: 1, current: 0, onPick: () => {} }), "");
});

test("the header has a visible button back to the Runs list, and the breadcrumb's Runs is a link to the same place", () => {
  const html = render(RunView, { runId: "wf-aaaa0001" });
  const back = /<a class="btn back" href="\/#\/runs">(.*?)<\/a>/.exec(html);
  assert.ok(back, "a link styled as a button points at #/runs");
  assert.equal(textOf(back[1]!), "← Back to Runs");
  assert.match(html, /<nav class="crumbs" aria-label="Breadcrumb"><a href="\/#\/runs">Runs<\/a>/);
  assert.ok(html.indexOf(back[0]) < html.indexOf('class="run-stats"'), "the button is in the header, above the run's numbers");
});
