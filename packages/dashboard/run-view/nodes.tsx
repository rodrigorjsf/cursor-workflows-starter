// The node components of the Run view: a step or command (with its tooltip), the start, a fork or join, and a lane's band.
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { NodeRows } from "./NodeRows.js";
import { describeNode, runsInCloud } from "./node-details.js";
import { NODE_SIZE } from "./run-layout.js";
import type { GraphNode, NodeState } from "./run-graph.js";

export interface WorkNodeData extends Record<string, unknown> {
  node: GraphNode;
  /** The clock in ms, for the time of a node that is still running. */
  now: number;
  /** Opens the node's log. Called for a key press on the node; a click is React Flow's `onNodeClick`. */
  onOpen?: () => void;
}
export interface LaneNodeData extends Record<string, unknown> {
  title: string;
}

const GLYPH: Record<NodeState, string> = { running: "●", ok: "✓", failed: "✗", cancelled: "⊘", cached: "↺", interrupted: "⏸" };

/** The state as a word a screen reader says; the glyph alone is decoration. */
function Glyph({ state }: { state: NodeState }) {
  return (
    <span className="glyph" aria-hidden="true">
      {GLYPH[state]}
    </span>
  );
}

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}

/** A step or a command: its label, what it runs, a badge when it ran in the cloud, and a tooltip with the details that appears on hover or focus. Clicking it (or Enter on it) opens its log. */
export function WorkNode({ data, selected }: NodeProps<Node<WorkNodeData, "work">>) {
  const { node, now, onOpen } = data;
  const rows = describeNode(node, now);
  const what = node.kind === "command" ? node.detail.command : node.detail.model;
  const cloud = runsInCloud(node);
  return (
    <div
      className={`work ${node.kind} state-${node.state}${selected ? " selected" : ""}`}
      style={NODE_SIZE[node.kind]}
      tabIndex={0}
      role="button"
      aria-pressed={selected}
      aria-label={`${node.label}: ${node.state}${cloud ? ", cloud agent" : ""}. Open its log`}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onOpen?.();
      }}
    >
      <Handles />
      <div className="title">
        <Glyph state={node.state} />
        <span className="label">{node.label}</span>
        {cloud && (
          <span className="where" title="Runs as a Cursor cloud agent">
            <span aria-hidden="true">☁</span> cloud
          </span>
        )}
      </div>
      {what !== undefined && <div className="sub">{what}</div>}
      <NodeRows rows={rows} className="tip" role="tooltip" tabbable={false} />
    </div>
  );
}

/** The fork and the join of a group: a small pill that says what fans out, and a dot where it comes back together. */
export function JunctionNode({ data }: NodeProps<Node<WorkNodeData, "junction">>) {
  const { node } = data;
  return (
    <div className={`junction ${node.kind} state-${node.state}`} style={NODE_SIZE[node.kind]} aria-label={`${node.label}: ${node.state}`}>
      <Handles />
      {node.kind === "fork" && <span className="label">{node.label}</span>}
    </div>
  );
}

export function StartNode({ data }: NodeProps<Node<WorkNodeData, "start">>) {
  return (
    <div className="start" style={NODE_SIZE.start} aria-label={`start of ${data.node.label}`}>
      <Handles />
      <span className="label">{data.node.label}</span>
    </div>
  );
}

/** A phase: a band behind the nodes with its title on top. */
export function LaneNode({ data }: NodeProps<Node<LaneNodeData, "lane">>) {
  return <div className="lane">{data.title !== "" && <span className="lane-title">{data.title}</span>}</div>;
}
