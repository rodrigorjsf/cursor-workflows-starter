// Where each node of a run graph goes. elkjs lays the graph out left to right (layers by dependency), with one partition per
// lane so that the phases come out as consecutive bands. The same module runs in the browser and, for the tests, in Node.
import ELK from "elkjs/lib/elk.bundled.js";
import type { GraphLane, NodeKind, RunGraph } from "./run-graph.js";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A lane as a vertical band: it spans the whole height of the layout. */
export interface LaneBand {
  index: number;
  title: string;
  x: number;
  width: number;
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

/** Space around the nodes of the first and last lane, inside the band. */
const LANE_PADDING = 24;

const elk = new ELK();

export async function layoutRunGraph(graph: RunGraph): Promise<RunLayout> {
  if (graph.nodes.length === 0) return { nodes: {}, lanes: [], width: 0, height: 0 };
  const laid = await elk.layout({
    id: "run",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.partitioning.activate": "true",
      "elk.spacing.nodeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      // The order the nodes and edges arrived in decides ties, so that what is already drawn stays where it is as the run grows.
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
    },
    children: graph.nodes.map((node) => ({ id: node.id, ...NODE_SIZE[node.kind], layoutOptions: { "elk.partitioning.partition": String(node.lane) } })),
    edges: graph.edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  });

  const nodes: Record<string, Box> = {};
  for (const child of laid.children ?? []) nodes[child.id] = { x: child.x ?? 0, y: child.y ?? 0, width: child.width ?? 0, height: child.height ?? 0 };
  const right = Math.max(...Object.values(nodes).map((b) => b.x + b.width));
  const bottom = Math.max(...Object.values(nodes).map((b) => b.y + b.height));
  const left = Math.min(...Object.values(nodes).map((b) => b.x));
  return { nodes, lanes: bandsOf(graph, nodes, left - LANE_PADDING, right + LANE_PADDING), width: right + LANE_PADDING, height: bottom + LANE_PADDING };
}

/** The bands: each lane spans its nodes, and the gap between two lanes is split down the middle, so the bands tile. */
function bandsOf(graph: RunGraph, nodes: Record<string, Box>, from: number, to: number): LaneBand[] {
  const spans = graph.lanes
    .map((lane: GraphLane) => {
      const boxes = graph.nodes.filter((n) => n.lane === lane.index).map((n) => nodes[n.id]!);
      return boxes.length === 0 ? undefined : { lane, min: Math.min(...boxes.map((b) => b.x)), max: Math.max(...boxes.map((b) => b.x + b.width)) };
    })
    .filter((span) => span !== undefined);
  return spans.map((span, i) => {
    const x = i === 0 ? from : (spans[i - 1]!.max + span.min) / 2;
    const end = i === spans.length - 1 ? to : (span.max + spans[i + 1]!.min) / 2;
    return { index: span.lane.index, title: span.lane.title, x, width: end - x };
  });
}
