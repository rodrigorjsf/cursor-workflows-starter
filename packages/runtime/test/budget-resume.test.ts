// Seam 1, the run: a run's budget accumulates across resumes, failed attempts included, and a cap passed to a resume is the
// new total cap. Runs `runWorkflow` and `startJob` with the fake Cursor SDK; every attempt there costs 9 cents (7 charged)
// and 110 tokens.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { calls, costConfig, script, stats } from "@cursor/sdk";
import { runWorkflow } from "../src/runtime/engine.js";
import { readJob, startJob } from "../src/runtime/jobs.js";
import { defineWorkflow } from "../src/runtime/workflow.js";

const cwd = join(import.meta.dirname, ".tmp", `budget-resume-${process.pid}`); // one directory per test process
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined });
});

/** Three steps in sequence. `spentAtStart` collects what the budget said when each execution began. */
const spentAtStart: number[] = [];
const three = defineWorkflow({
  meta: { name: "three", description: "three" },
  defaults: { model: { id: "m" } },
  async run(ctx) {
    spentAtStart.push(ctx.budget.spentCents());
    await ctx.agent("a", { label: "a", retries: 0 });
    await ctx.agent("b", { label: "b", retries: 0 });
    await ctx.agent("c", { label: "c", retries: 0 });
    return { status: "done", spent: ctx.budget.spentCents() };
  },
});

test("a resume starts from what the run already spent, so the budget never restarts from zero", async () => {
  spentAtStart.length = 0;
  const first = await runWorkflow(three, {}, { cwd, maxCents: 15 });
  assert.equal(first.status, "failed");
  assert.match(first.error!, /Teto de custo atingido: 18¢ de 15¢/);
  assert.deepEqual([first.spentCents, first.chargedCents, first.spentTokens], [18, 14, 220]);

  const resumed = await runWorkflow(three, {}, { cwd, runId: first.runId });
  assert.equal(resumed.status, "finished", resumed.error);
  assert.deepEqual(spentAtStart, [0, 18], "the second execution begins with the 18 cents of the first");
  assert.deepEqual([resumed.spentCents, resumed.chargedCents, resumed.spentTokens], [27, 21, 330], "27 = 18 replayed + 9 for the step that was left");
  assert.equal(resumed.usage.totalTokens, 330);
  assert.equal(resumed.usage.inputTokens, 300);
  assert.equal(calls.length, 3, "the two finished steps were not run again");
});

test("failed attempts count: a resume replays what the attempts that failed cost", async () => {
  script.push(() => ({ status: "error", error: { message: "boom" } }));
  const one = defineWorkflow({ meta: { name: "one", description: "one" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent("x", { label: "x", retries: 0 }) });
  const first = await runWorkflow(one, {}, { cwd });
  assert.equal(first.status, "failed");
  assert.deepEqual([first.spentCents, first.spentTokens], [9, 110], "the failed attempt was paid for");

  const resumed = await runWorkflow(one, {}, { cwd, runId: first.runId });
  assert.equal(resumed.status, "finished", resumed.error);
  assert.deepEqual([resumed.spentCents, resumed.spentTokens], [18, 220], "the failed attempt and the one that worked");
});

test("a resume with a cap sets the new total cap, not an allowance on top of what was spent", async () => {
  const first = await runWorkflow(three, {}, { cwd, maxCents: 15 }); // spends 18 and stops before c
  assert.equal(first.spentCents, 18);

  const tight = await runWorkflow(three, {}, { cwd, runId: first.runId, maxCents: 18 });
  assert.equal(tight.status, "failed");
  assert.match(tight.error!, /Teto de custo atingido: 18¢ de 18¢/, "18 already spent, total cap 18: no step may start");
  assert.equal(tight.spentCents, 18);

  const wider = await runWorkflow(three, {}, { cwd, runId: first.runId, maxCents: 27 });
  assert.equal(wider.status, "finished", wider.error);
  assert.equal(wider.spentCents, 27);
});

test("the token cap is a total across resumes too", async () => {
  // The cap is live now: a turn that takes the run strictly above it cancels the step. 220 lets a (110) and b (220) finish
  // and refuses c before it starts.
  const first = await runWorkflow(three, {}, { cwd, maxTokens: 220 });
  assert.equal(first.status, "failed");
  assert.equal(first.spentTokens, 220);
  assert.match(first.error!, /Teto de tokens atingido: 220 de 220/);

  const tight = await runWorkflow(three, {}, { cwd, runId: first.runId, maxTokens: 220 });
  assert.equal(tight.status, "failed");
  assert.match(tight.error!, /Teto de tokens atingido: 220 de 220/);

  const wider = await runWorkflow(three, {}, { cwd, runId: first.runId, maxTokens: 400 });
  assert.equal(wider.status, "finished", wider.error);
  assert.equal(wider.spentTokens, 330);
});

test("resuming a run that is already complete spends nothing more", async () => {
  const first = await runWorkflow(three, {}, { cwd });
  const again = await runWorkflow(three, {}, { cwd, runId: first.runId });
  assert.deepEqual([again.spentCents, again.spentTokens], [first.spentCents, first.spentTokens]);
  assert.equal(calls.length, 3);
});

test("the job of a resume shows the cumulative spend of the run", async () => {
  const first = startJob(three, {}, { cwd, maxCents: 15 });
  await first.done;
  assert.equal(readJob(cwd, first.job.jobId)!.spentCents, 18);

  const second = startJob(three, {}, { cwd, runId: first.job.runId });
  const state = await second.done;
  assert.equal(state.status, "finished");
  assert.deepEqual([state.spentCents, state.chargedCents, state.spentTokens], [27, 21, 330]);
  assert.equal(readJob(cwd, first.job.jobId)!.spentCents, 18, "the first job still shows what it had spent when it ended");
});
