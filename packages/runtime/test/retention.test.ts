// Seam: the run, with the fake Cursor SDK: what a run holds that is private (the text of its step content, and the results of its steps) is pruned
// when it falls outside the retention (default: the last 30 runs or 14 days per repo) and another run starts: the `text` of the
// content events of its event log, the `result` of every line of its journal (the run is then marked, and a resume of it is
// refused), and the memo entries older than the days. The metadata around it stays. Runs `runWorkflow` with the fake Cursor SDK,
// ages a run by setting the modification time of its log, and reads the files back.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { calls, costConfig, script, stats } from "./fake-sdk.js";
import { runWorkflow } from "../src/runtime/engine.js";
import type { ContentEvent, WorkflowEvent } from "../src/runtime/events.js";
import { DEFAULT_RETENTION, pruneMemo } from "../src/runtime/retention.js";
import { MemoStore } from "../src/runtime/memo.js";
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

const journalFile = (runId: string) => join(runDirPath(cwd, runId), "journal.jsonl");
/** The lines of a run's journal, parsed. */
const journalOf = (runId: string) => readFileSync(journalFile(runId), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
const hasResults = (runId: string) => journalOf(runId).length > 0 && journalOf(runId).every((entry) => entry.result !== undefined && entry.pruned === undefined);
const isJournalPruned = (runId: string) => journalOf(runId).length > 0 && journalOf(runId).every((entry) => entry.result === undefined && entry.pruned === true);
const memoFile = (key: string) => join(cwd, ".workflows", "memo", `${key}.json`);
const memoKeys = () => readdirSync(join(cwd, ".workflows", "memo")).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)).sort();
/** Writes a memo entry the way a step does, and pretends it was written `ms` ago. */
const seedMemo = (key: string, ms: number) => {
  new MemoStore(cwd).set(key, { answer: `private result of ${key}` });
  const when = new Date(Date.now() - ms);
  utimesSync(memoFile(key), when, when);
};

test("the default retention is the last 30 runs or 14 days", () => {
  assert.deepEqual(DEFAULT_RETENTION, { runs: 30, days: 14 });
});

test("content older than 14 days is pruned when the next run starts; the metadata stays, and the journal keeps its keys and costs but loses its results", async () => {
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
  assert.ok(isJournalPruned(old), "the journal of a run outside the retention no longer holds its results");
  assert.ok(hasResults(recent), "the journal of a run inside it is untouched");
  assert.notEqual(readFileSync(journalFile(old), "utf8"), journalBefore);
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

test("a pruned journal line keeps what the budget and the step list need, and only loses the result and gains the mark", async () => {
  const old = await run("old-run");
  const before = journalOf(old);
  assert.ok(before.length > 0 && before.every((entry) => entry.result !== undefined), "the run's journal held its step's result");
  age(old, 20 * DAY);

  await run("next-run");

  const after = journalOf(old);
  assert.deepEqual(
    after,
    before.map(({ result: _result, ...kept }) => ({ ...kept, pruned: true })),
    "key, label, model, chargedCents and totalTokens stay; result goes; pruned: true says so",
  );
});

test("seed 31 older runs with journal results and memo entries, then start a run: the pruned runs hold no result, memo entries past the days are gone, and a resume of a pruned run is refused", async () => {
  for (let i = 0; i < 31; i++) {
    const id = await run(`run-${String(i).padStart(2, "0")}`);
    age(id, (40 - i) * 60_000); // all within the last hour, run-00 the oldest
  }
  seedMemo("stale-a", 15 * DAY);
  seedMemo("stale-b", 400 * DAY);
  seedMemo("fresh", 13 * DAY);
  assert.ok(hasResults("run-01") && hasResults("run-30"), "the 31st run to start pushed run-00 out; run-01 is still inside the 30");

  const trigger = await run("run-31");

  // The run starting and the 29 newest others keep their results: of the 31 older runs, the two oldest fall outside the 30.
  assert.ok(isJournalPruned("run-00") && isJournalPruned("run-01"), "the two oldest runs lost their results");
  assert.ok(hasResults("run-02") && hasResults("run-30") && hasResults(trigger));
  assert.deepEqual(memoKeys(), ["fresh"], "memo entries older than 14 days are deleted, the others stay");

  const callsBefore = calls.length;
  const logBefore = readFileSync(eventLogPath(cwd, "run-00"), "utf8");
  const resumed = await runWorkflow(wf, {}, { cwd, runId: "run-00" });
  assert.equal(resumed.status, "failed");
  assert.equal(resumed.refused, true, "refused before anything ran, not a failed attempt");
  assert.match(resumed.error!, /run run-00 cannot be resumed: the retention policy deleted the step results its journal held/);
  assert.match(resumed.error!, /Start a new run/);
  assert.equal(calls.length, callsBefore, "no step ran, so nothing was paid for again");
  assert.equal(readFileSync(eventLogPath(cwd, "run-00"), "utf8"), logBefore, "the refusal writes nothing to the run's log");
});

test("a run outside the retention that finished no step has no results to lose: it is not marked, and a resume runs it", async () => {
  script.push(() => ({ status: "error", error: { message: "boom" } })); // the only attempt of the first step fails: nothing reaches the journal
  const failing = defineWorkflow({ meta: { name: "ret-fail", description: "fails" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent("never answered", { label: "work", retries: 0 }) });
  const failed = await runWorkflow(failing, {}, { cwd, runId: "never-finished" });
  assert.equal(failed.status, "failed");
  age("never-finished", 20 * DAY);

  await run("trigger");

  const resumed = await runWorkflow(wf, {}, { cwd, runId: "never-finished" });
  assert.equal(resumed.status, "finished", "nothing was pruned from it, so it resumes (from the start)");
});

test("a journal is pruned once: it keeps its modification time and is not rewritten", async () => {
  const old = await run("old-run");
  age(old, 20 * DAY);
  const file = journalFile(old);
  const stamp = statSync(file).mtimeMs;

  await run("one");
  assert.ok(isJournalPruned(old), "every line is pruned");
  assert.ok(Math.abs(statSync(file).mtimeMs - stamp) < 1, "rewriting the journal did not make it look fresh");
  const bytes = readFileSync(file, "utf8");

  await run("two");
  assert.equal(readFileSync(file, "utf8"), bytes, "nothing left to prune: the file is not rewritten");
});

test("a torn last line of a journal can hold the start of a result: pruning removes it, and the whole lines are pruned as usual", async () => {
  const old = await run("old-run");
  const fs = await import("node:fs");
  fs.appendFileSync(journalFile(old), '{"key":"torn","result":"private source of a step that was being written');
  age(old, 20 * DAY);

  await run("trigger");

  const text = readFileSync(journalFile(old), "utf8");
  assert.doesNotMatch(text, /private source/, "no part of the torn result is left");
  assert.ok(isJournalPruned(old), "the whole lines are pruned");
  await run("again");
  assert.equal(readFileSync(journalFile(old), "utf8"), text, "and the file is settled: not rewritten again");
});

test("a torn content event of an event log is removed with the other texts, and the other lines stay byte for byte", async () => {
  const old = await run("torn-content-run");
  const file = eventLogPath(cwd, old);
  const before = readEventLog(file).events;
  const fs = await import("node:fs");
  fs.appendFileSync(file, '{"v":1,"ts":"2026-01-01T00:00:00.000Z","runId":"torn-content-run","type":"content","kind":"agent-message","text":"private text that was being appen');
  age(old, 20 * DAY);

  await run("trigger");

  assert.doesNotMatch(readFileSync(file, "utf8"), /private text/, "no part of the torn text is left");
  assert.deepEqual(withoutContent(readEventLog(file).events), withoutContent(before), "every metadata event is untouched");
  assert.ok(isPruned(old));
});

test("memo entries are deleted by age alone: the days limit decides, a null days keeps them, and the runs limit does not touch them", async () => {
  seedMemo("old", 20 * DAY);
  seedMemo("recent", 1 * DAY);

  await run("a", { runs: 1, days: null });
  assert.deepEqual(memoKeys(), ["old", "recent"], "days: null keeps every memo entry, however old, and a runs limit does not apply to them");

  await run("b", { days: 30 });
  assert.deepEqual(memoKeys(), ["old", "recent"], "a 20-day-old entry is inside a 30-day limit");

  await run("c", { runs: null, days: 14 });
  assert.deepEqual(memoKeys(), ["recent"], "only the entry past the days limit goes");
});

test("a memo folder that is missing has nothing to prune, and one that cannot be listed is reported as failed, not as nothing pruned", () => {
  assert.deepEqual(pruneMemo({ memoDir: join(cwd, "no-memo") }), { pruned: [], failed: [] });
  mkdirSync(cwd, { recursive: true });
  const notAFolder = join(cwd, "memo-file");
  writeFileSync(notAFolder, "");
  const { pruned, failed } = pruneMemo({ memoDir: notAFolder });
  assert.deepEqual(pruned, []);
  assert.equal(failed.length, 1);
  assert.match(failed[0]?.error ?? "", /ENOTDIR/);
});

test("a run whose memo folder cannot be listed warns that the old memo entries could not be pruned, not that an entry could not be deleted", async () => {
  const memoDir = join(cwd, ".workflows", "memo");
  mkdirSync(memoDir, { recursive: true });
  chmodSync(memoDir, 0o000); // the folder is there, but listing it fails with EACCES
  let id: string;
  try {
    id = await run("memo-unlistable");
  } finally {
    chmodSync(memoDir, 0o700); // so afterEach can delete it
  }
  const warnings = logOf(id).filter((e) => e.type === "warning").map((e) => (e as { message: string }).message);
  const memoWarnings = warnings.filter((message) => message.includes("memo"));
  assert.equal(memoWarnings.length, 1, warnings.join("\n"));
  assert.match(memoWarnings[0] ?? "", /^could not prune the old memo entries: could not list .*EACCES/);
  assert.doesNotMatch(memoWarnings[0] ?? "", /delete|entry \*/);
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
  assert.ok(hasResults(old), "nor the results its journal served the resume from");
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
