// The cloud backend: one attempt of a step on a Cursor cloud agent (ADR-0006). A cloud agent is not a local agent somewhere
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
// A step that writes works on the snapshot branch itself (`workOnCurrentBranch`): the agent commits there, and when the run
// ends the branch is fetched and the local worktree fast-forwarded to it (`bringBack`), before the snapshot branch is deleted.
// A step that asks for a structured result gets it from the last fenced JSON block of the answer, or, when the role's
// `resultVia` says so, from the `result.json` file the agent saves in its artifacts directory, downloaded after the run.

import { Agent, type Run, type RunResult, type SDKAgent } from "@cursor/sdk";
import {
  SEND_GRACE_MS,
  type AgentBackend,
  type AttemptEvent,
  type AttemptResult,
  type Delivery,
  type Exchange,
  type ResultVia,
  type SettleRun,
  type SnapshotRef,
  type StepOptions,
  agentBase,
  classifyError,
  converse,
  disposeQuietly,
  runAttempt,
  within,
} from "./backend.js";
import { errorText } from "./error-text.js";
import { isGone } from "./cloud-cancel.js";
import { BringBackError, type PushedSnapshot, bringBack, cloudRepoUrl, deleteSnapshot, pushSnapshot, snapshotBranch } from "./cloud-snapshot.js";
import type { JsonSchema } from "./workflow.js";
import { type Parsed, RESULT_ARTIFACT, artifactInstruction, artifactReprompt, jsonBlockInstruction, jsonBlockReprompt, resultFromArtifact, resultFromJsonBlock } from "./structured.js";

/** What a read-only cloud step is told, since the allowlist that would make it so cannot be sent. */
const READ_ONLY_INSTRUCTION = "\n\n---\nThis is a read-only step: do not create, edit or delete files, do not commit, and do not push or open a pull request.";

/**
 * What a step that writes is told, since the agent's changes come back through git and the cloud agent is not the one that decides
 * where it works. It also overrides a prompt written for a local agent, which often forbids git commands: the workflow's own
 * version control does not reach a cloud agent's VM.
 */
const WRITE_INSTRUCTION =
  "\n\n---\nThis step works on a throwaway branch, and what you change comes back to the person's machine through git. Work on the current branch and commit your changes there when you finish, even if an instruction above says not to run git commands. Do not create another branch, do not rebase, amend, reset or force-push, and do not open a pull request.";

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
  const agent = await within(signal, Agent.resume(agentId, agentBase(o)), disposeQuietly);
  const release = () => disposeQuietly(agent);
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

/** Where a cloud run says it pushed: the branches, by repository (`RunResult.git`). */
type PushedBranches = NonNullable<RunResult["git"]>;

/** Is `path`, as the artifacts API lists it, the `result.json` at the top of the agent's artifacts directory? The API roots paths at the workspace (`artifacts/result.json`); the VM's own form (`/opt/cursor/artifacts/result.json`) is the same file. A file of that name deeper down is not it. */
const isResultArtifact = (path: string): boolean => path.replace(/^\/?(?:opt\/cursor\/)?(?:artifacts\/)?/, "") === RESULT_ARTIFACT;

/** The text of the `result.json` the agent saved in its artifacts directory, or undefined when it saved none. */
async function downloadResult(agent: SDKAgent): Promise<string | undefined> {
  const saved = (await agent.listArtifacts()).find((artifact) => isResultArtifact(artifact.path));
  return saved && (await agent.downloadArtifact(saved.path)).toString("utf8");
}

/**
 * How a cloud step delivers its structured result, one per `ResultVia`: what the prompt asks for, where the result is read from
 * after an answer, how a refusal is worded for the step and for the follow-up that corrects it.
 */
interface ResultChannel {
  instruction: (schema: JsonSchema) => string;
  read: (answer: { result?: string }, agent: SDKAgent, schema: JsonSchema) => Promise<Parsed>;
  refusal: string;
  reprompt: (error: string) => string;
}
const RESULT_CHANNELS: Record<ResultVia, ResultChannel> = {
  "json-block": {
    instruction: jsonBlockInstruction,
    read: async (answer, _agent, schema) => resultFromJsonBlock(answer.result ?? "", schema),
    refusal: "the agent did not end with a valid JSON block",
    reprompt: jsonBlockReprompt,
  },
  artifact: {
    instruction: artifactInstruction,
    read: async (_answer, agent, schema) => resultFromArtifact(await downloadResult(agent), schema),
    refusal: `the agent did not deliver a valid ${RESULT_ARTIFACT} artifact`,
    reprompt: artifactReprompt,
  },
};

/** The exchange of the attempt, handing every answer's `git` (where the run pushed) to `remember`. */
function rememberingGit(exchange: Exchange, remember: (git: PushedBranches | undefined) => void): Exchange {
  const noting = async (answer: Promise<RunResult>) => {
    const done = await answer;
    remember(done.git);
    return done;
  };
  return Object.assign((message: string) => noting(exchange(message)), { attach: (run: Run) => noting(exchange.attach(run)) });
}

/**
 * The branches the run says it pushed to when the snapshot branch is not among them (an agent that did not work on the current
 * branch pushes to one of its own); empty when it pushed to the snapshot branch, or says nothing about where it pushed.
 */
function pushedElsewhere(pushed: PushedBranches | undefined, snapshotBranch: string): string[] {
  const reported = (pushed?.branches ?? []).flatMap((entry) => (entry.branch ? [entry.branch] : []));
  return reported.includes(snapshotBranch) ? [] : reported;
}

/**
 * The end of a step that writes: the agent's commits are fetched into the worktree, which is fast-forwarded to them (see
 * `bringBack`). A work that cannot be brought back fails the step (`final`: a retry would pay for a new agent), with the reason,
 * and the worktree is left as it was (or the engine puts it back, when `touchedWorktree` says it may have been changed). `result`
 * is what the attempt reports otherwise.
 */
async function bringWorkBack(result: AttemptResult, pushed: PushedBranches | undefined, from: SnapshotRef | undefined, o: StepOptions, signal: AbortSignal, onEvent: (event: AttemptEvent) => void): Promise<AttemptResult> {
  const failed = (message: string, touchedWorktree = false): AttemptResult => ({
    ...result,
    outcome: { kind: "error", reason: "other", message: `the cloud agent's work could not be brought back: ${message}` },
    final: true,
    ...(touchedWorktree && { touchedWorktree: true as const }),
  });
  if (!from?.commit) return failed("the snapshot the interrupted agent started from is not in the event log, so there is nothing to check the worktree against");
  const elsewhere = pushedElsewhere(pushed, from.branch);
  if (elsewhere.length) return failed(`the cloud agent pushed to ${elsewhere.join(", ")} instead of the snapshot branch ${from.branch}, so its work is not on the branch the worktree moves to; ${elsewhere.length === 1 ? "that branch stays" : "those branches stay"} on ${from.remote}: delete ${elsewhere.length === 1 ? "it" : "them"} by hand`);
  try {
    const commits = await bringBack({ cwd: o.cwd, remote: from.remote, branch: from.branch, base: from.commit, signal });
    if (commits === 0) onEvent({ type: "warning", message: `the cloud agent made no commit on ${from.branch}, so nothing came back to the worktree: a step that writes has to commit its work` });
    return result;
  } catch (err) {
    if (signal.aborted) return { ...result, outcome: { kind: "aborted", reason: signal.reason } };
    return failed(errorText(err), err instanceof BringBackError && err.touched);
  }
}

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
  const startsFrom: SnapshotRef | undefined = start.kind === "resumed" ? previous?.snapshot : { remote: start.snapshot.remote, branch: start.snapshot.branch, commit: start.snapshot.commit };
  try {
    const { schema } = o;
    let agent: SDKAgent | undefined;
    /** Where the last answer says the agent pushed. */
    let pushed: PushedBranches | undefined;
    const channel = RESULT_CHANNELS[o.resultVia ?? "json-block"];
    const check = async (answer: { result?: string }): Promise<Delivery> => {
      const delivered = await channel.read(answer, agent!, schema!);
      return delivered.ok ? delivered : { ok: false, message: `${channel.refusal} (${delivered.error})`, reprompt: channel.reprompt(delivered.error) };
    };
    const message = prompt + (o.writes ? WRITE_INSTRUCTION : READ_ONLY_INSTRUCTION) + (schema ? channel.instruction(schema) : "");
    const result = await runAttempt(
      signal,
      // The agent's event says where it starts from and whether it is one taken over: the log keeps that with the id, for a resume to clean up after it.
      (event) => onEvent(event.type === "agent" ? { ...event, ...(startsFrom && { snapshot: startsFrom }), ...(start.kind === "resumed" && { reattached: true as const }) } : event),
      async () =>
        (agent =
          start.kind === "resumed"
            ? start.agent
            : // Never `tools`, `disallowedTools`, `systemPrompt` or `local` (custom tools, setting sources): a cloud agent rejects or ignores them.
              await Agent.create({
                ...agentBase(o),
                // A step that writes commits on the snapshot branch itself, which the engine then fetches.
                cloud: { repos: [{ url: cloudRepoUrl(start.snapshot.remoteUrl), startingRef: start.snapshot.branch }], autoCreatePR: false, ...(o.writes && { workOnCurrentBranch: true }) },
              })),
      (exchange) => converse(rememberingGit(exchange, (git) => (pushed = git)), message, { schemaRetries: o.schemaRetries, check: schema ? check : undefined, onEvent, running: start.kind === "resumed" ? start.running : undefined }),
      settleCloudRun(o.apiKey, signal, waitFloorMs),
    );
    // The work comes back before the snapshot branch is deleted (the agent's branch is the snapshot branch).
    if (!o.writes || result.outcome.kind !== "finished" || signal.aborted) return result;
    return await bringWorkBack(result, pushed, startsFrom, o, signal, onEvent);
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
