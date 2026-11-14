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
import { RateLimitError, calls, costConfig, script, stats } from "./fake-sdk.js";
import { runWorkflow } from "../src/runtime/engine.js";
import type { WorkflowEvent } from "../src/runtime/events.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { clearConfig, configWorkflow, writeGlobalConfig, writeRepoConfig } from "./config-fixtures.js";

const cwd = join(import.meta.dirname, ".tmp", `live-caps-${process.pid}`);
const reset = () => {
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0, cancels: 0, turnsDelivered: 0, sends: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined, createGate: undefined });
};
afterEach(() => {
  clearConfig(cwd);
  rmSync(cwd, { recursive: true, force: true });
  reset();
});

/** One finished turn that used `tokens` tokens in all (10 of them output). */
const turn = (tokens: number) => ({ type: "turn-ended", usage: { inputTokens: tokens - 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } });
/** A send() that streams `count` turns of `tokens` tokens each, until the run is cancelled. */
/** What the fake does on one send(): an entry of its `script`. */
type Send = (typeof script)[number];
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
  assert.match(r.error!, /Step token cap reached for step "c": 300 of 250/);
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

/** A promise and the function that settles it, for a test that decides when something may go on. */
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

/** A send() chosen by the step's prompt, so parallel steps need no send order. */
const byPrompt = (plan: Record<string, Send>) => (o: any, msg: string, n: number) => plan[msg]!(o, msg, n);

/**
 * Like `byPrompt`, for live runs that must all exist before any of them streams: the first turn of every run is held until
 * every step of the plan has called send(). The runs are then handed back (and known to the engine) before a turn can cross
 * a cap, however late a step's agent was created, so a test can count on every active step having a run to cancel.
 * Push the result once per step of the plan.
 */
const holdUntilAllSent = (plan: Record<string, Send>) => {
  let sent = 0;
  const allSent = deferred();
  return (o: any, msg: string, n: number) => {
    const behaviour = plan[msg]!(o, msg, n);
    if (++sent === Object.keys(plan).length) allSent.resolve();
    return { ...behaviour, gate: allSent.promise };
  };
};

test("a step cut by its own cap fails alone: the run goes on, as it does for any failed step", async () => {
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { maxTokensPerStep: 250 } } } } });
  for (let i = 0; i < 2; i++) script.push(byPrompt({ runaway: live(10, 100), fine: live(2, 100) }));
  const events: WorkflowEvent[] = [];
  const wf = configWorkflow((ctx) => ctx.parallel([() => ctx.agent("runaway", { role: "classify", label: "runaway" }), () => ctx.agent("fine", { role: "review", label: "fine" })]));
  const r = await runWorkflow(wf, {}, { cwd, onEvent: (e) => events.push(e) });

  assert.equal(r.status, "finished", r.error);
  assert.deepEqual(r.result, [null, "ok"], "the runaway step came back as the null of a failed parallel branch");
  assert.ok(events.some((e) => e.type === "warning" && /Step token cap reached for step "runaway"/.test(e.message)));
  const ends = Object.fromEntries(stepEnds(logOf(r.runId)).map((e) => [e.label, e]));
  assert.equal(ends.runaway!.errorKind, "budget");
  assert.equal(ends.fine!.ok, true, "the other step was not touched");
  assert.equal(stats.turnsDelivered, 3 + 2);
});

test("the overshoot is bounded by one turn: the turn that crosses the cap is the last one the step is paid for", async () => {
  // Each case is a step that would run 50 turns. `turns` is the turn that first takes the total strictly above the cap.
  const cases = [
    { cap: 250, turnTokens: 100, turns: 3, spent: 300 },
    { cap: 300, turnTokens: 100, turns: 4, spent: 400 }, // exactly the cap is not over it
    { cap: 99, turnTokens: 100, turns: 1, spent: 100 },
    { cap: 1000, turnTokens: 330, turns: 4, spent: 1320 },
  ];
  for (const { cap, turnTokens, turns, spent } of cases) {
    writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { maxTokensPerStep: cap, retries: 0 } } } } });
    reset();
    script.push(live(50, turnTokens));
    const r = await runWorkflow(configWorkflow((ctx) => ctx.agent("p", { role: "classify", label: "c" })), {}, { cwd });

    assert.equal(r.status, "failed");
    assert.equal(stats.turnsDelivered, turns, `cap ${cap}, turns of ${turnTokens}: the step was cut at turn ${turns} of 50`);
    assert.equal(r.spentTokens, spent);
    assert.ok(r.spentTokens - cap <= turnTokens, `cap ${cap}: the overshoot (${r.spentTokens - cap}) is at most one turn (${turnTokens})`);
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
  assert.match(r.error!, /Step token cap reached for step "c": 300 of 250/, "200 from the failed attempt + the first turn of the retry");
  assert.deepEqual(stepEnds(logOf(r.runId)).map((e) => [e.attempt, e.errorKind]), [[1, "run-error"], [2, "budget"]]);
  assert.equal(stats.turnsDelivered, 3);
});

test("a turn that arrives before send() has handed back the run still cuts the step, and the run is cancelled once it is known", async () => {
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { maxTokensPerStep: 150, retries: 2 } } } } });
  script.push(() => ({ deltas: [turn(100), turn(100), turn(100)] })); // the plain fake delivers every delta inside send()
  const r = await runWorkflow(configWorkflow((ctx) => ctx.agent("p", { role: "classify", label: "c" })), {}, { cwd });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /Step token cap reached for step "c": 200 of 150/, "cut at the second turn, the one that crossed");
  assert.equal(calls.length, 1, "no retry");
  assert.equal(stats.cancels, 1, "the run was cancelled as soon as send() returned it");
  assert.equal(stepEnds(logOf(r.runId))[0]!.errorKind, "budget");
});

test("a chat override of the per-step cap is enforced live too", async () => {
  script.push(live(10, 100));
  const r = await runWorkflow(configWorkflow((ctx) => ctx.agent("p", { role: "review", label: "r", retries: 0 })), {}, { cwd, mcpOverrides: { maxTokensPerStep: 120 } });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /Step token cap reached for step "r": 200 of 120/);
  assert.equal(stats.turnsDelivered, 2);
});

test("a global per-step cap is enforced even when the repo asks for none", async () => {
  writeGlobalConfig({ caps: { maxTokensPerStep: 150 } });
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { maxTokensPerStep: null, retries: 0 } } } } });
  script.push(live(10, 100));
  const r = await runWorkflow(configWorkflow((ctx) => ctx.agent("p", { role: "classify", label: "c" })), {}, { cwd });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /Step token cap reached for step "c": 200 of 150/);
});

/**
 * The run's cap crossed by the fifth turn of two parallel live steps (100 tokens each, cap 450). `delayBCreationMs` creates b's
 * agent that much later than a's. The turns still wait for both runs (`holdUntilAllSent`), so this is about every active step
 * having a run to cancel; a step cut before it has a run is the next test.
 */
async function runCapCrossedByTwoSteps({ delayBCreationMs }: { delayBCreationMs: number }) {
  let bDelayed = false;
  if (delayBCreationMs) {
    costConfig.createGate = (o) => {
      if (!String(o.name).endsWith(":b")) return undefined;
      bDelayed = true;
      return new Promise((resolve) => setTimeout(resolve, delayBCreationMs));
    };
  }
  const plan = holdUntilAllSent({ a: live(10, 100), b: live(10, 100) });
  script.push(plan, plan);
  const wf = configWorkflow((ctx) => ctx.parallel([() => ctx.agent("a", { role: "classify", label: "a", retries: 0 }), () => ctx.agent("b", { role: "review", label: "b", retries: 0 })]));
  const r = await runWorkflow(wf, {}, { cwd, maxTokens: 450 });

  assert.equal(bDelayed, delayBCreationMs > 0, "b's agent was held back exactly when the test asked for it");
  assert.equal(r.status, "failed");
  assert.match(r.error!, /^Token cap reached: 500 of 450\.$/, "the sum of both steps' turns, live");
  assert.equal(stats.cancels, 2, "both active steps were cancelled, not only the one whose turn crossed");
  assert.equal(stats.turnsDelivered, 5, "no further turn was delivered to either step");
  assert.equal(r.spentTokens, 500, "what the cancelled steps used is in the run's total");

  const log = logOf(r.runId);
  const ends = stepEnds(log);
  assert.deepEqual(ends.map((e) => [e.ok, e.errorKind]).sort(), [[false, "budget"], [false, "budget"]]);
  assert.equal(log.at(-1)!.type, "run-end", "the run waited for the cancelled steps: no step event after the run-end");
  const runEnd = log.at(-1) as Extract<WorkflowEvent, { type: "run-end" }>;
  assert.equal(runEnd.status, "failed");
  assert.match(runEnd.error!, /Token cap reached/);
}

test("the run's cap cancels every active step at once and the run ends with a budget error", () => runCapCrossedByTwoSteps({ delayBCreationMs: 0 }));

test("the run's cap cancels every active step at once even when the second step's agent is created late", () => runCapCrossedByTwoSteps({ delayBCreationMs: 30 }));

test("a step the run's cap cuts while its agent is still being created never sends: it ends as 'budget', with no turn and nothing to cancel", async () => {
  const bCreating = deferred();
  const releaseB = deferred();
  costConfig.createGate = (o) => {
    if (!String(o.name).endsWith(":b")) return undefined;
    bCreating.resolve();
    return releaseB.promise; // b's agent is not created until the test says so
  };
  // One send only (a step that sent would find the script empty and run as a plain, finished step). Its first turn waits until
  // b is inside Agent.create, so the cap cannot be crossed before b has started: that would be another path (a step refused at its start).
  script.push(() => ({ ...live(10, 100)(), gate: bCreating.promise }));
  let turns = 0;
  const wf = configWorkflow((ctx) => ctx.parallel([() => ctx.agent("a", { role: "classify", label: "a", retries: 0 }), () => ctx.agent("b", { role: "review", label: "b", retries: 0 })]));
  // The second turn of a takes the run over its cap (200 > 150) while b is still waiting for its agent; b's creation completes right after.
  const r = await runWorkflow(wf, {}, { cwd, maxTokens: 150, onEvent: (e) => e.type === "turn" && ++turns === 2 && releaseB.resolve() });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /^Token cap reached: 200 of 150\.$/);
  assert.equal(calls.length, 2, "b's agent was created, late");
  assert.equal(stats.sends, 1, "but b never sent");
  assert.equal(stats.turnsDelivered, 2, "no turn reached b");
  assert.equal(stats.cancels, 1, "only a had an SDK run: nothing to cancel for b");
  assert.equal(stats.disposed, 2, "the agent b got late is disposed");
  assert.equal(r.spentTokens, 200, "b used nothing");

  const log = logOf(r.runId);
  const byLabel = Object.fromEntries(stepEnds(log).map((e) => [e.label, e]));
  assert.deepEqual([byLabel.a!.ok, byLabel.a!.errorKind], [false, "budget"]);
  assert.deepEqual([byLabel.b!.ok, byLabel.b!.errorKind], [false, "budget"]);
  assert.equal(byLabel.b!.turns, 0);
  assert.equal(byLabel.b!.usage?.totalTokens, 0);
  assert.equal(log.at(-1)!.type, "run-end", "the run waited for b to stop");
});

test("steps queued behind the concurrency limit do not start once the run's cap is crossed", async () => {
  script.push(live(10, 100), live(10, 100), live(10, 100));
  const wf = configWorkflow((ctx) => ctx.parallel([1, 2, 3].map((n) => () => ctx.agent(`step ${n}`, { role: "classify", label: `s${n}`, retries: 0 }))));
  const r = await runWorkflow(wf, {}, { cwd, maxTokens: 150, concurrency: 1 });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /Token cap reached: 200 of 150/);
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
  assert.match(resumed.error!, /Token cap reached: 330 of 300/, "220 replayed from the log + the first turn of c");
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
  assert.match(r.error!, /Token cap reached: 200 of 150/);
  assert.equal(calls.length, 1, "only the first step ever had an agent");
  assert.equal(stats.turnsDelivered, 2);
});

test("a cut does not wait for the SDK: a run whose wait() never settles after cancel() still fails at once", { timeout: 30_000 }, async () => {
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { maxTokensPerStep: 150, retries: 0, timeoutMs: 600_000 } } } } });
  script.push(() => ({ live: true, stuckAfterCancel: true, deltas: Array.from({ length: 10 }, () => turn(100)) }));
  const r = await runWorkflow(configWorkflow((ctx) => ctx.agent("p", { role: "classify", label: "c" })), {}, { cwd });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /Step token cap reached for step "c": 200 of 150/);
  assert.equal(stats.cancels, 1);
});

test("a workflow that swallows the step's budget error does not turn a crossed run cap into a finished run", async () => {
  script.push(live(10, 100));
  const wf = configWorkflow(async (ctx) => {
    try {
      await ctx.agent("p", { role: "classify", label: "c", retries: 0 });
    } catch {
      /* the workflow degrades on its own */
    }
    return "fallback";
  });
  const r = await runWorkflow(wf, {}, { cwd, maxTokens: 150 });

  assert.equal(r.status, "failed", "the run's cap was crossed: the run ends with the budget error whatever the workflow does with it");
  assert.match(r.error!, /^Token cap reached: 200 of 150\.$/);
  assert.equal(r.result, undefined);
  const runEnd = logOf(r.runId).at(-1) as Extract<WorkflowEvent, { type: "run-end" }>;
  assert.deepEqual([runEnd.type, runEnd.status], ["run-end", "failed"]);
});

test("a step that already used its whole cap in a failed attempt is not retried: no agent is created for the retry", async () => {
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { maxTokensPerStep: 200, retries: 2 } } } } });
  script.push(() => ({ live: true, deltas: [turn(100), turn(100)], status: "error", error: { message: "boom" } }), live(5, 100));
  const r = await runWorkflow(configWorkflow((ctx) => ctx.agent("p", { role: "classify", label: "c" })), {}, { cwd });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /Step token cap reached for step "c": 200 of 200/, "exactly the cap is not over it, but nothing is left for another attempt");
  assert.equal(calls.length, 1);
  assert.deepEqual(stepEnds(logOf(r.runId)).map((e) => [e.attempt, e.errorKind]), [[1, "run-error"]]);
});

test("a cap crossed while the agent answers a schema re-prompt cuts the step too", async () => {
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { maxTokensPerStep: 150, retries: 2 } } } } });
  script.push(live(1, 100), live(5, 100)); // the first answer never calls submit_result, so the engine re-prompts
  const schema = { type: "object", required: ["tier"], properties: { tier: { type: "string" } } };
  const r = await runWorkflow(configWorkflow((ctx) => ctx.agent("p", { role: "classify", label: "c", schema })), {}, { cwd });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /Step token cap reached for step "c": 200 of 150/);
  assert.equal(calls.length, 1, "one agent: the re-prompt went to the same conversation, and a budget failure is not retried");
  assert.equal(stats.turnsDelivered, 2, "the one turn of the first answer and the first turn of the re-prompt");
  assert.equal(stats.cancels, 1);
  assert.equal(stepEnds(logOf(r.runId))[0]!.errorKind, "budget");
});

test("the tokens of an attempt that failed on a rate limit are counted once while it backs off, not twice", { timeout: 30_000 }, async () => {
  const rateLimited = Object.assign(new RateLimitError("slow down"), { isRetryable: true }); // the engine sleeps 2 s before the retry
  let aSends = 0;
  script.push(...[0, 1, 2].map(() => (o: any, msg: string, n: number) => {
    if (msg === "b") return live(2, 40)();
    return aSends++ === 0 ? { live: true, deltas: [turn(100), turn(100)], rejectWait: rateLimited } : live(1, 10)();
  }));
  let turns = 0;
  let aTurned!: () => void;
  const afterSecondTurn = new Promise<void>((resolve) => (aTurned = resolve));
  const wf = configWorkflow((ctx) =>
    ctx.parallel([
      () => ctx.agent("a", { role: "classify", label: "a", retries: 1 }),
      async () => {
        await afterSecondTurn; // b starts while a's failed attempt is already charged and a is sleeping before its retry
        return ctx.agent("b", { role: "classify", label: "b", retries: 0 });
      },
    ]),
  );
  const r = await runWorkflow(wf, {}, { cwd, maxTokens: 300, onEvent: (e) => e.type === "turn" && ++turns === 2 && aTurned() });

  assert.equal(r.status, "finished", r.error);
  assert.equal(r.spentTokens, 290, "a's 200 + b's 80 + a's retry 10: each counted once");
});
