// Seam: `panTarget`, where the Run view's canvas pans when a node takes the keyboard focus. A run too big to read whole is
// framed in part, so some of its nodes start off the canvas, and every step and command is a Tab stop: focusing one must bring
// the whole of it into view, at the zoom the reader is at. A node already in view does not move the canvas.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FitViewOptions } from "@xyflow/react";
import { boundsOf, fitZoom, frameOf, panTarget } from "../run-view/framing.js";
import { buildRunGraph, isWork } from "../run-view/run-graph.js";
import { type Box, type RunLayout, layoutRunGraph } from "../run-view/run-layout.js";
import { groupEnd, groupStart, phase, runStart, stamp, step, stepStart, type Draft } from "./run-log.js";

type Viewport = { x: number; y: number; zoom: number };
type Pane = { width: number; height: number };

/** The viewport React Flow's `fitView` gives a frame (`getViewportForBounds`): what it frames, centred, at the zoom it clamps. */
function viewportOf(frame: FitViewOptions, layout: RunLayout, pane: Pane): Viewport {
  const boxes = frame.nodes ? frame.nodes.map((n) => layout.nodes[n.id]!) : Object.values(layout.nodes);
  const bounds = boundsOf(boxes);
  const zoom = Math.min(Math.max(fitZoom(bounds, pane), frame.minZoom ?? 0.1), frame.maxZoom ?? 1.5);
  return { x: pane.width / 2 - (bounds.x + bounds.width / 2) * zoom, y: pane.height / 2 - (bounds.y + bounds.height / 2) * zoom, zoom };
}

/** React Flow's `setCenter(x, y, { zoom })`: the point at the centre of the pane. */
const centredOn = (point: { x: number; y: number }, zoom: number, pane: Pane): Viewport => ({ x: pane.width / 2 - point.x * zoom, y: pane.height / 2 - point.y * zoom, zoom });

/** The whole box is on the canvas. */
const inView = (box: Box, vp: Viewport, pane: Pane): boolean =>
  box.x * vp.zoom + vp.x >= 0 && (box.x + box.width) * vp.zoom + vp.x <= pane.width && box.y * vp.zoom + vp.y >= 0 && (box.y + box.height) * vp.zoom + vp.y <= pane.height;

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

test("focusing any step or command puts the whole of it on the canvas; a step already there does not move it", async () => {
  for (const pane of [
    { width: 360, height: 520 },
    { width: 1440, height: 700 },
  ]) {
    for (const running of [false, true]) {
      const graph = buildRunGraph(stamp(long(running)), { settled: !running });
      const layout = await layoutRunGraph(graph);
      const start = viewportOf(frameOf(graph, layout, pane), layout, pane);
      for (const node of graph.nodes.filter((n) => isWork(n.kind))) {
        const box = layout.nodes[node.id]!;
        const target = panTarget(box, start, pane);
        if (inView(box, start, pane)) assert.equal(target, undefined, `${pane.width}px: ${node.label} is in view, yet focusing it pans`);
        const after = target === undefined ? start : centredOn(target, start.zoom, pane);
        assert.ok(inView(box, after, pane), `${pane.width}px ${running ? "live" : "settled"}: ${node.label} is off the canvas when focused`);
      }
    }
  }
});
