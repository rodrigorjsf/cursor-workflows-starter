// Seam 1, the run: `runWorkflow` with the fake Cursor SDK. The `smoke` workflow proves the chat -> MCP -> SDK -> structured
// result path as cheaply as possible: one step, a model the plan includes, a low token cap. Assertions are on the outcome,
// the replayed event log and what the SDK was asked.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { calls, script, stats } from "@cursor/sdk";
import { runWorkflow } from "../src/runtime/engine.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { clearConfig, runStartOf, writeRepoConfig } from "./config-fixtures.js";
import smoke from "../workflows/smoke.js";

const cwd = join(import.meta.dirname, ".tmp", `smoke-${process.pid}`);
afterEach(() => {
  clearConfig(cwd);
  rmSync(cwd, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { sends: 0 });
});

const submit = (o: any, value: unknown) => o.local.customTools.submit_result.execute(value, {});
/** The agent answers through `submit_result` with `value`, as the prompt asks. */
const answers = (value: unknown) => (o: any) => {
  submit(o, value);
  return { status: "finished", result: "ok" };
};
const logOf = (runId: string) => readEventLog(eventLogPath(cwd, runId)).events;

test("smoke finishes after one structured step and returns the answer the agent submitted", async () => {
  script.push(answers({ answer: "pong" }));
  const r = await runWorkflow(smoke, {}, { cwd });

  assert.equal(r.status, "finished", r.error);
  assert.deepEqual(r.result, { status: "ok", answer: "pong", tokens: 110 });
  assert.equal(r.spentTokens, 110);
  assert.equal(calls.length, 1, "one agent, one step");
});

test("the step runs on an included model with no tools and no project context: only the structured answer is on offer", async () => {
  script.push(answers({ answer: "pong" }));
  await runWorkflow(smoke, {}, { cwd });

  assert.equal(calls[0].model.id, "composer-2.5");
  assert.deepEqual(calls[0].tools, ["mcp"], "no native tool; `mcp` is where the SDK offers submit_result");
  assert.deepEqual(calls[0].local.settingSources, [], "no AGENTS.md, rules, hooks, MCP or skills in the step's context");
  assert.ok(calls[0].local.customTools.submit_result, "the answer travels through submit_result");
});

test("the answer is checked against the schema: a wrong answer is refused to the agent, which corrects it in the same conversation", async () => {
  const refusals: boolean[] = [];
  script.push((o) => {
    refusals.push((submit(o, { answer: "not pong" }) as { isError?: boolean }).isError === true);
    submit(o, { answer: "pong" });
    return { status: "finished", result: "ok" };
  });
  const r = await runWorkflow(smoke, {}, { cwd });

  assert.deepEqual(refusals, [true]);
  assert.equal(r.status, "finished", r.error);
  assert.equal((r.result as { answer: string }).answer, "pong");
});

test("an agent that never calls submit_result fails the run: no structured answer, no pass", async () => {
  const r = await runWorkflow(smoke, {}, { cwd });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /submit_result/);
  assert.equal(calls.length, 1, "retries are off: the failure is reported, not repeated");
});

test("the token cap of a smoke run is low, and a step that crosses it is cut at once", async () => {
  script.push(() => ({
    live: true,
    result: "ok",
    deltas: [{ type: "turn-ended", usage: { inputTokens: 90_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
  }));
  const r = await runWorkflow(smoke, {}, { cwd });

  const cap = runStartOf(logOf(r.runId)).config.limits.maxTokens;
  assert.ok(cap !== null && cap <= 50_000, `a smoke run must be cheap, cap is ${cap}`);
  assert.equal(r.status, "failed");
  assert.match(r.error!, /Token cap reached/);
});

test("the model is the role's: the repo config swaps it (an account where composer-2.5 is not included)", async () => {
  writeRepoConfig(cwd, { workflows: { smoke: { roles: { ping: { model: { id: "grok-4.7" } } } } } });
  script.push(answers({ answer: "pong" }));
  const r = await runWorkflow(smoke, {}, { cwd });

  assert.equal(r.status, "finished", r.error);
  assert.equal(calls[0].model.id, "grok-4.7");
});

test("smoke takes no arguments: anything else is refused before an agent is created", async () => {
  const r = await runWorkflow(smoke, { surprise: true } as never, { cwd });

  assert.equal(r.status, "failed");
  assert.equal(r.refused, true);
  assert.equal(calls.length, 0);
});
