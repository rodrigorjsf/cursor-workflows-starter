// Seam: the run graph. `buildRunGraph(events)` is what the Run view draws: it turns a run's event log into nodes, edges and
// lanes using only the step, parent and group ids and the phase, and it works on any prefix of a log, so the same function
// serves the live view and the replay. The events here are written the way the runtime writes them (the contract test in
// `engine-log.test.ts` checks that against a real run).
import assert from "node:assert/strict";
import { test } from "node:test";
import { type GraphNode, KNOWN_EVENT_VERSION, type RunEvent, buildRunGraph, currentExecution, executionsOf, failedWork, joinIdOf, shownEvents } from "../run-view/run-graph.js";
import { type Draft, cloudAgent, execEnd, execStart, groupEnd, groupStart, phase, ref, RUN, runStart, sandboxRun, stamp, step, stepEnd, stepStart, T0 } from "./run-log.js";

const idsOf = (nodes: GraphNode[]) => nodes.map((n) => n.id);
const arrows = (graph: { edges: Array<{ source: string; target: string }> }) => graph.edges.map((e) => `${e.source}>${e.target}`).sort();

test("steps and the commands marked as nodes are nodes, chained from a start node by the parent id of each", () => {
  const graph = buildRunGraph(stamp([runStart, phase("Build"), ...step("s-a", "plan"), stepStart("s-b", "code", { parentId: "s-a" }), execStart("x-1", "test", { parentId: "s-b" }, { node: true })]));

  assert.deepEqual(
    graph.nodes.map((n) => [n.id, n.kind, n.label]),
    [["start", "start", "demo"], ["s-a", "step", "plan"], ["s-b", "step", "code"], ["x-1", "command", "test"]],
  );
  assert.deepEqual(arrows(graph), ["s-a>s-b", "s-b>x-1", "start>s-a"]);
});

const SUITE = (n: number) => `x-7589c5601a70.${n}`;
const TEST_1 = "s-e47a373472ae.0";
const CODE_1 = "s-0627cf788f08.0";
const REVIEW_SPEC_1 = "s-7720409f62fc.0";
const REVIEW_STANDARDS_1 = "s-b488463f0829.0";
const REVIEW_SECURITY_1 = "s-37297b5b5f4c.0";
const TEST_EXTRA_1 = "s-613bbe36ecdc.0";
const TEST_EXTRA_2 = "s-dbe7881c2149.0";
const TEST_EXTRA_2_RETRY = "s-263b4ccd42fb.0";
const REVIEW_SPEC_2 = "s-2bfed702788b.0";

test("the sandbox run's graph draws only its steps, its groups, its start and its test suites, in run order", () => {
  const graph = buildRunGraph(sandboxRun(), { settled: true });

  assert.deepEqual(
    graph.nodes.map((n) => [n.id, n.kind, n.label]),
    [
      ["start", "start", "implement-issue"],
      [SUITE(0), "command", "suite:baseline"],
      [TEST_1, "step", "test-1"],
      [SUITE(1), "command", "suite:red:1"],
      [CODE_1, "step", "code-1"],
      [SUITE(2), "command", "suite:green:1"],
      ["g1", "fork", "parallel ×3"],
      [REVIEW_SPEC_1, "step", "review:spec:1"],
      [REVIEW_STANDARDS_1, "step", "review:standards:1"],
      [REVIEW_SECURITY_1, "step", "review:security:1"],
      [joinIdOf("g1"), "join", "join"],
      [TEST_EXTRA_1, "step", "test-extra-1"],
      [SUITE(3), "command", "suite:red:extra-1"],
      [TEST_EXTRA_2, "step", "test-extra-2"],
      [SUITE(4), "command", "suite:red:extra-2"],
      [TEST_EXTRA_2_RETRY, "step", "test-extra-2:2"],
      [SUITE(5), "command", "suite:red:extra-2"],
      ["g2", "fork", "parallel ×1"],
      [REVIEW_SPEC_2, "step", "review:spec:2"],
      [joinIdOf("g2"), "join", "join"],
      [SUITE(6), "command", "suite:final"],
    ],
  );
  assert.deepEqual(arrows(graph), [
    `${SUITE(0)}>${TEST_1}`,
    `${SUITE(1)}>${CODE_1}`,
    `${SUITE(2)}>g1`,
    `${SUITE(3)}>${TEST_EXTRA_2}`,
    `${SUITE(4)}>${TEST_EXTRA_2_RETRY}`,
    `${SUITE(5)}>g2`,
    `${CODE_1}>${SUITE(2)}`,
    `${TEST_1}>${SUITE(1)}`,
    `${TEST_EXTRA_1}>${SUITE(3)}`,
    `${TEST_EXTRA_2}>${SUITE(4)}`,
    `${TEST_EXTRA_2_RETRY}>${SUITE(5)}`,
    `${REVIEW_SPEC_2}>${joinIdOf("g2")}`,
    `${joinIdOf("g1")}>${TEST_EXTRA_1}`,
    `${joinIdOf("g2")}>${SUITE(6)}`,
    `${REVIEW_SECURITY_1}>${joinIdOf("g1")}`,
    `${REVIEW_SPEC_1}>${joinIdOf("g1")}`,
    `${REVIEW_STANDARDS_1}>${joinIdOf("g1")}`,
    "g1>" + REVIEW_SPEC_1,
    "g1>" + REVIEW_STANDARDS_1,
    "g1>" + REVIEW_SECURITY_1,
    `g2>${REVIEW_SPEC_2}`,
    `start>${SUITE(0)}`,
  ].sort());
});

test("every command the graph leaves out is listed under the step it follows or under its phase, and none is lost", () => {
  const events = sandboxRun();
  const ran = [...new Set(events.filter((e) => e.type === "exec-start").map((e) => String(e.stepId)))];
  const graph = buildRunGraph(events, { settled: true });

  const listed = [
    ...graph.nodes.filter((n) => n.kind === "command").map((n) => n.id),
    ...graph.nodes.flatMap((n) => n.commands.map((c) => c.id)),
    ...graph.lanes.flatMap((l) => l.commands.map((c) => c.id)),
  ];
  assert.equal(ran.length, 88, "89 commands ran; one of them ran again in the second execution");
  assert.deepEqual([...listed].sort(), [...ran].sort());
  assert.equal(new Set(listed).size, listed.length, "each is listed once");
});

test("in the sandbox run every command ran between steps, so each is listed under its phase, in run order", () => {
  const graph = buildRunGraph(sandboxRun(), { settled: true });
  const labels = (title: string) => graph.lanes.find((l) => l.title === title)!.commands.map((c) => c.label);

  assert.deepEqual(graph.lanes.map((l) => [l.title, l.commands.length]), [["Triage", 2], ["Implementation", 33], ["Review", 39], ["Delivery", 7]]);
  assert.deepEqual(labels("Triage"), ["git config", "gh issue view"]);
  assert.deepEqual(labels("Delivery"), ["git rev-parse", "git add", "git diff", "git diff", "git diff", "git commit", "git rev-parse"]);
  assert.deepEqual(graph.nodes.flatMap((n) => n.commands), []);
});

test("a command that ran while a step was going is listed under that step, through the commands between them; one that came after is listed under its phase", () => {
  const graph = buildRunGraph(
    stamp([
      runStart,
      phase("Build"),
      stepStart("s-a", "code"),
      execStart("x-during", "git status", { parentId: "s-a" }),
      execEnd("x-during", "git status"),
      execStart("x-nested", "git log", { parentId: "x-during" }),
      execEnd("x-nested", "git log"),
      stepEnd("s-a", "code"),
      execStart("x-after", "git add", { parentId: "s-a" }),
      execEnd("x-after", "git add"),
    ]),
  );

  assert.deepEqual(idsOf(graph.nodes), ["start", "s-a"]);
  assert.deepEqual(idsOf(nodeOf(graph, "s-a").commands), ["x-during", "x-nested"]);
  assert.deepEqual(idsOf(graph.lanes[0]!.commands), ["x-after"]);
});

test("the phases of the sandbox run are its lanes, a phase of commands only included, and the commands before any phase join the first one", () => {
  const graph = buildRunGraph(sandboxRun(), { settled: true });

  assert.deepEqual(graph.lanes.map((l) => l.title), ["Triage", "Implementation", "Review", "Delivery"]);
  assert.deepEqual(["start", SUITE(0), joinIdOf("g1"), SUITE(6)].map((id) => nodeOf(graph, id).lane), [0, 1, 2, 3]);
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

const asNode = { node: true };

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
      execStart("x-ok", "tests", {}, asNode),
      execEnd("x-ok", "tests"),
      execStart("x-bad", "lint", {}, asNode),
      execEnd("x-bad", "lint", {}, { ok: false, exitCode: 2 }),
      execStart("x-slow", "build", {}, asNode),
      execEnd("x-slow", "build", {}, { ok: false, outcome: "timeout", exitCode: undefined, signal: "SIGTERM" }),
      execStart("x-gone", "deploy", {}, asNode),
      execEnd("x-gone", "deploy", {}, { ok: false, outcome: "cancelled" }),
    ]),
  );

  assert.deepEqual(
    ["s-run", "s-ok", "s-bad", "s-stop", "s-old", "x-ok", "x-bad", "x-slow", "x-gone"].map((id) => stateOf(graph, id)),
    ["running", "ok", "failed", "cancelled", "cached", "ok", "failed", "failed", "cancelled"],
  );
});

const commandOf = (graph: { nodes: GraphNode[]; lanes: Array<{ commands: GraphNode[] }> }, id: string): GraphNode =>
  [...graph.nodes, ...graph.nodes.flatMap((n) => n.commands), ...graph.lanes.flatMap((l) => l.commands)].find((n) => n.id === id)!;

test("a probe that exits non-zero is neutral and keeps its exit code, while a timeout, a kill and a command that is no probe are red", () => {
  const probe = { probe: true };
  const graph = buildRunGraph(
    stamp([
      runStart,
      execStart("x-answer", "git rev-parse"),
      execEnd("x-answer", "git rev-parse", {}, { ok: false, exitCode: 1, ...probe }),
      execStart("x-other", "git diff"),
      execEnd("x-other", "git diff", {}, { ok: false, exitCode: 128, ...probe }),
      execStart("x-hung", "git fetch"),
      execEnd("x-hung", "git fetch", {}, { ok: false, outcome: "timeout", exitCode: undefined, ...probe }),
      execStart("x-killed", "git gc"),
      execEnd("x-killed", "git gc", {}, { ok: false, outcome: "exit", exitCode: undefined, signal: "SIGKILL", ...probe }),
      execStart("x-plain", "git rev-parse"),
      execEnd("x-plain", "git rev-parse", {}, { ok: false, exitCode: 1 }),
      execStart("x-clear", "git diff"),
      execEnd("x-clear", "git diff", {}, probe),
    ]),
  );

  assert.deepEqual(
    ["x-answer", "x-other", "x-hung", "x-killed", "x-plain", "x-clear"].map((id) => commandOf(graph, id).state),
    ["neutral", "neutral", "failed", "failed", "failed", "ok"],
  );
  assert.deepEqual(["x-answer", "x-other", "x-hung"].map((id) => commandOf(graph, id).detail.errorKind), ["exit 1", "exit 128", "timeout"]);
});

test("a probe marked as a node is neutral too, and a probe still running is running", () => {
  const graph = buildRunGraph(
    stamp([runStart, execStart("x-a", "git rev-parse", {}, asNode), execEnd("x-a", "git rev-parse", {}, { ok: false, exitCode: 1, probe: true }), execStart("x-b", "git diff", {}, asNode)]),
  );
  assert.deepEqual([stateOf(graph, "x-a"), stateOf(graph, "x-b")], ["neutral", "running"]);
});

test("in the sandbox run the existence checks are neutral and the failed test suite is red", () => {
  const graph = buildRunGraph(sandboxRun(), { settled: true });
  const states = (commands: GraphNode[]) => commands.map((c) => [c.label, c.state, c.detail.errorKind]);

  assert.deepEqual(
    states(graph.lanes.find((l) => l.title === "Implementation")!.commands.filter((c) => c.state !== "ok")),
    [["git rev-parse", "neutral", "exit 1"], ["git rev-parse", "neutral", "exit 1"]],
  );
  assert.deepEqual(states(graph.lanes.find((l) => l.title === "Delivery")!.commands.filter((c) => c.state !== "ok")), [["git diff", "neutral", "exit 1"]]);
  assert.deepEqual([stateOf(graph, SUITE(1)), nodeOf(graph, SUITE(1)).detail.errorKind, stateOf(graph, SUITE(2))], ["failed", "exit 1", "ok"]);
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

test("a cloud step names its agent from the moment the agent exists, before the step ends; the latest agent is the step's when an attempt replaced it", () => {
  const cloud = { location: "cloud" };
  const going = buildRunGraph(stamp([runStart, stepStart("s-a", "look", {}, cloud), cloudAgent("s-a", "bc-1111")]));
  assert.equal(nodeOf(going, "s-a").state, "running");
  assert.deepEqual([nodeOf(going, "s-a").detail.location, nodeOf(going, "s-a").detail.cloudAgentId], ["cloud", "bc-1111"]);

  const replaced = buildRunGraph(
    stamp([
      runStart,
      stepStart("s-a", "look", {}, cloud),
      cloudAgent("s-a", "bc-1111"),
      stepEnd("s-a", "look", {}, { attemptId: "s-a#1", ok: false, errorKind: "exception", location: "cloud", agentId: "bc-1111" }),
      stepStart("s-a", "look", {}, { ...cloud, attemptId: "s-a#2", attempt: 2 }),
      cloudAgent("s-a", "bc-2222", {}, { attemptId: "s-a#2" }),
      stepEnd("s-a", "look", {}, { attemptId: "s-a#2", attempt: 2, location: "cloud", agentId: "bc-2222" }),
    ]),
  );
  assert.equal(nodeOf(replaced, "s-a").detail.cloudAgentId, "bc-2222");
});

test("a step that did not run in the cloud has no cloud agent, whatever agent id its end carries; a log that never named one leaves it out", () => {
  const graph = buildRunGraph(
    stamp([
      runStart,
      stepStart("s-a", "local one", {}, { location: "local" }),
      stepEnd("s-a", "local one", {}, { location: "local", agentId: "agent-7" }),
      stepStart("s-b", "older log", {}),
      stepEnd("s-b", "older log", {}),
    ]),
  );
  for (const id of ["s-a", "s-b"]) assert.equal("cloudAgentId" in nodeOf(graph, id).detail, false, id);
});

test("a command shows how it ended: the exit code, or the outcome when it was killed", () => {
  const graph = buildRunGraph(
    stamp([
      runStart,
      execStart("x-a", "lint", {}, asNode),
      execEnd("x-a", "lint", {}, { ok: false, exitCode: 2, durationMs: 1500 }),
      execStart("x-b", "build", {}, asNode),
      execEnd("x-b", "build", {}, { ok: false, outcome: "timeout", exitCode: undefined, durationMs: 600000 }),
      execStart("x-c", "ghost", {}, asNode),
      execEnd("x-c", "ghost", {}, { ok: false, outcome: "spawn-error", exitCode: undefined, error: "spawn ghost ENOENT", durationMs: 2 }),
    ]),
  );

  assert.deepEqual(nodeOf(graph, "x-a").detail, { command: "npm", location: "local", attempts: 1, tokens: 0, costCents: 0, costFinal: true, durationMs: 1500, errorKind: "exit 2", exitCode: 2 });
  assert.equal(nodeOf(graph, "x-b").detail.errorKind, "timeout");
  assert.deepEqual([nodeOf(graph, "x-c").detail.errorKind, nodeOf(graph, "x-c").detail.error], ["spawn-error", "spawn ghost ENOENT"]);
});

test("a command keeps the exit code or the signal it ended with, and whether its caller marked it as a probe", () => {
  const graph = buildRunGraph(
    stamp([
      runStart,
      execStart("x-ok", "lint", {}, asNode),
      execEnd("x-ok", "lint", {}, { durationMs: 40 }),
      execStart("x-fail", "build", {}, asNode),
      execEnd("x-fail", "build", {}, { ok: false, exitCode: 2 }),
      execStart("x-probe", "git rev-parse", {}, asNode),
      execEnd("x-probe", "git rev-parse", {}, { ok: false, exitCode: 1, probe: true }),
      execStart("x-hung", "git fetch", {}, asNode),
      execEnd("x-hung", "git fetch", {}, { ok: false, outcome: "timeout", exitCode: undefined, signal: "SIGTERM" }),
      execStart("x-live", "sleep", {}, asNode),
    ]),
  );
  const facts = (id: string) => {
    const { exitCode, signal, probe } = nodeOf(graph, id).detail;
    return { exitCode, signal, probe };
  };

  assert.deepEqual(facts("x-ok"), { exitCode: 0, signal: undefined, probe: undefined });
  assert.deepEqual(facts("x-fail"), { exitCode: 2, signal: undefined, probe: undefined });
  assert.deepEqual(facts("x-probe"), { exitCode: 1, signal: undefined, probe: true });
  assert.deepEqual(facts("x-hung"), { exitCode: undefined, signal: "SIGTERM", probe: undefined });
  assert.deepEqual(facts("x-live"), { exitCode: undefined, signal: undefined, probe: undefined }, "a command still going has not ended with anything");
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

  assert.deepEqual(graph.lanes.map(({ index, title }) => [index, title]), [[0, "Plan"], [1, "Build"], [2, "Ship"]]);
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
  assert.deepEqual(graph.lanes.map(({ index, title }) => [index, title]), [[0, ""]]);
  assert.equal(laneOf(graph, "s-a"), 0);
});

test("the run's summary says whether what it spent is final: not once an attempt's cost was reported as not final", () => {
  const ended = (stepId: string, costFinal: boolean): Draft[] => [stepStart(stepId, stepId), stepEnd(stepId, stepId, {}, { usage: { totalTokens: 1000 }, rawCents: 0, chargedCents: 0, costFinal })];
  const summary = (drafts: Draft[]) => buildRunGraph(stamp(drafts)).run;

  assert.equal(summary([runStart, ...ended("s-a", true), ...ended("s-b", true)]).costFinal, true);
  assert.equal(summary([runStart, ...ended("s-a", true), ...ended("s-b", false)]).costFinal, false);
  assert.equal(summary([runStart, stepStart("s-a", "plan")]).costFinal, true, "an attempt still going has not reported its cost as not final");
});

test("the run's summary: status, executions and what it spent, from its events alone", () => {
  const spent = (stepId: string): Draft[] => [stepStart(stepId, stepId), stepEnd(stepId, stepId, {}, { usage: { totalTokens: 1000 }, rawCents: 2, chargedCents: 1 })];
  const summary = (drafts: Draft[], settled = false) => buildRunGraph(stamp(drafts), { settled }).run;

  assert.deepEqual(summary([runStart, ...spent("s-a"), ...spent("s-b")]), { workflow: "demo", status: "running", startedAt: new Date(T0).toISOString(), executions: 1, tokens: 2000, costCents: 4, costFinal: true });
  assert.equal(summary([runStart, ...spent("s-a")], true).status, "interrupted", "settled with no run-end: the process is gone");

  const ended = (status: string, extra: Record<string, unknown> = {}): Draft[] => [runStart, ...spent("s-a"), { type: "run-end", status, ...extra }];
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

test("the event schema version decides how an event is read: an older or unversioned one is read, a newer one is opaque even when its type is known", () => {
  const known = stamp([runStart, ...step("s-a", "plan")]);
  const older = known.map(({ v: _v, ...rest }) => rest as RunEvent); // a log from before events carried `v`
  assert.deepEqual(idsOf(buildRunGraph(older).nodes), idsOf(buildRunGraph(known).nodes));

  const newer = (event: Draft): RunEvent => ({ ...stamp([event])[0]!, v: KNOWN_EVENT_VERSION + 1 });
  const graph = buildRunGraph([...known, newer(stepStart("s-z", "from the future", { parentId: "s-a" })), newer({ type: "step-end", stepId: "s-a", ok: false, errorKind: "timeout" })]);
  assert.deepEqual(idsOf(graph.nodes), idsOf(buildRunGraph(known).nodes), "a newer step-start may mean something else: no node");
  assert.equal(stateOf(graph, "s-a"), "ok", "a newer step-end does not change the step");
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

const spentBy = (stepId: string, tokens: number, cents: number, extra: Record<string, unknown> = {}): Draft[] => [
  stepStart(stepId, stepId, {}, extra),
  stepEnd(stepId, stepId, {}, { usage: { totalTokens: tokens }, rawCents: cents, chargedCents: cents, ...extra }),
];
const failedThenResumed = (): RunEvent[] =>
  stamp([
    runStart,
    ...spentBy("s-a", 1000, 2),
    { type: "run-end", status: "failed" },
    runStart,
    ...spentBy("s-a", 2000, 3, { attemptId: "s-a#2", attempt: 2 }),
    ...spentBy("s-b", 500, 1),
    { type: "run-end", status: "finished" },
  ]);

test("each run-start opens an execution that lasts to the next one, and the page opens on the latest unless another was picked", () => {
  const sandbox = sandboxRun();
  const executions = executionsOf(sandbox);

  assert.deepEqual(executions, [{ from: 0, to: 7 }, { from: 7, to: sandbox.length }]);
  assert.deepEqual([currentExecution(executions, undefined), currentExecution(executions, 0), currentExecution(executions, 1)], [1, 0, 1]);
  assert.equal(currentExecution(executions, 5), 1, "a pick beyond the executions there are stays on the latest");
  assert.deepEqual(executionsOf([]), [{ from: 0, to: 0 }], "a run with no event yet has the one execution it is about to have");
  const ahead = stamp([runStart, ...step("s-a", "plan")]);
  assert.deepEqual(executionsOf([...ahead, { ...stamp([runStart])[0]!, v: KNOWN_EVENT_VERSION + 1 }]), [{ from: 0, to: 4 }], "a run-start of a newer schema opens nothing");
});

test("the sandbox run's first execution draws its start and its failed command, and its second draws the run without that failure", () => {
  const sandbox = sandboxRun();
  const [first, second] = executionsOf(sandbox).map(({ from, to }) => buildRunGraph(sandbox.slice(from, to), { settled: true }));

  assert.deepEqual(idsOf(first!.nodes), ["start"]);
  assert.equal(first!.run.status, "failed");
  assert.deepEqual(failedWork(first!).map((n) => [n.label, n.detail.errorKind]), [["gh issue view", "exit 1"]]);
  assert.equal(second!.run.status, "finished");
  assert.ok(!failedWork(second!).some((n) => n.label === "gh issue view"), "the failed attempt belongs to the first execution only");
  assert.equal(stateOf(second!, SUITE(1)), "failed", "what the second execution draws is its own: the red test suite");
});

test("the totals of a resumed run sum its executions, whichever execution is on show", () => {
  const events = failedThenResumed();
  const executions = executionsOf(events);
  const spent = (shown: RunEvent[]) => {
    const { run } = buildRunGraph(shown, { settled: true });
    return [run.tokens, run.costCents];
  };
  const each = executions.map(({ from, to }) => spent(events.slice(from, to)));
  assert.deepEqual(each, [[1000, 2], [2500, 4]], "an execution alone knows only what it spent");

  for (const picked of [0, 1]) {
    const { run } = shownEvents(events, executions[picked]!, null);
    assert.deepEqual(spent(run), [3500, 6], `execution ${picked + 1} on show: the header still has the sum of both`);
  }
});

test("a replay of an execution shows that execution up to its position, after the executions before it", () => {
  const events = failedThenResumed();
  const [first, second] = executionsOf(events);

  const early = shownEvents(events, first!, 2);
  assert.deepEqual([early.execution.length, early.run.length], [2, 2]);

  const part = shownEvents(events, second!, 3);
  assert.deepEqual(part.execution, events.slice(second!.from, second!.from + 3));
  assert.deepEqual(part.run, events.slice(0, second!.from + 3), "the run as it stood: the first execution whole, the second so far");
  assert.deepEqual(idsOf(buildRunGraph(part.execution).nodes), ["start", "s-a"], "the second execution so far has its start and its first step only");
  assert.deepEqual(shownEvents(events, first!, 0).execution, []);
});

test("a step names the attempts that ran in the execution on show: the ones of a resume are not in the execution before it, and one served from the journal ran none", () => {
  const events = stamp([
    runStart,
    ...spentBy("s-a", 1000, 2),
    { type: "run-end", status: "failed" },
    runStart,
    ...spentBy("s-a", 2000, 3, { attemptId: "s-a#2", attempt: 2 }),
    stepStart("s-b", "cached-step", {}, { cached: "journal", attemptId: "s-b#j" }),
    stepEnd("s-b", "cached-step", {}, { cached: "journal", attemptId: "s-b#j" }),
  ]);
  const [first, second] = executionsOf(events).map(({ from, to }) => buildRunGraph(events.slice(from, to), { settled: true }));

  assert.deepEqual(nodeOf(first!, "s-a").attemptIds, ["s-a#1"]);
  assert.deepEqual(nodeOf(second!, "s-a").attemptIds, ["s-a#2"]);
  assert.deepEqual(nodeOf(second!, "s-b").attemptIds, [], "nothing ran now: its log is the one of the execution that ran it");
  assert.deepEqual(nodeOf(buildRunGraph(events, { settled: true }), "s-a").attemptIds, ["s-a#1", "s-a#2"]);
});
