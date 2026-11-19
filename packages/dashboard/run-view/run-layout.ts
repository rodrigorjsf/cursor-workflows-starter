// Where each node of a run graph goes. elkjs lays the graph out left to right (layers by dependency), with one partition per
// lane so that the phases come out as consecutive bands. The same module runs in the browser and, for the tests, in Node.
import ELK from "elkjs/lib/elk.bundled.js";
import type { NodeKind, RunGraph } from "./run-graph.js";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaneBand {
  index: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RunLayout {
  nodes: Record<string, Box>;
  lanes: LaneBand[];
  width: number;
  height: number;
}

/** The size each kind of node is drawn at. The components size themselves to these. */
export const NODE_SIZE: Record<NodeKind, { width: number; height: number }> = {
  start: { width: 120, height: 34 },
  step: { width: 200, height: 60 },
  command: { width: 200, height: 46 },
  fork: { width: 110, height: 30 },
  join: { width: 30, height: 30 },
};

/** The text sizes of a step or command node, in pixels at zoom 1: its label, and the line under it (the model or the command). The components set them. */
export const NODE_TEXT_PX = { label: 14, sub: 12 } as const;

const LANE_PADDING = 24;
const ROW_GAP = 32;
export const LAYOUT_MAX_WIDTH = 1400;

/** Where a lane's title sits inside its band: `LaneNode` places the title with these, and the title is cut to the box. */
export const LANE_TITLE = { top: 10, left: 12, height: 18 } as const;

/** The strip at the top of every band that holds its title: no node is placed in it, so no node covers a title. */
const LANE_HEADER = LANE_TITLE.top + LANE_TITLE.height + 12;

/** The box a lane's title takes, in the coordinates of the layout. */
export const laneTitleBox = (lane: LaneBand): Box => ({ x: lane.x + LANE_TITLE.left, y: lane.y + LANE_TITLE.top, width: Math.max(0, lane.width - 2 * LANE_TITLE.left), height: LANE_TITLE.height });

const elk = new ELK();

interface Layer {
  boxes: Array<Box & { id: string }>;
  left: number;
  right: number;
}

async function layersOf(graph: RunGraph, laneIndex: number): Promise<Layer[]> {
  const members = graph.nodes.filter((node) => node.lane === laneIndex);
  if (members.length === 0) return [];
  const ids = new Set(members.map((node) => node.id));
  const laid = await elk.layout({
    id: `lane-${laneIndex}`,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.layering.strategy": "LONGEST_PATH_SOURCE",
      "elk.spacing.nodeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
    },
    children: members.map((node) => ({ id: node.id, ...NODE_SIZE[node.kind] })),
    edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  });
  const boxes = (laid.children ?? []).map((child) => ({ id: child.id, x: child.x ?? 0, y: child.y ?? 0, width: child.width ?? 0, height: child.height ?? 0 })).sort((a, b) => a.x - b.x);
  const layers: Layer[] = [];
  for (const box of boxes) {
    const layer = layers.at(-1);
    if (layer && box.x < layer.right) {
      layer.boxes.push(box);
      layer.right = Math.max(layer.right, box.x + box.width);
    } else layers.push({ boxes: [box], left: box.x, right: box.x + box.width });
  }
  return layers;
}

function rowsOf(layers: Layer[], cap: number): Layer[][] {
  const rows: Layer[][] = [];
  for (const layer of layers) {
    const row = rows.at(-1);
    if (row && layer.right - row[0]!.left <= cap) row.push(layer);
    else rows.push([layer]);
  }
  return rows;
}

function balancedRows(layers: Layer[], cap: number): Layer[][] {
  const count = rowsOf(layers, cap).length;
  let tight = cap;
  while (tight > 0 && rowsOf(layers, tight - 8).length === count) tight -= 8;
  return rowsOf(layers, tight);
}

export async function layoutRunGraph(graph: RunGraph): Promise<RunLayout> {
  if (graph.nodes.length === 0) return { nodes: {}, lanes: [], width: 0, height: 0 };
  const cap = LAYOUT_MAX_WIDTH - 2 * LANE_PADDING;
  const perLane = await Promise.all(graph.lanes.map(async (lane) => balancedRows(await layersOf(graph, lane.index), cap)));
  const rowWidth = (row: Layer[]) => row.at(-1)!.right - row[0]!.left;
  const width = Math.max(...perLane.flatMap((rows) => rows.map(rowWidth)), 0) + 2 * LANE_PADDING;
  const nodes: Record<string, Box> = {};
  const lanes: LaneBand[] = [];
  let top = 0;
  for (const [i, rows] of perLane.entries()) {
    let rowTop = top + LANE_HEADER;
    for (const row of rows) {
      const boxes = row.flatMap((layer) => layer.boxes);
      const first = Math.min(...boxes.map((b) => b.y));
      for (const box of boxes) nodes[box.id] = { x: box.x - row[0]!.left + LANE_PADDING, y: box.y - first + rowTop, width: box.width, height: box.height };
      rowTop += Math.max(...boxes.map((b) => b.y + b.height)) - first + ROW_GAP;
    }
    const height = rows.length === 0 ? LANE_HEADER + LANE_PADDING : rowTop - ROW_GAP + LANE_PADDING - top;
    lanes.push({ index: graph.lanes[i]!.index, title: graph.lanes[i]!.title, x: 0, y: top, width, height });
    top += height;
  }
  return { nodes, lanes, width, height: top };
}
