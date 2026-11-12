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
// Today there is one backend, the local one: `Agent.create` with the SDK's `local` options. The cloud spec (#5) adds a
// second behind this same interface (ADR-0005). Tests substitute the SDK (test/fake-sdk.ts) or the backend itself
// (`RunOptions.backend`); the engine has no other way to reach an agent.
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
import type { TurnUsage } from "./events.js";
import { type Capture, SUBMIT_TOOL, repromptMessage, schemaInstruction, submitResultTool } from "./structured.js";
import type { AgentCallOptions } from "./workflow.js";

/** Where a step runs. The global cap `allowedLocations` decides which ones a run may use. */
export type StepLocation = "local" | "cloud";

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
  /** Re-prompts allowed, in the same conversation, when a structured step has not delivered a valid result. */
  schemaRetries: number;
}

/** What happens while an attempt runs. The engine counts and logs these; a backend only reports them. */
export type AttemptEvent =
  /** The agent exists. A token cap that was crossed while it was being created is applied now (see the contract above). */
  | { type: "agent"; agentId: string }
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
  | { type: "reprompt"; message: string };

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
}

export interface AgentBackend {
  readonly location: StepLocation;
  /** Runs one attempt of a step: see the contract at the top of this file. */
  run(prompt: string, options: StepOptions, signal: AbortSignal, onEvent: (event: AttemptEvent) => void): Promise<AttemptResult>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SDK error codes that are about the account, not the step. Trying again does not help. */
const ACCOUNT_ERROR_CODES = new Set(["plan_required"]);

function classifyError(err: unknown): Extract<AttemptOutcome, { kind: "error" }> {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && ACCOUNT_ERROR_CODES.has(code)) return { kind: "error", reason: "account", message, code };
  // A rate limit that is not retryable is the plan's usage cap (the SDK doc: "Usage limit exceeded"): trying again does not help.
  if (err instanceof RateLimitError) return { kind: "error", reason: err.isRetryable ? "rate-limit" : "usage-limit", message };
  return { kind: "error", reason: "other", message };
}

/** How long an abort waits for a `send()` already in flight to hand back its run, so the run can be cancelled and awaited. */
const SEND_GRACE_MS = 1000;

/**
 * Settles with `promise`, or rejects with the signal's reason as soon as it aborts. A value that arrives after the race
 * was given up goes to `late`, so an agent created too late is still disposed. The abort wins over a result that arrives
 * at the same time. With `graceMs`, an abort first waits that long for the value (a run that is about to be handed back
 * is cancelled by the caller, and waited for, instead of being left to stop on its own).
 */
async function within<T>(signal: AbortSignal, promise: Promise<T>, late?: (value: T) => void, graceMs = 0): Promise<T> {
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
 * The agent's usage and cost. The cost "may lag a little after the run ends" (SDK doc): it is read again when it comes back
 * empty. A local agent's usage can answer 403 `feature_unavailable` (it is rolled out per account): no point asking again.
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

/** Runs the attempt on this machine, in the step's cwd. */
async function runLocalAttempt(prompt: string, o: StepOptions, signal: AbortSignal, onEvent: (event: AttemptEvent) => void): Promise<AttemptResult> {
  // A structured step is answered through a custom tool, `submit_result`, that validates the object in this process.
  const capture: Capture = { value: undefined, submitted: false };
  const canceller = new RunCanceller(signal);
  const sendOpts: SendOptions = { onDelta: attemptDeltas(onEvent) };
  let agent: SDKAgent | undefined;
  let model: string | undefined;
  let outcome: AttemptOutcome;
  try {
    signal.throwIfAborted(); // no agent is created for an attempt that is already over
    const created = await within(
      signal,
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
      (late) => void late[Symbol.asyncDispose]().catch(() => {}),
    );
    agent = created;
    onEvent({ type: "agent", agentId: created.agentId });
    signal.throwIfAborted();
    /** One message and its answer. An aborted attempt throws the signal's reason as soon as it knows, before anything else. */
    const exchange = async (message: string): Promise<RunResult> => {
      const run = await within(signal, sendWhenFree(created, message, sendOpts), (late) => void late.cancel().catch(() => {}), SEND_GRACE_MS);
      canceller.bind(run);
      signal.throwIfAborted();
      try {
        const answer = await within(signal, run.wait());
        signal.throwIfAborted();
        return answer;
      } finally {
        canceller.bind(undefined); // finished or abandoned: an abort has nothing to cancel until the next send()
      }
    };
    let result = await exchange(o.schema ? prompt + schemaInstruction() : prompt);
    model = result.model?.id;
    // Structured output: re-prompt in the SAME conversation until the model calls submit_result with valid JSON.
    let schemaTries = o.schemaRetries;
    while (o.schema && result.status === "finished" && !capture.submitted && schemaTries-- > 0) {
      const message = repromptMessage(capture);
      onEvent({ type: "reprompt", message });
      result = await exchange(message);
    }
    if (result.status !== "finished") {
      outcome = { kind: "run-error", message: `run ${result.status}: ${result.error?.message ?? "no detail"}` };
    } else if (o.schema && !capture.submitted) {
      outcome = { kind: "schema", message: `the agent did not deliver a valid ${SUBMIT_TOOL} (${capture.lastError ?? "no call"})` };
    } else {
      outcome = { kind: "finished", value: o.schema ? capture.value : (result.result ?? "") };
    }
  } catch (err) {
    // Once the signal is aborted, whatever else the SDK throws is a consequence of it: the cause is the signal's reason.
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

/** Runs the agent on this machine, in the step's cwd. */
export const localBackend: AgentBackend = {
  location: "local",
  run: runLocalAttempt,
};
