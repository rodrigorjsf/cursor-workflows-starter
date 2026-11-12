// Seam 1, the run: `runWorkflow` with the fake Cursor SDK. The per-step token cap and the run's cumulative token cap are
// enforced on every turn while a step runs, not after it: crossing either cancels the agent run at once, so the overshoot
// is at most the turn that crossed. The fake's `live` runs stream their turns after `send()` returns and stop delivering
// when cancelled, as the real SDK does. Assertions are on the outcome, the replayed event log and what the SDK was asked.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { calls, costConfig, script, stats } from "@cursor/sdk";
import { runWorkflow } from "../src/runtime/engine.js";
import type { WorkflowEvent } from "../src/runtime/events.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { clearConfig, configWorkflow, writeGlobalConfig, writeRepoConfig } from "./config-fixtures.js";

const cwd = join(import.meta.dirname, ".tmp", `live-caps-${process.pid}`);
afterEach(() => {
  clearConfig(cwd);
  rmSync(cwd, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0, cancels: 0, turnsDelivered: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined });
});

/** One finished turn that used `tokens` tokens in all (10 of them output). */
const turn = (tokens: number) => ({ type: "turn-ended", usage: { inputTokens: tokens - 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } });
/** A send() that streams `count` turns of `tokens` tokens each, until the run is cancelled. */
const live = (count: number, tokens: number) => () => ({ live: true, result: "ok", deltas: Array.from({ length: count }, () => turn(tokens)) });

type StepEnd = Extract<WorkflowEvent, { type: "step-end" }>;
const stepEnds = (events: WorkflowEvent[]) => events.filter((e): e is StepEnd => e.type === "step-end");
const logOf = (runId: string) => readEventLog(eventLogPath(cwd, runId)).events;

test("a step that crosses its per-step cap during a turn is cancelled on the spot, fails as 'budget' and is not retried", async () => {
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { maxTokensPerStep: 250, retries: 3 } } } } });
  script.push(live(10, 100), live(10, 100), live(10, 100), live(10, 100));
  const wf = configWorkflow((ctx) => ctx.agent("p", { role: "classify", label: "c" }));
  const r = await runWorkflow(wf, {}, { cwd });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /Teto de tokens da etapa "c" atingido: 300 de 250/);
  assert.equal(calls.length, 1, "retries is 3, but a budget failure is not retried: one agent only");
  assert.equal(stats.cancels, 1, "the agent run was cancelled");
  assert.equal(stats.disposed, 1);

  const ends = stepEnds(logOf(r.runId));
  assert.equal(ends.length, 1);
  assert.equal(ends[0]!.ok, false);
  assert.equal(ends[0]!.errorKind, "budget");
  assert.equal(ends[0]!.usage?.totalTokens, 300, "what the step used before it was cut still counts");
  assert.equal(r.spentTokens, 300);
});

/** A send() for one step by its label (the agent is named `<workflow>:<label>`), so parallel steps need no send order. */
const byLabel = (plan: Record<string, ReturnType<typeof live>>) => (o: any, msg: string, n: number) => plan[o.name.split(":")[1]]!(o, msg, n);

test("a step cut by its own cap fails alone: the run goes on, as it does for any failed step", async () => {
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { maxTokensPerStep: 250 } } } } });
  for (let i = 0; i < 2; i++) script.push(byLabel({ runaway: live(10, 100), fine: live(2, 100) }));
  const events: WorkflowEvent[] = [];
  const wf = configWorkflow((ctx) => ctx.parallel([() => ctx.agent("a", { role: "classify", label: "runaway" }), () => ctx.agent("b", { role: "review", label: "fine" })]));
  const r = await runWorkflow(wf, {}, { cwd, onEvent: (e) => events.push(e) });

  assert.equal(r.status, "finished", r.error);
  assert.deepEqual(r.result, [null, "ok"], "the runaway step came back as the null of a failed parallel branch");
  assert.ok(events.some((e) => e.type === "warning" && /Teto de tokens da etapa "runaway" atingido/.test(e.message)));
  const ends = Object.fromEntries(stepEnds(logOf(r.runId)).map((e) => [e.label, e]));
  assert.equal(ends.runaway!.errorKind, "budget");
  assert.equal(ends.fine!.ok, true, "the other step was not touched");
  assert.equal(stats.turnsDelivered, 3 + 2);
});

test("the overshoot is bounded by one turn: the turn that crosses the cap is the last one the step is paid for", async () => {
  for (const { cap, turnTokens } of [{ cap: 250, turnTokens: 100 }, { cap: 300, turnTokens: 100 }, { cap: 99, turnTokens: 100 }, { cap: 1000, turnTokens: 330 }]) {
    writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { maxTokensPerStep: cap, retries: 0 } } } } });
    script.length = 0;
    Object.assign(stats, { cancels: 0, turnsDelivered: 0 });
    script.push(live(50, turnTokens));
    const r = await runWorkflow(configWorkflow((ctx) => ctx.agent("p", { role: "classify", label: "c" })), {}, { cwd });

    const spent = r.spentTokens;
    const turnsPaid = Math.floor(cap / turnTokens) + 1; // the first turn that takes the total strictly above the cap
    assert.equal(r.status, "failed");
    assert.equal(stats.turnsDelivered, turnsPaid, `cap ${cap}, turns of ${turnTokens}: the step was cut at turn ${turnsPaid} of 50`);
    assert.equal(spent, turnsPaid * turnTokens);
    assert.ok(spent > cap && spent - cap <= turnTokens, `cap ${cap}: spent ${spent}, overshoot ${spent - cap} is at most one turn (${turnTokens})`);
  }
});

test("a step with no per-step cap runs to its end: null and absent both mean no cap", async () => {
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { maxTokensPerStep: null } } } } });
  script.push(live(10, 100));
  const r = await runWorkflow(configWorkflow((ctx) => ctx.agent("p", { role: "classify", label: "c" })), {}, { cwd });
  assert.equal(r.status, "finished", r.error);
  assert.equal(stats.turnsDelivered, 10);
  assert.equal(stats.cancels, 0);
  assert.equal(r.spentTokens, 1000);
});

test("the step's cap covers all its attempts: a retry does not get a fresh allowance", async () => {
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { maxTokensPerStep: 250, retries: 1 } } } } });
  script.push(() => ({ live: true, deltas: [turn(100), turn(100)], status: "error", error: { message: "boom" } }), live(5, 100));
  const r = await runWorkflow(configWorkflow((ctx) => ctx.agent("p", { role: "classify", label: "c" })), {}, { cwd });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /Teto de tokens da etapa "c" atingido: 300 de 250/, "200 from the failed attempt + the first turn of the retry");
  assert.deepEqual(stepEnds(logOf(r.runId)).map((e) => [e.attempt, e.errorKind]), [[1, "run-error"], [2, "budget"]]);
  assert.equal(stats.turnsDelivered, 3);
});

test("a turn that arrives before send() has handed back the run still cuts the step, and the run is cancelled once it is known", async () => {
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { maxTokensPerStep: 150, retries: 2 } } } } });
  script.push(() => ({ deltas: [turn(100), turn(100), turn(100)] })); // the plain fake delivers every delta inside send()
  const r = await runWorkflow(configWorkflow((ctx) => ctx.agent("p", { role: "classify", label: "c" })), {}, { cwd });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /Teto de tokens da etapa "c" atingido: 200 de 150/, "cut at the second turn, the one that crossed");
  assert.equal(calls.length, 1, "no retry");
  assert.equal(stats.cancels, 1, "the run was cancelled as soon as send() returned it");
  assert.equal(stepEnds(logOf(r.runId))[0]!.errorKind, "budget");
});

test("a chat override of the per-step cap is enforced live too", async () => {
  script.push(live(10, 100));
  const r = await runWorkflow(configWorkflow((ctx) => ctx.agent("p", { role: "review", label: "r", retries: 0 })), {}, { cwd, mcpOverrides: { maxTokensPerStep: 120 } });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /Teto de tokens da etapa "r" atingido: 200 de 120/);
  assert.equal(stats.turnsDelivered, 2);
});

test("a global per-step cap is enforced even when the repo asks for none", async () => {
  writeGlobalConfig({ caps: { maxTokensPerStep: 150 } });
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { maxTokensPerStep: null, retries: 0 } } } } });
  script.push(live(10, 100));
  const r = await runWorkflow(configWorkflow((ctx) => ctx.agent("p", { role: "classify", label: "c" })), {}, { cwd });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /Teto de tokens da etapa "c" atingido: 200 de 150/);
});

test("the run's cap cancels every active step at once and the run ends with a budget error", async () => {
  for (let i = 0; i < 2; i++) script.push(byLabel({ a: live(10, 100), b: live(10, 100) }));
  const events: WorkflowEvent[] = [];
  const wf = configWorkflow((ctx) => ctx.parallel([() => ctx.agent("a", { role: "classify", label: "a", retries: 0 }), () => ctx.agent("b", { role: "review", label: "b", retries: 0 })]));
  const r = await runWorkflow(wf, {}, { cwd, maxTokens: 450, onEvent: (e) => events.push(e) });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /^Teto de tokens atingido: 500 de 450\.$/, "the sum of both steps' turns, live");
  assert.equal(stats.cancels, 2, "both active steps were cancelled, not only the one whose turn crossed");
  assert.equal(stats.turnsDelivered, 5, "no further turn was delivered to either step");
  assert.equal(r.spentTokens, 500, "what the cancelled steps used is in the run's total");
  assert.ok(r.spentTokens - 450 <= 100, "overshoot of at most one turn");

  const log = logOf(r.runId);
  const ends = stepEnds(log);
  assert.deepEqual(ends.map((e) => [e.ok, e.errorKind]).sort(), [[false, "budget"], [false, "budget"]]);
  assert.equal(log.at(-1)!.type, "run-end", "the run waited for the cancelled steps: no step event after the run-end");
  const runEnd = log.at(-1) as Extract<WorkflowEvent, { type: "run-end" }>;
  assert.equal(runEnd.status, "failed");
  assert.match(runEnd.error!, /Teto de tokens atingido/);
});

test("steps queued behind the concurrency limit do not start once the run's cap is crossed", async () => {
  script.push(live(10, 100), live(10, 100), live(10, 100));
  const wf = configWorkflow((ctx) => ctx.parallel([1, 2, 3].map((n) => () => ctx.agent(`step ${n}`, { role: "classify", label: `s${n}`, retries: 0 }))));
  const r = await runWorkflow(wf, {}, { cwd, maxTokens: 150, concurrency: 1 });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /Teto de tokens atingido: 200 de 150/);
  assert.equal(calls.length, 1, "the two queued steps never created an agent");
  assert.equal(stats.turnsDelivered, 2);
});

test("the run's cap counts what earlier executions spent: a resume cuts a step that crosses the new total", async () => {
  const three = configWorkflow(async (ctx) => {
    await ctx.agent("a", { role: "classify", label: "a", retries: 0 }); // 110 tokens each in the plain fake
    await ctx.agent("b", { role: "classify", label: "b", retries: 0 });
    await ctx.agent("c", { role: "classify", label: "c", retries: 0 });
  });
  const first = await runWorkflow(three, {}, { cwd, maxTokens: 150 });
  assert.equal(first.spentTokens, 220, "a and b ran; c was refused");

  script.push(live(5, 110));
  const resumed = await runWorkflow(three, {}, { cwd, runId: first.runId, maxTokens: 300 });
  assert.equal(resumed.status, "failed");
  assert.match(resumed.error!, /Teto de tokens atingido: 330 de 300/, "220 replayed from the log + the first turn of c");
  assert.equal(stats.turnsDelivered, 1);
  assert.equal(resumed.spentTokens, 330);
});

test("a step the workflow starts after the run's cap was crossed, while the cancelled steps are still stopping, never creates an agent", async () => {
  script.push(live(10, 100), live(10, 100));
  let crossed!: () => void;
  const afterSecondTurn = new Promise<void>((resolve) => (crossed = resolve));
  let turns = 0;
  const wf = configWorkflow((ctx) =>
    ctx.parallel([
      () => ctx.agent("a", { role: "classify", label: "a", retries: 0 }),
      async () => {
        await afterSecondTurn; // continues right after the turn that takes the run over its cap, before the cut step is charged
        return ctx.agent("b", { role: "classify", label: "late", retries: 0 });
      },
    ]),
  );
  const r = await runWorkflow(wf, {}, { cwd, maxTokens: 150, onEvent: (e) => e.type === "turn" && ++turns === 2 && crossed() });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /Teto de tokens atingido: 200 de 150/);
  assert.equal(calls.length, 1, "only the first step ever had an agent");
  assert.equal(stats.turnsDelivered, 2);
});

test("a cut does not wait for the SDK: a run whose wait() never settles after cancel() still fails at once", { timeout: 10_000 }, async () => {
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { maxTokensPerStep: 150, retries: 0, timeoutMs: 600_000 } } } } });
  script.push(() => ({ live: true, stuckAfterCancel: true, deltas: Array.from({ length: 10 }, () => turn(100)) }));
  const r = await runWorkflow(configWorkflow((ctx) => ctx.agent("p", { role: "classify", label: "c" })), {}, { cwd });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /Teto de tokens da etapa "c" atingido: 200 de 150/);
  assert.equal(stats.cancels, 1);
});
