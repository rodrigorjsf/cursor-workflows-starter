// Seam: the run graph. `buildRunGraph(events)` is what the Run view draws: it turns a run's event log into nodes, edges and
// lanes using only the step, parent and group ids and the phase, and it works on any prefix of a log, so the same function
// serves the live view and the replay. The events here are written the way the runtime writes them (the contract test in
// `engine-log.test.ts` checks that against a real run).
import assert from "node:assert/strict";
import { test } from "node:test";
import { type GraphNode, type RunEvent, buildRunGraph, joinIdOf } from "../run-view/run-graph.js";
import { type Draft, execEnd, execStart, groupEnd, groupStart, phase, ref, RUN, runStart, stamp, step, stepEnd, stepStart, T0 } from "./run-log.js";

const idsOf = (nodes: GraphNode[]) => nodes.map((n) => n.id);
const arrows = (graph: { edges: Array<{ source: string; target: string }> }) => graph.edges.map((e) => `${e.source}>${e.target}`).sort();

test("steps and commands are nodes, chained from a start node by the parent id of each", () => {
  const graph = buildRunGraph(stamp([runStart, phase("Build"), ...step("s-a", "plan"), stepStart("s-b", "code", { parentId: "s-a" }), execStart("x-1", "test", { parentId: "s-b" })]));

  assert.deepEqual(
    graph.nodes.map((n) => [n.id, n.kind, n.label]),
    [["start", "start", "demo"], ["s-a", "step", "plan"], ["s-b", "step", "code"], ["x-1", "command", "test"]],
  );
  assert.deepEqual(arrows(graph), ["s-a>s-b", "s-b>x-1", "start>s-a"]);
});

test("a parallel group fans out from a fork to its branches and back in at a join, and the next step continues from the join", () => {
  const g1 = { groupId: "g1" };
  const graph = buildRunGraph(
    stamp([
      runStart,
      ...step("s-a", "plan"),
      groupStart("g1", "parallel", 2, "s-a"),
      ...step("s-b1", "left 1", { parentId: "g1", ...g1 }),
      ...step("s-c1", "right 1", { parentId: "g1", ...g1 }),
      ...step("s-b2", "left 2", { parentId: "s-b1", ...g1 }),
      groupEnd("g1"),
      ...step("s-d", "merge", { parentId: "g1" }),
    ]),
  );

  assert.deepEqual(
    graph.nodes.map((n) => [n.id, n.kind]),
    [["start", "start"], ["s-a", "step"], ["g1", "fork"], ["s-b1", "step"], ["s-c1", "step"], ["s-b2", "step"], [joinIdOf("g1"), "join"], ["s-d", "step"]],
  );
  assert.deepEqual(arrows(graph), [
    "g1>s-b1",
    "g1>s-c1",
    `${joinIdOf("g1")}>s-d`,
    "s-a>g1",
    "s-b1>s-b2",
    `s-b2>${joinIdOf("g1")}`,
    `s-c1>${joinIdOf("g1")}`,
    "start>s-a",
  ]);
  assert.equal(graph.nodes.find((n) => n.id === "g1")?.label, "parallel ×2");
});

test("groups nest and pipelines chain the stages of one item: each group has its own fork and join, and a join with no continuation is a tail of the group around it", () => {
  const graph = buildRunGraph(
    stamp([
      runStart,
      groupStart("g1", "parallel", 2, null),
      // branch 0 of g1 holds a pipeline of two items, two stages each
      groupStart("g1.0.g1", "pipeline", 2, "g1", "g1"),
      ...step("s-i0a", "item 0, stage a", { parentId: "g1.0.g1", groupId: "g1.0.g1" }),
      ...step("s-i0b", "item 0, stage b", { parentId: "s-i0a", groupId: "g1.0.g1" }),
      ...step("s-i1a", "item 1, stage a", { parentId: "g1.0.g1", groupId: "g1.0.g1" }),
      groupEnd("g1.0.g1"),
      // branch 1 of g1 is a single step
      ...step("s-solo", "solo", { parentId: "g1", groupId: "g1" }),
      groupEnd("g1"),
    ]),
  );

  assert.deepEqual(arrows(graph), [
    "g1.0.g1>s-i0a",
    "g1.0.g1>s-i1a",
    "g1>g1.0.g1",
    "g1>s-solo",
    `join:g1.0.g1>join:g1`,
    "s-i0a>s-i0b",
    `s-i0b>join:g1.0.g1`,
    `s-i1a>join:g1.0.g1`,
    `s-solo>join:g1`,
    "start>g1",
  ]);
  assert.equal(graph.nodes.find((n) => n.id === "g1.0.g1")?.label, "pipeline ×2");
});

test("a group that has not ended has a fork and no join yet; an empty group joins straight to its fork", () => {
  const open = buildRunGraph(stamp([runStart, groupStart("g1", "parallel", 2, null), ...step("s-a", "a", { parentId: "g1", groupId: "g1" }), stepStart("s-b", "b", { parentId: "g1", groupId: "g1" })]));
  assert.deepEqual(idsOf(open.nodes), ["start", "g1", "s-a", "s-b"]);
  assert.deepEqual(arrows(open), ["g1>s-a", "g1>s-b", "start>g1"]);

  const empty = buildRunGraph(stamp([runStart, groupStart("g1", "parallel", 0, null), groupEnd("g1"), ...step("s-z", "after", { parentId: "g1" })]));
  assert.deepEqual(arrows(empty), [`g1>${joinIdOf("g1")}`, `${joinIdOf("g1")}>s-z`, "start>g1"]);
});

const stateOf = (graph: { nodes: GraphNode[] }, id: string) => graph.nodes.find((n) => n.id === id)?.state;
const nodeOf = (graph: { nodes: GraphNode[] }, id: string) => graph.nodes.find((n) => n.id === id)!;

test("a node shows its final state: running until its end, then ok, failed, cancelled or cached", () => {
  const graph = buildRunGraph(
    stamp([
      runStart,
      stepStart("s-run", "going"),
      ...step("s-ok", "fine"),
      stepStart("s-bad", "broken"),
      stepEnd("s-bad", "broken", {}, { ok: false, errorKind: "timeout", error: "no answer in 60s" }),
      stepStart("s-stop", "stopped"),
      stepEnd("s-stop", "stopped", {}, { ok: false, errorKind: "cancelled" }),
      stepStart("s-old", "from the journal", {}, { cached: "journal" }),
      stepEnd("s-old", "from the journal", {}, { cached: "journal" }),
      execStart("x-ok", "tests"),
      execEnd("x-ok", "tests"),
      execStart("x-bad", "lint"),
      execEnd("x-bad", "lint", {}, { ok: false, exitCode: 2 }),
      execStart("x-slow", "build"),
      execEnd("x-slow", "build", {}, { ok: false, outcome: "timeout", exitCode: undefined, signal: "SIGTERM" }),
      execStart("x-gone", "deploy"),
      execEnd("x-gone", "deploy", {}, { ok: false, outcome: "cancelled" }),
    ]),
  );

  assert.deepEqual(
    ["s-run", "s-ok", "s-bad", "s-stop", "s-old", "x-ok", "x-bad", "x-slow", "x-gone"].map((id) => stateOf(graph, id)),
    ["running", "ok", "failed", "cancelled", "cached", "ok", "failed", "failed", "cancelled"],
  );
});

test("a retried step keeps one node: attempts, tokens, cost and time add up, and the last failure's kind stays", () => {
  const graph = buildRunGraph(
    stamp([
      runStart,
      stepStart("s-a", "flaky"),
      stepEnd("s-a", "flaky", {}, { attemptId: "s-a#1", ok: false, errorKind: "timeout", error: "no answer in 60s", usage: { inputTokens: 400, outputTokens: 100, totalTokens: 500 }, rawCents: 5, chargedCents: 0, durationMs: 60000 }),
      stepStart("s-a", "flaky", {}, { attemptId: "s-a#2", attempt: 2 }),
      stepEnd("s-a", "flaky", {}, { attemptId: "s-a#2", attempt: 2, usage: { inputTokens: 800, outputTokens: 200, totalTokens: 1000 }, rawCents: 3, chargedCents: 4, durationMs: 9000, resolvedModel: "composer-2.5" }),
    ]),
  );

  assert.equal(stateOf(graph, "s-a"), "ok");
  assert.deepEqual(nodeOf(graph, "s-a").detail, {
    model: "composer-2.5",
    location: "local",
    attempts: 2,
    tokens: 1500,
    costCents: 9,
    costFinal: true,
    durationMs: 69000,
    errorKind: "timeout",
    error: "no answer in 60s",
  });
});

test("an attempt still going counts the turns it has finished, and its start is kept to time it", () => {
  const turn = (inputTokens: number, outputTokens: number): Draft => ({ type: "turn", ...ref("s-a", {}), attemptId: "s-a#1", idx: 0, steps: 1, usage: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  const graph = buildRunGraph(stamp([runStart, stepStart("s-a", "thinking"), turn(100, 10), turn(200, 20)]));

  const detail = nodeOf(graph, "s-a").detail;
  assert.equal(detail.tokens, 330);
  assert.equal(detail.attempts, 1);
  assert.equal(detail.runningSince, new Date(T0 + 1000).toISOString());
  assert.equal(detail.durationMs, 0);
});

test("a step from the journal or the memo spent nothing now: no attempts, no cost, and it says where it came from", () => {
  const graph = buildRunGraph(stamp([runStart, stepStart("s-a", "again", {}, { cached: "memo" }), stepEnd("s-a", "again", {}, { cached: "memo", usage: { totalTokens: 900 }, rawCents: 8, chargedCents: 8 })]));
  const detail = nodeOf(graph, "s-a").detail;
  assert.deepEqual([detail.attempts, detail.tokens, detail.costCents, detail.cached], [0, 0, 0, "memo"]);
});

test("a command shows how it ended: the exit code, or the outcome when it was killed", () => {
  const graph = buildRunGraph(
    stamp([
      runStart,
      execStart("x-a", "lint"),
      execEnd("x-a", "lint", {}, { ok: false, exitCode: 2, durationMs: 1500 }),
      execStart("x-b", "build"),
      execEnd("x-b", "build", {}, { ok: false, outcome: "timeout", exitCode: undefined, durationMs: 600000 }),
      execStart("x-c", "ghost"),
      execEnd("x-c", "ghost", {}, { ok: false, outcome: "spawn-error", exitCode: undefined, error: "spawn ghost ENOENT", durationMs: 2 }),
    ]),
  );

  assert.deepEqual(nodeOf(graph, "x-a").detail, { command: "npm", location: "local", attempts: 1, tokens: 0, costCents: 0, costFinal: true, durationMs: 1500, errorKind: "exit 2" });
  assert.equal(nodeOf(graph, "x-b").detail.errorKind, "timeout");
  assert.deepEqual([nodeOf(graph, "x-c").detail.errorKind, nodeOf(graph, "x-c").detail.error], ["spawn-error", "spawn ghost ENOENT"]);
});

test("a group is ok when it ended well and failed when a fatal error aborted it", () => {
  const graph = buildRunGraph(stamp([runStart, groupStart("g1", "parallel", 1, null), groupEnd("g1"), groupStart("g2", "parallel", 1, joinIdOf("g1")), groupEnd("g2", false)]));
  assert.deepEqual(["g1", joinIdOf("g1"), "g2", joinIdOf("g2")].map((id) => stateOf(graph, id)), ["ok", "ok", "failed", "failed"]);
});

test("once nothing more will come, whatever was still going is interrupted", () => {
  const events = stamp([runStart, groupStart("g1", "parallel", 2, null), stepStart("s-a", "going", { parentId: "g1", groupId: "g1" }), ...step("s-b", "done", { parentId: "g1", groupId: "g1" })]);

  const live = buildRunGraph(events);
  assert.deepEqual(["g1", "s-a", "s-b"].map((id) => stateOf(live, id)), ["running", "running", "ok"]);
  const settled = buildRunGraph(events, { settled: true });
  assert.deepEqual(["g1", "s-a", "s-b"].map((id) => stateOf(settled, id)), ["interrupted", "interrupted", "ok"]);
});

const laneOf = (graph: { nodes: GraphNode[] }, id: string) => nodeOf(graph, id).lane;

test("phases are lanes, in the order they first appear, and a group sits in the phase it was opened in", () => {
  const inB = { groupId: "g1" };
  const graph = buildRunGraph(
    stamp([
      runStart,
      phase("Plan"),
      ...step("s-a", "plan"),
      phase("Build"),
      groupStart("g1", "parallel", 2, "s-a"),
      ...step("s-b1", "left", { parentId: "g1", ...inB }),
      ...step("s-b2", "right", { parentId: "g1", ...inB }),
      groupEnd("g1"),
      phase("Ship"),
      ...step("s-c", "ship", { parentId: "g1" }),
    ]),
  );

  assert.deepEqual(graph.lanes, [{ index: 0, title: "Plan" }, { index: 1, title: "Build" }, { index: 2, title: "Ship" }]);
  assert.deepEqual(
    ["start", "s-a", "g1", "s-b1", "s-b2", joinIdOf("g1"), "s-c"].map((id) => laneOf(graph, id)),
    [0, 0, 1, 1, 1, 1, 2],
  );
});

test("a step names its own phase, and no edge runs backwards from a later lane to an earlier one", () => {
  const graph = buildRunGraph(
    stamp([
      runStart,
      phase("Plan"),
      stepStart("s-a", "plan", {}, { phase: "Plan" }),
      stepStart("s-b", "build", { parentId: "s-a" }, { phase: "Build" }),
      // the workflow names an earlier phase for a step that comes after one in a later phase: it is drawn in the later lane
      stepStart("s-c", "fix the plan", { parentId: "s-b" }, { phase: "Plan" }),
    ]),
  );

  assert.deepEqual(["s-a", "s-b", "s-c"].map((id) => laneOf(graph, id)), [0, 1, 1]);
  for (const edge of graph.edges) assert.ok(laneOf(graph, edge.source) <= laneOf(graph, edge.target), `${edge.id} runs backwards`);
  assert.deepEqual(graph.lanes.map((l) => l.title), ["Plan", "Build"]);
});

test("a run with no phases has one unnamed lane", () => {
  const graph = buildRunGraph(stamp([runStart, ...step("s-a", "only")]));
  assert.deepEqual(graph.lanes, [{ index: 0, title: "" }]);
  assert.equal(laneOf(graph, "s-a"), 0);
});

test("the run's summary: status, executions and what it spent, from its events alone", () => {
  const spent = (stepId: string): Draft[] => [stepStart(stepId, stepId), stepEnd(stepId, stepId, {}, { usage: { totalTokens: 1000 }, rawCents: 2, chargedCents: 1 })];
  const summary = (drafts: Draft[], settled = false) => buildRunGraph(stamp(drafts), { settled }).run;

  assert.deepEqual(summary([runStart, ...spent("s-a"), ...spent("s-b")]), { workflow: "demo", status: "running", startedAt: new Date(T0).toISOString(), executions: 1, tokens: 2000, costCents: 4 });
  assert.equal(summary([runStart, ...spent("s-a")], true).status, "interrupted", "settled with no run-end: the process is gone");

  const ended = (status: string, extra: Draft = {}): Draft[] => [runStart, ...spent("s-a"), { type: "run-end", status, ...extra }];
  assert.equal(summary(ended("finished")).status, "finished");
  assert.deepEqual(
    [summary(ended("failed", { error: "budget" })).status, summary(ended("failed", { error: "budget" })).error, summary(ended("cancelled")).status],
    ["failed", "budget", "cancelled"],
  );
  assert.equal(summary(ended("something-new")).status, "failed", "a status this reader does not know is not a success");

  const resumed = summary([runStart, ...spent("s-a"), { type: "run-end", status: "cancelled" }, runStart, ...spent("s-b")]);
  assert.deepEqual([resumed.executions, resumed.status, resumed.endedAt], [2, "running", undefined]);
});

test("events of other schema versions, unknown types and damaged fields are tolerated: they change nothing, and nothing throws", () => {
  const known = stamp([runStart, ...step("s-a", "plan"), stepStart("s-b", "code", { parentId: "s-a" })]);
  const noise = [
    { v: 7, ts: "2027-01-01T00:00:00.000Z", runId: RUN, type: "teleport", to: "mars" },
    { type: "step-end", stepId: "s-never-started", ok: true },
    { type: "turn", stepId: "s-never-started", usage: null },
    { type: "group-end", groupId: "g-never-opened" },
    { type: "step-start" },
    { type: "step-start", stepId: 42, label: ["not", "a", "string"], parentId: 7, groupId: {} },
    { type: "exec-end", stepId: "s-a", attemptId: "other", ok: "yes", durationMs: "slow" },
    null,
    "not an event",
    42,
  ] as unknown as RunEvent[];
  const clean = buildRunGraph(known);
  const noisy = buildRunGraph([...known.slice(0, 2), ...noise, ...known.slice(2)]);

  assert.deepEqual(idsOf(noisy.nodes), idsOf(clean.nodes), "the damaged step-start named no usable step");
  assert.deepEqual(arrows(noisy), arrows(clean));
  assert.equal(stateOf(noisy, "s-a"), "ok");
  assert.equal(stateOf(noisy, "s-b"), "running");
});

test("any prefix of a log is a graph of its own, which is what lets a replay step through the run", () => {
  const events = stamp([runStart, ...step("s-a", "plan"), groupStart("g1", "parallel", 2, "s-a"), ...step("s-b", "left", { parentId: "g1", groupId: "g1" }), ...step("s-c", "right", { parentId: "g1", groupId: "g1" }), groupEnd("g1")]);

  const sizes = Array.from({ length: events.length + 1 }, (_, n) => buildRunGraph(events.slice(0, n)).nodes.length);
  assert.deepEqual(sizes, [0, 1, 2, 2, 3, 4, 4, 5, 5, 6]);
});

test("a resume runs its groups again: the fork and the join show the latest execution, and what follows the group stays on its join", () => {
  const inG1 = { groupId: "g1" };
  const firstExecution: Draft[] = [
    runStart,
    groupStart("g1", "parallel", 2, null),
    ...step("s-b", "left", { parentId: "g1", ...inG1 }),
    groupEnd("g1", false), // a fatal error aborted the group
    ...step("s-after", "after", { parentId: "g1" }),
    { type: "run-end", status: "failed", error: "budget" },
  ];

  const midResume = buildRunGraph(stamp([...firstExecution, runStart, groupStart("g1", "parallel", 2, null), { ...stepStart("s-b", "left", { parentId: "g1", ...inG1 }), attemptId: "s-b#2", attempt: 2 }]));
  assert.deepEqual(["g1", joinIdOf("g1")].map((id) => stateOf(midResume, id)), ["running", "running"], "the group is going again");
  assert.ok(arrows(midResume).includes(`${joinIdOf("g1")}>s-after`), "the step after the group still continues from the join");
  assert.ok(!arrows(midResume).includes("g1>s-after"));

  const resumed = buildRunGraph(stamp([...firstExecution, runStart, groupStart("g1", "parallel", 2, null), ...step("s-b", "left", { parentId: "g1", ...inG1 }), groupEnd("g1")]));
  assert.deepEqual(["g1", joinIdOf("g1")].map((id) => stateOf(resumed, id)), ["ok", "ok"], "the aborted group finished well the second time");
  assert.equal(resumed.nodes.filter((n) => n.kind === "fork").length, 1, "one fork, not one per execution");
});
