// The cloud backend: one attempt of a step on a Cursor cloud agent (ADR-0005). A cloud agent is not a local agent somewhere
// else: it rejects custom tools and tool allowlists, ignores setting sources, and sees only what was pushed to a remote. So
// before the agent is created the worktree is pushed as a snapshot branch (cloud-snapshot.ts) and the agent starts from it;
// when the attempt ends the branch is deleted. The backend never sends custom tools, allowlists or setting sources, and
// asks for a structured result as a final fenced JSON block in the answer, which it validates and, when it is wrong,
// corrects with follow-ups in the same conversation.
//
// A cloud agent outlives the process that started it, so an attempt can pick one up (`StepOptions.reattach`): the agent an
// interrupted attempt left running is resumed by its id, and the attempt waits for the run it already has instead of starting
// another. The client's own wait ends after two hours with the run still going; that is a reattach point too (`settleCloudRun`).
//
// It runs read-only steps. A step that writes needs the agent's commits brought back, which is not here yet.

import { Agent, type Run, type SDKAgent } from "@cursor/sdk";
import {
  SEND_GRACE_MS,
  type AgentBackend,
  type AttemptEvent,
  type AttemptResult,
  type Delivery,
  type SettleRun,
  type SnapshotRef,
  type StepOptions,
  classifyError,
  converse,
  runAttempt,
  within,
} from "./backend.js";
import { type PushedSnapshot, cloudRepoUrl, deleteSnapshot, pushSnapshot, snapshotBranch } from "./cloud-snapshot.js";
import { jsonBlockInstruction, jsonBlockReprompt, resultFromJsonBlock } from "./structured.js";

/** What a read-only cloud step is told, since the allowlist that would make it so cannot be sent. */
const READ_ONLY_INSTRUCTION = "\n\n---\nThis is a read-only step: do not create, edit or delete files, do not commit, and do not push or open a pull request.";

export interface CloudBackendOptions {
  /** The git remote the snapshots go to (the `cloud.remote` preference). */
  remote: string;
  /** The run the steps belong to: part of every snapshot branch's name. */
  runId: string;
  /** The least time between two waits on a run that is still going (default one second; tests turn it off). */
  waitFloorMs?: number;
}

const WAIT_FLOOR_MS = 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Did the cloud answer that it has no such agent (or run)? The SDK reports a 404 as a configuration error with the status. */
function isGone(err: unknown): boolean {
  const { status, code } = (err ?? {}) as { status?: unknown; code?: unknown };
  return status === 404 || code === "agent_not_found";
}

/**
 * Waits for a cloud run to end. The SDK's `wait()` also ends, with status "error", when the client gives up (after two hours,
 * or when its stream fails for good) while the run goes on in the cloud, and that handle stays failed. So an "error" answer is
 * checked with the cloud: a run that is still going (or has ended in the meantime) is looked up afresh and waited on again,
 * and only a run the cloud itself calls failed is an error. The step's own timeout and the run's cancellation still end it.
 * A wait that gave up at once, with the run still going, is a failing client and not the two-hour limit: the next wait starts
 * no sooner than `floorMs` after the last one, so the loop never spins on the API.
 */
function settleCloudRun(apiKey: string | undefined, signal: AbortSignal, floorMs: number): SettleRun {
  return async (first) => {
    for (let run = first; ; ) {
      const waitedAt = Date.now();
      const answer = await run.wait();
      if (answer.status !== "error" || signal.aborted) return answer;
      const fresh = await Agent.getRun(run.id, { runtime: "cloud", agentId: run.agentId, apiKey }).catch(() => undefined);
      if (!fresh) return answer; // the cloud cannot be asked: the answer stands
      if (fresh.status === "error") return fresh.wait(); // the run itself failed: the cloud's account of it
      run = fresh;
      await sleep(floorMs - (Date.now() - waitedAt));
    }
  };
}

/** The agent an interrupted attempt left, resumed, and the run it was in the middle of (none when it had not been given a message). */
interface Resumed {
  agent: SDKAgent;
  running?: Run;
}

/**
 * Resumes the agent an interrupted attempt left, and finds the run it was in the middle of: the one still going, or else the
 * latest. Undefined when the cloud no longer has the agent (it never got the first message, or it was deleted): the attempt
 * then starts a new one. Any other failure rejects. A run that is cancelled while this looks the agent up cancels the run it
 * finds: the user stopped the run, and the agent must not go on spending.
 */
async function resumeInterrupted(o: StepOptions, agentId: string, signal: AbortSignal): Promise<Resumed | undefined> {
  const agent = await within(signal, Agent.resume(agentId, { apiKey: o.apiKey, name: o.name, model: o.model, agents: o.agents, mcpServers: o.mcpServers }), (late) => void late[Symbol.asyncDispose]().catch(() => {}));
  const release = () => agent[Symbol.asyncDispose]().catch(() => {});
  /** The run of `runs` to wait for: the one still going wins, then the newest by its creation time (the order of the cloud's list is not documented). */
  const pick = (runs: Run[]) => runs.find((run) => run.status === "running") ?? runs.toSorted((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  const stop = (runs: Run[]) => {
    const going = pick(runs);
    return going?.status === "running" ? going.cancel().catch(() => {}) : Promise.resolve();
  };
  try {
    // An abort gets a short grace for the list to arrive, so the run it names is cancelled and not left to finish unwatched.
    const { items } = await within(signal, Agent.listRuns(agentId, { runtime: "cloud", apiKey: o.apiKey }), (late) => void stop(late.items).then(release), SEND_GRACE_MS);
    if (signal.aborted) {
      await stop(items);
      throw signal.reason;
    }
    return { agent, running: pick(items) };
  } catch (err) {
    await release();
    if (isGone(err)) return undefined;
    throw err;
  }
}

/** Where an attempt's agent comes from: an interrupted one, resumed, or a new one, started from the snapshot this attempt pushed. */
type Start = ({ kind: "resumed" } & Resumed) | { kind: "fresh"; snapshot: PushedSnapshot };

async function runCloudAttempt({ remote, runId, waitFloorMs = WAIT_FLOOR_MS }: CloudBackendOptions, prompt: string, o: StepOptions, signal: AbortSignal, onEvent: (event: AttemptEvent) => void): Promise<AttemptResult> {
  onEvent({
    type: "warning",
    message: `cloud agents ignore setting sources (requested: ${o.settingSources.join(", ") || "none"}): the VM loads the project, team and plugin settings it always loads`,
  });
  const previous = o.reattach;
  let resumed: Resumed | undefined;
  if (previous) {
    try {
      resumed = await resumeInterrupted(o, previous.agentId, signal);
    } catch (err) {
      if (signal.aborted) return { outcome: { kind: "aborted", reason: signal.reason } };
      // Not "gone": the agent may well be running. Starting another would pay twice, so the attempt fails and the engine reattaches again.
      return { outcome: { ...classifyError(err), message: `could not reattach to cloud agent ${previous.agentId}: ${errorText(err)}` }, reattachFailed: true };
    }
    if (!resumed) onEvent({ type: "warning", message: `cloud agent ${previous.agentId}, left by an interrupted attempt, is no longer there: starting a new one` });
  }
  let start: Start;
  if (resumed) {
    start = { kind: "resumed", ...resumed };
  } else {
    try {
      start = { kind: "fresh", snapshot: await pushSnapshot({ cwd: o.cwd, remote, branch: snapshotBranch(runId), signal }) };
    } catch (err) {
      return { outcome: signal.aborted ? { kind: "aborted", reason: signal.reason } : { kind: "error", reason: "other", message: `cloud snapshot: ${errorText(err)}` } };
    }
  }
  /** Where the agent of this attempt starts from. A reattached one keeps the branch the interrupted attempt pushed. */
  const startsFrom: SnapshotRef | undefined = start.kind === "resumed" ? previous?.snapshot : { remote: start.snapshot.remote, branch: start.snapshot.branch };
  try {
    const { schema } = o;
    const check = (answer: { result?: string }): Delivery => {
      const delivered = resultFromJsonBlock(answer.result ?? "", schema!);
      return delivered.ok ? delivered : { ok: false, message: `the agent did not end with a valid JSON block (${delivered.error})`, reprompt: jsonBlockReprompt(delivered.error) };
    };
    const message = prompt + (o.writes ? "" : READ_ONLY_INSTRUCTION) + (schema ? jsonBlockInstruction(schema) : "");
    return await runAttempt(
      signal,
      // The agent's event says where it starts from and whether it is one taken over: the log keeps that with the id, for a resume to clean up after it.
      (event) => onEvent(event.type === "agent" ? { ...event, ...(startsFrom && { snapshot: startsFrom }), ...(start.kind === "resumed" && { reattached: true as const }) } : event),
      () =>
        start.kind === "resumed"
          ? Promise.resolve(start.agent)
          : // Never `tools`, `disallowedTools`, `systemPrompt` or `local` (custom tools, setting sources): a cloud agent rejects or ignores them.
            Agent.create({
              apiKey: o.apiKey,
              name: o.name,
              model: o.model,
              agents: o.agents,
              mcpServers: o.mcpServers,
              cloud: { repos: [{ url: cloudRepoUrl(start.snapshot.remoteUrl), startingRef: start.snapshot.branch }], autoCreatePR: false },
            }),
      (exchange) => converse(exchange, message, { schemaRetries: o.schemaRetries, check: schema ? check : undefined, onEvent, running: start.kind === "resumed" ? start.running : undefined }),
      settleCloudRun(o.apiKey, signal, waitFloorMs),
    );
  } finally {
    // The branch this attempt pushed, and the one an interrupted attempt left (the agent it belonged to is done with it, or gone).
    const branches: Array<Pick<PushedSnapshot, "top" | "remote" | "branch">> = [];
    if (start.kind === "fresh") branches.push(start.snapshot);
    if (previous?.snapshot) branches.push({ top: o.cwd, ...previous.snapshot });
    for (const branch of branches) {
      await deleteSnapshot(branch).catch((err: unknown) =>
        onEvent({ type: "warning", message: `could not delete the snapshot branch ${branch.branch} from ${branch.remote} (${errorText(err)}): delete it by hand` }),
      );
    }
  }
}

/** The cloud backend of one run. */
export function createCloudBackend(options: CloudBackendOptions): AgentBackend {
  return { location: "cloud", run: (prompt, o, signal, onEvent) => runCloudAttempt(options, prompt, o, signal, onEvent) };
}
