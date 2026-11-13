// Seam 2, the AgentBackend interface, from the other side: the local backend called directly, the way the engine calls it,
// with the fake Cursor SDK underneath. It holds the contract the engine relies on (see backend.ts): events streamed through
// the callback, an abort that cancels the run in flight and reports the signal's reason, the usage read, the agent disposed.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { RateLimitError, calls, costConfig, script, stats } from "@cursor/sdk";
import { type AttemptEvent, type AttemptResult, type StepOptions, localBackend } from "../src/runtime/backend.js";
import { waitFor } from "./wait-for.js";

afterEach(() => {
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0, cancels: 0, cancelled: 0, turnsDelivered: 0, sends: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined, createHang: undefined, createDelayMs: undefined, createGate: undefined });
});

const options = (extra: Partial<StepOptions> = {}): StepOptions => ({
  name: "wf:step",
  model: { id: "m" },
  cwd: "/work",
  settingSources: ["project"],
  sandbox: false,
  schemaRetries: 2,
  ...extra,
});

/** Runs one attempt on the local backend and collects the events it streams. */
async function attempt(prompt: string, o: StepOptions, signal: AbortSignal = new AbortController().signal, onEvent?: (e: AttemptEvent) => void) {
  const events: AttemptEvent[] = [];
  const result = await localBackend.run(prompt, o, signal, (e) => {
    events.push(e);
    onEvent?.(e);
  });
  return { result, events };
}

const outcomeOf = (r: AttemptResult) => r.outcome;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A turn that used `tokens` tokens in all (10 of them output). */
const turn = (tokens: number) => ({ type: "turn-ended", usage: { inputTokens: tokens - 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } });

test("an attempt streams the agent's activity through the callback, in order, and reports the answer, the agent, the model and the usage", async () => {
  script.push(() => ({
    result: "the answer",
    deltas: [
      { type: "text-delta", text: "thin" },
      { type: "text-delta", text: "king" },
      { type: "tool-call-started", callId: "c1", toolCall: { type: "shell", args: { command: "ls" } } },
      { type: "tool-call-completed", callId: "c1", toolCall: { type: "shell", result: { status: "success", value: { exitCode: 0, stdout: "a.ts\n", stderr: "warn" } } } },
      { type: "step-completed", stepId: 1 },
      { type: "summary-completed" },
      turn(110),
    ],
  }));
  const { result, events } = await attempt("do it", options());

  assert.deepEqual(events, [
    { type: "agent", agentId: "agent-1" },
    { type: "text", delta: "thin" },
    { type: "text", delta: "king" },
    { type: "tool-call", tool: "shell", callId: "c1", args: { command: "ls" } },
    { type: "tool-output", tool: "shell", callId: "c1", output: "exit 0\na.ts\n\n[stderr]\nwarn" },
    { type: "step" },
    { type: "summary" },
    { type: "turn", usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  ]);
  assert.deepEqual(outcomeOf(result), { kind: "finished", value: "the answer" });
  assert.equal(result.agentId, "agent-1");
  assert.deepEqual(result.model, "m");
  assert.ok(result.usage && "report" in result.usage);
  assert.deepEqual([result.usage.report.cost?.chargedCents, result.usage.report.cost?.rawCostCents, result.usage.report.usage.totalTokens], [7, 9, 110]);
  assert.equal(stats.disposed, 1, "the agent is disposed before the attempt reports");
  assert.deepEqual([calls[0].name, calls[0].model, calls[0].local.cwd, calls[0].local.settingSources, calls[0].local.sandboxOptions], ["wf:step", { id: "m" }, "/work", ["project"], undefined]);
});

test("the resolved options become the SDK agent's: allowlists, sandbox and an apiKey", async () => {
  await attempt("p", options({ apiKey: "k", tools: ["read"], disallowedTools: ["shell"], sandbox: true, mcpServers: { x: { command: "x" } as never } }));
  const [created] = calls;
  assert.equal(created.apiKey, "k");
  assert.deepEqual(created.tools, ["read"]);
  assert.deepEqual(created.disallowedTools, ["shell"]);
  assert.deepEqual(created.local.sandboxOptions, { enabled: true });
  assert.deepEqual(Object.keys(created.mcpServers), ["x"]);
});

test("a structured step is answered through the submit_result tool: the allowlist gains 'mcp', and the validated object comes back", async () => {
  const schema = { type: "object", required: ["tier"], properties: { tier: { enum: ["LOW", "MED"] } } };
  script.push((o: any) => {
    o.local.customTools.submit_result.execute({ tier: "MED" }, {});
    return {};
  });
  const { result, events } = await attempt("classify", options({ schema, tools: ["read"] }));

  assert.deepEqual(outcomeOf(result), { kind: "finished", value: { tier: "MED" } });
  assert.deepEqual(calls[0].tools, ["read", "mcp"]);
  assert.equal(events.some((e) => e.type === "reprompt"), false);
});

test("a structured step that does not call submit_result is re-prompted in the same conversation, up to schemaRetries, then reported as a schema failure", async () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };
  const { result, events } = await attempt("classify", options({ schema, schemaRetries: 1 }));

  assert.equal(stats.sends, 2, "the first message and one re-prompt");
  assert.equal(calls.length, 1, "same agent, same conversation");
  const reprompts = events.flatMap((e) => (e.type === "reprompt" ? [e.message] : []));
  assert.equal(reprompts.length, 1);
  assert.match(reprompts[0]!, /You did not call submit_result/);
  assert.deepEqual(outcomeOf(result), { kind: "schema", message: "the agent did not deliver a valid submit_result (no call)" });
  assert.ok(result.usage, "the agent existed, so its usage is reported");
});

test("an agent run that ends without finishing is reported as a run error", async () => {
  script.push(() => ({ status: "error", error: { message: "boom" } }));
  const { result } = await attempt("p", options());
  assert.deepEqual(outcomeOf(result), { kind: "run-error", message: "run error: boom" });
});

test("aborting cancels the run in flight, waits for it to stop, reads the usage, disposes the agent and reports the signal's reason", async () => {
  script.push(() => ({ hang: true, cancelDelayMs: 40 }));
  const controller = new AbortController();
  const reason = new Error("stop now");
  setTimeout(() => controller.abort(reason), 20);
  const { result } = await attempt("p", options(), controller.signal);

  assert.deepEqual(outcomeOf(result), { kind: "aborted", reason });
  assert.equal(stats.cancelled, 1, "the run was cancelled, and the attempt waited for the (slow) cancellation to finish");
  assert.equal(stats.disposed, 1);
  assert.equal(stats.usageReads, 1, "what the aborted attempt used is still reported");
  assert.equal(result.agentId, "agent-1");
  assert.ok(result.usage && "report" in result.usage);
});

test("aborting from inside the callback, on a turn, cancels the run at once: no further turn is delivered", async () => {
  script.push(() => ({ live: true, result: "ok", deltas: [turn(100), turn(100), turn(100), turn(100)] }));
  const controller = new AbortController();
  const reason = new Error("cap");
  const { result } = await attempt("p", options(), controller.signal, (e) => e.type === "turn" && controller.abort(reason));

  assert.deepEqual(outcomeOf(result), { kind: "aborted", reason });
  assert.equal(stats.turnsDelivered, 1, "cancelled on the spot, not after the run");
  assert.equal(stats.cancels, 1);
  assert.equal(stats.disposed, 1);
});

test("a signal aborted while the agent is being created ends the attempt at once, and the agent that arrives late is disposed", async () => {
  costConfig.createDelayMs = 200;
  const controller = new AbortController();
  const reason = new Error("run cancelled");
  setTimeout(() => controller.abort(reason), 10);
  const startedAt = Date.now();
  const { result, events } = await attempt("p", options(), controller.signal);

  assert.ok(Date.now() - startedAt < 150, "the attempt did not wait for the creation");
  assert.deepEqual(outcomeOf(result), { kind: "aborted", reason });
  assert.equal(result.agentId, undefined);
  assert.equal(result.usage, undefined, "no agent existed: nothing was used");
  assert.deepEqual(events, [], "no agent, no events");
  assert.equal(stats.disposed, 0);
  await waitFor("the agent that arrived late to be disposed", () => stats.disposed >= 1);
  assert.equal(stats.disposed, 1, "the agent that arrived late was disposed, not left running");
  assert.equal(stats.sends, 0);
});

test("a signal aborted while send() is still handing back the run waits for that run, cancels it and waits for the cancellation before reading the usage", async () => {
  script.push(async () => {
    await wait(60); // send() takes a while to hand the run back
    return { hang: true, cancelDelayMs: 40 };
  });
  const controller = new AbortController();
  const reason = new Error("cap crossed by another step");
  setTimeout(() => controller.abort(reason), 15);
  const { result } = await attempt("p", options(), controller.signal);

  assert.deepEqual(outcomeOf(result), { kind: "aborted", reason });
  assert.equal(stats.cancelled, 1, "the run that came back late was cancelled, and the attempt waited for it to stop");
  assert.equal(stats.usageReads, 1, "the usage was read after the run stopped, not while it was still running");
  assert.equal(stats.disposed, 1);
});

test("a send() that never hands back a run does not hold the attempt: it ends after a short grace, and the run that arrives late is cancelled", async () => {
  script.push(async () => {
    await wait(1400);
    return { hang: true };
  });
  const controller = new AbortController();
  const reason = new Error("timeout after 20 ms");
  setTimeout(() => controller.abort(reason), 20);
  const startedAt = Date.now();
  const { result } = await attempt("p", options(), controller.signal);

  assert.deepEqual(outcomeOf(result), { kind: "aborted", reason });
  assert.ok(Date.now() - startedAt < 1250, "the attempt gave up on the send after the grace instead of waiting for it");
  await waitFor("the run that arrived late to be cancelled", () => stats.cancelled >= 1);
  assert.equal(stats.cancelled, 1, "the run that arrived late was cancelled, not left running");
});

test("a signal aborted as soon as the agent is reported stops the attempt before it sends anything", async () => {
  const controller = new AbortController();
  const reason = new Error("cap held back until the agent existed");
  const { result } = await attempt("p", options(), controller.signal, (e) => e.type === "agent" && controller.abort(reason));

  assert.deepEqual(outcomeOf(result), { kind: "aborted", reason });
  assert.equal(stats.sends, 0);
  assert.equal(stats.disposed, 1);
  assert.ok(result.usage, "the agent existed, so its usage is read");
});

test("a signal that is already aborted creates no agent", async () => {
  const controller = new AbortController();
  const reason = new Error("already");
  controller.abort(reason);
  const { result, events } = await attempt("p", options(), controller.signal);
  assert.deepEqual(outcomeOf(result), { kind: "aborted", reason });
  assert.equal(calls.length, 0);
  assert.deepEqual(events, []);
});

test("SDK failures are classified for the engine's retry policy: account, usage cap, rate limit, other", async () => {
  costConfig.createErrorCode = "plan_required";
  const account = await attempt("p", options());
  assert.deepEqual(outcomeOf(account.result), { kind: "error", reason: "account", code: "plan_required", message: "[plan_required] Cloud Agent is not available for free users. Please upgrade to Pro." });
  assert.equal(account.result.usage, undefined, "no agent, no usage");
  costConfig.createErrorCode = undefined;

  script.push(() => ({ live: true, deltas: [], rejectWait: new RateLimitError("Usage limit exceeded") })); // not retryable: the plan's cap
  const cap = await attempt("p", options());
  assert.deepEqual(outcomeOf(cap.result), { kind: "error", reason: "usage-limit", message: "Usage limit exceeded" });
  assert.ok(cap.result.usage, "the agent existed, so its usage is read");
  assert.equal(stats.disposed, 1);

  script.push(() => ({ live: true, deltas: [], rejectWait: Object.assign(new RateLimitError("slow down"), { isRetryable: true }) }));
  const throttle = await attempt("p", options());
  assert.deepEqual(outcomeOf(throttle.result), { kind: "error", reason: "rate-limit", message: "slow down" });

  script.push(() => ({ live: true, deltas: [], rejectWait: new Error("socket hang up") }));
  const other = await attempt("p", options());
  assert.deepEqual(outcomeOf(other.result), { kind: "error", reason: "other", message: "socket hang up" });
});

test("a usage that cannot be read is reported as such, with the reason, instead of failing the attempt", async () => {
  costConfig.getUsageError = "403 feature_unavailable";
  const { result } = await attempt("p", options());
  assert.deepEqual(outcomeOf(result), { kind: "finished", value: "ok" });
  assert.deepEqual(result.usage, { failed: "403 feature_unavailable" });
  assert.equal(stats.usageReads, 1, "feature_unavailable is not asked again");
});

test("a cost that Cursor has not reported yet is asked for again before the attempt gives up on it", async () => {
  costConfig.raw = undefined;
  const { result } = await attempt("p", options());
  assert.ok(result.usage && "report" in result.usage);
  assert.equal(result.usage.report.cost, undefined);
  assert.equal(stats.usageReads, 3, "three reads, a second apart");
});
