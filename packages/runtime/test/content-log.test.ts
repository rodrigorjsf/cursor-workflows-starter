// Seam 1, the run: the full content of a step (prompts, agent messages, tool calls, command output) lives in the run's
// local event log, with secrets redacted, and nowhere else: not in the metrics database, not in its exports, not in what
// `onEvent` listeners receive. Runs `runWorkflow` with the fake Cursor SDK and asserts on the replayed log and the files.
import assert from "node:assert/strict";
import "./isolate-home.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { calls, costConfig, script, stats } from "@cursor/sdk";
import { openDb } from "../src/observability/db.js";
import { exportRows } from "../src/observability/queries.js";
import { runWorkflow } from "../src/runtime/engine.js";
import type { ContentEvent, WorkflowEvent } from "../src/runtime/events.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { defineWorkflow } from "../src/runtime/workflow.js";

let dir: string;
let cwd: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-content-"));
  cwd = join(dir, "repo");
  dbPath = join(dir, "home", "metrics.db");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined });
});

const USAGE = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 20 };
const shell = (command: string) => ({ type: "shell", args: { command } });
/** A turn as the SDK streams it: some text, one shell call with its output, the end of the turn. */
const turn = (text: string[], command: string, stdout: string, stderr = "") => [
  ...text.map((t) => ({ type: "text-delta", text: t })),
  { type: "tool-call-started", callId: "c1", modelCallId: "m1", toolCall: shell(command) },
  { type: "tool-call-completed", callId: "c1", modelCallId: "m1", toolCall: { ...shell(command), result: { status: "success", value: { exitCode: 0, signal: "", stdout, stderr, executionTime: 1 } } } },
  { type: "turn-ended", usage: USAGE },
];

const oneStep = (prompt: string) =>
  defineWorkflow({ meta: { name: "content", description: "content" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent(prompt, { label: "work" }) });

const contentOf = (events: WorkflowEvent[]) => events.filter((e): e is ContentEvent => e.type === "content");

test("prompts, agent messages, tool calls and command output are kept in the event log, tied to their step and attempt", async () => {
  script.push(() => ({ status: "finished", result: "done", deltas: turn(["Reading ", "the files."], "ls -la", "total 0\n", "warn\n") }));
  const r = await runWorkflow(oneStep("PROMPT-MARKER do the work"), {}, { cwd, metricsDb: false });
  assert.equal(r.status, "finished");

  const { events } = readEventLog(eventLogPath(cwd, r.runId));
  const start = events.find((e) => e.type === "step-start");
  assert.ok(start && start.type === "step-start");
  const content = contentOf(events);
  assert.deepEqual(
    content.map((c) => [c.kind, c.tool, c.callId, c.text]),
    [
      ["prompt", undefined, undefined, "PROMPT-MARKER do the work"],
      ["tool-call", "shell", "c1", '{"command":"ls -la"}'],
      ["command-output", "shell", "c1", "exit 0\ntotal 0\n\n[stderr]\nwarn\n"],
      ["agent-message", undefined, undefined, "Reading the files."],
    ],
  );
  for (const c of content) {
    assert.equal(c.stepId, start.stepId, `${c.kind}: step id`);
    assert.equal(c.attemptId, start.attemptId, `${c.kind}: attempt id`);
    assert.equal(c.chars, c.text!.length, `${c.kind}: size`);
  }
  const order = events.map((e) => e.type);
  assert.ok(order.indexOf("content") > order.indexOf("step-start") && order.lastIndexOf("content") < order.indexOf("turn"), "content sits between the step's start and its first turn event");
});

test("a step served from the journal sends no prompt, so it has no content", async () => {
  const wf = oneStep("cached prompt");
  const first = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  const second = await runWorkflow(wf, {}, { cwd, metricsDb: false, runId: first.runId });
  assert.equal(second.status, "finished");
  const { events } = readEventLog(eventLogPath(cwd, first.runId));
  const resumeAt = events.findLastIndex((e) => e.type === "run-start");
  assert.ok(contentOf(events.slice(0, resumeAt)).length > 0, "the first execution called the agent");
  assert.deepEqual(contentOf(events.slice(resumeAt)), [], "the execution served from the journal sent nothing to an agent");
});

test("a re-prompt is content too", async () => {
  const wf = defineWorkflow({
    meta: { name: "schema", description: "schema" },
    defaults: { model: { id: "m" } },
    run: (ctx) => ctx.agent("give me json", { label: "json", schema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] }, retries: 0, schemaRetries: 1 }),
  });
  const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  assert.equal(r.status, "failed"); // the fake agent never calls submit_result
  const prompts = contentOf(readEventLog(eventLogPath(cwd, r.runId)).events).filter((c) => c.kind === "prompt");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0]!.text, "give me json");
  assert.match(prompts[1]!.text!, /You did not call submit_result/);
});

test("step content never reaches the metrics database, its exports, or the listeners of the run", async () => {
  script.push(() => ({
    status: "finished",
    result: "RESULT-MARKER",
    deltas: turn(["AGENT-MARKER"], "echo TOOL-MARKER", "OUTPUT-MARKER\n"),
  }));
  const seen: WorkflowEvent[] = [];
  const r = await runWorkflow(oneStep("PROMPT-MARKER"), {}, { cwd, metricsDb: dbPath, onEvent: (e) => seen.push(e) });
  assert.equal(r.status, "finished");

  const log = readFileSync(eventLogPath(cwd, r.runId), "utf8");
  for (const marker of ["PROMPT-MARKER", "AGENT-MARKER", "TOOL-MARKER", "OUTPUT-MARKER"]) assert.ok(log.includes(marker), `${marker} is in the local event log`);

  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(existsSync).map((f) => readFileSync(f).toString("latin1"));
  const db = await openDb(dbPath);
  const exported = JSON.stringify(exportRows(db, 30, false));
  db.close();
  const everywhere = [...files, exported, JSON.stringify(seen)].join("\n");
  for (const marker of ["PROMPT-MARKER", "AGENT-MARKER", "TOOL-MARKER", "OUTPUT-MARKER"]) {
    assert.ok(!everywhere.includes(marker), `${marker} must not leave the event log`);
  }
  assert.ok(!seen.some((e) => e.type === "content"), "listeners get no content events");
  assert.equal("prompt" in (seen.find((e) => e.type === "step-start") ?? {}), false, "step-start has no prompt text");
});

test("WF_METRICS_STORE_PROMPTS no longer stores prompt text in the metrics database", async () => {
  process.env.WF_METRICS_STORE_PROMPTS = "1";
  try {
    await runWorkflow(oneStep("PROMPT-MARKER"), {}, { cwd, metricsDb: dbPath });
  } finally {
    delete process.env.WF_METRICS_STORE_PROMPTS;
  }
  const db = await openDb(dbPath);
  const row = db.prepare("SELECT prompt_text FROM attempts").get() as { prompt_text: string | null };
  db.close();
  assert.equal(row.prompt_text, null);
});

test("content larger than 32768 characters is cut, and the event says how long it was", async () => {
  const r = await runWorkflow(oneStep("x".repeat(40_000)), {}, { cwd, metricsDb: false });
  const [prompt] = contentOf(readEventLog(eventLogPath(cwd, r.runId)).events);
  assert.equal(prompt!.kind, "prompt");
  assert.equal(prompt!.text!.length, 32_768);
  assert.equal(prompt!.chars, 40_000);
  assert.equal(prompt!.truncated, true);
});
