// The cloud agents a run left running when its process is gone. A process that executes a run cancels its own cloud runs
// when the run is cancelled; one that died (a crash, a SIGKILL) cannot, and its agents keep working, and spending, in the
// cloud. The run's event log still names them (US13): cancelling the run from outside reaches them through the Cursor API.
//
// The SDK is loaded only when the log names an agent: the dashboard, a process that stays up, cancels through here too and
// has no use for the SDK (hundreds of MB) otherwise.
import { join } from "node:path";
import { errorText } from "./error-text.js";
import { interruptedCloudSteps } from "./projection.js";
import { EVENTS_FILE, isRunExecuting, readEventLog, runDirIn } from "./run-store.js";

/** Did the cloud answer that it has no such agent (or run)? The SDK reports a 404 as a configuration error with the status. */
export function isGone(err: unknown): boolean {
  const { status, code } = (err ?? {}) as { status?: unknown; code?: unknown };
  return status === 404 || code === "agent_not_found";
}

/** What cancelling the cloud agents a dead run left did: the agents whose runs it cancelled, and the ones it could not reach. */
export interface LeftAgentsCancel {
  cancelled: string[];
  failed: Array<{ agentId: string; error: string }>;
}

/**
 * Cancels every cloud run still going of the agents run `runId`'s log shows as interrupted (an agent recorded, its attempt
 * never ended), when no process executes the run: a live process owns its agents, and cancels them itself. An agent the
 * cloud no longer has, or one with no run going, needs nothing. A log that cannot be read names no agent. Never throws, and
 * never creates a directory in the repo.
 */
export async function cancelLeftCloudAgents(repo: string, runId: string, apiKey?: string): Promise<LeftAgentsCancel> {
  const result: LeftAgentsCancel = { cancelled: [], failed: [] };
  let agentIds: string[];
  try {
    if (isRunExecuting(repo, runId)) return result;
    agentIds = [...interruptedCloudSteps(readEventLog(join(runDirIn(repo, runId), EVENTS_FILE), { content: false }).events).values()].map((step) => step.agentId);
  } catch {
    return result;
  }
  if (agentIds.length === 0) return result;
  const { Agent } = await import("@cursor/sdk");
  for (const agentId of agentIds) {
    try {
      const { items } = await Agent.listRuns(agentId, { runtime: "cloud", apiKey });
      const going = items.filter((run) => run.status === "running");
      await Promise.all(going.map((run) => run.cancel()));
      if (going.length > 0) result.cancelled.push(agentId);
    } catch (err) {
      if (!isGone(err)) result.failed.push({ agentId, error: errorText(err) });
    }
  }
  return result;
}

/** What `left` did, as the tail of a cancellation note: empty when the run left no agent running. */
export function leftAgentsNote(left: LeftAgentsCancel): string {
  const parts: string[] = [];
  if (left.cancelled.length > 0) parts.push(`cancelled the cloud agent${left.cancelled.length > 1 ? "s" : ""} it left running: ${left.cancelled.join(", ")}`);
  for (const { agentId, error } of left.failed) parts.push(`could not reach cloud agent ${agentId} (${error}): resume the run and cancel it`);
  return parts.map((part) => `; ${part}`).join("");
}
