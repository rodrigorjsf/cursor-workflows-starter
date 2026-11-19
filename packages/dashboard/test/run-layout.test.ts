// Seam: the run layout. `layoutRunGraph(graph)` gives every node a box and every lane a band, using elkjs (the same library the
// browser runs). The assertions are on the geometry the picture depends on: the flow runs left to right, parallel branches
// stack, lanes tile the width in phase order and hold their nodes, and a node keeps its place as the run grows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type RunGraph, buildRunGraph, joinIdOf } from "../run-view/run-graph.js";
import { frameOf } from "../run-view/framing.js";
import { type Box, LAYOUT_MAX_WIDTH, laneTitleBox, layoutRunGraph } from "../run-view/run-layout.js";
import { execEnd, execStart, groupEnd, groupStart, phase, runStart, sandboxRun, stamp, step, type Draft } from "./run-log.js";

const inG1 = { groupId: "g1" };
/** plan, then two parallel branches (two steps on the left, one on the right), then a merge step: three phases. */
const fanOut = (upTo = Infinity): Draft[] =>
  [
    runStart,
    phase("Plan"),
    ...step("s-a", "plan"),
    phase("Build"),
    groupStart("g1", "parallel", 2, "s-a"),
    ...step("s-b1", "left 1", { parentId: "g1", ...inG1 }),
    ...step("s-c1", "right 1", { parentId: "g1", ...inG1 }),
    ...step("s-b2", "left 2", { parentId: "s-b1", ...inG1 }),
    groupEnd("g1"),
    phase("Ship"),
    ...step("s-d", "merge", { parentId: "g1" }),
  ].slice(0, upTo);

const laneOf = (graph: RunGraph, id: string) => graph.nodes.find((n) => n.id === id)!.lane;

test("the flow runs left to right inside a phase, on to the band below for the next, and parallel branches stack one above the other", async () => {
  const graph = buildRunGraph(stamp(fanOut()));
  const layout = await layoutRunGraph(graph);

  for (const { source, target } of graph.edges) {
    if (laneOf(graph, source) === laneOf(graph, target)) assert.ok(layout.nodes[source]!.x < layout.nodes[target]!.x, `${source} is left of ${target}`);
    else assert.ok(layout.nodes[source]!.y < layout.nodes[target]!.y, `${source} is above ${target}`);
  }
  const [left, right] = [layout.nodes["s-b1"]!, layout.nodes["s-c1"]!];
  assert.equal(left.x, right.x, "both branches start in the same column");
  assert.ok(left.y + left.height <= right.y || right.y + right.height <= left.y, "and do not overlap");
  assert.ok(layout.width > 0 && layout.height > 0);
});

test("lanes are bands in phase order that tile the height without overlapping, and each holds its nodes", async () => {
  const graph = buildRunGraph(stamp(fanOut()));
  const layout = await layoutRunGraph(graph);

  assert.deepEqual(layout.lanes.map((l) => l.title), ["Plan", "Build", "Ship"]);
  for (const [i, lane] of layout.lanes.entries()) {
    assert.ok(lane.height > 0);
    assert.deepEqual([lane.x, lane.width], [0, layout.width]);
    if (i > 0) assert.ok(layout.lanes[i - 1]!.y + layout.lanes[i - 1]!.height <= lane.y + 0.001, `lane ${i} starts where lane ${i - 1} ends`);
  }
  assert.equal(layout.lanes.at(-1)!.y + layout.lanes.at(-1)!.height, layout.height);
  for (const node of graph.nodes) {
    const box = layout.nodes[node.id]!;
    const lane = layout.lanes[node.lane]!;
    assert.ok(box.x >= lane.x && box.x + box.width <= lane.x + lane.width && box.y >= lane.y && box.y + box.height <= lane.y + lane.height, `${node.id} is inside its lane`);
  }
});

test("a node keeps its row as the run grows: the branches do not swap places when more of the run arrives", async () => {
  const early = await layoutRunGraph(buildRunGraph(stamp(fanOut(12))));
  const full = await layoutRunGraph(buildRunGraph(stamp(fanOut())));

  assert.ok(early.nodes["s-b1"]!.y < early.nodes["s-c1"]!.y);
  assert.ok(full.nodes["s-b1"]!.y < full.nodes["s-c1"]!.y, "left stays above right once the left branch is longer and the join is there");
  assert.ok(full.nodes[joinIdOf("g1")] !== undefined);
});

test("an empty graph has an empty layout", async () => {
  const layout = await layoutRunGraph(buildRunGraph([]));
  assert.deepEqual(layout, { nodes: {}, lanes: [], width: 0, height: 0 });
});

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Shapes whose lanes start with a node on the top row: the fan-out, two phases of one command each (a setup, then a wait), a lane that holds only a fork, and a long single file. */
const titledRuns: Array<[name: string, drafts: Draft[]]> = [
  ["fan-out", fanOut()],
  ["setup then wait", [runStart, phase("Setup"), execStart("e1", "prepare", {}, { node: true }), execEnd("e1", "prepare"), phase("Wait"), execStart("e2", "sleep 600", { parentId: "e1" }, { node: true })]],
  [
    "a fork alone in its lane",
    [runStart, phase("Plan"), ...step("s-a", "plan"), phase("Fan out"), groupStart("g1", "parallel", 2, "s-a"), phase("Build"), ...step("s-b", "left", { parentId: "g1", ...inG1 }), ...step("s-c", "right", { parentId: "g1", ...inG1 }), groupEnd("g1")],
  ],
  ["one phase per step", [runStart, ...["Triage", "Plan", "Build", "Review", "Deliver"].flatMap((title, i) => [phase(title), ...step(`s${i}`, title.toLowerCase(), { parentId: i === 0 ? null : `s${i - 1}` })])]],
];

test("no node covers a lane's title: every title box is clear of every node, whatever node starts the lane", async () => {
  for (const [name, drafts] of titledRuns) {
    const graph = buildRunGraph(stamp(drafts), { settled: true });
    const layout = await layoutRunGraph(graph);
    assert.ok(layout.lanes.length > 1, `${name}: several lanes`);
    for (const lane of layout.lanes) {
      const title = laneTitleBox(lane);
      assert.ok(title.width >= 40, `${name}: the title of ${lane.title} has room (${title.width}px)`);
      for (const [id, box] of Object.entries(layout.nodes)) assert.ok(!overlaps(title, box), `${name}: node ${id} covers the title of lane ${lane.title}`);
    }
    for (const box of Object.values(layout.nodes)) assert.ok(box.y + box.height <= layout.height && box.x + box.width <= layout.width, `${name}: the layout is as large as the nodes`);
  }
});

const longChain = (length: number): Draft[] => [runStart, phase("Build"), ...Array.from({ length }, (_, i) => step(`s${i}`, `step ${i}`, { parentId: i === 0 ? null : `s${i - 1}` })).flat()];

test("a phase with a long chain wraps into rows inside its band, so the layout never grows wider than the page it is drawn for", async () => {
  const graph = buildRunGraph(stamp(longChain(14)));
  const layout = await layoutRunGraph(graph);

  assert.ok(layout.width <= LAYOUT_MAX_WIDTH, `${layout.width}px wide`);
  const rowsTops = new Set(Object.entries(layout.nodes).filter(([id]) => id !== "start").map(([, box]) => box.y));
  assert.ok(rowsTops.size >= 2, "the chain takes more than one row");
  const lane = layout.lanes[0]!;
  assert.equal(layout.lanes.length, 1);
  assert.equal(lane.height, layout.height);
  const boxes = Object.entries(layout.nodes);
  for (const [a, boxA] of boxes) for (const [b, boxB] of boxes) if (a < b) assert.ok(!overlaps(boxA, boxB), `${a} and ${b} do not overlap`);
});

test("a short run is not wrapped: its chain stays on one row", async () => {
  const layout = await layoutRunGraph(buildRunGraph(stamp(longChain(3))));
  const xs = ["s0", "s1", "s2"].map((id) => layout.nodes[id]!.x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs);
  assert.equal(new Set(xs).size, 3);
  assert.equal(new Set(["s0", "s1", "s2"].map((id) => layout.nodes[id]!.y)).size, 1);
});

test("a phase that holds no node has a band of its own, tall enough for its title", async () => {
  const graph = buildRunGraph(stamp([runStart, phase("Triage"), execStart("e1", "gh issue view"), execEnd("e1", "gh issue view"), phase("Build"), ...step("s-a", "code", { parentId: "e1" }), phase("Deliver"), execStart("e2", "git push", { parentId: "s-a" }), execEnd("e2", "git push")]), { settled: true });
  const layout = await layoutRunGraph(graph);

  assert.deepEqual(layout.lanes.map((l) => l.title), ["Triage", "Build", "Deliver"]);
  for (const lane of layout.lanes) assert.ok(lane.height >= 40, `${lane.title} has room for its title`);
});

test("the sandbox run's graph fits a page 1500 px wide in one frame, with no horizontal scrolling", async () => {
  const graph = buildRunGraph(sandboxRun(), { settled: true });
  const layout = await layoutRunGraph(graph);

  assert.ok(layout.width <= 1500, `${layout.width}px wide`);
  const frame = frameOf(graph, layout, { width: 1500, height: 740 });
  assert.equal(frame.nodes, undefined, "every node is in the frame");
  assert.ok((frame.minZoom ?? 1) <= 0.9, "at a zoom a person can read");
});
