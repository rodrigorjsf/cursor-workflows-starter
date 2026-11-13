// Seam 1, the run: `runWorkflow` with the fake Cursor SDK. Asserts on the run outcome and on the replayed per-run event
// log (`.workflows/runs/<runId>/events.jsonl`), never on internal calls.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { calls, costConfig, script, stats } from "@cursor/sdk";
import { runWorkflow } from "../src/runtime/engine.js";
import type { WorkflowEvent } from "../src/runtime/events.js";
import { eventLogPath, readEventLog, runDirPath } from "../src/runtime/run-store.js";
import { discoverWorkflows } from "../src/runtime/registry.js";
import { readRunsIndex } from "../src/runtime/runs-index.js";
import { defineWorkflow } from "../src/runtime/workflow.js";

const cwd = join(import.meta.dirname, ".tmp", `event-log-${process.pid}`); // one directory per test process
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined });
});

const logOf = (runId: string) => readEventLog(eventLogPath(cwd, runId));
const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v));

test("every event of a run is appended to the run's event log with schema version, timestamp and run id", async () => {
  const wf = defineWorkflow({
    meta: { name: "envelope", description: "envelope" },
    defaults: { model: { id: "m" } },
    async run(ctx) {
      ctx.phase("plan");
      ctx.log("hello");
      ctx.metric("tier", "LOW");
      return ctx.agent("do it", { label: "do" });
    },
  });
  const seen: WorkflowEvent[] = [];
  const r = await runWorkflow(wf, {}, { cwd, onEvent: (e) => seen.push(e) });
  assert.equal(r.status, "finished");

  const { events, skipped } = logOf(r.runId);
  assert.equal(skipped, 0);
  assert.deepEqual(
    events.map((e) => e.type),
    ["run-start", "phase", "log", "metric", "step-start", "content", "content", "turn", "step-end", "run-end"],
  );
  for (const e of events) {
    assert.equal(e.v, 1, `${e.type}: schema version`);
    assert.match(e.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, `${e.type}: timestamp`);
    assert.equal(e.runId, r.runId, `${e.type}: run id`);
  }
  assert.deepEqual(events.filter((e) => e.type !== "content"), roundTrip(seen), "the log holds exactly what listeners received, plus the step content that only the log keeps");
  assert.ok(events.some((e) => e.type === "content"), "the step's prompt is in the log");
});

type Of<T extends WorkflowEvent["type"]> = Extract<WorkflowEvent, { type: T }>;
const ofType = <T extends WorkflowEvent["type"]>(events: WorkflowEvent[], type: T) => events.filter((e): e is Of<T> => e.type === type);
/** The step-start event of the step with this label. */
const startOf = (events: WorkflowEvent[], label: string) => {
  const found = ofType(events, "step-start").filter((e) => e.label === label);
  assert.equal(found.length, 1, `exactly one step-start for ${label}`);
  return found[0]!;
};

test("ctx.card puts the workflow's card in the log, with the fields the workflow gave and none it did not, and the run-start lists the declared phases", async () => {
  const wf = defineWorkflow({
    meta: { name: "carded", description: "carded", phases: [{ title: "Triage" }, { title: "Delivery", detail: "ignored by the log" }] },
    async run(ctx) {
      ctx.card({ title: "#7 Add subtract", badges: ["LOW"] });
      ctx.card({ title: "#7 Add subtract", subtitle: "wf/issue-7", links: [{ label: "PR #9", url: "https://github.com/o/r/pull/9" }], badges: ["LOW", "2 slices"] });
      return "ok";
    },
  });
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.status, "finished", r.error);
  const { events } = logOf(r.runId);

  const cards = ofType(events, "card");
  assert.equal(cards.length, 2, "every call is an event: the board keeps the latest");
  const { v: _v, ts: _ts, runId: _runId, ...first } = roundTrip(cards[0]!);
  assert.deepEqual(first, { type: "card", title: "#7 Add subtract", badges: ["LOW"] });
  const { v: _v2, ts: _ts2, runId: _runId2, ...second } = roundTrip(cards[1]!);
  assert.deepEqual(second, {
    type: "card",
    title: "#7 Add subtract",
    subtitle: "wf/issue-7",
    links: [{ label: "PR #9", url: "https://github.com/o/r/pull/9" }],
    badges: ["LOW", "2 slices"],
  });
  assert.deepEqual(ofType(events, "run-start")[0]!.phases, ["Triage", "Delivery"], "the board's columns come from the workflow's declared phases");
});

test("ctx.card copies the fields it knows: an object with more than that never puts the rest in the log, and a workflow that edits its card afterwards changes nothing", async () => {
  const wf = defineWorkflow({
    meta: { name: "carded-copy", description: "carded-copy" },
    async run(ctx) {
      const badges = ["a"];
      const links = [{ label: "x", url: "https://example.com/x" }];
      ctx.card({ title: "t", badges, links, extra: "no" } as never);
      badges.push("late");
      links[0]!.label = "late";
      return "ok";
    },
  });
  const r = await runWorkflow(wf, {}, { cwd });
  const card = ofType(logOf(r.runId).events, "card")[0]!;
  assert.deepEqual(Object.keys(card).filter((k) => !["v", "ts", "runId", "type"].includes(k)).sort(), ["badges", "links", "title"]);
  assert.deepEqual(card.badges, ["a"]);
  assert.deepEqual(card.links, [{ label: "x", url: "https://example.com/x" }]);
});

test("step events carry step, parent and group ids; parallel and pipeline groups are identifiable from the log alone", async () => {
  const wf = defineWorkflow({
    meta: { name: "structure", description: "structure" },
    defaults: { model: { id: "m" } },
    async run(ctx) {
      await ctx.agent("a", { label: "a" });
      await ctx.parallel([() => ctx.agent("p0", { label: "p0" }), () => ctx.agent("p1", { label: "p1" })]);
      await ctx.pipeline(
        [1, 2],
        (x: number) => ctx.agent(`s1-${x}`, { label: `s1-${x}` }),
        (_prev: string, x: number) => ctx.agent(`s2-${x}`, { label: `s2-${x}` }),
      );
      await ctx.agent("z", { label: "z" });
    },
  });
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.status, "finished", r.error);
  const { events } = logOf(r.runId);

  const [par, pipe] = ofType(events, "group-start");
  assert.equal(par!.kind, "parallel");
  assert.equal(par!.size, 2);
  assert.equal(pipe!.kind, "pipeline");
  assert.equal(pipe!.size, 2);

  const a = startOf(events, "a");
  assert.equal(a.parentId, null, "the first step continues from nothing");
  assert.equal(a.groupId, null);
  assert.equal(par!.parentId, a.stepId, "the group continues from the step before it");
  assert.equal(par!.parentGroupId, null);

  for (const label of ["p0", "p1"]) {
    const s = startOf(events, label);
    assert.equal(s.groupId, par!.groupId, `${label} belongs to the parallel group`);
    assert.equal(s.parentId, par!.groupId, `${label} fans out from the group`);
  }
  assert.equal(pipe!.parentId, par!.groupId, "what follows a group continues from its join");

  for (const x of [1, 2]) {
    const first = startOf(events, `s1-${x}`);
    const second = startOf(events, `s2-${x}`);
    assert.equal(first.groupId, pipe!.groupId);
    assert.equal(first.parentId, pipe!.groupId, "an item enters the pipeline from the group");
    assert.equal(second.groupId, pipe!.groupId);
    assert.equal(second.parentId, first.stepId, "a stage continues from the previous stage of the same item");
  }

  const z = startOf(events, "z");
  assert.equal(z.groupId, null);
  assert.equal(z.parentId, pipe!.groupId, "the step after a group continues from the group");

  // The group closes after its last step ends, and the end event names the same group.
  for (const g of [par!, pipe!]) {
    const closing = ofType(events, "group-end").filter((e) => e.groupId === g.groupId);
    assert.equal(closing.length, 1);
    assert.equal(closing[0]!.ok, true);
    const lastStepEnd = Math.max(...events.map((e, i) => (e.type === "step-end" && e.groupId === g.groupId ? i : -1)));
    assert.ok(events.indexOf(closing[0]!) > lastStepEnd, "group-end comes after the group's last step-end");
  }

  // One step = one id, shared by its start, turn and end events; ids are unique across steps.
  const ids = ofType(events, "step-start").map((e) => e.stepId);
  assert.equal(new Set(ids).size, ids.length);
  for (const e of [...ofType(events, "turn"), ...ofType(events, "step-end")]) {
    const start = ofType(events, "step-start").find((s) => s.attemptId === e.attemptId)!;
    assert.deepEqual([e.stepId, e.parentId, e.groupId], [start.stepId, start.parentId, start.groupId], `${e.type} repeats its step's position`);
  }
});

test("a parallel inside a pipeline stage is a nested group", async () => {
  const wf = defineWorkflow({
    meta: { name: "nested", description: "nested" },
    defaults: { model: { id: "m" } },
    run: (ctx) =>
      ctx.pipeline([1], () => ctx.parallel([() => ctx.agent("n0", { label: "n0" }), () => ctx.agent("n1", { label: "n1" })])),
  });
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.status, "finished", r.error);
  const { events } = logOf(r.runId);
  const [outer, inner] = ofType(events, "group-start");
  assert.deepEqual([outer!.kind, inner!.kind], ["pipeline", "parallel"]);
  assert.equal(inner!.parentGroupId, outer!.groupId);
  assert.equal(inner!.parentId, outer!.groupId);
  assert.equal(startOf(events, "n0").groupId, inner!.groupId, "a step belongs to the innermost group");
});

test("a step served from the journal emits a start event as well as an end event, with the step id of the first execution", async () => {
  const wf = defineWorkflow({
    meta: { name: "served", description: "served" },
    defaults: { model: { id: "m" } },
    run: (ctx) => ctx.agent("same prompt", { label: "once" }),
  });
  const first = await runWorkflow(wf, {}, { cwd });
  const second = await runWorkflow(wf, {}, { cwd, runId: first.runId });
  assert.equal(second.runId, first.runId);

  const { events } = logOf(first.runId);
  const starts = ofType(events, "step-start");
  const ends = ofType(events, "step-end");
  assert.deepEqual(starts.map((e) => e.cached), [false, "journal"]);
  assert.deepEqual(ends.map((e) => e.cached), [false, "journal"]);
  assert.equal(starts[1]!.stepId, starts[0]!.stepId, "the same step keeps its id across executions");
  assert.equal(ends[1]!.attemptId, starts[1]!.attemptId, "the served start and end are the same attempt");
  assert.ok(events.indexOf(starts[1]!) < events.indexOf(ends[1]!), "start before end");
  assert.deepEqual(ofType(events, "run-start").length, 2, "each execution of the run opens with its own run-start");
});

test("a step served from the memo emits a start event as well as an end event", async () => {
  mkdirSync(cwd, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(cwd, "a.txt"), "1");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const wf = defineWorkflow({
    meta: { name: "memoed", description: "memoed" },
    defaults: { model: { id: "m" } },
    run: (ctx) => ctx.agent("plan", { label: "plan", tools: ["read"], memo: true }),
  });
  await runWorkflow(wf, {}, { cwd });
  const second = await runWorkflow(wf, {}, { cwd }); // a new run id: only the memo can serve the step
  assert.equal(calls.length, 1);

  const { events } = logOf(second.runId);
  const [start] = ofType(events, "step-start");
  const [end] = ofType(events, "step-end");
  assert.equal(start!.cached, "memo");
  assert.equal(end!.cached, "memo");
  assert.equal(end!.attemptId, start!.attemptId);
});

const twoSteps = defineWorkflow({
  meta: { name: "torn", description: "torn" },
  defaults: { model: { id: "m" } },
  async run(ctx) {
    const a = await ctx.agent("first", { label: "first" });
    const b = await ctx.agent("second", { label: "second" });
    return { a, b };
  },
});

/** Cuts the file mid-line, as a crash during an append would: drops the last `bytes` bytes (the newline included). */
function tear(file: string, bytes: number): void {
  const content = readFileSync(file);
  writeFileSync(file, content.subarray(0, content.length - bytes));
}

test("a journal that ends in a partial line resumes: finished steps are served, the torn one runs again", async () => {
  const first = await runWorkflow(twoSteps, {}, { cwd });
  assert.equal(calls.length, 2);
  tear(join(runDirPath(cwd, first.runId), "journal.jsonl"), 15); // the entry of "second" is now incomplete

  const resumed = await runWorkflow(twoSteps, {}, { cwd, runId: first.runId });
  assert.equal(resumed.status, "finished", resumed.error);
  assert.deepEqual(resumed.result, first.result);
  assert.equal(calls.length, 3, "only the step whose journal entry was torn runs again");

  const again = await runWorkflow(twoSteps, {}, { cwd, runId: first.runId });
  assert.equal(again.status, "finished", again.error);
  assert.equal(calls.length, 3, "the re-recorded entry is whole: a third execution serves both steps");
});

test("an event log that ends in a partial line resumes: later events are appended on their own lines", async () => {
  const first = await runWorkflow(twoSteps, {}, { cwd });
  const file = eventLogPath(cwd, first.runId);
  tear(file, 10); // the run-end event is now incomplete

  const resumed = await runWorkflow(twoSteps, {}, { cwd, runId: first.runId });
  assert.equal(resumed.status, "finished", resumed.error);
  assert.equal(calls.length, 2, "nothing runs again");

  const { events, skipped } = readEventLog(file);
  assert.equal(skipped, 1, "the torn line is skipped, nothing else");
  assert.equal(events.at(-1)!.type, "run-end", "the resumed execution's events are all readable");
  assert.equal(ofType(events, "run-start").length, 2);
  const tornWarnings = () => ofType(readEventLog(file).events, "warning").filter((w) => /line of the event log/i.test(w.message)).length;
  assert.equal(tornWarnings(), 1, "the resume says that it found a torn line");

  await runWorkflow(twoSteps, {}, { cwd, runId: first.runId });
  assert.equal(tornWarnings(), 1, "the tear is reported once, not at every later resume");
});

const oneStep = defineWorkflow({
  meta: { name: "indexed", description: "indexed" },
  defaults: { model: { id: "m" } },
  run: (ctx) => ctx.agent("one", { label: "one" }),
});

test("each run appends an entry (run id, repo path, workflow, start time) to the global runs index, once", async () => {
  const before = Date.now(); // wall-clock-ok: compared with the start time the run wrote to the index
  const first = await runWorkflow(oneStep, {}, { cwd });
  await runWorkflow(oneStep, {}, { cwd, runId: first.runId }); // a resume is the same run
  const other = await runWorkflow(oneStep, {}, { cwd });

  const entries = readRunsIndex().filter((e) => e.runId === first.runId || e.runId === other.runId);
  assert.deepEqual(entries.map((e) => e.runId), [first.runId, other.runId]);
  const [entry] = entries;
  assert.equal(entry!.repo, cwd);
  assert.equal(entry!.workflow, "indexed");
  assert.equal(entry!.v, 1);
  const started = Date.parse(entry!.startedAt);
  assert.ok(started >= before - 1000 && started <= Date.now(), `start time ${entry!.startedAt}`); // wall-clock-ok: compared with the start time the run wrote to the index
});

test("a global runs index that cannot be written warns but never fails the run", async () => {
  const previous = process.env.WF_HOME;
  const blocker = join(cwd, "not-a-directory");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(blocker, "x");
  process.env.WF_HOME = join(blocker, "home"); // a path below a regular file: creating it fails
  try {
    const events: WorkflowEvent[] = [];
    const r = await runWorkflow(oneStep, {}, { cwd, onEvent: (e) => events.push(e) });
    assert.equal(r.status, "finished", r.error);
    assert.ok(ofType(events, "warning").some((w) => /global runs index/.test(w.message)));
  } finally {
    process.env.WF_HOME = previous;
  }
});

test("resuming a run whose workflow changed records a warning event; resuming it unchanged does not", async () => {
  const v1 = defineWorkflow({
    meta: { name: "evolving", description: "evolving" },
    defaults: { model: { id: "m" } },
    async run(ctx) {
      await ctx.agent("a", { label: "a" });
      return ctx.agent("b", { label: "b", retries: 0 });
    },
  });
  const v2 = defineWorkflow({
    meta: { name: "evolving", description: "evolving" },
    defaults: { model: { id: "m" } },
    async run(ctx) {
      await ctx.agent("a", { label: "a" });
      ctx.log("a line that only version two has");
      return ctx.agent("b", { label: "b", retries: 0 });
    },
  });
  script.push(() => ({}), () => ({ status: "error", error: { message: "boom" } }));
  const failed = await runWorkflow(v1, {}, { cwd });
  assert.equal(failed.status, "failed");

  const changeWarnings = (events: WorkflowEvent[]) => ofType(events, "warning").filter((w) => /workflow code changed/.test(w.message));

  const seen: WorkflowEvent[] = [];
  const resumed = await runWorkflow(v2, {}, { cwd, runId: failed.runId, onEvent: (e) => seen.push(e) });
  assert.equal(resumed.status, "finished", resumed.error);
  const warnings = changeWarnings(logOf(failed.runId).events);
  assert.equal(warnings.length, 1);
  assert.deepEqual(changeWarnings(seen), roundTrip(warnings), "listeners get the warning too");
  const starts = ofType(logOf(failed.runId).events, "run-start");
  assert.match(warnings[0]!.message, new RegExp(`${starts[0]!.workflowHash}.*${starts[1]!.workflowHash}`), "names both versions");

  await runWorkflow(v2, {}, { cwd, runId: failed.runId });
  assert.equal(changeWarnings(logOf(failed.runId).events).length, 1, "the same code as the previous execution: no new warning");
});

test("resuming a run whose workflow's imported module changed records the code-changed warning", async () => {
  const dir = join(cwd, "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "helper.ts"), `export const answer = () => "v1";\n`);
  writeFileSync(
    join(dir, "uses-helper.ts"),
    `import { answer } from "./helper.js";\nexport default { meta: { name: "uses-helper", description: "x" }, run: async () => answer() };\n`,
  );
  const previousDir = process.env.WORKFLOWS_DIR;
  process.env.WORKFLOWS_DIR = dir;
  try {
    const load = async () => (await discoverWorkflows(cwd)).workflows.get("uses-helper")!;
    const first = await runWorkflow(await load(), {}, { cwd });
    assert.equal(first.status, "finished", first.error);

    writeFileSync(join(dir, "helper.ts"), `export const answer = () => "v2";\n`); // only the imported module changes
    await runWorkflow(await load(), {}, { cwd, runId: first.runId });
    const changeWarnings = ofType(logOf(first.runId).events, "warning").filter((w) => /workflow code changed/.test(w.message));
    assert.equal(changeWarnings.length, 1);
  } finally {
    if (previousDir === undefined) delete process.env.WORKFLOWS_DIR;
    else process.env.WORKFLOWS_DIR = previousDir;
  }
});

test("a group that a fatal error aborts is closed with ok=false, and the run fails", async () => {
  const wf = defineWorkflow({
    meta: { name: "aborted", description: "aborted" },
    defaults: { model: { id: "m" } },
    run: (ctx) => ctx.parallel([() => ctx.agent("a", { label: "a" }), () => ctx.agent("b", { label: "b" }), () => ctx.agent("c", { label: "c" })]),
  });
  const r = await runWorkflow(wf, {}, { cwd, concurrency: 1, maxCents: 5 }); // the fake charges 9¢ per step: the second step hits the cap
  assert.equal(r.status, "failed");
  assert.match(r.error!, /Cost cap reached/);
  const { events } = logOf(r.runId);
  const [group] = ofType(events, "group-start");
  const closing = ofType(events, "group-end").filter((e) => e.groupId === group!.groupId);
  assert.deepEqual(closing.map((e) => e.ok), [false]);
});

test("a metrics recorder that cannot start is reported after the run-start, not before it", async () => {
  const previous = process.env.WF_METRICS;
  delete process.env.WF_METRICS;
  mkdirSync(cwd, { recursive: true });
  const blocker = join(cwd, "not-a-directory");
  writeFileSync(blocker, "x");
  try {
    const r = await runWorkflow(oneStep, {}, { cwd, metricsDb: join(blocker, "metrics.db") });
    assert.equal(r.status, "finished", r.error);
    const { events } = logOf(r.runId);
    assert.equal(events[0]!.type, "run-start", "every execution of the log opens with its run-start");
    assert.ok(ofType(events, "warning").some((w) => /metrics off/.test(w.message)));
  } finally {
    process.env.WF_METRICS = previous;
  }
});
