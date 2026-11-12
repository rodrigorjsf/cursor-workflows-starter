// Seam: the run layout. `layoutRunGraph(graph)` gives every node a box and every lane a band, using elkjs (the same library the
// browser runs). The assertions are on the geometry the picture depends on: the flow runs left to right, parallel branches
// stack, lanes tile the width in phase order and hold their nodes, and a node keeps its place as the run grows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRunGraph, joinIdOf } from "../run-view/run-graph.js";
import { layoutRunGraph } from "../run-view/run-layout.js";
import { groupEnd, groupStart, phase, runStart, stamp, step, type Draft } from "./run-log.js";

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

test("the flow runs left to right and parallel branches stack one above the other", async () => {
  const graph = buildRunGraph(stamp(fanOut()));
  const layout = await layoutRunGraph(graph);

  for (const { source, target } of graph.edges) assert.ok(layout.nodes[source]!.x < layout.nodes[target]!.x, `${source} is left of ${target}`);
  const [left, right] = [layout.nodes["s-b1"]!, layout.nodes["s-c1"]!];
  assert.equal(left.x, right.x, "both branches start in the same column");
  assert.ok(left.y + left.height <= right.y || right.y + right.height <= left.y, "and do not overlap");
  assert.ok(layout.width > 0 && layout.height > 0);
});

test("lanes are bands in phase order that tile the width without overlapping, and each holds its nodes", async () => {
  const graph = buildRunGraph(stamp(fanOut()));
  const layout = await layoutRunGraph(graph);

  assert.deepEqual(layout.lanes.map((l) => l.title), ["Plan", "Build", "Ship"]);
  for (const [i, lane] of layout.lanes.entries()) {
    assert.ok(lane.width > 0);
    if (i > 0) assert.ok(layout.lanes[i - 1]!.x + layout.lanes[i - 1]!.width <= lane.x + 0.001, `lane ${i} starts where lane ${i - 1} ends`);
  }
  for (const node of graph.nodes) {
    const box = layout.nodes[node.id]!;
    const lane = layout.lanes[node.lane]!;
    assert.ok(box.x >= lane.x && box.x + box.width <= lane.x + lane.width, `${node.id} is inside its lane`);
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
