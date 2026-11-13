// Seam 1, the run: step content older than the retention (default: the last 30 runs or 14 days per repo) is pruned from
// the event logs of the repo when a run starts; the metadata around it stays. Runs `runWorkflow` with the fake Cursor SDK,
// ages a run by setting the modification time of its log, and reads the logs back.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { calls, costConfig, script, stats } from "@cursor/sdk";
import { runWorkflow } from "../src/runtime/engine.js";
import type { ContentEvent, WorkflowEvent } from "../src/runtime/events.js";
import { DEFAULT_RETENTION } from "../src/runtime/retention.js";
import { eventLogPath, readEventLog, runDirPath } from "../src/runtime/run-store.js";
import { defineWorkflow } from "../src/runtime/workflow.js";

const cwd = join(import.meta.dirname, ".tmp", `retention-${process.pid}`); // one directory per test process
let child: ChildProcess | undefined;
afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  rmSync(cwd, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined });
});

const DAY = 24 * 60 * 60 * 1000;
const wf = defineWorkflow({ meta: { name: "ret", description: "ret" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent(`prompt of ${ctx.runId}`, { label: "work" }) });
const logOf = (runId: string) => readEventLog(eventLogPath(cwd, runId)).events;
const contentOf = (events: WorkflowEvent[]) => events.filter((e): e is ContentEvent => e.type === "content");
const withoutContent = (events: WorkflowEvent[]) => events.filter((e) => e.type !== "content");
/** Pretends the run's last activity was `ms` ago. */
const age = (runId: string, ms: number) => {
  const when = new Date(Date.now() - ms);
  utimesSync(eventLogPath(cwd, runId), when, when);
};
const run = async (runId: string, retention?: { runs?: number | null; days?: number | null }) => {
  const r = await runWorkflow(wf, {}, { cwd, runId, retention });
  assert.equal(r.status, "finished", r.error);
  return r.runId;
};
const hasText = (runId: string) => contentOf(logOf(runId)).every((c) => typeof c.text === "string") && contentOf(logOf(runId)).length > 0;
const isPruned = (runId: string) => contentOf(logOf(runId)).length > 0 && contentOf(logOf(runId)).every((c) => c.text === undefined);

test("the default retention is the last 30 runs or 14 days", () => {
  assert.deepEqual(DEFAULT_RETENTION, { runs: 30, days: 14 });
});

test("content older than 14 days is pruned when the next run starts; the metadata and the journal stay", async () => {
  const old = await run("old-run");
  const recent = await run("recent-run");
  age(old, 15 * DAY);
  age(recent, 13 * DAY);
  const before = logOf(old);
  const journalBefore = readFileSync(join(runDirPath(cwd, old), "journal.jsonl"), "utf8");
  assert.ok(hasText(old));

  const next = await run("next-run");

  assert.ok(isPruned(old), "the 15-day-old content is gone");
  assert.ok(hasText(recent), "the 13-day-old content stays");
  assert.ok(hasText(next), "the new run's content is intact");
  const after = logOf(old);
  assert.deepEqual(withoutContent(after), withoutContent(before), "every metadata event is untouched");
  assert.deepEqual(
    contentOf(after).map(({ text: _text, ...rest }) => rest),
    contentOf(before).map(({ text: _text, ...rest }) => rest),
    "a pruned content event keeps its kind, ids and size, and only loses the text",
  );
  assert.equal(readFileSync(join(runDirPath(cwd, old), "journal.jsonl"), "utf8"), journalBefore, "the journal is resume state, not log content");
});

test("only the last 30 runs of the repo keep their content, the run being started included", async () => {
  for (let i = 0; i < 30; i++) {
    const id = await run(`run-${String(i).padStart(2, "0")}`);
    age(id, (40 - i) * 60_000); // run-00 is the oldest, all within the last hour
  }
  assert.ok(hasText("run-00") && hasText("run-29"), "30 runs: nothing is pruned yet");
  // The 31st run starts: it and the 29 newest others keep their content; the oldest loses it.
  const last = await run("run-30");
  assert.ok(isPruned("run-00"));
  assert.ok(hasText("run-01") && hasText("run-29") && hasText(last));
});

test("a limit set to null is off, and a limit passed to the run replaces the default", async () => {
  const a = await run("a");
  age(a, 400 * DAY);
  await run("b", { runs: null, days: null });
  assert.ok(hasText(a), "no limit, nothing pruned, however old");

  await run("c", { runs: 2, days: null });
  assert.ok(isPruned(a), "with 2 runs kept, only the current run and the newest other keep their content");
  assert.ok(hasText("b") && hasText("c"));
});

test("pruning is done once: the pruned log keeps its modification time, so it stays old", async () => {
  const old = await run("old-run");
  age(old, 20 * DAY);
  const stamp = statSync(eventLogPath(cwd, old)).mtimeMs;
  await run("one");
  assert.ok(isPruned(old));
  assert.ok(Math.abs(statSync(eventLogPath(cwd, old)).mtimeMs - stamp) < 1, "rewriting the log did not make it look fresh (to the millisecond)");
  const bytes = readFileSync(eventLogPath(cwd, old), "utf8");
  await run("two");
  assert.equal(readFileSync(eventLogPath(cwd, old), "utf8"), bytes, "nothing left to prune: the file is not rewritten");
});

test("the run that is starting is never pruned, even when it is an old run being resumed", async () => {
  const old = await run("resumed");
  age(old, 30 * DAY);
  await run("resumed"); // a resume: served from the journal, so no new content, and the old content must survive
  assert.ok(hasText(old), "resuming an old run does not erase its own content");
});

test("a run another process is executing is left alone, however old its log looks", async () => {
  const proc = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(import.meta.dirname, "hold-run.ts"), cwd, "held-run"], {
    env: { ...process.env, TSX_TSCONFIG_PATH: join(import.meta.dirname, "..", "tsconfig.test.json") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  child = proc;
  await new Promise<void>((resolve, reject) => {
    proc.once("exit", (code) => reject(new Error(`the child exited early with code ${code}`)));
    proc.stdout!.on("data", (chunk: Buffer) => chunk.toString().includes("started") && resolve());
  });
  for (const deadline = performance.now() + 5000; !hasText("held-run"); await new Promise((r) => setTimeout(r, 10))) {
    if (performance.now() > deadline) throw new Error("the child never wrote its prompt to the log");
  }
  age("held-run", 40 * DAY);
  await run("fresh");
  assert.ok(hasText("held-run"), "the content of a run in progress is not erased under it");
});

test("a log that ends in a torn line is pruned without losing the other lines", async () => {
  const old = await run("torn-run");
  age(old, 20 * DAY);
  const file = eventLogPath(cwd, old);
  const before = readEventLog(file).events;
  const fs = await import("node:fs");
  fs.appendFileSync(file, '{"v":1,"ts":"2026-01-01T00:00:00.000Z","runId":"torn-run","type":"co');
  age(old, 20 * DAY);
  await run("trigger");
  assert.ok(isPruned(old));
  assert.deepEqual(withoutContent(readEventLog(file).events), withoutContent(before));
  assert.ok(readFileSync(file, "utf8").endsWith('"type":"co'), "the torn tail is kept byte for byte");
});
