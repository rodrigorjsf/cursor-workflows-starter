// Seam 2, the AgentBackend interface: `runWorkflow` with a backend handed in through `RunOptions.backend`, so the engine is
// exercised without the Cursor SDK in the picture (the fake SDK is only there to prove it is never touched). The backend
// takes the prompt, the step's resolved options and an abort signal, streams events through a callback and reports how the
// attempt ended. Assertions are on the outcome, the replayed event log and what the backend was handed.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { calls as sdkCalls } from "@cursor/sdk";
import type { AgentBackend, AttemptEvent, AttemptResult, StepOptions } from "../src/runtime/backend.js";
import { BudgetExceededError, RunCancelledError, runWorkflow } from "../src/runtime/engine.js";
import type { WorkflowEvent } from "../src/runtime/events.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { type AgentCallOptions, defineWorkflow } from "../src/runtime/workflow.js";
import { clearConfig, configWorkflow, writeGlobalConfig, writeRepoConfig } from "./config-fixtures.js";

const cwd = join(import.meta.dirname, ".tmp", `backend-${process.pid}`);
afterEach(() => {
  clearConfig(cwd);
  rmSync(cwd, { recursive: true, force: true });
  sdkCalls.length = 0;
});

/** What a backend was handed for one attempt. */
interface Handed {
  prompt: string;
  options: StepOptions;
  signal: AbortSignal;
}
type Behaviour = (handed: Handed & { onEvent: (e: AttemptEvent) => void }) => AttemptResult | Promise<AttemptResult>;

/** A backend that answers each attempt with the next behaviour (the last one repeats) and records what it was handed. */
function stubBackend(...behaviours: Behaviour[]) {
  const handed: Handed[] = [];
  const backend: AgentBackend = {
    location: "local",
    async run(prompt, options, signal, onEvent) {
      handed.push({ prompt, options, signal });
      const behave = behaviours.length > 1 ? behaviours.shift()! : behaviours[0]!;
      return behave({ prompt, options, signal, onEvent });
    },
  };
  return { backend, handed };
}

const USAGE = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 20, totalTokens: 110 };
const report = { usage: USAGE, cost: { chargedCents: 3, rawCostCents: 5 }, runs: [] };
const finished = (value: unknown): Behaviour => () => ({ outcome: { kind: "finished", value }, agentId: "agent-1", model: "m-resolved", usage: { report } });

const model = { id: "m" };
const oneStep = (opts: AgentCallOptions = {}) =>
  defineWorkflow({
    meta: { name: "wf", description: "one step" },
    defaults: { model },
    run: (ctx) => ctx.agent("hello", { label: "greet", ...opts }),
  });

type StepEnd = Extract<WorkflowEvent, { type: "step-end" }>;
const logOf = (runId: string) => readEventLog(eventLogPath(cwd, runId)).events;
const stepEnds = (events: WorkflowEvent[]) => events.filter((e): e is StepEnd => e.type === "step-end");

test("a step runs through the backend: prompt, resolved options and a live signal go in; value, turns and cost come out", async () => {
  const { backend, handed } = stubBackend(({ onEvent }) => {
    onEvent({ type: "step" });
    onEvent({ type: "tool-call", tool: "read", callId: "c1", args: { path: "a.ts" } });
    onEvent({ type: "step" });
    onEvent({ type: "turn", usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 20 } });
    return { outcome: { kind: "finished", value: "hi" }, agentId: "agent-1", model: "m-resolved", usage: { report } };
  });
  const r = await runWorkflow(oneStep({ tools: ["read"], settingSources: [] }), {}, { cwd, backend, apiKey: "k" });

  assert.equal(r.status, "finished", r.error);
  assert.equal(r.result, "hi");
  assert.equal(sdkCalls.length, 0, "no SDK agent was created: the engine only talked to the backend");

  assert.equal(handed.length, 1);
  assert.equal(handed[0]!.prompt, "hello");
  assert.equal(handed[0]!.signal.aborted, false);
  const o = handed[0]!.options;
  assert.equal(o.name, "wf:greet");
  assert.deepEqual(o.model, model);
  assert.equal(o.cwd, cwd);
  assert.equal(o.apiKey, "k");
  assert.deepEqual(o.tools, ["read"]);
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.sandbox, false);
  assert.equal(o.schema, undefined);

  const events = logOf(r.runId);
  const turns = events.filter((e) => e.type === "turn");
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0]!.type === "turn" && [turns[0]!.idx, turns[0]!.steps, turns[0]!.usage.inputTokens], [0, 2, 100]);
  const [end] = stepEnds(events);
  assert.equal(end!.ok, true);
  assert.equal(end!.agentId, "agent-1");
  assert.equal(end!.resolvedModel, "m-resolved");
  assert.deepEqual([end!.turns, end!.steps, end!.toolCalls], [1, 2, { read: 1 }]);
  assert.equal(end!.chargedCents, 3);
  assert.equal(end!.usage?.totalTokens, 110);
  const call = events.find((e) => e.type === "content" && e.kind === "tool-call");
  assert.ok(call && call.type === "content" && call.text === '{"path":"a.ts"}' && call.tool === "read" && call.callId === "c1");

  assert.equal(r.spentCents, 5, "the cap counts the larger of raw (5) and charged (3)");
  assert.equal(r.chargedCents, 3);
  assert.equal(r.spentTokens, 110);
  assert.equal(r.usage.cacheReadTokens, 60);
});

/** The usage report of an attempt that used `tokens` tokens in all (10 of them output), at no reported cost. */
const usedTokens = (tokens: number) => ({ report: { usage: { inputTokens: tokens - 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: tokens }, runs: [] } });
const turn = (tokens: number): AttemptEvent => ({ type: "turn", usage: { inputTokens: tokens - 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } });
const nextMacrotask = () => new Promise((resolve) => setImmediate(resolve));
/** What a backend does for an attempt that streams turns of `tokens` tokens until it is aborted, as an agent that never finishes would. */
const streamsUntilAborted =
  (tokens: number, seen: { turns: number; reason?: unknown } = { turns: 0 }): Behaviour =>
  async ({ signal, onEvent }) => {
    while (!signal.aborted) {
      await nextMacrotask();
      if (signal.aborted) break;
      seen.turns++;
      onEvent(turn(tokens));
    }
    seen.reason = signal.reason;
    return { outcome: { kind: "aborted", reason: signal.reason }, agentId: "agent-x", usage: usedTokens(seen.turns * tokens) };
  };

test("the step's token cap works through the backend: the turn that crosses it aborts the signal with the cap's error, and the step is not retried", async () => {
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { maxTokensPerStep: 250, retries: 3 } } } } });
  const seen = { turns: 0, reason: undefined as unknown };
  const { backend, handed } = stubBackend(streamsUntilAborted(100, seen));
  const r = await runWorkflow(configWorkflow((ctx) => ctx.agent("p", { role: "classify", label: "c" })), {}, { cwd, backend });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /Step token cap reached for step "c": 300 of 250/);
  assert.equal(handed.length, 1, "retries is 3, but a budget failure is not retried");
  assert.equal(seen.turns, 3, "the backend was stopped at the turn that crossed the cap");
  assert.ok(seen.reason instanceof Error && /Step token cap reached/.test(seen.reason.message), "the signal's reason is the cap's error");
  const [end] = stepEnds(logOf(r.runId));
  assert.equal(end!.errorKind, "budget");
  assert.equal(end!.usage?.totalTokens, 300, "what the step used before it was cut still counts");
  assert.equal(r.spentTokens, 300);
});

test("the run's token cap works through the backend: the turn that crosses it aborts every active attempt", async () => {
  const bHanded = Promise.withResolvers<void>();
  const seenA = { turns: 0, reason: undefined as unknown };
  const seenB = { turns: 0, reason: undefined as unknown };
  const { backend } = stubBackend(async (h) => {
    if (h.prompt === "b") bHanded.resolve();
    else await bHanded.promise; // a streams only once b is inside its attempt
    return streamsUntilAborted(100, h.prompt === "a" ? seenA : seenB)(h);
  });
  const wf = configWorkflow((ctx) => ctx.parallel([() => ctx.agent("a", { role: "classify", label: "a", retries: 0 }), () => ctx.agent("b", { role: "classify", label: "b", retries: 0 })]));
  const r = await runWorkflow(wf, {}, { cwd, backend, maxTokens: 250 });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /^Token cap reached: 300 of 250\.$/, "the turns of both attempts, live");
  for (const reason of [seenA.reason, seenB.reason]) assert.ok(reason instanceof BudgetExceededError, "both attempts were aborted with the run's budget error");
  assert.equal(r.spentTokens, 300, "what the aborted attempts used is in the run's total");
  assert.deepEqual(stepEnds(logOf(r.runId)).map((e) => e.errorKind), ["budget", "budget"]);
});

test("a token cap crossed while the backend is still creating the agent is held back until the agent exists, then applied", async () => {
  const bHanded = Promise.withResolvers<void>();
  const capCrossed = Promise.withResolvers<void>();
  const seenB: { before?: boolean; after?: boolean } = {};
  const { backend } = stubBackend(async (h) => {
    if (h.prompt === "b") {
      bHanded.resolve();
      await capCrossed.promise; // b's agent is still being created while a crosses the cap
      seenB.before = h.signal.aborted;
      h.onEvent({ type: "agent", agentId: "agent-b" });
      seenB.after = h.signal.aborted;
      return { outcome: { kind: "aborted", reason: h.signal.reason }, agentId: "agent-b", usage: usedTokens(0) };
    }
    await bHanded.promise;
    await nextMacrotask();
    h.onEvent(turn(100));
    h.onEvent(turn(100)); // 200 > 150
    capCrossed.resolve();
    return { outcome: { kind: "aborted", reason: h.signal.reason }, agentId: "agent-a", usage: usedTokens(200) };
  });
  const wf = configWorkflow((ctx) => ctx.parallel([() => ctx.agent("a", { role: "classify", label: "a", retries: 0 }), () => ctx.agent("b", { role: "classify", label: "b", retries: 0 })]));
  const r = await runWorkflow(wf, {}, { cwd, backend, maxTokens: 150 });

  assert.equal(r.status, "failed");
  assert.deepEqual(seenB, { before: false, after: true }, "not aborted while creating; aborted the moment the agent was reported");
  const ends = Object.fromEntries(stepEnds(logOf(r.runId)).map((e) => [e.label, e]));
  assert.deepEqual([ends.b!.ok, ends.b!.errorKind, ends.b!.agentId, ends.b!.usage?.totalTokens], [false, "budget", "agent-b", 0], "b's agent existed, so its usage was read and charged");
});

test("cancelling the run aborts the attempt's signal with the cancellation as its reason, and the run stays resumable", async () => {
  const controller = new AbortController();
  const seen: { reason?: unknown } = {};
  const { backend, handed } = stubBackend(async ({ signal }) => {
    setTimeout(() => controller.abort(), 10);
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    seen.reason = signal.reason;
    return { outcome: { kind: "aborted", reason: signal.reason }, agentId: "agent-1", usage: { report } };
  }, finished("done"));
  const wf = oneStep({ retries: 0 });
  const outcome = await runWorkflow(wf, {}, { cwd, runId: "r1", backend, signal: controller.signal });

  assert.equal(outcome.status, "cancelled");
  assert.match(outcome.error!, /resumeRunId="r1"/);
  assert.ok(seen.reason instanceof RunCancelledError);
  const [end] = stepEnds(logOf("r1"));
  assert.deepEqual([end!.ok, end!.errorKind, end!.agentId], [false, "cancelled", "agent-1"]);

  const resumed = await runWorkflow(wf, {}, { cwd, runId: "r1", backend });
  assert.equal(resumed.status, "finished");
  assert.equal(resumed.result, "done");
  assert.equal(handed.length, 2);
  assert.equal(resumed.spentCents, 10, "the cancelled attempt's 5 cents plus the new one's 5");
});

test("a signal that is already aborted starts no attempt", async () => {
  const controller = new AbortController();
  controller.abort();
  const { backend, handed } = stubBackend(finished("never"));
  const outcome = await runWorkflow(oneStep(), {}, { cwd, backend, signal: controller.signal });
  assert.equal(outcome.status, "cancelled");
  assert.equal(handed.length, 0);
});

test("the step's timeout aborts the attempt's signal with a timeout as its reason", async () => {
  const seen: { reason?: unknown } = {};
  const { backend } = stubBackend(async ({ signal }) => {
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    seen.reason = signal.reason;
    return { outcome: { kind: "aborted", reason: signal.reason }, agentId: "agent-1", usage: { report } };
  });
  const r = await runWorkflow(oneStep({ timeoutMs: 50, retries: 0 }), {}, { cwd, backend });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /timeout after 50 ms/);
  assert.ok(seen.reason instanceof Error && /^timeout after 50 ms$/.test(seen.reason.message));
  const [end] = stepEnds(logOf(r.runId));
  assert.equal(end!.errorKind, "timeout");
  assert.equal(r.spentCents, 5, "a timed-out attempt is charged too");
});

test("an attempt that ends without finishing is retried, and every attempt is charged", async () => {
  const { backend, handed } = stubBackend(
    () => ({ outcome: { kind: "run-error", message: "run error: boom" }, agentId: "agent-1", usage: { report } }),
    finished("second time lucky"),
  );
  const r = await runWorkflow(oneStep(), {}, { cwd, backend });

  assert.equal(r.status, "finished", r.error);
  assert.equal(r.result, "second time lucky");
  assert.equal(handed.length, 2);
  assert.deepEqual(stepEnds(logOf(r.runId)).map((e) => [e.attempt, e.ok, e.errorKind, e.error]), [[1, false, "run-error", "run error: boom"], [2, true, undefined, undefined]]);
  assert.equal(r.spentCents, 10);
});

test("a structured step that never delivers fails as 'schema', and the re-prompts the backend sent are counted and logged", async () => {
  const { backend } = stubBackend(({ onEvent }) => {
    onEvent({ type: "reprompt", message: "call submit_result now" });
    return { outcome: { kind: "schema", message: "the agent did not deliver a valid submit_result (no call)" }, agentId: "agent-1", usage: { report } };
  });
  const r = await runWorkflow(oneStep({ retries: 0, schema: { type: "object" } }), {}, { cwd, backend });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /failed after 1 attempt\(s\): the agent did not deliver a valid submit_result/);
  const events = logOf(r.runId);
  const [end] = stepEnds(events);
  assert.deepEqual([end!.errorKind, end!.schemaReprompts], ["schema", 1]);
  const prompts = events.flatMap((e) => (e.type === "content" && e.kind === "prompt" ? [e.text] : []));
  assert.deepEqual(prompts, ["hello", "call submit_result now"]);
});

test("a step's schema and re-prompt allowance reach the backend resolved", async () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };
  const { backend, handed } = stubBackend(finished({ a: "x" }));
  const r = await runWorkflow(oneStep({ schema, schemaRetries: 5 }), {}, { cwd, backend });
  assert.deepEqual(r.result, { a: "x" });
  assert.deepEqual(handed[0]!.options.schema, schema);
  assert.equal(handed[0]!.options.schemaRetries, 5);

  const defaults = stubBackend(finished({ a: "x" }));
  await runWorkflow(oneStep({ schema }), {}, { cwd, backend: defaults.backend });
  assert.equal(defaults.handed[0]!.options.schemaRetries, 2, "two re-prompts unless the step says otherwise");
});

test("an account error ends the run without a retry, and a plan's usage cap ends it as a budget error", async () => {
  const account = stubBackend(() => ({ outcome: { kind: "error", reason: "account", code: "plan_required", message: "[plan_required] not available for free users" } }));
  const a = await runWorkflow(oneStep(), {}, { cwd, backend: account.backend });
  assert.equal(a.status, "failed");
  assert.match(a.error!, /does not give access to the Cursor SDK \(plan_required\): \[plan_required\] not available for free users/);
  assert.equal(account.handed.length, 1, "retries is 1, but trying again does not help");
  assert.equal(stepEnds(logOf(a.runId))[0]!.errorKind, "exception");

  const cap = stubBackend(() => ({ outcome: { kind: "error", reason: "usage-limit", message: "Usage limit exceeded" }, agentId: "agent-1", usage: { report } }));
  const b = await runWorkflow(oneStep(), {}, { cwd, backend: cap.backend });
  assert.equal(b.status, "failed");
  assert.match(b.error!, /^Cursor usage limit reached: Usage limit exceeded$/);
  assert.equal(cap.handed.length, 1);
  assert.equal(stepEnds(logOf(b.runId))[0]!.errorKind, "rate-limit");
});

test("when the backend could not read the usage, the tokens come from the turn events and the cost is unknown", async () => {
  const events: WorkflowEvent[] = [];
  const { backend } = stubBackend(({ onEvent }) => {
    onEvent(turn(110));
    return { outcome: { kind: "finished", value: "ok" }, agentId: "agent-1", usage: { failed: "403 feature_unavailable" } };
  });
  const r = await runWorkflow(oneStep(), {}, { cwd, backend, onEvent: (e) => events.push(e) });

  assert.equal(r.status, "finished", r.error);
  assert.equal(r.spentTokens, 110);
  assert.equal(r.spentCents, 0);
  assert.ok(events.some((e) => e.type === "warning" && /^getUsage\(\) failed \(403 feature_unavailable\)/.test(e.message)));
});

test("a backend that throws instead of reporting fails the attempt without taking the engine down", async () => {
  const { backend } = stubBackend(() => {
    throw new Error("backend bug");
  });
  const r = await runWorkflow(oneStep({ retries: 0 }), {}, { cwd, backend });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /failed after 1 attempt\(s\): backend bug/);
  assert.equal(stepEnds(logOf(r.runId))[0]!.errorKind, "exception");
});

test("the global allowedLocations cap is checked against the backend's location", async () => {
  writeGlobalConfig({ caps: { allowedLocations: ["cloud"] } });
  const { backend, handed } = stubBackend(finished("never"));
  const r = await runWorkflow(oneStep(), {}, { cwd, backend });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /allowedLocations cap \(cloud\) does not allow local steps/);
  assert.equal(handed.length, 0);
});
