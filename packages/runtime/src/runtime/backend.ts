// AgentBackend: the seam where one attempt of a step runs. The engine orchestrates (budget, live caps, timeouts,
// cancellation, retries, the journal and the event log) and hands a backend what it needs to run the attempt; it does
// not know where or how the agent runs. A backend creates the agent, sends the prompt, waits for the answer, delivers a
// structured result when the step asks for one, reads the agent's usage and disposes the agent.
//
// The contract, in the order the engine relies on it:
//  - `signal` is the attempt's abort switch. The engine aborts it for every reason that ends an attempt early (the run was
//    cancelled, the step timed out, a token cap was crossed) and puts the cause in `signal.reason`. On abort the backend
//    cancels the agent run in flight, waits for it to stop (the next attempt must not edit the same directory in
//    parallel), reads the usage the attempt left behind, disposes the agent and reports `{ kind: "aborted", reason }`
//    with the signal's reason. An agent that is still being created when the signal aborts is disposed when it arrives. A
//    `send()` already in flight gets a short grace to hand back its run, so that run is cancelled and waited for too.
//  - `onEvent` receives what happens while the attempt runs, in order. A `turn` event is how the engine enforces the live
//    token caps: the engine may abort the signal from inside the callback, and the backend must then cancel at once.
//  - A token cap never abandons a creation: the engine holds a cap's abort back until the backend reports the agent (an
//    `agent` event, or any later one) and applies it then, so the agent that exists is stopped, its usage read and its
//    cost counted. The cancellation of the run and the step's timeout do abort a creation in flight. A backend therefore
//    emits `agent` as soon as the agent exists, and checks `signal.aborted` right after.
//  - The returned promise settles with a report for every way an attempt can end, a failure included; it rejects only
//    on a bug. The report says how the attempt ended and what it used, so the engine can charge it.
//
// There are two backends, one per location: the local one (here) is `Agent.create` with the SDK's `local` options, and the
// cloud one (backend-cloud.ts) is `Agent.create` with its `cloud` options against a snapshot of the worktree (ADR-0006).
// Both run the attempt through `runAttempt`, which holds the abort, cancellation and usage rules above. Tests substitute the
// SDK (test/fake-sdk.ts) or a backend (`RunOptions.backend`); the engine has no other way to reach an agent.
import {
  Agent,
  AgentBusyError,
  RateLimitError,
  type AgentUsage,
  type ModelSelection,
  type Run,
  type RunResult,
  type SDKAgent,
  type SendOptions,
  type SettingSource,
} from "@cursor/sdk";
import type { CloudAgentEvent, TurnUsage } from "./events.js";
import { type Capture, SUBMIT_TOOL, repromptMessage, schemaInstruction, submitResultTool } from "./structured.js";
import type { AgentCallOptions } from "./workflow.js";

/** Where a step runs. The global cap `allowedLocations` decides which ones a run may use. */
export type StepLocation = "local" | "cloud";

/**
 * How a cloud step delivers a structured result, the role's `resultVia` in the config: the last fenced `json` block of its
 * final message (the default), or a `result.json` file it saves in its artifacts directory, which is downloaded after the run.
 */
export type ResultVia = "json-block" | "artifact";

/**
 * The step's options as the engine resolved them (code defaults, role, config layers and the global caps already applied):
 * everything a backend needs to run one attempt, and nothing it has to look up.
 */
export interface StepOptions extends Pick<AgentCallOptions, "tools" | "disallowedTools" | "agents" | "mcpServers" | "schema"> {
  /** `<workflow>:<label>`: names the agent. */
  name: string;
  apiKey?: string;
  model: ModelSelection;
  /** The directory the agent works in. */
  cwd: string;
  settingSources: SettingSource[];
  /** Run the agent's commands in the SDK sandbox. */
  sandbox: boolean;
  /** The step can change files: its `tools` allowlist is absent or has more than read-only tools. */
  writes: boolean;
  /** Re-prompts allowed, in the same conversation, when a structured step has not delivered a valid result. */
  schemaRetries: number;
  /** How a cloud step delivers its structured result. Absent: `json-block`. A local step delivers it through a tool, whatever this says. */
  resultVia?: ResultVia;
  /**
   * A cloud agent that an earlier, interrupted attempt of this step left running (the process died, the run was resumed): the
   * cloud backend picks it up instead of creating another, and the local backend never gets one. `snapshot` is the branch
   * that attempt pushed, which this one cleans up.
   */
  reattach?: { agentId: string; snapshot?: SnapshotRef };
}

/** A snapshot branch of the worktree on a git remote: what a cloud agent starts from (see cloud-snapshot.ts). */
export type SnapshotRef = NonNullable<CloudAgentEvent["snapshot"]>;

/** What happens while an attempt runs. The engine counts and logs these; a backend only reports them. */
export type AttemptEvent =
  /**
   * The agent exists. A token cap that was crossed while it was being created is applied now (see the contract above). A cloud
   * agent also says where it starts from, and whether it is one an interrupted attempt left running (`reattached`): the
   * engine logs both with the id, so a resume can find the agent and clean up after it.
   */
  | { type: "agent"; agentId: string; snapshot?: SnapshotRef; reattached?: true }
  /** A piece of what the agent is saying. */
  | { type: "text"; delta: string }
  /** The agent finished one step (a model call and its tool calls). */
  | { type: "step" }
  | { type: "tool-call"; tool: string; callId?: string; args: unknown }
  /** The output of a finished command (`tool: "shell"`): exit code, stdout, then stderr, as one text. */
  | { type: "tool-output"; tool: string; callId?: string; output: string }
  /** The agent's context was summarised. */
  | { type: "summary" }
  /** A turn ended. `usage` is what the turn used, when the backend knows. The live token caps are checked here. */
  | { type: "turn"; usage?: TurnUsage }
  /** A structured step has not delivered a valid result: `message` is sent to the agent as a follow-up. */
  | { type: "reprompt"; message: string }
  /** Something the user should know about how the attempt runs (a setting this location ignores, a leftover it could not clean up). */
  | { type: "warning"; message: string };

/** What a backend could read of the attempt's usage: the agent's own report, or why it could not be read. */
export type UsageReading = { report: AgentUsage } | { failed: string };

/**
 * Why an attempt ended with an error. `account` is a problem of the account, not the step (no plan access): the run
 * ends. `usage-limit` is the plan's usage cap, and `rate-limit` a throttle that passes: the step may try again.
 */
export type AttemptErrorReason = "account" | "usage-limit" | "rate-limit" | "other";

/** How an attempt ended. */
export type AttemptOutcome =
  /** The agent finished: the text it ended with, or the validated object a structured step asked for. */
  | { kind: "finished"; value: unknown }
  /** The agent's run ended without finishing (it errored or was cancelled by someone else). */
  | { kind: "run-error"; message: string }
  /** The agent finished but never delivered a valid structured result, re-prompts included. */
  | { kind: "schema"; message: string }
  /** The signal was aborted; `reason` is `signal.reason`, the cause the engine gave. */
  | { kind: "aborted"; reason: unknown }
  /** The backend failed (creating the agent, sending, waiting). `code` is the provider's error code, when it has one. */
  | { kind: "error"; reason: AttemptErrorReason; message: string; code?: string };

/** What one attempt did and cost. */
export interface AttemptResult {
  outcome: AttemptOutcome;
  /** The agent's id, as soon as the agent existed: the event log keeps it. */
  agentId?: string;
  /** The model the run resolved to (an alias becomes the catalog id), once a run answered. */
  model?: string;
  /** The attempt's usage. Absent when no agent existed, so nothing was used. */
  usage?: UsageReading;
  /**
   * The attempt was asked to reattach to an interrupted agent (`StepOptions.reattach`) and could not reach it to say whether it
   * is still there. The engine hands the same agent to the next attempt, rather than letting it start another one.
   */
  reattachFailed?: true;
  /**
   * The backend may have changed the step's directory before it failed (a cloud step's work could not be brought back into the
   * worktree half way). The engine puts the directory back as it was before the step, the way it does for a cancelled one.
   */
  touchedWorktree?: true;
  /**
   * The step fails with this attempt, whatever retries it has left: another attempt would pay for a new agent and could not do
   * better (a cloud step's work that could not be brought back into the worktree).
   */
  final?: true;
}

export interface AgentBackend {
  readonly location: StepLocation;
  /** Runs one attempt of a step: see the contract at the top of this file. */
  run(prompt: string, options: StepOptions, signal: AbortSignal, onEvent: (event: AttemptEvent) => void): Promise<AttemptResult>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SDK error codes that are about the account, not the step. Trying again does not help. */
const ACCOUNT_ERROR_CODES = new Set(["plan_required"]);

export function classifyError(err: unknown): Extract<AttemptOutcome, { kind: "error" }> {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && ACCOUNT_ERROR_CODES.has(code)) return { kind: "error", reason: "account", message, code };
  // A rate limit that is not retryable is the plan's usage cap (the SDK doc: "Usage limit exceeded"): trying again does not help.
  if (err instanceof RateLimitError) return { kind: "error", reason: err.isRetryable ? "rate-limit" : "usage-limit", message };
  return { kind: "error", reason: "other", message };
}

/** How long an abort waits for a `send()` already in flight to hand back its run, so the run can be cancelled and awaited. */
export const SEND_GRACE_MS = 1000;

/**
 * Settles with `promise`, or rejects with the signal's reason as soon as it aborts. A value that arrives after the race
 * was given up goes to `late`, so an agent created too late is still disposed. The abort wins over a result that arrives
 * at the same time. With `graceMs`, an abort first waits that long for the value (a run that is about to be handed back
 * is cancelled by the caller, and waited for, instead of being left to stop on its own).
 */
export async function within<T>(signal: AbortSignal, promise: Promise<T>, late?: (value: T) => void, graceMs = 0): Promise<T> {
  let onAbort!: () => void;
  let abortedFirst = false;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      abortedFirst = true;
      reject(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  try {
    return await Promise.race([aborted, promise]);
  } catch (err) {
    if (abortedFirst && graceMs > 0) {
      let timer: NodeJS.Timeout | undefined;
      const arrived = await Promise.race([promise.then((value) => ({ value }), () => undefined), new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), graceMs)))]);
      clearTimeout(timer);
      if (arrived) return arrived.value;
    }
    promise.then(late, () => {}); // given up (or failed): whatever it yields later is not ours
    throw err;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** send() tolerating AgentBusyError (the previous run is still closing). */
async function sendWhenFree(agent: SDKAgent, message: string, options?: SendOptions): Promise<Run> {
  for (let i = 0; ; i++) {
    try {
      return await agent.send(message, options);
    } catch (err) {
      if (err instanceof AgentBusyError && i < 5) {
        await sleep(1000 * (i + 1));
        continue;
      }
      throw err;
    }
  }
}

/** The output of a finished shell tool call, as one text: exit code, stdout, then stderr. Undefined when the call has no result. */
function shellOutput(result: unknown): string | undefined {
  const r = result as { status?: string; value?: { exitCode?: number; stdout?: string; stderr?: string }; error?: unknown } | undefined;
  if (r?.status === "success" && r.value) {
    const { exitCode, stdout = "", stderr = "" } = r.value;
    return `exit ${exitCode}\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
  }
  if (r?.status === "error") return `error: ${JSON.stringify(r.error)}`;
  return undefined;
}

/**
 * The agent's usage and cost: a local agent's, or the cloud usage API's for a cloud agent. The cost "may lag a little after
 * the run ends" (SDK doc): it is read again when it comes back empty. A local agent's usage can answer 403
 * `feature_unavailable` (it is rolled out per account): no point asking again.
 */
async function readUsage(agent: SDKAgent): Promise<UsageReading> {
  let lastErr: unknown;
  for (let i = 0; ; i++) {
    const report = await agent.getUsage().catch((err: unknown) => {
      lastErr = err;
      return undefined;
    });
    const unavailable = (lastErr as { code?: unknown } | undefined)?.code === "feature_unavailable";
    if (report?.cost || i === 2 || unavailable) {
      return report ? { report } : { failed: lastErr instanceof Error ? lastErr.message : String(lastErr) };
    }
    await sleep(1000);
  }
}

/** Translates the SDK's stream of deltas into attempt events. */
function attemptDeltas(onEvent: (event: AttemptEvent) => void): NonNullable<SendOptions["onDelta"]> {
  return ({ update }) => {
    switch (update.type) {
      case "step-completed":
        onEvent({ type: "step" });
        break;
      case "text-delta":
        onEvent({ type: "text", delta: update.text });
        break;
      case "tool-call-started":
        onEvent({ type: "tool-call", tool: update.toolCall?.type ?? "unknown", callId: update.callId, args: (update.toolCall as { args?: unknown } | undefined)?.args ?? null });
        break;
      case "tool-call-completed": {
        const output = update.toolCall?.type === "shell" ? shellOutput(update.toolCall.result) : undefined;
        if (output !== undefined) onEvent({ type: "tool-output", tool: "shell", callId: update.callId, output });
        break;
      }
      case "summary-completed":
        onEvent({ type: "summary" });
        break;
      case "turn-ended":
        onEvent({ type: "turn", usage: update.usage });
        break;
    }
  };
}

/**
 * Cancels the SDK run in flight when the signal aborts, and remembers the cancellation so the attempt can wait for it. A
 * turn can arrive before `send()` hands the run back: the run is then cancelled as soon as it is bound.
 */
class RunCanceller {
  private run: Run | undefined;
  private cancelling: Promise<void> | undefined;

  constructor(private readonly signal: AbortSignal) {
    signal.addEventListener("abort", this.onAbort, { once: true });
  }

  private readonly onAbort = () => {
    if (this.run) this.cancelling ??= this.run.cancel().catch(() => {});
  };

  /** The SDK run in flight, or undefined between runs (a finished run has nothing left to cancel). */
  bind(run: Run | undefined): void {
    this.run = run;
    if (this.signal.aborted) this.onAbort();
  }

  /** Resolves once the run cancelled by the abort has stopped. */
  stopped(): Promise<void> {
    return this.cancelling ?? Promise.resolve();
  }

  dispose(): void {
    this.signal.removeEventListener("abort", this.onAbort);
  }
}

/** How a conversation talks to the agent of an attempt. */
export interface Exchange {
  /** Sends `message` and waits for the answer. */
  (message: string): Promise<RunResult>;
  /** Waits for the answer of a run that is already going (the one an interrupted attempt left on a reattached agent). */
  attach(run: Run): Promise<RunResult>;
}

/**
 * How a backend waits for a run to end: by default `run.wait()`. A backend whose wait can end without the run having ended (a
 * cloud run, whose client gives up after two hours) looks the run up again here and waits on what it finds. The run's
 * cancellation goes by ids, so cancelling the run `runAttempt` holds cancels the one found later too.
 */
export type SettleRun = (run: Run) => Promise<RunResult>;

/**
 * Runs one attempt around an agent, the same wherever the agent runs: creates it (an abort that arrives meanwhile disposes
 * it), reports it, hands `converse` the way to send a message and wait for the answer, and reports how the attempt ended.
 * Whatever the SDK throws once the signal is aborted is a consequence of the abort: the cause is the signal's reason. The
 * run an abort cancels is waited for before the usage is read and before anything else touches the agent's directory.
 */
export async function runAttempt(
  signal: AbortSignal,
  onEvent: (event: AttemptEvent) => void,
  createAgent: () => Promise<SDKAgent>,
  converse: (exchange: Exchange) => Promise<AttemptOutcome>,
  settle: SettleRun = (run) => run.wait(),
): Promise<AttemptResult> {
  const canceller = new RunCanceller(signal);
  const sendOpts: SendOptions = { onDelta: attemptDeltas(onEvent) };
  let agent: SDKAgent | undefined;
  let model: string | undefined;
  let outcome: AttemptOutcome;
  try {
    signal.throwIfAborted(); // no agent is created for an attempt that is already over
    const created = await within(signal, createAgent(), (late) => void late[Symbol.asyncDispose]().catch(() => {}));
    agent = created;
    onEvent({ type: "agent", agentId: created.agentId });
    signal.throwIfAborted();
    let answered = false;
    /** The answer of the run `getRun` hands back. An aborted attempt throws the signal's reason as soon as it knows, before anything else. */
    const answerOf = async (getRun: Promise<Run>): Promise<RunResult> => {
      const run = await within(signal, getRun, (late) => void late.cancel().catch(() => {}), SEND_GRACE_MS);
      canceller.bind(run);
      signal.throwIfAborted();
      try {
        const answer = await within(signal, settle(run));
        signal.throwIfAborted();
        if (!answered) model = answer.model?.id; // the first answer names the model the alias resolved to
        answered = true;
        return answer;
      } finally {
        canceller.bind(undefined); // finished or abandoned: an abort has nothing to cancel until the next send()
      }
    };
    /** One message and its answer. */
    const exchange: Exchange = Object.assign((message: string) => answerOf(sendWhenFree(created, message, sendOpts)), { attach: (run: Run) => answerOf(Promise.resolve(run)) });
    outcome = await converse(exchange);
  } catch (err) {
    outcome = signal.aborted ? { kind: "aborted", reason: signal.reason } : classifyError(err);
  }
  try {
    // Let the run cancelled by an abort stop before its usage is read and anything else touches the cwd. A timeout or an error also costs.
    await canceller.stopped();
    const usage = agent ? await readUsage(agent) : undefined;
    return { outcome, agentId: agent?.agentId, model, usage };
  } finally {
    canceller.dispose();
    if (agent) await agent[Symbol.asyncDispose]().catch(() => {});
  }
}

/** What a structured step's answer holds: the validated result, or why there is none and what to tell the agent. */
export type Delivery = { ok: true; value: unknown } | { ok: false; message: string; reprompt: string };

/**
 * Sends `message` and, for a structured step (`check` given), re-prompts in the SAME conversation, up to `schemaRetries`
 * times, until `check` accepts the answer. Says how the attempt ended. With `running`, the conversation starts from that run's
 * answer instead of sending `message`.
 */
export async function converse(
  exchange: Exchange,
  message: string,
  { schemaRetries, check, onEvent, running }: { schemaRetries: number; check?: (answer: RunResult) => Delivery | Promise<Delivery>; onEvent: (event: AttemptEvent) => void; running?: Run },
): Promise<AttemptOutcome> {
  // A reattached agent already has a run going: its answer is the first one, and `message` is not sent again.
  let answer = await (running ? exchange.attach(running) : exchange(message));
  // A run found by a lookup has no stream (no `onDelta`): its answer is all the attempt can log of what the agent said.
  if (running && answer.result) onEvent({ type: "text", delta: answer.result });
  // Only an answer of a run that finished has a result to check (a backend's check may call an API).
  const deliveryOf = (a: RunResult) => (check && a.status === "finished" ? check(a) : undefined);
  let delivery = await deliveryOf(answer);
  for (let tries = schemaRetries; delivery && !delivery.ok && answer.status === "finished" && tries > 0; tries--) {
    onEvent({ type: "reprompt", message: delivery.reprompt });
    answer = await exchange(delivery.reprompt);
    delivery = await deliveryOf(answer);
  }
  if (answer.status !== "finished") return { kind: "run-error", message: `run ${answer.status}: ${answer.error?.message ?? "no detail"}` };
  if (delivery && !delivery.ok) return { kind: "schema", message: delivery.message };
  return { kind: "finished", value: delivery ? delivery.value : (answer.result ?? "") };
}

/** Runs the attempt on this machine, in the step's cwd. */
async function runLocalAttempt(prompt: string, o: StepOptions, signal: AbortSignal, onEvent: (event: AttemptEvent) => void): Promise<AttemptResult> {
  // A structured step is answered through a custom tool, `submit_result`, that validates the object in this process.
  const capture: Capture = { value: undefined, submitted: false };
  const check = (): Delivery =>
    capture.submitted
      ? { ok: true, value: capture.value }
      : { ok: false, message: `the agent did not deliver a valid ${SUBMIT_TOOL} (${capture.lastError ?? "no call"})`, reprompt: repromptMessage(capture) };
  return runAttempt(
    signal,
    onEvent,
    () =>
      Agent.create({
        apiKey: o.apiKey,
        name: o.name,
        model: o.model,
        // Custom tools reach the model as the MCP server `custom-user-tools`: an allowlist without "mcp" would hide submit_result.
        tools: o.schema && o.tools && !o.tools.includes("mcp") ? [...o.tools, "mcp"] : o.tools,
        disallowedTools: o.disallowedTools,
        agents: o.agents,
        mcpServers: o.mcpServers,
        local: {
          cwd: o.cwd,
          settingSources: o.settingSources,
          sandboxOptions: o.sandbox ? { enabled: true } : undefined,
          customTools: o.schema ? { [SUBMIT_TOOL]: submitResultTool(o.schema, capture) } : undefined,
        },
      }),
    (exchange) => converse(exchange, o.schema ? prompt + schemaInstruction() : prompt, { schemaRetries: o.schemaRetries, check: o.schema ? check : undefined, onEvent }),
  );
}

/** Runs the agent on this machine, in the step's cwd. */
export const localBackend: AgentBackend = {
  location: "local",
  run: runLocalAttempt,
};
