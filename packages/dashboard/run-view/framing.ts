// How the Run view frames a run on its canvas: all of it when that stays readable, otherwise as many nodes as fit at a readable
// zoom. Pure: the caller gives it the size of the pane.
import type { FitViewOptions } from "@xyflow/react";
import type { RunGraph } from "./run-graph.js";
import { type Box, NODE_TEXT_PX, type RunLayout } from "./run-layout.js";

/** Text smaller than this on screen is not readable: a node's label, and the line under it. */
const MIN_LABEL_PX = 11;
const MIN_SUB_PX = 10;

/** The smallest zoom at which a node's text can still be read: its label at 11px or more, the line under it at 10px or more. A run that would need less to fit on screen is framed in part. */
export const READABLE_ZOOM = Math.ceil(Math.max(MIN_LABEL_PX / NODE_TEXT_PX.label, MIN_SUB_PX / NODE_TEXT_PX.sub) * 100) / 100;
/** The padding `fitView` keeps around what it frames, as a share of its size. */
export const FRAME_PADDING = 0.15;

/** The zoom React Flow's `fitView` gives `bounds` in a pane of `pane` pixels with `padding`, before it clamps it (`getViewportForBounds` in @xyflow/system). */
export function fitZoom(bounds: Box, pane: { width: number; height: number }, padding = FRAME_PADDING): number {
  const pad = (size: number) => 2 * Math.floor((size - size / (1 + padding)) * 0.5);
  return Math.min((pane.width - pad(pane.width)) / bounds.width, (pane.height - pad(pane.height)) / bounds.height);
}

export function boundsOf(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}

/**
 * How to frame the run in a pane of `pane` pixels: all of it when that stays readable; otherwise as many nodes as fit at a
 * readable zoom around a focus, the nearest first. The focus is the node whose log is open; else, in a run that is over, the
 * first node that failed or stopped (what the reader came for), or its first step (to be read from the start); in a live run,
 * the latest node. The user pans to the rest; Fit View shows it all.
 */
export function frameOf(graph: RunGraph, layout: RunLayout, pane: { width: number; height: number }, selectedId?: string): FitViewOptions {
  const options: FitViewOptions = { padding: FRAME_PADDING, maxZoom: 1, minZoom: READABLE_ZOOM };
  if (layout.width === 0 || fitZoom({ x: 0, y: 0, width: layout.width, height: layout.height }, pane) >= READABLE_ZOOM) return options;
  const settled = graph.nodes.every((n) => n.state !== "running");
  const placed = graph.nodes.filter((n) => layout.nodes[n.id] !== undefined);
  const work = placed.filter((n) => n.kind !== "start");
  const focus =
    placed.find((n) => n.id === selectedId) ??
    (settled ? (work.find((n) => n.state === "failed" || n.state === "interrupted") ?? work[0]) : (work.findLast((n) => n.state === "running") ?? work.at(-1))) ??
    placed[0]!;
  const centre = (id: string) => layout.nodes[id]!.x + layout.nodes[id]!.width / 2;
  const order = [focus, ...placed.filter((n) => n !== focus).sort((a, b) => Math.abs(centre(a.id) - centre(focus.id)) - Math.abs(centre(b.id) - centre(focus.id)))];
  const picked: string[] = [];
  for (const node of order) {
    const boxes = [...picked, node.id].map((id) => layout.nodes[id]!);
    if (picked.length > 0 && fitZoom(boundsOf(boxes), pane) < READABLE_ZOOM) break;
    picked.push(node.id);
  }
  return { ...options, nodes: picked.map((id) => ({ id })) };
}
