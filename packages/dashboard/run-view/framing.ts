// How the Run view frames a run on its canvas: all of it when that stays readable, otherwise a part of it. Pure: the caller
// gives it the size of the pane.
import type { FitViewOptions } from "@xyflow/react";
import type { RunGraph } from "./run-graph.js";
import type { RunLayout } from "./run-layout.js";

/** The smallest zoom at which a node's text can still be read. A run that would need less to fit on screen is framed in part. */
export const READABLE_ZOOM = 0.45;
/** How many nodes a partial frame holds. */
const FRAME_NODES = 5;
/** The padding `fitView` keeps around what it frames, as a share of its size. */
export const FRAME_PADDING = 0.15;

/** How to frame the run in a pane of `pane` pixels: all of it when that stays readable, otherwise the latest nodes of a live run, or the first ones of a run that is over (to be read from the start). */
export function frameOf(graph: RunGraph, layout: RunLayout, pane: { width: number; height: number }): FitViewOptions {
  const options: FitViewOptions = { padding: FRAME_PADDING, maxZoom: 1, minZoom: READABLE_ZOOM };
  if (Math.min(pane.width / layout.width, pane.height / layout.height) >= READABLE_ZOOM) return options;
  const settled = graph.nodes.every((n) => n.state !== "running");
  const work = graph.nodes.filter((n) => n.kind !== "start");
  return { ...options, nodes: (settled ? work.slice(0, FRAME_NODES) : work.slice(-FRAME_NODES)).map((n) => ({ id: n.id })) };
}
