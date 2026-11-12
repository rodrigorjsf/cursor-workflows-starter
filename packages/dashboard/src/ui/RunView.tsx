// The Run view: a run drawn as a graph that grows as its events arrive, with the phases as lanes, and a replay of a finished
// run. The data comes from `useRunEvents`, the graph from `buildRunGraph` and the positions from `layoutRunGraph`; this file
// puts them on a React Flow canvas.
import { Background, Controls, type Edge, type Node, ReactFlow, ReactFlowProvider, useReactFlow, useStore } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { JunctionNode, LaneNode, type LaneNodeData, StartNode, WorkNode, type WorkNodeData } from "./nodes.js";
import { formatCents, formatDuration } from "./node-details.js";
import { type RunGraph, buildRunGraph } from "./run-graph.js";
import { type RunLayout, layoutRunGraph } from "./run-layout.js";
import { useRunEvents } from "./use-run-events.js";

// `group` is a node type of React Flow's own (a grey box): the fork and the join are `junction`s.
const NODE_TYPES = { work: WorkNode, junction: JunctionNode, start: StartNode, lane: LaneNode };

/** Event types that change what the graph shows: a replay jumps from one of these to the next. */
const VISIBLE = new Set(["run-start", "run-end", "step-start", "step-end", "exec-start", "exec-end", "group-start", "group-end"]);
/** A replay starts with the run's first event shown: the start node, not an empty canvas. */
const FIRST_FRAME = 1;
/** Milliseconds between two steps of a replay, by speed. */
const SPEEDS: Array<[label: string, intervalMs: number]> = [["1×", 500], ["2×", 250], ["5×", 100], ["20×", 25]];

/** What makes two graphs need two layouts: the nodes, their lanes and their edges. A node changing state does not. */
const structureOf = (graph: RunGraph): string => `${graph.nodes.map((n) => `${n.id}:${n.kind}:${n.lane}`).join(",")}|${graph.edges.map((e) => e.id).join(",")}`;

/** The layout of `graph`, computed again whenever its structure changes. The previous layout stays up meanwhile. */
function useLayout(graph: RunGraph): RunLayout | undefined {
  const [layout, setLayout] = useState<RunLayout>();
  const structure = structureOf(graph);
  useEffect(() => {
    let stale = false;
    layoutRunGraph(graph).then((next) => {
      if (!stale) setLayout(next);
    }, () => undefined);
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the layout depends on the structure only
  }, [structure]);
  return layout;
}

/** The ticking clock of a view of a live run; a replay passes its own. */
function useClock(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function toFlow(graph: RunGraph, layout: RunLayout, now: number): { nodes: Node[]; edges: Edge[] } {
  const lanes: Node<LaneNodeData, "lane">[] = layout.lanes.map((lane) => ({
    id: `lane-${lane.index}`,
    type: "lane",
    position: { x: lane.x, y: 0 },
    data: { title: lane.title },
    width: lane.width,
    height: layout.height,
    zIndex: -1,
    draggable: false,
    selectable: false,
    focusable: false,
  }));
  const placed = graph.nodes.filter((n) => layout.nodes[n.id]);
  const work: Node<WorkNodeData>[] = placed.map((node) => ({
    id: node.id,
    type: node.kind === "step" || node.kind === "command" ? "work" : node.kind === "start" ? "start" : "junction",
    position: { x: layout.nodes[node.id]!.x, y: layout.nodes[node.id]!.y },
    data: { node, now: node.state === "running" ? now : 0 },
    draggable: false,
  }));
  const state = new Map(graph.nodes.map((n) => [n.id, n.state]));
  const edges: Edge[] = graph.edges
    .filter((e) => layout.nodes[e.source] && layout.nodes[e.target])
    .map((e) => ({ id: e.id, source: e.source, target: e.target, animated: state.get(e.target) === "running", className: `edge-${state.get(e.target)}` }));
  return { nodes: [...(layout.lanes.some((l) => l.title !== "") ? lanes : []), ...work], edges };
}

/** The smallest zoom at which a node's text can still be read. A run that would need less to fit on screen is framed in part. */
const READABLE_ZOOM = 0.45;
const FRAME = { padding: 0.15, maxZoom: 1, minZoom: READABLE_ZOOM };
/** How many nodes a partial frame holds. */
const FRAME_NODES = 5;

/**
 * The canvas. It keeps the run in view as it grows, until the user moves the view themselves: all of it when that stays
 * readable, otherwise the latest nodes of a live run, or the first ones of a run that is over (to be read from the start).
 */
function Canvas({ graph, layout, now }: { graph: RunGraph; layout: RunLayout; now: number }) {
  const { nodes, edges } = useMemo(() => toFlow(graph, layout, now), [graph, layout, now]);
  const { fitView } = useReactFlow();
  const pane = useStore((s) => ({ width: s.width, height: s.height }), (a, b) => a.width === b.width && a.height === b.height);
  const userMoved = useRef(false);
  const settled = graph.nodes.every((n) => n.state !== "running");
  const frame = (duration: number) => {
    const fits = Math.min(pane.width / layout.width, pane.height / layout.height) >= READABLE_ZOOM;
    const work = graph.nodes.filter((n) => n.kind !== "start");
    const part = settled ? work.slice(0, FRAME_NODES) : work.slice(-FRAME_NODES);
    void fitView({ ...FRAME, duration, ...(fits ? {} : { nodes: part.map((n) => ({ id: n.id })) }) });
  };
  const firstDrawing = useRef(true);
  useEffect(() => {
    if (!firstDrawing.current && userMoved.current) return;
    // The nodes are measured by the browser after this render: frame the run once they are.
    const timer = setTimeout(() => {
      frame(firstDrawing.current ? 0 : 250);
      firstDrawing.current = false;
    }, 80);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-frame when the layout or what is framed changes, not on every tick of the clock
  }, [layout, settled]);
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      colorMode="system"
      nodesDraggable={false}
      nodesConnectable={false}
      zoomOnDoubleClick={false}
      minZoom={0.1}
      maxZoom={1.5}
      onMoveStart={(event) => {
        if (event) userMoved.current = true; // a gesture of the user; the null event is our own fitView
      }}
    >
      <Background />
      <Controls
        showInteractive={false}
        onFitView={() => {
          userMoved.current = false;
        }}
      />
    </ReactFlow>
  );
}

const STATUS_TEXT: Record<string, string> = {
  running: "running",
  finished: "finished",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "stopped without finishing",
};

export function RunView({ runId }: { runId: string }) {
  const { events, status, connection } = useRunEvents(runId);
  /** null: the view follows the run (live, or the end of a finished one). A number: a replay, showing that many events. */
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0);
  const replaying = replayAt !== null;
  const shown = replaying ? events.slice(0, replayAt) : events;
  const settled = replaying ? replayAt >= events.length : status !== undefined && status !== "running";
  const graph = useMemo(() => buildRunGraph(shown, { settled }), [shown, settled]);
  const layout = useLayout(graph);
  const clock = useClock(!replaying && !settled);
  const now = replaying ? Date.parse(String(shown.at(-1)?.ts ?? "")) || 0 : clock;

  useEffect(() => {
    document.title = `${graph.run.workflow ?? "run"} · ${runId}`;
  }, [graph.run.workflow, runId]);

  // The replay: step to the next event that changes the picture.
  useEffect(() => {
    if (!playing || replayAt === null) return;
    if (replayAt >= events.length) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => {
      let next = replayAt + 1;
      while (next < events.length && !VISIBLE.has(String(events[next - 1]?.type))) next++;
      setReplayAt(Math.min(next, events.length));
    }, SPEEDS[speed]![1]);
    return () => clearTimeout(timer);
  }, [playing, replayAt, speed, events]);

  const togglePlay = () => {
    if (!playing && replayAt !== null && replayAt >= events.length) setReplayAt(FIRST_FRAME); // again, from the start
    setPlaying(!playing);
  };

  const { run } = graph;
  const counts = { steps: graph.nodes.filter((n) => n.kind === "step").length, commands: graph.nodes.filter((n) => n.kind === "command").length };
  const shownStatus = replaying && !settled ? "replaying" : STATUS_TEXT[run.status] ?? run.status;
  const elapsed = run.startedAt === undefined ? undefined : Math.max(0, (run.endedAt !== undefined ? Date.parse(run.endedAt) : now) - Date.parse(run.startedAt));

  if (connection === "not-found") {
    return (
      <main className="page">
        <p className="notice">
          Run <code>{runId}</code> was not found. <a href="/">Back to the dashboard</a>
        </p>
      </main>
    );
  }
  return (
    <main className="page">
      <header className="bar">
        <a className="back" href="/">
          ← Dashboard
        </a>
        <h1>
          <span className="workflow">{run.workflow ?? "…"}</span> <code>{runId}</code>
        </h1>
        <span className={`badge status-${replaying && !settled ? "replaying" : run.status}`}>{shownStatus}</span>
        <span className="totals">
          {counts.steps} steps · {counts.commands} commands · {run.tokens.toLocaleString("en-US")} tokens · {formatCents(run.costCents)}
          {elapsed !== undefined && ` · ${formatDuration(elapsed)}`}
          {run.executions > 1 && ` · ${run.executions} executions`}
        </span>
        <span className={`conn conn-${connection}`} title="connection to the dashboard">
          {connection === "live" ? "live" : connection === "waiting" ? "waiting for the run" : connection === "reconnecting" ? "reconnecting…" : ""}
        </span>
        <div className="replay">
          {!replaying && status !== undefined && status !== "running" && events.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setReplayAt(FIRST_FRAME);
                setPlaying(true);
              }}
            >
              ▶ Replay
            </button>
          )}
          {replaying && (
            <>
              <button type="button" onClick={togglePlay}>
                {playing ? "⏸ Pause" : replayAt >= events.length ? "↻ Again" : "▶ Play"}
              </button>
              <input
                type="range"
                aria-label="replay position"
                min={FIRST_FRAME}
                max={events.length}
                value={replayAt}
                onChange={(e) => {
                  setPlaying(false);
                  setReplayAt(Number(e.target.value));
                }}
              />
              <select aria-label="replay speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                {SPEEDS.map(([label], i) => (
                  <option key={label} value={i}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  setPlaying(false);
                  setReplayAt(null);
                }}
              >
                ■ Stop replay
              </button>
            </>
          )}
        </div>
      </header>
      <div className="canvas">
        {layout && status !== undefined ? (
          <ReactFlowProvider>
            <Canvas graph={graph} layout={layout} now={now} />
          </ReactFlowProvider>
        ) : (
          <p className="notice">{connection === "waiting" ? "Waiting for the run to start…" : "Drawing the run…"}</p>
        )}
      </div>
    </main>
  );
}
