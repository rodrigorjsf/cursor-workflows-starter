// The Run view: a run drawn as a graph that grows as its events arrive, with the phases as lanes, and a replay of a finished
// run. The data comes from `useRunEvents`, the graph from `buildRunGraph` and the positions from `layoutRunGraph`; this file
// puts them on a React Flow canvas.
import { Background, Controls, type Edge, type Node, ReactFlow, ReactFlowProvider, useReactFlow, useStore, useStoreApi } from "@xyflow/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Glyph, JunctionNode, LaneNode, type LaneNodeData, StartNode, WorkNode, type WorkNodeData } from "./nodes.js";
import { RunActions } from "./RunActions.js";
import { SeamsPanel } from "./SeamsPanel.js";
import { argsHashOf } from "./resume-command.js";
import { CommandPanel, PhasePanel, StepLogPanel } from "./StepLogPanel.js";
import { frameOf, jumpTarget, panTarget } from "./framing.js";
import { formatCents, formatCount, formatDuration } from "../app/format.js";
import { type MenuPhase, type RunGraph, type RunProgress, buildRunGraph, commandCount, currentExecution, executionsOf, isWork, shownEvents, stepMenu } from "./run-graph.js";
import { costUnknown, executionNote, headerStatus, offeredActions, runElapsed } from "./run-status.js";
import { type Box, type RunLayout, layoutRunGraph } from "./run-layout.js";
import { type Connection, useRunEvents } from "./use-run-events.js";
import { errorText } from "../app/error-text.js";

// `group` is a node type of React Flow's own (a grey box): the fork and the join are `junction`s.
const NODE_TYPES = { work: WorkNode, junction: JunctionNode, start: StartNode, lane: LaneNode };
/** The Fit View button's name and tooltip say it also hands the view back to the run, which panning (or Tab) takes from it. */
const FLOW_LABELS = { "controls.fitView.ariaLabel": "Fit View (follow the run again)" };

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
      (err: unknown) => !stale && setState((before) => ({ ...before, error: errorText(err) })),
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

const wraps = (from: Box, to: Box): boolean => to.x < from.x + from.width;

export interface FlowView {
  now: number;
  selectedId?: string;
  open(id: string): void;
  focus(id: string): void;
  phases: PhaseEntries;
}

export interface PhaseEntries {
  openIndex?: number;
  onOpen(lane: number): void;
}

/** What React Flow draws for `graph` laid out as `layout`. `open` opens a node's log; `focus` brings a node that took the keyboard focus into view. */
export function toFlow(graph: RunGraph, layout: RunLayout, view: FlowView): { nodes: Node[]; edges: Edge[] } {
  const { now, selectedId, open, focus, phases } = view;
  const lanes: Node<LaneNodeData, "lane">[] = layout.lanes.map((lane) => ({
    id: `lane-${lane.index}`,
    type: "lane",
    position: { x: lane.x, y: lane.y },
    data: { title: lane.title, commandCount: graph.lanes[lane.index]?.commands.length ?? 0, open: lane.index === phases.openIndex, onOpen: () => phases.onOpen(lane.index) },
    width: lane.width,
    height: lane.height,
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
    data: { node, now: node.state === "running" ? now : 0, onOpen: () => open(node.id), onFocus: () => focus(node.id) },
    selected: node.id === selectedId,
    draggable: false,
  }));
  const state = new Map(graph.nodes.map((n) => [n.id, n.state]));
  const edges: Edge[] = graph.edges
    .filter((e) => layout.nodes[e.source] && layout.nodes[e.target])
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(wraps(layout.nodes[e.source]!, layout.nodes[e.target]!) && { sourceHandle: "below", targetHandle: "above" }),
      animated: state.get(e.target) === "running",
      className: `edge-${state.get(e.target)}`,
      focusable: false,
    }));
  return { nodes: [...(lanes.some((l) => l.data.title !== "" || l.data.commandCount > 0) ? lanes : []), ...work], edges };
}

export function RunCost({ run }: { run: RunProgress }) {
  return costUnknown(run) ? (
    <span className="none" title="Cursor did not report the cost of these steps: 0¢ is not what the run cost">
      unknown
    </span>
  ) : (
    <>{formatCents(run.costCents)}</>
  );
}

export function ExecutionPicker({ count, current, note, onPick }: { count: number; current: number; note?: string; onPick(index: number): void }) {
  if (count < 2) return null;
  return (
    <div className="executions">
      <select aria-label="Execution shown" value={current} onChange={(event) => onPick(Number(event.target.value))}>
        {Array.from({ length: count }, (_, index) => (
          <option key={index} value={index}>
            Execution {index + 1} / {count}
          </option>
        ))}
      </select>
      {note !== undefined && (
        <p className="execution-note" role="alert">
          {note}
        </p>
      )}
    </div>
  );
}

/** The height the page's header takes, to guess the size of the canvas before it is measured. */
const HEADER_PX = 160;

interface Jump {
  id: string;
}

/** The pane's size, or a guess from the window's before React Flow has measured it. */
const paneOrWindow = (pane: { width: number; height: number }) => (pane.width > 0 && pane.height > 0 ? pane : { width: window.innerWidth, height: window.innerHeight - HEADER_PX });

/**
 * The canvas. It keeps the run in view as it grows, until the user moves the view themselves. The first drawing is framed
 * by React Flow itself, which waits for the nodes to be measured; later ones are framed by hand, a moment after the layout
 * (or what is framed) changes. A node that takes the keyboard focus off the canvas is panned into view, at the same zoom;
 * that counts as the user moving the view, so the run stays where the reader tabbed to (Fit View hands it back).
 */
function Canvas({ graph, layout, now, selectedId, onOpen, phases, jump }: { graph: RunGraph; layout: RunLayout; now: number; selectedId?: string; onOpen(id: string): void; phases: PhaseEntries; jump?: Jump }) {
  const { fitView, setCenter } = useReactFlow();
  const store = useStoreApi();
  const userMoved = useRef(false);
  const following = useRef<string | undefined>(undefined);
  const moveTo = useCallback(
    (target: { x: number; y: number; zoom: number }) => {
      userMoved.current = true;
      void setCenter(target.x, target.y, { zoom: target.zoom, duration: 200 });
    },
    [setCenter],
  );
  const focus = useCallback(
    (id: string) => {
      const box = layout.nodes[id];
      const { transform, width, height } = store.getState();
      const target = box && panTarget(box, { x: transform[0], y: transform[1], zoom: transform[2] }, { width, height });
      if (target) moveTo({ ...target, zoom: transform[2] });
    },
    [layout, store, moveTo],
  );
  const centreOn = useCallback(
    (id: string) => {
      const box = layout.nodes[id];
      if (box) moveTo(jumpTarget(box, store.getState().transform[2]));
    },
    [layout, store, moveTo],
  );
  const { nodes, edges } = useMemo(() => toFlow(graph, layout, { now, selectedId, open: onOpen, focus, phases }), [graph, layout, now, selectedId, onOpen, focus, phases]);
  const pane = useStore((s) => ({ width: s.width, height: s.height }), (a, b) => a.width === b.width && a.height === b.height);
  useEffect(() => {
    following.current = jump?.id;
  }, [jump]);
  useEffect(() => {
    if (following.current !== selectedId) following.current = undefined;
    if (following.current !== undefined) centreOn(following.current);
  }, [jump, selectedId, centreOn, pane.width, pane.height]);
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
    // Frame again when the layout, whether the run is over or the size of the pane changes, not on every tick of the clock. The list leaves
    // out the other values the effect reads, on purpose:
    // - `layout`: a new one only when the run's structure changes (`useLayout`), the change that needs a new frame.
    // - `settled`: a run that is over is framed on its first failure, not on its latest node (`frameOf`), so the frame is made again when it flips.
    // - `pane.width`, `pane.height`: a log panel opened beside the canvas resizes it.
    // - `graph` is a new object at every event, and what the framing takes from it is in `layout` and `settled`.
    // - `selectedId` is read as it is when one of the values above changes: selecting a node alone leaves the view where the reader put it.
    // - `fitView` of React Flow only reads React Flow's store, so the one of an earlier render frames the same.
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
        if (!event) return;
        userMoved.current = true;
        following.current = undefined;
      }}
      ariaLabelConfig={FLOW_LABELS}
    >
      <Background gap={20} size={1.2} />
      <Controls
        showInteractive={false}
        onFitView={() => {
          userMoved.current = false;
          following.current = undefined;
        }}
      />
    </ReactFlow>
  );
}

export function StepMenu({ phases, open, selectedId, onToggle, onPick, onOverlay }: { phases: MenuPhase[]; open: boolean; selectedId?: string; onToggle(): void; onPick(id: string): void; onOverlay(): void }) {
  const aside = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (aside.current && getComputedStyle(aside.current).position === "absolute") onOverlay();
  }, []);
  return (
    <aside ref={aside} className={open ? "step-menu" : "step-menu collapsed"} aria-label="Steps">
      <button type="button" className="btn menu-toggle" aria-expanded={open} aria-controls={open ? "step-menu-body" : undefined} onClick={onToggle}>
        <span aria-hidden="true">{open ? "◂" : "▸"}</span> Steps
      </button>
      {open && (
        <div id="step-menu-body" className="menu-body">
          {phases.map((phase) => (
            <section key={phase.index}>
              {phase.title !== "" && <h2>{phase.title}</h2>}
              <ul>
                {phase.steps.map((step) => (
                  <li key={step.id}>
                    <button type="button" className={`menu-step state-${step.state}`} aria-pressed={step.id === selectedId} onClick={() => onPick(step.id)}>
                      <Glyph state={step.state} />
                      <span className="label">{step.label}</span>
                      <span className="state">{step.state}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </aside>
  );
}

const CONNECTION_TEXT: Record<Connection, string> = { waiting: "", live: "live", reconnecting: "reconnecting…", closed: "", "not-found": "" };

export function RunView({ runId }: { runId: string }) {
  const { events, ids, status, error, unreachable, info, connection, refresh } = useRunEvents(runId);
  /** null: the view follows the run (live, or the end of a finished one). A number: a replay, showing that many events. */
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0);
  const [picked, setPicked] = useState<number>();
  const replaying = replayAt !== null;
  const executions = useMemo(() => executionsOf(events), [events]);
  const current = currentExecution(executions, picked);
  const execution = executions[current]!;
  const executionLength = execution.to - execution.from;
  const shown = useMemo(() => shownEvents(events, execution, replayAt), [events, execution.from, execution.to, replayAt]);
  const settled = replaying ? replayAt >= executionLength : status !== undefined && status !== "running";
  const executionSettled = settled || current < executions.length - 1;
  const graph = useMemo(() => buildRunGraph(shown.execution, { settled: executionSettled }), [shown.execution, executionSettled]);
  const whole = useMemo(() => (shown.run.length === shown.execution.length ? graph : buildRunGraph(shown.run, { settled })), [graph, shown, settled]);
  const { layout, error: layoutError } = useLayout(graph);
  const clock = useClock(!replaying && !settled);
  const [selectedId, setSelectedId] = useState<string>();
  const [phaseIndex, setPhaseIndex] = useState<number>();
  const [commandId, setCommandId] = useState<string>();
  const open = useCallback((id: string) => {
    setSelectedId(id);
    setPhaseIndex(undefined);
    setCommandId(undefined);
  }, []);
  const close = useCallback(() => {
    setSelectedId(undefined);
    setCommandId(undefined);
  }, []);
  const openPhase = useCallback((lane: number) => {
    setPhaseIndex(lane);
    setSelectedId(undefined);
    setCommandId(undefined);
  }, []);
  const closePhase = useCallback(() => {
    setPhaseIndex(undefined);
    setCommandId(undefined);
  }, []);
  const phases = useMemo<PhaseEntries>(() => ({ openIndex: phaseIndex, onOpen: openPhase }), [phaseIndex, openPhase]);
  const [menuOpen, setMenuOpen] = useState(true);
  const [jump, setJump] = useState<Jump>();
  const pickStep = useCallback(
    (id: string) => {
      open(id);
      setJump({ id });
    },
    [open],
  );
  const closeCommand = useCallback(() => setCommandId(undefined), []);
  const now = replaying ? Date.parse(String(shown.execution.at(-1)?.ts ?? "")) || 0 : clock;

  useEffect(() => {
    document.title = `${whole.run.workflow ?? "run"} · ${runId}`;
  }, [whole.run.workflow, runId]);

  // The replay: step to the next event that changes the picture.
  useEffect(() => {
    if (!playing || replayAt === null) return;
    if (replayAt >= executionLength) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => {
      let next = replayAt + 1;
      while (next < executionLength && !VISIBLE.has(String(events[execution.from + next - 1]?.type))) next++;
      setReplayAt(Math.min(next, executionLength));
    }, SPEEDS[speed]![1]);
    return () => clearTimeout(timer);
  }, [playing, replayAt, speed, events, execution.from, executionLength]);

  const togglePlay = () => {
    if (!playing && replayAt !== null && replayAt >= executionLength) setReplayAt(FIRST_FRAME);
    setPlaying(!playing);
  };
  const pick = (index: number) => {
    setPicked(index === executions.length - 1 ? undefined : index);
    setPlaying(false);
    if (replaying) setReplayAt(FIRST_FRAME);
  };

  const { run } = whole;
  const selected = graph.nodes.find((n) => n.id === selectedId && isWork(n.kind));
  const phase = phaseIndex === undefined || selected ? undefined : graph.lanes[phaseIndex];
  const openCommand = (selected?.commands ?? phase?.commands)?.find((c) => c.id === commandId);
  const menu = useMemo(() => stepMenu(graph), [graph]);
  /** In a replay, the log line it has reached; at its end, and outside a replay, the whole log. */
  const upTo = replaying && replayAt < executionLength ? (ids[execution.from + replayAt - 1] ?? 0) : undefined;
  const counts = { steps: whole.nodes.filter((n) => n.kind === "step").length, commands: commandCount(whole) };
  const header = headerStatus({ api: { status, error }, run, replaying, settled });
  const offered = offeredActions(status, whole, error);
  const note = current < executions.length - 1 ? executionNote(graph, current + 1) : undefined;
  const elapsed = runElapsed(run, settled, now);

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
        <div className="run-nav">
          <a className="btn back" href="/#/runs">
            <span aria-hidden="true">←</span> Back to Runs
          </a>
          <nav className="crumbs" aria-label="Breadcrumb">
            <a href="/#/runs">Runs</a>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{run.workflow ?? info?.workflow ?? "…"}</span>
          </nav>
        </div>
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
            <dd>
              {elapsed !== undefined ? (
                formatDuration(elapsed)
              ) : (
                <span className="none" title={run.startedAt !== undefined ? "The run did not record its end" : undefined}>
                  —
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Cost</dt>
            <dd>
              <RunCost run={run} />
            </dd>
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
        <ExecutionPicker count={executions.length} current={current} note={note} onPick={pick} />
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
                max={executionLength}
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
      {!replaying && info?.seamsProposal && <SeamsPanel key={info.seamsProposal.digest} runId={runId} proposal={info.seamsProposal} status={status} onChanged={refresh} />}
      <div className="workspace">
        {menu.length > 0 && <StepMenu phases={menu} open={menuOpen} selectedId={selected?.id} onToggle={() => setMenuOpen(!menuOpen)} onPick={pickStep} onOverlay={() => setMenuOpen(false)} />}
        <div className="canvas">
          {layoutError !== undefined ? (
            <p className="notice" role="alert">
              The run could not be drawn: {layoutError}
            </p>
          ) : layout && status !== undefined ? (
            <ReactFlowProvider key={current}>
              <Canvas graph={graph} layout={layout} now={now} selectedId={selected?.id} onOpen={open} phases={phases} jump={jump} />
            </ReactFlowProvider>
          ) : (
            <p className="notice">{connection === "waiting" ? "Waiting for the run to start…" : "Drawing the run…"}</p>
          )}
        </div>
        {selected && <StepLogPanel key={selected.id} runId={runId} node={selected} now={now} live={!replaying && selected.state === "running"} upTo={upTo} openCommandId={openCommand?.id} onOpenCommand={setCommandId} onClose={close} />}
        {phase && <PhasePanel key={phaseIndex} lane={phase.index} title={phase.title} commands={phase.commands} openId={openCommand?.id} onSelect={setCommandId} onClose={closePhase} />}
        {openCommand && <CommandPanel key={openCommand.id} runId={runId} command={openCommand} now={now} live={!replaying && openCommand.state === "running"} upTo={upTo} onClose={closeCommand} />}
      </div>
    </main>
  );
}
