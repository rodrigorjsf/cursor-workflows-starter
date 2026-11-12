// What can be derived from a run's event log, so that the log stays the one source of truth: the run's spend so far (the
// budget ledger) and the state of one execution of it (what `wf status` and `wait_workflow` show).
//
// Nothing here reads a file or the clock: both take the events. Neither ever carries step content: the projection looks
// at metadata fields only, and `content` events are not read at all.

import type { CloudAgentEvent, ExecEndEvent, RunStatus, TurnUsage, WorkflowEvent } from "./events.js";
import { type OutcomeClass, outcomeClass } from "./outcome.js";
import type { UsageTotals } from "./workflow.js";

/** How a message tells the reader to continue a run that stopped without finishing. The `run-workflow` skill matches the `resumeRunId="..."` part. */
export const resumeHint = (runId: string): string => `relaunch with resumeRunId="${runId}"`;

export const emptyUsage = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 });

export function addUsage(acc: UsageTotals, u: Partial<UsageTotals> | undefined): void {
  if (!u) return;
  acc.inputTokens += u.inputTokens ?? 0;
  acc.outputTokens += u.outputTokens ?? 0;
  acc.cacheReadTokens += u.cacheReadTokens ?? 0;
  acc.cacheWriteTokens += u.cacheWriteTokens ?? 0;
  acc.totalTokens += u.totalTokens ?? 0;
}

/** Takes `u` away from `acc`: the undo of an `addUsage` of the same tokens. */
export function subtractUsage(acc: UsageTotals, u: UsageTotals): void {
  addUsage(acc, { inputTokens: -u.inputTokens, outputTokens: -u.outputTokens, cacheReadTokens: -u.cacheReadTokens, cacheWriteTokens: -u.cacheWriteTokens, totalTokens: -u.totalTokens });
}

/** A turn's tokens as totals. The cache is already in the input (measured), so the total is input + output. */
export const turnTokens = (u: TurnUsage): UsageTotals => ({ ...u, totalTokens: u.inputTokens + u.outputTokens });

export function withRatio(u: UsageTotals): UsageTotals & { cacheHitRatio: number | null } {
  // Measured on the API: inputTokens already includes cache reads and writes, and totalTokens = input + output.
  return { ...u, cacheHitRatio: u.inputTokens > 0 ? Math.round((u.cacheReadTokens / u.inputTokens) * 1000) / 1000 : null };
}

/** What a run has spent. The run's budget (cap) is checked against it, and it accumulates across resumes. */
export interface Ledger {
  /** The cost the cap uses: the sum, per attempt, of the larger of the raw and the charged cost. */
  spentCents: number;
  /** Only what Cursor charged (0 for usage included in the plan). */
  chargedCents: number;
  spentTokens: number;
  /** Tokens by kind. */
  usage: UsageTotals;
}

/** The cost the cap counts for an attempt: the larger of the raw and the charged cost (the charged cost alone is 0 for usage included in the plan). */
const attemptCents = (e: { rawCents?: number; chargedCents: number }) => Math.max(e.rawCents ?? 0, e.chargedCents);

/**
 * Replays a run's spend from its events: every attempt that called the API, failed ones included, in every execution of
 * the run. A step served from the journal or the memo spent nothing now: its cost is already in the attempt that ran it.
 * An attempt that never reached its `step-end` (the process died mid-step) is counted by the turns it finished: those
 * tokens were spent. Its cost in cents never reached the log, so the cents cap cannot count it.
 */
export function replayLedger(events: Iterable<WorkflowEvent>): Ledger {
  const ledger: Ledger = { spentCents: 0, chargedCents: 0, spentTokens: 0, usage: emptyUsage() };
  const unfinished = new Map<string, UsageTotals>(); // tokens of the turns of each attempt that has not ended
  for (const e of events) {
    if (e.type === "turn") {
      const tokens = unfinished.get(e.attemptId) ?? emptyUsage();
      addUsage(tokens, turnTokens(e.usage));
      unfinished.set(e.attemptId, tokens);
    } else if (e.type === "step-end" && !e.cached) {
      unfinished.delete(e.attemptId);
      ledger.spentCents += attemptCents(e);
      ledger.chargedCents += e.chargedCents;
      ledger.spentTokens += e.usage?.totalTokens ?? 0;
      addUsage(ledger.usage, e.usage);
    }
  }
  for (const tokens of unfinished.values()) {
    ledger.spentTokens += tokens.totalTokens;
    addUsage(ledger.usage, tokens);
  }
  return ledger;
}

/** A cloud step an earlier execution left without an end: its agent may still be running in the cloud. */
export interface InterruptedCloudStep {
  /** The step's stable id: what a resume matches the step to. */
  stepId: string;
  /** The attempt that has an agent and no end. */
  attemptId: string;
  agentId: string;
  /** Where that agent started from, when the log says. */
  snapshot?: CloudAgentEvent["snapshot"];
  /** The tokens the attempt's turns reported before the process died: the ledger counts them as spent. */
  countedTokens: UsageTotals;
}

/**
 * The cloud steps a run's log shows as interrupted, by `stepId`: the latest attempt of each whose agent was recorded
 * (`cloud-agent`) and that never ended (no `step-end`). That is a crash, or a process killed in the middle of the step; the
 * agent it started keeps working in the cloud, and a resume reattaches to it (or starts a new one when that agent's run was
 * cancelled). (A step that delivered is in the journal, which
 * a resume reads first; an execution that reattaches closes the attempt it takes over, so there is one at a time.)
 */
export function interruptedCloudSteps(events: Iterable<WorkflowEvent>): Map<string, InterruptedCloudStep> {
  const open = new Map<string, CloudAgentEvent>(); // by attemptId, in the order the agents appeared
  const turns = new Map<string, UsageTotals>(); // what each attempt's turns reported, by attemptId
  for (const e of events) {
    if (e.type === "cloud-agent") open.set(e.attemptId, e);
    else if (e.type === "turn") {
      const tokens = turns.get(e.attemptId) ?? emptyUsage();
      addUsage(tokens, turnTokens(e.usage));
      turns.set(e.attemptId, tokens);
    } else if (e.type === "step-end" && !e.cached) {
      open.delete(e.attemptId);
    }
  }
  const steps = new Map<string, InterruptedCloudStep>();
  for (const agent of open.values()) {
    steps.set(agent.stepId, { stepId: agent.stepId, attemptId: agent.attemptId, agentId: agent.agentId, snapshot: agent.snapshot, countedTokens: turns.get(agent.attemptId) ?? emptyUsage() });
  }
  return steps;
}

/** How many progress lines `recent` keeps. */
export const RECENT_LINES = 20;
/** The longest a progress line gets. Longer text is cut: a line is a summary, never a transcript. */
const LINE_MAX_CHARS = 200;

/** One line: line breaks and runs of spaces collapsed, cut at `LINE_MAX_CHARS`. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > LINE_MAX_CHARS ? `${flat.slice(0, LINE_MAX_CHARS - 1)}…` : flat;
}

/** How a command ended, in a few words: `exit 0, 1.2s`, `timeout, 600.0s`. Never the command's output. */
function execEndText(e: ExecEndEvent): string {
  const what = e.outcome === "exit" ? `exit ${e.exitCode ?? e.signal ?? "?"}` : e.outcome === "spawn-error" ? "could not start" : e.outcome;
  return `${what}, ${(e.durationMs / 1000).toFixed(1)}s`;
}

/**
 * The progress line of an event, or undefined when the event is not progress. Built from metadata only (labels, model
 * ids, costs) and from the lines the workflow and the engine wrote for people to read (`ctx.log`, warnings). Never from
 * a prompt, an agent message, a tool call or a command output.
 */
function recentLine(e: WorkflowEvent): string | undefined {
  switch (e.type) {
    case "log":
      return oneLine(e.message);
    case "phase":
      return oneLine(`== ${e.title}`);
    case "step-start":
      if (e.cached) return undefined; // served from the journal/memo: the step-end that follows already shows it
      return oneLine(`▶ ${e.label} [${e.model ?? "?"}]${e.attempt > 1 ? ` attempt ${e.attempt}` : ""}`);
    case "step-end": {
      const cache = e.usage && e.usage.cacheReadTokens > 0 ? ` cache-read ${e.usage.cacheReadTokens}` : "";
      const cents = attemptCents(e);
      return oneLine(`${e.ok ? "✓" : "✗"} ${e.label}${e.cached ? ` (${e.cached})` : ""}${cents ? ` ${cents}¢` : ""}${cache}`);
    }
    case "exec-start":
      return oneLine(`▶ ${e.label} [${e.command}]`);
    case "exec-end":
      return oneLine(`${e.ok ? "✓" : "✗"} ${e.label} (${execEndText(e)})`);
    case "warning":
      return oneLine(`⚠ ${e.message}`);
    case "metric":
      return oneLine(`· ${e.name} = ${e.value}`);
    case "run-start":
    case "run-end":
    case "card": // the Board shows it; it is not progress
    case "group-start":
    case "group-end":
    case "turn":
    case "cloud-agent": // the step-start already shows the step; the agent's id is for the log
    case "content":
      return undefined;
  }
}

/** The state of one execution of a run, as the event log shows it. */
export interface ExecutionState {
  workflow: string;
  startedAt: string;
  /** Set when the execution wrote its `run-end`. */
  finishedAt?: string;
  /** How the execution's ending is classed (see `outcomeClass`). Set with `finishedAt`. */
  outcome?: OutcomeClass;
  /** `running` until the execution writes its `run-end`. A caller that knows the process is gone decides what that means. */
  status: "running" | RunStatus;
  phase?: string;
  /** The last progress lines, one line each. */
  recent: string[];
  result?: unknown;
  error?: string;
  /** The run's spend up to the end of this execution (spend accumulates across resumes). */
  ledger: Ledger;
}

/**
 * The state of the execution that starts at `events[start]` (a `run-start`): the events from there up to the next
 * `run-start`. The run's spend is replayed up to the end of the execution.
 */
function projectFrom(events: readonly WorkflowEvent[], start: number): ExecutionState | undefined {
  const next = events.findIndex((e, i) => i > start && e.type === "run-start");
  const end = next < 0 ? events.length : next;
  const runStart = events[start]!;
  if (runStart.type !== "run-start") return undefined;

  const state: ExecutionState = {
    workflow: runStart.workflow,
    startedAt: runStart.ts,
    status: "running",
    recent: [],
    ledger: replayLedger(events.slice(0, end)),
  };
  for (const e of events.slice(start, end)) {
    if (e.type === "phase") state.phase = e.title;
    if (e.type === "run-end") {
      state.status = e.status;
      state.finishedAt = e.ts;
      state.outcome = outcomeClass(e.status, e.outcomeStatus);
      state.result = e.result;
      state.error = e.error;
    }
    const line = recentLine(e);
    if (line !== undefined) state.recent.push(line);
  }
  state.recent = state.recent.slice(-RECENT_LINES);
  return state;
}

/**
 * The state of the execution that job `jobId` started: the events from the `run-start` that carries its id up to the next
 * `run-start`. Undefined when the log has no such execution yet (the job exists, its process has not started the run).
 */
export function projectExecution(events: readonly WorkflowEvent[], jobId: string): ExecutionState | undefined {
  const start = events.findIndex((e) => e.type === "run-start" && e.jobId === jobId);
  return start < 0 ? undefined : projectFrom(events, start);
}

/** The state of the latest execution of the run, whichever job (or `wf run`) started it. Undefined when the log has no `run-start`. */
export function projectLatestExecution(events: readonly WorkflowEvent[]): ExecutionState | undefined {
  const start = events.findLastIndex((e) => e.type === "run-start");
  return start < 0 ? undefined : projectFrom(events, start);
}

/** A link on a run's card. */
export interface RunCardLink {
  label: string;
  /** An `http:` or `https:` URL: anything else in a log is dropped. */
  url: string;
}

/** What a run's card shows on the Board: the latest `card` event of the run, made safe to display. */
export interface RunCard {
  title: string;
  subtitle?: string;
  links: RunCardLink[];
  badges: string[];
}

/** The most a card carries. A log is written by workflow code and read by a browser: the read side bounds what it hands over. */
const CARD_MAX = { title: 200, subtitle: 200, label: 80, url: 2048, badge: 40, links: 8, badges: 8 };
/** The most a phase title and a run's phase list carry, for the same reason. */
const PHASES_MAX = { title: 80, count: 30 };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Whether `url` is an absolute `http:` or `https:` URL. A card link is shown as a link to click: `javascript:` and `data:` never are. */
function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** The card a `card` event describes, or undefined when it has no usable title. Log content is data, not code: types are checked, not assumed. */
function parseCardEvent(event: unknown): RunCard | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const { title, subtitle, links, badges } = event as Record<string, unknown>;
  if (!isText(title)) return undefined;
  const card: RunCard = { title: clip(title.trim(), CARD_MAX.title), links: [], badges: [] };
  if (isText(subtitle)) card.subtitle = clip(subtitle.trim(), CARD_MAX.subtitle);
  for (const link of Array.isArray(links) ? links : []) {
    const { label, url } = (typeof link === "object" && link !== null ? link : {}) as Record<string, unknown>;
    if (card.links.length < CARD_MAX.links && isText(label) && isText(url) && url.length <= CARD_MAX.url && isWebUrl(url)) {
      card.links.push({ label: clip(label.trim(), CARD_MAX.label), url });
    }
  }
  for (const badge of Array.isArray(badges) ? badges : []) {
    if (card.badges.length < CARD_MAX.badges && isText(badge)) card.badges.push(clip(badge.trim(), CARD_MAX.badge));
  }
  return card;
}

/**
 * The card of a run: the latest `card` event of the log, whichever execution wrote it (a resume that sets no card of its own
 * is still the same card). An event with no usable title is skipped, so the card before it stays. Undefined when the workflow
 * never set one.
 */
export function latestCard(events: readonly WorkflowEvent[]): RunCard | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== "card") continue;
    const card = parseCardEvent(event);
    if (card) return card;
  }
  return undefined;
}

/** A phase title as the read side hands it over: cut to what a column title may hold. A run's `phase` and its `phases` both go through it, so they always agree. */
export const boundedPhase = (title: string): string => clip(title, PHASES_MAX.title);

/**
 * The phases of a run, in order: the ones its workflow declared (the latest `run-start` that lists them; logs of older kits
 * list none), then any other phase the run entered. The Board's columns.
 */
export function runPhases(events: readonly WorkflowEvent[]): string[] {
  const phases: string[] = [];
  const add = (title: unknown) => {
    if (!isText(title) || phases.length >= PHASES_MAX.count) return;
    const bounded = boundedPhase(title);
    if (!phases.includes(bounded)) phases.push(bounded);
  };
  const declared = events.findLast((e) => e.type === "run-start" && Array.isArray(e.phases));
  if (declared?.type === "run-start") for (const title of declared.phases ?? []) add(title);
  for (const e of events) if (e.type === "phase") add(e.title);
  return phases;
}
