// Seam: `frameOf`, which picks what the Run view's canvas shows first. A run framed whole is shown whole; a run too big for the
// screen at a readable zoom is framed in part, at a zoom where a node's text can be read and what is framed fits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FRAME_PADDING, READABLE_ZOOM, frameOf } from "../run-view/framing.js";
import { buildRunGraph } from "../run-view/run-graph.js";
import { type Box, NODE_TEXT_PX, layoutRunGraph } from "../run-view/run-layout.js";
import { groupEnd, groupStart, phase, runStart, stamp, step, stepStart, type Draft } from "./run-log.js";

/** Text smaller than this many pixels on screen is not readable. */
const MIN_LABEL_PX = 11;
const MIN_SUB_PX = 10;

test("the zoom floor keeps a node's text readable: its label at 11px or more, the line under it at 10px or more", () => {
  assert.ok(READABLE_ZOOM * NODE_TEXT_PX.label >= MIN_LABEL_PX, `the label is ${(READABLE_ZOOM * NODE_TEXT_PX.label).toFixed(1)}px at the floor`);
  assert.ok(READABLE_ZOOM * NODE_TEXT_PX.sub >= MIN_SUB_PX, `the model or command is ${(READABLE_ZOOM * NODE_TEXT_PX.sub).toFixed(1)}px at the floor`);
});

/** The zoom React Flow's `fitView` gives `bounds` in a pane, before it clamps it (`getViewportForBounds`). */
function fitZoom(bounds: Box, pane: { width: number; height: number }, padding: number): number {
  const pad = (size: number) => 2 * Math.floor((size - size / (1 + padding)) * 0.5);
  return Math.min((pane.width - pad(pane.width)) / bounds.width, (pane.height - pad(pane.height)) / bounds.height);
}

const boundsOf = (boxes: Box[]): Box => {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
};

/** A long run: five phases, a fan-out of three in the middle. */
const long = (running: boolean): Draft[] => [
  runStart,
  phase("Triage"),
  ...step("s1", "triage"),
  phase("Plan"),
  ...step("s2", "plan", { parentId: "s1" }),
  phase("Build"),
  groupStart("g1", "parallel", 3, "s2"),
  ...step("b1", "implement-ui", { parentId: "g1", groupId: "g1" }),
  ...step("b2", "implement-api", { parentId: "g1", groupId: "g1" }),
  ...step("b3", "lint", { parentId: "g1", groupId: "g1" }),
  groupEnd("g1"),
  phase("Review"),
  ...step("s3", "review", { parentId: "g1" }),
  phase("Deliver"),
  ...(running ? [stepStart("s4", "push", { parentId: "s3" })] : step("s4", "push", { parentId: "s3" })),
];

const PHONE = { width: 360, height: 520 };

test("on a phone, a run too big to read whole is framed in part: what is framed fits at a readable zoom", async () => {
  for (const running of [false, true]) {
    const graph = buildRunGraph(stamp(long(running)), { settled: !running });
    const layout = await layoutRunGraph(graph);
    const frame = frameOf(graph, layout, PHONE);
    assert.ok((frame.minZoom ?? 0) >= READABLE_ZOOM, "fitView never goes under the floor");
    assert.ok(frame.nodes && frame.nodes.length > 0, "a part of the run is framed");
    const framed = frame.nodes.map((n) => layout.nodes[n.id]!);
    const zoom = fitZoom(boundsOf(framed), PHONE, FRAME_PADDING);
    assert.ok(zoom >= READABLE_ZOOM, `${running ? "live" : "settled"}: the framed nodes need zoom ${zoom.toFixed(2)} to fit, under the floor ${READABLE_ZOOM}`);
    const ids = frame.nodes.map((n) => n.id);
    if (running) assert.ok(ids.includes("s4"), "a live run is framed on the step that runs");
    else assert.ok(ids.includes("s1"), "a settled run is framed on its first step, to be read from the start");
  }
});

test("a run that fits a wide screen at a readable zoom is framed whole", async () => {
  const graph = buildRunGraph(stamp(long(false)), { settled: true });
  const layout = await layoutRunGraph(graph);
  const frame = frameOf(graph, layout, { width: 2400, height: 900 });
  assert.equal(frame.nodes, undefined);
});
