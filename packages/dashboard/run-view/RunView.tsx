// The Run view: a run drawn as a graph that grows as its events arrive, with the phases as lanes, and a replay of a finished
// run. The data comes from `useRunEvents`, the graph from `buildRunGraph` and the positions from `layoutRunGraph`; this file
// puts them on a React Flow canvas.
import { Background, Controls, type Edge, type Node, ReactFlow, ReactFlowProvider, useReactFlow, useStore } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JunctionNode, LaneNode, type LaneNodeData, StartNode, WorkNode, type WorkNodeData } from "./nodes.js";
import { RunActions } from "./RunActions.js";
import { argsHashOf } from "./resume-command.js";
import { StepLogPanel } from "./StepLogPanel.js";
import { frameOf } from "./framing.js";
import { formatCents, formatCount, formatDuration } from "../app/format.js";
import { type RunGraph, buildRunGraph, isWork } from "./run-graph.js";
import { headerStatus, offeredActions } from "./run-status.js";
import { type RunLayout, layoutRunGraph } from "./run-layout.js";
import { type Connection, useRunEvents } from "./use-run-events.js";

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

/** The layout of `graph`, computed again whenever its structure changes. The previous layout stays up meanwhile; a layout that fails is reported. */
function useLayout(graph: RunGraph): { layout?: RunLayout; error?: string } {
  const [state, setState] = useState<{ layout?: RunLayout; error?: string }>({});
  const structure = structureOf(graph);
  useEffect(() => {
    let stale = false;
    layoutRunGraph(graph).then(
      (layout) => !stale && setState({ layout }),
      (err: unknown) => !stale && setState((before) => ({ ...before, error: err instanceof Error ? err.message : String(err) })),
    );
    return () => {
      stale = true;
    };
    // `graph` is read when the structure changes, not when a node merely changes state.
  }, [structure]);
  return state;
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

export function toFlow(graph: RunGraph, layout: RunLayout, now: number, selectedId: string | undefined, open: (id: string) => void): { nodes: Node[]; edges: Edge[] } {
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
    type: isWork(node.kind) ? "work" : node.kind === "start" ? "start" : "junction",
    position: { x: layout.nodes[node.id]!.x, y: layout.nodes[node.id]!.y },
    data: { node, now: node.state === "running" ? now : 0, onOpen: () => open(node.id) },
    selected: node.id === selectedId,
    draggable: false,
  }));
  const state = new Map(graph.nodes.map((n) => [n.id, n.state]));
  const edges: Edge[] = graph.edges
    .filter((e) => layout.nodes[e.source] && layout.nodes[e.target])
    .map((e) => ({ id: e.id, source: e.source, target: e.target, animated: state.get(e.target) === "running", className: `edge-${state.get(e.target)}` }));
  return { nodes: [...(layout.lanes.some((l) => l.title !== "") ? lanes : []), ...work], edges };
}

/** The height the page's header takes, to guess the size of the canvas before it is measured. */
const HEADER_PX = 160;

/** The pane's size, or a guess from the window's before React Flow has measured it. */
const paneOrWindow = (pane: { width: number; height: number }) => (pane.width > 0 && pane.height > 0 ? pane : { width: window.innerWidth, height: window.innerHeight - HEADER_PX });

/**
 * The canvas. It keeps the run in view as it grows, until the user moves the view themselves. The first drawing is framed
 * by React Flow itself, which waits for the nodes to be measured; later ones are framed by hand, a moment after the layout
 * (or what is framed) changes.
 */
function Canvas({ graph, layout, now, selectedId, onOpen }: { graph: RunGraph; layout: RunLayout; now: number; selectedId?: string; onOpen(id: string): void }) {
  const { nodes, edges } = useMemo(() => toFlow(graph, layout, now, selectedId, onOpen), [graph, layout, now, selectedId, onOpen]);
  const { fitView } = useReactFlow();
  const pane = useStore((s) => ({ width: s.width, height: s.height }), (a, b) => a.width === b.width && a.height === b.height);
  const userMoved = useRef(false);
  const firstFrame = useRef(frameOf(graph, layout, paneOrWindow(pane), selectedId));
  const settled = graph.nodes.every((n) => n.state !== "running");
  const drawn = useRef(false);
  useEffect(() => {
    if (!drawn.current) {
      drawn.current = true;
      return;
    }
    if (userMoved.current) return;
    let cancelled = false;
    const attempt = async (tries: number) => {
      if (cancelled) return;
      if (!(await fitView({ ...frameOf(graph, layout, paneOrWindow(pane), selectedId), duration: 250 })) && tries < 10) setTimeout(() => void attempt(tries + 1), 60);
    };
    const timer = setTimeout(() => void attempt(0), 80); // the new nodes are measured by the browser after this render
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Frame again when the layout, what is framed or the size of the pane (a log panel opened beside it) changes, not on every tick of the clock.
  }, [layout, settled, pane.width, pane.height]);
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      colorMode="system"
      fitView
      fitViewOptions={firstFrame.current}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false} // the node's own element is the control: it takes the focus, Enter and the click
      onNodeClick={(_, node) => {
        if (node.type === "work") onOpen(node.id);
      }}
      zoomOnDoubleClick={false}
      minZoom={0.1}
      maxZoom={1.5}
      onMoveStart={(event) => {
        if (event) userMoved.current = true; // a gesture of the user; the null event is our own fitView
      }}
    >
      <Background gap={20} size={1.2} />
      <Controls
        showInteractive={false}
        onFitView={() => {
          userMoved.current = false;
        }}
      />
    </ReactFlow>
  );
}

const CONNECTION_TEXT: Record<Connection, string> = { waiting: "", live: "live", reconnecting: "reconnecting…", closed: "", "not-found": "" };

export function RunView({ runId }: { runId: string }) {
  const { events, ids, status, error, unreachable, info, connection, refresh } = useRunEvents(runId);
  /** null: the view follows the run (live, or the end of a finished one). A number: a replay, showing that many events. */
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0);
  const replaying = replayAt !== null;
  const shown = useMemo(() => (replayAt === null ? events : events.slice(0, replayAt)), [events, replayAt]);
  const settled = replaying ? replayAt >= events.length : status !== undefined && status !== "running";
  const graph = useMemo(() => buildRunGraph(shown, { settled }), [shown, settled]);
  const { layout, error: layoutError } = useLayout(graph);
  const clock = useClock(!replaying && !settled);
  const [selectedId, setSelectedId] = useState<string>();
  const open = useCallback((id: string) => setSelectedId(id), []);
  const close = useCallback(() => setSelectedId(undefined), []);
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
  const selected = graph.nodes.find((n) => n.id === selectedId && isWork(n.kind));
  /** In a replay, the log line it has reached; at its end, and outside a replay, the whole log. */
  const upTo = replaying && replayAt < events.length ? (ids[replayAt - 1] ?? 0) : undefined;
  const counts = { steps: graph.nodes.filter((n) => n.kind === "step").length, commands: graph.nodes.filter((n) => n.kind === "command").length };
  const header = headerStatus({ api: { status, error }, run, replaying, settled });
  const offered = offeredActions(status, graph);
  // A run that is over ends at its run-end, or (its process died) at its last event; a live one at the clock.
  const endedAt = run.endedAt !== undefined ? Date.parse(run.endedAt) : settled ? Date.parse(String(shown.at(-1)?.ts ?? "")) || now : now;
  const elapsed = run.startedAt === undefined ? undefined : Math.max(0, endedAt - Date.parse(run.startedAt));

  if (connection === "not-found") {
    return (
      <main className="page">
        <div className="not-found">
          <p className="empty-title">Run not found</p>
          <p>
            No run <code>{runId}</code> is in the runs index, or its log cannot be read.
          </p>
          <a className="btn" href="/#/runs">
            ← All runs
          </a>
        </div>
      </main>
    );
  }
  return (
    <main className="page">
      <header className="run-header">
        <nav className="crumbs" aria-label="Breadcrumb">
          <a href="/#/runs">Runs</a>
          <span aria-hidden="true">/</span>
          <span>{run.workflow ?? info?.workflow ?? "…"}</span>
        </nav>
        <div className="title-row">
          <h1>
            <span className="workflow">{run.workflow ?? info?.workflow ?? "…"}</span> <code>{runId}</code>
          </h1>
          <span className={`pill status-${header.key}`}>{header.label}</span>
          {CONNECTION_TEXT[connection] !== "" && (
            <span className={`conn conn-${connection}`} title="Connection to the dashboard">
              {CONNECTION_TEXT[connection]}
            </span>
          )}
        </div>
        <dl className="run-stats">
          <div>
            <dt>Duration</dt>
            <dd>{elapsed === undefined ? "–" : formatDuration(elapsed)}</dd>
          </div>
          <div>
            <dt>Cost</dt>
            <dd>{formatCents(run.costCents)}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>{formatCount(run.tokens)}</dd>
          </div>
          <div>
            <dt>Steps</dt>
            <dd>{formatCount(counts.steps)}</dd>
          </div>
          <div>
            <dt>Commands</dt>
            <dd>{formatCount(counts.commands)}</dd>
          </div>
          {run.executions > 1 && (
            <div>
              <dt>Executions</dt>
              <dd>{formatCount(run.executions)}</dd>
            </div>
          )}
        </dl>
        <div className="toolbar">
        <div className="replay">
          {!replaying && status !== undefined && status !== "running" && events.length > 0 && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setReplayAt(FIRST_FRAME);
                setPlaying(true);
              }}
            >
              <span aria-hidden="true">▶</span> Replay
            </button>
          )}
          {replaying && (
            <>
              <button type="button" className="btn" onClick={togglePlay}>
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
                className="btn"
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
        {!replaying && <RunActions runId={runId} status={status} offered={offered} info={info} argsHash={argsHashOf(events)} onChanged={refresh} />}
        </div>
      </header>
      {unreachable !== undefined && (
        <p className="run-banner warn" role="alert">
          The dashboard is not answering ({unreachable}): what this page shows may be out of date.
        </p>
      )}
      {header.error !== undefined && (
        <p className="run-banner error" role="alert">
          {header.error}
        </p>
      )}
      <div className="workspace">
        <div className="canvas">
          {layoutError !== undefined ? (
            <p className="notice" role="alert">
              The run could not be drawn: {layoutError}
            </p>
          ) : layout && status !== undefined ? (
            <ReactFlowProvider>
              <Canvas graph={graph} layout={layout} now={now} selectedId={selected?.id} onOpen={open} />
            </ReactFlowProvider>
          ) : (
            <p className="notice">{connection === "waiting" ? "Waiting for the run to start…" : "Drawing the run…"}</p>
          )}
        </div>
        {selected && <StepLogPanel key={selected.id} runId={runId} node={selected} now={now} live={!replaying && selected.state === "running"} upTo={upTo} onClose={close} />}
      </div>
    </main>
  );
}
