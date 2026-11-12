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
  if (replaying) return settled ? { key: run.status, label: EVENTS_TEXT[run.status], error: run.error } : { key: "replaying", label: "replaying" };
  if (api?.status === undefined) return { key: "pending", label: "looking for the run…" };
  return { key: api.status, label: api.status, error: api.error };
}

export interface OfferedActions {
  /** Offer to cancel the run's process. */
  cancelRun: boolean;
  /** The cloud agents a dead process left working, which the view offers to cancel: the agents of the cloud steps whose attempt never ended. */
  leftCloudAgents: string[];
}

/**
 * What the header offers for a run in API status `status`, whose events (read to their end) gave `graph`. A running run can be
 * cancelled; a live process cancels its own cloud agents. A run whose process died is `failed` with steps still `interrupted`:
 * the cloud agents of those steps may still be working, and spending, and the server cancels them through the Cursor API.
 */
export function offeredActions(status: ApiStatus | undefined, graph: RunGraph): OfferedActions {
  const leftCloudAgents =
    status === "failed"
      ? [...new Set(graph.nodes.filter((n) => n.state === "interrupted" && runsInCloud(n) && n.detail.cloudAgentId !== undefined).map((n) => n.detail.cloudAgentId!))]
      : [];
  return { cancelRun: status === "running", leftCloudAgents };
}
