// What the Run view's header says about the run: its status, its error, and which actions it offers. Pure.
import type { ProgressStatus, RunGraph, RunProgress } from "./run-graph.js";
import type { ApiStatus } from "./use-run-events.js";

const STATUS_TEXT: Record<ProgressStatus, string> = {
  running: "running",
  finished: "finished",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "stopped without finishing",
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

export function headerStatus({ run, replaying, settled }: HeaderInput): HeaderStatus {
  if (replaying && !settled) return { key: "replaying", label: "replaying", error: run.error };
  return { key: run.status, label: STATUS_TEXT[run.status], error: run.error };
}

export interface OfferedActions {
  /** Offer to cancel the run's process. */
  cancelRun: boolean;
  /** The cloud agents a dead process left running, which the view offers to cancel. */
  leftCloudAgents: string[];
}

export function offeredActions(status: ApiStatus | undefined, _graph: RunGraph): OfferedActions {
  return { cancelRun: status === "running", leftCloudAgents: [] };
}
