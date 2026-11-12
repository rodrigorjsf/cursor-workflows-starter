// What the Run view's header says about the run: its status, its error, and which actions it offers. Pure.
//
// The status and the error are the API's (`GET /api/runs/<runId>`): the one name the Board, the Runs table and `wf status` give
// the run. A run whose process died without ending it is `failed` there, with the runtime's error and its resume hint; the
// events alone would only say that they stopped. The events speak during a replay, which shows the run as it stood.
import { runsInCloud } from "./node-details.js";
import type { ProgressStatus, RunGraph, RunProgress } from "./run-graph.js";
import type { ApiStatus } from "./use-run-events.js";

const EVENTS_TEXT: Record<ProgressStatus, string> = {
  running: "running",
  finished: "finished",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "stopped",
};

export interface HeaderInput {
  /** What `GET /api/runs/<runId>` says; undefined until it answers. */
  api?: { status?: ApiStatus; error?: string };
  /** The run as its events show it. */
  run: RunProgress;
  replaying: boolean;
  /** No further event will come into what is shown. */
  settled: boolean;
}

export interface HeaderStatus {
  /** The status class (`status-<key>`). */
  key: string;
  label: string;
  error?: string;
}

export function headerStatus({ api, run, replaying, settled }: HeaderInput): HeaderStatus {
  if (replaying && !settled) return { key: "replaying", label: "replaying" };
  // At its end a replay shows the run as it is, under the API's name like everywhere else.
  if (api?.status === undefined) return replaying ? { key: run.status, label: EVENTS_TEXT[run.status], error: run.error } : { key: "pending", label: "looking for the run…" };
  return { key: api.status, label: api.status, error: api.error };
}

export interface OfferedActions {
  /** Offer to cancel the run's process. */
  cancelRun: boolean;
  /** The run's process is there but stopped beating: cancelling it kills the process, then cancels the cloud agents it left. */
  frozen: boolean;
  /** The cloud agents a process that is gone left working, which the view offers to cancel: the agents of the cloud steps whose attempt never ended. */
  leftCloudAgents: string[];
}

/** How the API's error of a frozen run starts (`silenceOf` in the runtime's `job-state.ts`). */
const FROZEN_ERROR = /^no heartbeat for /;

/**
 * What the header offers for a run in API status `status`, with the API's `error`, whose events (read to their end) gave
 * `graph`. A running run can be cancelled; a live process cancels its own cloud agents. A frozen run (its process alive, its
 * heartbeat stale) is `failed` with the error `no heartbeat for …`, and still holds the run: it can be cancelled too, which
 * kills the process and then cancels, through the Cursor API, the cloud agents it left (ADR-0007), so it needs no other
 * button. A run whose process is gone is `failed` with steps still `interrupted`: the cloud agents of those steps may still be
 * working, and spending, and the server cancels them through the Cursor API.
 */
export function offeredActions(status: ApiStatus | undefined, graph: RunGraph, error?: string): OfferedActions {
  const frozen = status === "failed" && error !== undefined && FROZEN_ERROR.test(error);
  const leftCloudAgents =
    status === "failed" && !frozen
      ? [...new Set(graph.nodes.filter((n) => n.state === "interrupted" && runsInCloud(n) && n.detail.cloudAgentId !== undefined).map((n) => n.detail.cloudAgentId!))]
      : [];
  return { cancelRun: status === "running" || frozen, frozen, leftCloudAgents };
}

/**
 * How long the run took, by the Runs table's rule: to its run-end, or to `now` while no further event can end it (a live run,
 * a replay part-way through). A run that is over without a run-end (its process died) did not record its end, and has none;
 * nor has a run with no start yet.
 */
export function runElapsed(run: { startedAt?: string; endedAt?: string }, settled: boolean, now: number): number | undefined {
  if (run.startedAt === undefined || (settled && run.endedAt === undefined)) return undefined;
  return Math.max(0, (run.endedAt !== undefined ? Date.parse(run.endedAt) : now) - Date.parse(run.startedAt));
}
