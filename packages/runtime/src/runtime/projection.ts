// What can be derived from a run's event log, so that the log stays the one source of truth: the run's spend so far (the
// budget ledger) and the state of one execution of it (what `wf status` and `wait_workflow` show).
//
// Nothing here reads a file or the clock: both take the events. Neither ever carries step content: the projection looks
// at metadata fields only, and `content` events are not read at all.

import type { WorkflowEvent } from "./events.js";
import type { UsageTotals } from "./workflow.js";

export const emptyUsage = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 });

export function addUsage(acc: UsageTotals, u: Partial<UsageTotals> | undefined): void {
  if (!u) return;
  acc.inputTokens += u.inputTokens ?? 0;
  acc.outputTokens += u.outputTokens ?? 0;
  acc.cacheReadTokens += u.cacheReadTokens ?? 0;
  acc.cacheWriteTokens += u.cacheWriteTokens ?? 0;
  acc.totalTokens += u.totalTokens ?? 0;
}

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
      addUsage(tokens, { ...e.usage, totalTokens: e.usage.inputTokens + e.usage.outputTokens }); // the cache is already in the input
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

/** How many progress lines `recent` keeps. */
export const RECENT_LINES = 20;
/** The longest a progress line gets. Longer text is cut: a line is a summary, never a transcript. */
const LINE_MAX_CHARS = 200;

/** One line: line breaks and runs of spaces collapsed, cut at `LINE_MAX_CHARS`. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > LINE_MAX_CHARS ? `${flat.slice(0, LINE_MAX_CHARS - 1)}…` : flat;
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
      return oneLine(`▶ ${e.label} [${e.model ?? "?"}]${e.attempt > 1 ? ` tentativa ${e.attempt}` : ""}`);
    case "step-end": {
      const cache = e.usage && e.usage.cacheReadTokens > 0 ? ` cache-read ${e.usage.cacheReadTokens}` : "";
      const cents = attemptCents(e);
      return oneLine(`${e.ok ? "✓" : "✗"} ${e.label}${e.cached ? ` (${e.cached})` : ""}${cents ? ` ${cents}¢` : ""}${cache}`);
    }
    case "warning":
      return oneLine(`⚠ ${e.message}`);
    case "metric":
      return oneLine(`· ${e.name} = ${e.value}`);
    case "run-start":
    case "run-end":
    case "group-start":
    case "group-end":
    case "turn":
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
  /** `running` until the execution writes its `run-end`. A caller that knows the process is gone decides what that means. */
  status: "running" | "finished" | "failed" | "cancelled";
  phase?: string;
  /** The last progress lines, one line each. */
  recent: string[];
  result?: unknown;
  error?: string;
  /** The run's spend up to the end of this execution (spend accumulates across resumes). */
  ledger: Ledger;
}

/**
 * The state of the execution that job `jobId` started: the events from the `run-start` that carries its id up to the next
 * `run-start`. Undefined when the log has no such execution yet (the job exists, its process has not started the run).
 */
export function projectExecution(events: readonly WorkflowEvent[], jobId: string): ExecutionState | undefined {
  const start = events.findIndex((e) => e.type === "run-start" && e.jobId === jobId);
  if (start < 0) return undefined;
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
      state.result = e.result;
      state.error = e.error;
    }
    const line = recentLine(e);
    if (line !== undefined) state.recent.push(line);
  }
  state.recent = state.recent.slice(-RECENT_LINES);
  return state;
}
