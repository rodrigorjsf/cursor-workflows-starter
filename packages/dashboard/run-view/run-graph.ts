// The run as a graph, derived from its event log alone. Pure: no DOM, no clock, no network, so the live view, the replay and
// the tests all call the same function on the events they have.
//
// - Edges come from `parentId`. The group id is both the fork and (once the group has ended) the join: a step that names the
//   group as its parent and sits inside it continues from the fork; one that sits outside continues from the join. The tails of
//   the branches (the nodes nothing inside the group continues from) flow into the join.
// - Lanes come from the phase.
//
// A reader must tolerate what it does not know: events of another schema version, unknown types, fields that are missing.
// Everything here is read defensively and anything it cannot place is left out rather than thrown on.

/** An event as the log has it. Only `type` is relied on; every other field is read with a check, because the log may hold events of another version. */
export interface RunEvent {
  v?: number;
  ts?: string;
  runId?: string;
  type: string;
  [field: string]: unknown;
}

/** The newest event schema version this reader knows (the runtime's `EVENT_SCHEMA_VERSION`; a test pins that they agree). */
export const KNOWN_EVENT_VERSION = 1;

/**
 * Whether this reader may interpret `event`: an object whose schema version it knows. An older version, or none (logs written
 * before events carried `v`), is read with the field checks below; a newer one is opaque even when its type is known, because
 * its fields may mean something else.
 */
export function readable(event: unknown): event is RunEvent {
  if (!event || typeof event !== "object") return false;
  const { v } = event as { v?: unknown };
  return typeof v !== "number" || v <= KNOWN_EVENT_VERSION;
}

export type NodeKind = "start" | "step" | "command" | "fork" | "join";

/** A node that stands for work (an agent step or a command), as opposed to the start and the forks and joins of groups. */
export const isWork = (kind: NodeKind): boolean => kind === "step" || kind === "command";
/** `interrupted`: the run stopped (or its process died) with this node still going. */
export type NodeState = "running" | "ok" | "failed" | "cancelled" | "cached" | "interrupted" | "neutral";

/** What hovering a node shows. Numbers are totals over every attempt the node had, in every execution of the run. */
export interface NodeDetail {
  /** The model asked for (agent steps). */
  model?: string;
  /** The program a `ctx.exec` command runs, without its arguments. */
  command?: string;
  /** Where the step ran. Events carry it from the cloud backend on; before that every step ran `local`. */
  location: string;
  /** The Cursor cloud agent of a step that ran in the cloud (`bc-…`), from the moment the agent exists. The latest one when an attempt replaced it. */
  cloudAgentId?: string;
  /** Attempts that really ran: a step served from the journal or the memo has none. */
  attempts: number;
  tokens: number;
  /** What the attempts cost, as the run's cap counts it: per attempt the larger of the raw and the charged cents. */
  costCents: number;
  /** false while Cursor has not reported the cost of an attempt yet. */
  costFinal: boolean;
  /** Time of the attempts that ended. */
  durationMs: number;
  /** When the attempt in progress started (ISO): a live view adds the time since then. */
  runningSince?: string;
  /** Why the latest failed attempt failed: the step's error kind, or how the command ended (`exit 2`, `timeout`). */
  errorKind?: string;
  error?: string;
  /** Where the result came from when it was not computed now. */
  cached?: "journal" | "memo";
  /** How the command ended, when the process ran and exited. */
  exitCode?: number;
  /** The signal that killed the command. */
  signal?: string;
  /** The caller marked the command as a probe: a non-zero exit is its answer. */
  probe?: boolean;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  state: NodeState;
  /** The lane the node is drawn in: an index into `RunGraph.lanes`. */
  lane: number;
  detail: NodeDetail;
  commands: GraphNode[];
}

/** A phase, drawn as a band. A step is drawn in the lane of its phase, or in a later one when it continues from a node in a later lane. */
export interface GraphLane {
  index: number;
  /** The phase title; empty for the nodes that come before the first `ctx.phase`, and for a run with no phases. */
  title: string;
  commands: GraphNode[];
}

/** How the run stands: `interrupted` is a run with no `run-end` whose events have stopped coming. */
export type ProgressStatus = "running" | "finished" | "failed" | "cancelled" | "interrupted";

export interface RunProgress {
  workflow?: string;
  status: ProgressStatus;
  /** When the latest execution started. */
  startedAt?: string;
  /** When the latest execution ended. */
  endedAt?: string;
  error?: string;
  /** Executions of the run: a resume adds one. */
  executions: number;
  /** Tokens and cents spent now by the nodes shown. */
  tokens: number;
  costCents: number;
  costFinal: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface RunGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  lanes: GraphLane[];
  run: RunProgress;
}

export interface GraphOptions {
  /** No further event will come: a node still running is `interrupted`. */
  settled?: boolean;
}

/** The id of the node a group's branches flow into. The group's own id is its fork. */
export const joinIdOf = (groupId: string): string => `join:${groupId}`;

export const commandCount = (graph: RunGraph): number =>
  graph.nodes.reduce((sum, node) => sum + (node.kind === "command" ? 1 : 0) + node.commands.length, 0) + graph.lanes.reduce((sum, lane) => sum + lane.commands.length, 0);

const START = "start";

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** What the builder remembers about a node besides what the graph shows: where it sits in the run's structure. */
interface Placement {
  /** The node (step or group) it continues from. */
  parentId: string | null;
  /** The group it sits inside. */
  inGroup: string | null;
}

interface GroupInfo {
  ended: boolean;
  ok: boolean;
}

/** One attempt of a step or command, folded from its start, its turns and its end. */
interface Attempt {
  startedAt?: string;
  endedAt?: string;
  ended: boolean;
  ok: boolean;
  cached: false | "journal" | "memo";
  answered: boolean;
  /** Tokens of the turns finished so far (what is known while the attempt runs). */
  turnTokens: number;
  /** Tokens the end reported. */
  tokens?: number;
  costCents: number;
  costFinal: boolean;
  durationMs: number;
  errorKind?: string;
  error?: string;
  exitCode?: number;
  signal?: string;
  probe: boolean;
}

/** What is known about a step or command across its attempts. */
interface Work {
  model?: string;
  command?: string;
  location?: string;
  cloudAgentId?: string;
  attempts: Map<string, Attempt>;
}

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const cachedOf = (value: unknown): false | "journal" | "memo" => (value === "journal" || value === "memo" ? value : false);

/** How a command ended, as an error kind: the outcome when it did not exit by itself, else the exit code. Undefined when it succeeded. */
function execErrorKind(event: RunEvent): string | undefined {
  if (event.ok === true) return undefined;
  const outcome = str(event.outcome);
  if (outcome !== undefined && outcome !== "exit") return outcome;
  const code = num(event.exitCode);
  if (code !== undefined) return `exit ${code}`;
  const signal = str(event.signal);
  return signal === undefined ? undefined : `signal ${signal}`;
}

export function buildRunGraph(events: readonly RunEvent[], options: GraphOptions = {}): RunGraph {
  const nodes = new Map<string, GraphNode>();
  const placed = new Map<string, Placement>();
  const groups = new Map<string, GroupInfo>();
  const work = new Map<string, Work>();
  const emptyDetail = (): NodeDetail => ({ location: "local", attempts: 0, tokens: 0, costCents: 0, costFinal: true, durationMs: 0 });
  let currentPhase = "";
  /** The phase each node names (the title, "" for none), and the order in which phases first show up. */
  const phaseOf = new Map<string, string>();
  const phases: string[] = [];
  const marked = new Set<string>();
  const add = (node: Omit<GraphNode, "detail" | "lane" | "commands">, placement: Placement | null, phase = currentPhase) => {
    if (nodes.has(node.id)) return;
    nodes.set(node.id, { ...node, lane: 0, detail: emptyDetail(), commands: [] });
    if (placement) placed.set(node.id, placement);
    if (node.kind === "start") return;
    phaseOf.set(node.id, phase);
    if (!phases.includes(phase)) phases.push(phase);
  };
  /**
   * The attempt an event is about. A start makes it; a turn or an end only finds it, and an end for an attempt that never
   * started (a log cut in the middle, another version) is left alone. Without an attempt id, an event is about the latest attempt.
   */
  const attemptOf = (event: RunEvent, starting = false): { work: Work; attempt: Attempt } | undefined => {
    const stepId = str(event.stepId);
    const found = stepId === undefined ? undefined : work.get(stepId);
    if (!found) return undefined;
    const attemptId = str(event.attemptId);
    const key = attemptId ?? `${stepId}#${found.attempts.size + 1}`;
    let attempt = attemptId === undefined && !starting ? [...found.attempts.values()].at(-1) : found.attempts.get(key);
    if (!attempt && starting) found.attempts.set(key, (attempt = { ended: false, ok: false, cached: false, answered: false, probe: false, turnTokens: 0, costCents: 0, costFinal: true, durationMs: 0 }));
    return attempt && { work: found, attempt };
  };
  const begin = (event: RunEvent, kind: "step" | "command") => {
    const id = str(event.stepId);
    if (id === undefined) return;
    add({ id, kind, label: str(event.label) ?? id, state: "running" }, { parentId: str(event.parentId) ?? null, inGroup: str(event.groupId) ?? null }, str(event.phase));
    if (!work.has(id)) work.set(id, { attempts: new Map() });
    const at = attemptOf(event, true)!;
    at.attempt.startedAt = str(event.ts);
    at.attempt.cached = cachedOf(event.cached);
    at.work.model ??= str(event.model);
    at.work.command ??= str(event.command);
    at.work.location ??= str(event.location);
  };

  const run: RunProgress = { status: "running", executions: 0, tokens: 0, costCents: 0, costFinal: true };
  for (const event of events) {
    if (!readable(event)) continue;
    switch (event.type) {
      case "run-start":
        add({ id: START, kind: "start", label: str(event.workflow) ?? "run", state: "ok" }, null);
        run.executions++;
        run.status = "running";
        run.workflow = str(event.workflow) ?? run.workflow;
        run.startedAt = str(event.ts);
        delete run.endedAt;
        delete run.error;
        break;
      case "run-end": {
        const status = str(event.status);
        run.status = status === "finished" || status === "cancelled" ? status : "failed";
        run.endedAt = str(event.ts);
        const error = str(event.error);
        if (error !== undefined) run.error = error;
        break;
      }
      case "phase":
        currentPhase = str(event.title) ?? currentPhase;
        break;
      case "group-start": {
        const id = str(event.groupId);
        if (id === undefined) break;
        // A resume runs the same group again, with the same id: the group is going again, and the nodes it had stay.
        const again = groups.get(id);
        if (again) {
          again.ended = false;
          again.ok = true;
          break;
        }
        const kind = str(event.kind) ?? "parallel";
        const size = num(event.size) ?? 0;
        groups.set(id, { ended: false, ok: true });
        add({ id, kind: "fork", label: `${kind} ×${size}`, state: "running" }, { parentId: str(event.parentId) ?? null, inGroup: str(event.parentGroupId) ?? null });
        break;
      }
      case "group-end": {
        const id = str(event.groupId);
        const group = id === undefined ? undefined : groups.get(id);
        if (id === undefined || !group || group.ended) break;
        group.ended = true;
        group.ok = event.ok !== false;
        add({ id: joinIdOf(id), kind: "join", label: "join", state: "running" }, null); // already there after a resume
        break;
      }
      case "step-start":
        begin(event, "step");
        break;
      case "exec-start": {
        begin(event, "command");
        const id = str(event.stepId);
        if (id !== undefined && event.node === true) marked.add(id);
        break;
      }
      case "cloud-agent": {
        const found = work.get(str(event.stepId) ?? "");
        const agentId = str(event.agentId);
        if (found && agentId !== undefined) found.cloudAgentId = agentId;
        break;
      }
      case "turn": {
        const at = attemptOf(event);
        const usage = event.usage as Record<string, unknown> | undefined;
        if (at) at.attempt.turnTokens += (num(usage?.inputTokens) ?? 0) + (num(usage?.outputTokens) ?? 0);
        break;
      }
      case "step-end": {
        const at = attemptOf(event);
        if (!at) break;
        const { attempt } = at;
        const usage = event.usage as Record<string, unknown> | undefined;
        attempt.ended = true;
        attempt.endedAt = str(event.ts);
        attempt.ok = event.ok === true;
        attempt.cached = cachedOf(event.cached);
        attempt.tokens = num(usage?.totalTokens) ?? (usage ? (num(usage.inputTokens) ?? 0) + (num(usage.outputTokens) ?? 0) : undefined);
        attempt.costCents = Math.max(num(event.rawCents) ?? 0, num(event.chargedCents) ?? 0);
        attempt.costFinal = event.costFinal !== false;
        attempt.durationMs = num(event.durationMs) ?? 0;
        attempt.errorKind = str(event.errorKind);
        attempt.error = str(event.error);
        at.work.model ??= str(event.model);
        break;
      }
      case "exec-end": {
        const at = attemptOf(event);
        if (!at) break;
        at.attempt.ended = true;
        at.attempt.ok = event.ok === true;
        at.attempt.durationMs = num(event.durationMs) ?? 0;
        at.attempt.errorKind = execErrorKind(event);
        at.attempt.answered = event.probe === true && event.outcome === "exit" && (num(event.exitCode) ?? 0) !== 0;
        at.attempt.probe = event.probe === true;
        at.attempt.exitCode = num(event.exitCode);
        at.attempt.signal = str(event.signal);
        at.attempt.error = str(event.error);
        break;
      }
    }
  }

  // The state and the numbers of each step and command, from its attempts.
  for (const [id, w] of work) {
    const node = nodes.get(id)!;
    const attempts = [...w.attempts.values()];
    const last = attempts.at(-1)!;
    const real = attempts.filter((a) => !a.cached);
    const failed = real.filter((a) => a.ended && !a.ok).at(-1);
    const state: NodeState = !last.ended ? "running" : !last.ok ? (last.errorKind === "cancelled" ? "cancelled" : last.answered ? "neutral" : "failed") : last.cached ? "cached" : "ok";
    node.state = state;
    node.detail = {
      ...(w.model !== undefined && { model: w.model }),
      ...(w.command !== undefined && { command: w.command }),
      location: w.location ?? "local",
      ...(w.cloudAgentId !== undefined && { cloudAgentId: w.cloudAgentId }),
      attempts: real.length,
      tokens: real.reduce((sum, a) => sum + (a.ended ? (a.tokens ?? a.turnTokens) : a.turnTokens), 0),
      costCents: real.reduce((sum, a) => sum + a.costCents, 0),
      costFinal: real.every((a) => a.costFinal),
      durationMs: real.reduce((sum, a) => sum + a.durationMs, 0),
      ...(!last.ended && last.startedAt !== undefined && { runningSince: last.startedAt }),
      ...(failed?.errorKind !== undefined && { errorKind: failed.errorKind }),
      ...(failed?.error !== undefined && { error: failed.error }),
      ...(last.cached && { cached: last.cached }),
      ...(last.exitCode !== undefined && { exitCode: last.exitCode }),
      ...(last.signal !== undefined && { signal: last.signal }),
      ...(last.probe && { probe: true }),
    };
  }
  for (const [id, group] of groups) {
    const state: NodeState = !group.ended ? "running" : group.ok ? "ok" : "failed";
    nodes.get(id)!.state = state;
    const join = nodes.get(joinIdOf(id));
    if (join) join.state = state;
  }
  if (options.settled) {
    for (const node of nodes.values()) if (node.state === "running") node.state = "interrupted";
    if (run.status === "running") run.status = "interrupted";
  }

  const { removed, phaseCommands } = fileUnmarkedCommands(work, nodes, placed, marked);
  const continuesFrom = (id: string): string | null => {
    for (const ancestor of parentsOf(id, placed)) if (!removed.has(ancestor)) return ancestor;
    return null;
  };

  /** Where a node that names `parentId` as its parent continues from. */
  const sourceOf = (parentId: string | null, inGroup: string | null): string => {
    if (parentId === null) return START;
    if (groups.has(parentId)) return inGroup === parentId || !nodes.has(joinIdOf(parentId)) ? parentId : joinIdOf(parentId);
    return nodes.has(parentId) ? parentId : START;
  };
  const edges: GraphEdge[] = [];
  const link = (source: string, target: string) => edges.push({ id: `${source}>${target}`, source, target });
  for (const [id, where] of placed) if (!removed.has(id)) link(sourceOf(continuesFrom(id), where.inGroup), id);

  // The branches of an ended group flow into its join: from every node inside it that nothing else inside it continues from.
  for (const groupId of groups.keys()) {
    if (!nodes.has(joinIdOf(groupId))) continue;
    const members = [...placed].filter(([id, where]) => where.inGroup === groupId && !removed.has(id)).map(([id]) => id);
    const outputOf = (id: string) => (nodes.get(id)?.kind === "fork" && nodes.has(joinIdOf(id)) ? joinIdOf(id) : id);
    const continued = new Set(edges.filter((e) => members.includes(e.target)).map((e) => e.source));
    const tails = members.filter((id) => !continued.has(outputOf(id)));
    for (const tail of tails.length > 0 ? tails.map(outputOf) : [groupId]) link(tail, joinIdOf(groupId));
  }

  const lanes = assignLanes([...nodes.values()], edges, phaseOf, phases, phaseCommands);
  for (const node of nodes.values()) {
    run.tokens += node.detail.tokens;
    run.costCents += node.detail.costCents;
    run.costFinal &&= node.detail.costFinal;
  }
  return { nodes: [...nodes.values()], edges, lanes, run };
}

function* parentsOf(id: string, placed: Map<string, Placement>): Generator<string> {
  const seen = new Set<string>();
  for (let at = placed.get(id)?.parentId ?? null; at !== null && !seen.has(at); at = placed.get(at)?.parentId ?? null) {
    seen.add(at);
    yield at;
  }
}

function fileUnmarkedCommands(work: Map<string, Work>, nodes: Map<string, GraphNode>, placed: Map<string, Placement>, marked: Set<string>): { removed: Set<string>; phaseCommands: GraphNode[] } {
  const removed = new Set([...work.keys()].filter((id) => nodes.get(id)!.kind === "command" && !marked.has(id)));
  const startedAt = (id: string): number => Date.parse([...work.get(id)!.attempts.values()][0]?.startedAt ?? "");
  const runningAt = (stepId: string, time: number): boolean =>
    [...work.get(stepId)!.attempts.values()].some((a) => Date.parse(a.startedAt ?? "") <= time && time <= (a.endedAt === undefined ? Infinity : Date.parse(a.endedAt)));
  const stepEnclosing = (id: string): string | undefined => {
    const time = startedAt(id);
    for (const ancestor of parentsOf(id, placed)) {
      const kind = nodes.get(ancestor)?.kind;
      if (kind === "step" && runningAt(ancestor, time)) return ancestor;
      if (kind !== "step" && kind !== "command") return undefined;
    }
    return undefined;
  };
  const phaseCommands: GraphNode[] = [];
  for (const id of removed) {
    const owner = stepEnclosing(id);
    (owner === undefined ? phaseCommands : nodes.get(owner)!.commands).push(nodes.get(id)!);
  }
  for (const id of removed) nodes.delete(id);
  return { removed, phaseCommands };
}

/**
 * Puts each node in the lane of its phase, then moves a node later when it continues from a node in a later lane, so that no
 * edge runs backwards. Lanes nobody ends up in are dropped. Sets `lane` on the nodes and returns the lanes.
 */
function assignLanes(nodes: GraphNode[], edges: GraphEdge[], phaseOf: Map<string, string>, phases: string[], phaseCommands: GraphNode[]): GraphLane[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const phaseLane = (id: string) => Math.max(0, phases.indexOf(phaseOf.get(id) ?? ""));
  for (const node of nodes) node.lane = phaseLane(node.id);
  for (let moved = true; moved; ) {
    moved = false;
    for (const { source, target } of edges) {
      const from = byId.get(source)!;
      const to = byId.get(target)!;
      if (from.kind !== "start" && to.lane < from.lane) {
        to.lane = from.lane;
        moved = true;
      }
    }
  }
  for (const item of phaseCommands) item.lane = phaseLane(item.id);
  const drawn = new Set(nodes.filter((n) => n.kind !== "start").map((n) => n.lane));
  const bare = (lane: number) => phases[lane] === "" && !drawn.has(lane);
  const titled = [...new Set([...drawn, ...phaseCommands.map((i) => i.lane).filter((lane) => !bare(lane))])].sort((a, b) => a - b);
  for (const item of phaseCommands) if (bare(item.lane)) item.lane = titled.find((lane) => lane > item.lane) ?? item.lane;
  const used = [...new Set([...drawn, ...phaseCommands.map((i) => i.lane)])].sort((a, b) => a - b);
  if (used.length === 0) used.push(0);
  for (const node of [...nodes, ...phaseCommands]) node.lane = Math.max(0, used.indexOf(node.lane));
  const lanes = used.map((phase, index): GraphLane => ({ index, title: phases[phase] ?? "", commands: [] }));
  for (const item of phaseCommands) lanes[item.lane]!.commands.push(item);
  return lanes;
}
