// Seam 1, the run: cancelling a run through `RunOptions.signal` (what `wf cancel`, `cancel_workflow`, SIGINT and SIGTERM
// all end up doing). Asserts on the run outcome, the replayed event log, the job projection and the files in the working
// directory, with the fake Cursor SDK.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { calls, costConfig, script, stats } from "@cursor/sdk";
import { type WorkflowEvent, runWorkflow } from "../src/runtime/engine.js";
import { startJob, readJob } from "../src/runtime/jobs.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { defineWorkflow } from "../src/runtime/workflow.js";

// The run's own directory is outside this project's repository: a cancelled write step reverts its directory through git,
// and inside the repo that would be the project's own files and index.
const cwd = mkdtempSync(join(tmpdir(), "wf-cancel-run-"));
afterEach(() => {
  rmSync(join(cwd, ".workflows"), { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0, cancelled: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined, createHang: undefined, createDelayMs: undefined });
});

after(() => rmSync(cwd, { recursive: true, force: true }));

const eventsOf = (runId: string) => readEventLog(eventLogPath(cwd, runId)).events;
const model = { id: "m" };

/** A workflow of one step that hangs until cancelled, then (on a resume) finishes. */
const oneStep = defineWorkflow({
  meta: { name: "one-step", description: "one step" },
  defaults: { model },
  async run(ctx) {
    ctx.phase("work");
    return { status: "done", answer: await ctx.agent("do it", { label: "do", retries: 0, timeoutMs: 5000 }) };
  },
});

/** Aborts the run as soon as its first step starts, the way `wf cancel` finds a run in the middle of a step. */
function abortOnFirstStep(controller: AbortController): (e: WorkflowEvent) => void {
  return (e) => {
    if (e.type === "step-start" && !e.cached) setTimeout(() => controller.abort(), 10);
  };
}

test("aborting the signal cancels the active agent run, ends the run as cancelled and leaves it resumable", async () => {
  script.push(() => ({ hang: true }));
  const controller = new AbortController();
  const outcome = await runWorkflow(oneStep, {}, { cwd, runId: "r1", signal: controller.signal, onEvent: abortOnFirstStep(controller) });

  assert.equal(outcome.status, "cancelled");
  assert.match(outcome.error!, /cancelado/);
  assert.match(outcome.error!, /resumeRunId="r1"/, "the outcome tells how to resume");
  assert.equal(stats.cancelled, 1, "the agent run was cancelled");
  assert.equal(stats.disposed, 1, "the agent was disposed");

  const log = eventsOf("r1");
  const end = log.findLast((e) => e.type === "run-end");
  assert.ok(end && end.type === "run-end" && end.status === "cancelled");
  const stepEnd = log.find((e) => e.type === "step-end");
  assert.ok(stepEnd && stepEnd.type === "step-end" && !stepEnd.ok && stepEnd.errorKind === "cancelled");
  assert.ok(!existsSync(join(cwd, ".workflows", "runs", "r1", "run.lock")), "the lock is released");

  // The run is resumable: the step that was cancelled runs again, the budget keeps what the cancelled attempt spent.
  const resumed = await runWorkflow(oneStep, {}, { cwd, runId: "r1" });
  assert.equal(resumed.status, "finished");
  assert.equal(resumed.spentCents, 18, "9 cents of the cancelled attempt plus 9 of the new one");
  assert.equal(resumed.spentTokens, 220);
});

test("a signal already aborted starts no agent: the run ends cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  const outcome = await runWorkflow(oneStep, {}, { cwd, runId: "r-pre", signal: controller.signal });
  assert.equal(outcome.status, "cancelled");
  assert.equal(calls.length, 0);
});

test("cancelling while the agent is still being created ends the run at once, and the agent that arrives late is disposed", async () => {
  costConfig.createDelayMs = 300;
  const controller = new AbortController();
  const startedAt = Date.now();
  const outcome = await runWorkflow(oneStep, {}, { cwd, runId: "r-create", signal: controller.signal, onEvent: abortOnFirstStep(controller) });
  assert.equal(outcome.status, "cancelled");
  assert.ok(Date.now() - startedAt < 250, "the run did not wait for the creation");
  assert.equal(stats.disposed, 0, "the agent does not exist yet");
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(stats.disposed, 1, "the agent that arrived late was disposed, not left running");
});

test("a creation that never answers fails the step on its timeout instead of hanging the run", async () => {
  costConfig.createHang = true;
  const wf = defineWorkflow({
    meta: { name: "create-hang", description: "create hangs" },
    defaults: { model },
    run: (ctx) => ctx.agent("x", { label: "x", retries: 0, timeoutMs: 100 }),
  });
  const outcome = await runWorkflow(wf, {}, { cwd, runId: "r-create-timeout" });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error!, /timeout após 100 ms/);
  const stepEnd = eventsOf("r-create-timeout").find((e) => e.type === "step-end");
  assert.ok(stepEnd && stepEnd.type === "step-end" && stepEnd.errorKind === "timeout");
});

test("schema re-prompts share the step timeout instead of restarting it", async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  script.push(async () => (await sleep(250), { status: "finished", result: "no submit_result call" })); // the re-prompt follows
  script.push(() => ({ hang: true }));
  const wf = defineWorkflow({
    meta: { name: "reprompt-timeout", description: "reprompt" },
    defaults: { model },
    run: (ctx) => ctx.agent("x", { label: "x", retries: 0, timeoutMs: 400, schema: { type: "object", properties: { a: { type: "string" } } } }),
  });
  const outcome = await runWorkflow(wf, {}, { cwd, runId: "r-reprompt" });
  assert.equal(outcome.status, "failed");
  const stepEnd = eventsOf("r-reprompt").find((e) => e.type === "step-end");
  assert.ok(stepEnd && stepEnd.type === "step-end" && stepEnd.errorKind === "timeout");
  assert.ok(stepEnd.durationMs! < 600, `the re-prompt had the rest of the 400 ms, not a fresh 400 ms (took ${stepEnd.durationMs} ms)`);
  assert.equal(stats.cancelled, 1, "the hung re-prompt run was cancelled");
});

test("every branch of a parallel is cancelled, and the run ends cancelled", async () => {
  script.push(() => ({ hang: true }), () => ({ hang: true }));
  const wf = defineWorkflow({
    meta: { name: "wide", description: "two hung branches" },
    defaults: { model },
    run: (ctx) => ctx.parallel([() => ctx.agent("a", { label: "a", retries: 0, timeoutMs: 5000 }), () => ctx.agent("b", { label: "b", retries: 0, timeoutMs: 5000 })]),
  });
  const controller = new AbortController();
  let started = 0;
  const outcome = await runWorkflow(wf, {}, {
    cwd,
    runId: "r-wide",
    signal: controller.signal,
    onEvent: (e) => {
      if (e.type === "step-start" && ++started === 2) setTimeout(() => controller.abort(), 10);
    },
  });
  assert.equal(outcome.status, "cancelled");
  assert.equal(stats.cancelled, 2);
  assert.equal(stats.disposed, 2);
  const ends = eventsOf("r-wide").filter((e) => e.type === "step-end");
  assert.deepEqual(ends.map((e) => e.type === "step-end" && e.errorKind), ["cancelled", "cancelled"]);
});

test("a workflow that catches the error of a cancelled step still ends cancelled, and starts no further step", async () => {
  script.push(() => ({ hang: true }));
  const wf = defineWorkflow({
    meta: { name: "swallow", description: "catch-all" },
    defaults: { model },
    async run(ctx) {
      try {
        await ctx.agent("a", { label: "a", retries: 0, timeoutMs: 5000 });
      } catch {
        /* swallowed */
      }
      await ctx.agent("b", { label: "b" }).catch(() => {});
      return { status: "done" };
    },
  });
  const controller = new AbortController();
  const outcome = await runWorkflow(wf, {}, { cwd, runId: "r-swallow", signal: controller.signal, onEvent: abortOnFirstStep(controller) });
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.result, undefined, "the partial result of a cancelled run is not reported");
  assert.equal(calls.length, 1, "the step after the cancellation never created an agent");
});

test("a workflow stuck outside any step still ends when the run is cancelled", async () => {
  const wf = defineWorkflow({
    meta: { name: "stuck", description: "waits for nothing" },
    defaults: { model },
    run: () => new Promise<never>(() => {}),
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const outcome = await runWorkflow(wf, {}, { cwd, runId: "r-stuck", signal: controller.signal });
  assert.equal(outcome.status, "cancelled");
});

test("a cancelled job projects as cancelled with its run id, and a waiter stops waiting", async () => {
  script.push(() => ({ hang: true }));
  const controller = new AbortController();
  const { job, done } = startJob(oneStep, {}, { cwd, signal: controller.signal, onEvent: abortOnFirstStep(controller) });
  const state = await done;
  assert.equal(state.status, "cancelled");
  assert.equal(state.runId, job.runId);
  assert.match(state.error!, new RegExp(`resumeRunId="${job.runId}"`));
  assert.equal(readJob(cwd, job.jobId)!.status, "cancelled");
  assert.ok(state.finishedAt);
});

// --- the in-flight write step is reverted ---------------------------------------------------------------------------

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8" });
const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const repos: string[] = [];
afterEach(() => repos.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A throwaway git repository outside this project (a repo nested in it would answer for the project's own files). */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-cancel-repo-"));
  repos.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "tracked.txt"), "original\n");
  writeFileSync(join(dir, "other.txt"), "other\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** A workflow whose only step edits `repo` the way an agent would, then hangs until the run is cancelled. */
function writerIn(repo: string, tools?: Array<"read">) {
  return defineWorkflow({
    meta: { name: "writer", description: "writes, then hangs" },
    defaults: { model },
    run: (ctx) => ctx.agent("edit things", { label: "write", cwd: repo, retries: 0, timeoutMs: 5000, tools }),
  });
}

test("cancelling in the middle of a write step puts the working directory and the index back as they were before the step", async () => {
  const repo = makeRepo();
  // What the user had before the run: an uncommitted edit, an untracked file, a staged change, an ignored file.
  writeFileSync(join(repo, "other.txt"), "user edit\n");
  writeFileSync(join(repo, "notes.txt"), "mine\n");
  writeFileSync(join(repo, "staged.txt"), "staged by the user\n");
  git(repo, "add", "staged.txt");
  writeFileSync(join(repo, "ignored.log"), "ignored\n");
  const statusBefore = git(repo, "status", "--porcelain");
  const indexBefore = git(repo, "write-tree");

  script.push(() => {
    // The agent: edits a tracked file, deletes one, creates files in new directories, stages it all.
    writeFileSync(join(repo, "tracked.txt"), "changed by the step\n");
    rmSync(join(repo, "other.txt"));
    mkdirSync(join(repo, "sub", "deep"), { recursive: true });
    writeFileSync(join(repo, "sub", "deep", "new.txt"), "new\n");
    writeFileSync(join(repo, "new.txt"), "new\n");
    git(repo, "add", "-A");
    return { hang: true };
  });
  const controller = new AbortController();
  const outcome = await runWorkflow(writerIn(repo), {}, { cwd, runId: "r-revert", signal: controller.signal, onEvent: abortOnFirstStep(controller) });

  assert.equal(outcome.status, "cancelled");
  assert.equal(read(repo, "tracked.txt"), "original\n");
  assert.equal(read(repo, "other.txt"), "user edit\n", "the user's own edit is part of the state before the step");
  assert.equal(read(repo, "notes.txt"), "mine\n");
  assert.equal(read(repo, "ignored.log"), "ignored\n", "ignored files are left alone");
  assert.ok(!existsSync(join(repo, "new.txt")));
  assert.ok(!existsSync(join(repo, "sub")), "directories the step created are gone");
  assert.equal(git(repo, "status", "--porcelain"), statusBefore, "git sees the repository exactly as before the step");
  assert.equal(git(repo, "write-tree"), indexBefore, "the index is back too");

  const stepEnd = eventsOf("r-revert").find((e) => e.type === "step-end");
  assert.ok(stepEnd && stepEnd.type === "step-end" && stepEnd.reverted === true);
});

test("a revert restores bytes exactly: CRLF files under core.autocrlf and text=auto, the executable bit, a symlink", async () => {
  const repo = makeRepo();
  git(repo, "config", "core.autocrlf", "true");
  writeFileSync(join(repo, ".gitattributes"), "* text=auto\n");
  writeFileSync(join(repo, "crlf.txt"), "one\r\ntwo\r\n");
  writeFileSync(join(repo, "run.sh"), "#!/bin/sh\n");
  chmodSync(join(repo, "run.sh"), 0o755);
  symlinkSync("tracked.txt", join(repo, "link"));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "more");
  writeFileSync(join(repo, "crlf.txt"), "one\r\ntwo\r\nthree\r\n"); // the user's uncommitted edit, line endings included
  const before = { crlf: readFileSync(join(repo, "crlf.txt")), run: readFileSync(join(repo, "run.sh")) };

  script.push(() => {
    writeFileSync(join(repo, "crlf.txt"), "rewritten\n");
    writeFileSync(join(repo, "run.sh"), "changed\n");
    chmodSync(join(repo, "run.sh"), 0o644);
    rmSync(join(repo, "link"));
    symlinkSync("elsewhere", join(repo, "link"));
    return { hang: true };
  });
  const controller = new AbortController();
  await runWorkflow(writerIn(repo), {}, { cwd, runId: "r-bytes", signal: controller.signal, onEvent: abortOnFirstStep(controller) });

  assert.deepEqual(readFileSync(join(repo, "crlf.txt")), before.crlf, "the CRLF bytes are the ones from before the step");
  assert.deepEqual(readFileSync(join(repo, "run.sh")), before.run);
  assert.equal(statSync(join(repo, "run.sh")).mode & 0o111, 0o111, "executable again");
  assert.equal(readlinkSync(join(repo, "link")), "tracked.txt");
});

test("cancelling a write step in a directory that is not a git repository says nothing was reverted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-cancel-plain-"));
  repos.push(dir);
  writeFileSync(join(dir, "f.txt"), "before\n");
  script.push(() => {
    writeFileSync(join(dir, "f.txt"), "after\n");
    return { hang: true };
  });
  const controller = new AbortController();
  const outcome = await runWorkflow(writerIn(dir), {}, { cwd, runId: "r-plain", signal: controller.signal, onEvent: abortOnFirstStep(controller) });

  assert.equal(outcome.status, "cancelled");
  assert.equal(read(dir, "f.txt"), "after\n", "nothing could be reverted");
  const log = eventsOf("r-plain");
  assert.ok(log.some((e) => e.type === "warning" && /não é um repositório git/.test(e.message) && e.message.includes(dir)));
  const stepEnd = log.find((e) => e.type === "step-end");
  assert.ok(stepEnd && stepEnd.type === "step-end" && stepEnd.reverted === undefined);
});

test("a step that only reads is never reverted", async () => {
  const repo = makeRepo();
  script.push(() => {
    writeFileSync(join(repo, "tracked.txt"), "touched\n"); // a read-only step cannot do this; the test only shows the engine leaves it alone
    return { hang: true };
  });
  const controller = new AbortController();
  const outcome = await runWorkflow(writerIn(repo, ["read"]), {}, { cwd, runId: "r-read", signal: controller.signal, onEvent: abortOnFirstStep(controller) });
  assert.equal(outcome.status, "cancelled");
  assert.equal(read(repo, "tracked.txt"), "touched\n");
  assert.ok(!eventsOf("r-read").some((e) => e.type === "warning"), "and it does not warn about a revert it never attempted");
});

test("only the in-flight write step is reverted: a step that completed before the cancel keeps its work", async () => {
  const repo = makeRepo();
  const wf = defineWorkflow({
    meta: { name: "two-writes", description: "one step completes, the next hangs" },
    defaults: { model },
    async run(ctx) {
      await ctx.agent("first", { label: "first", cwd: repo, retries: 0 });
      await ctx.agent("second", { label: "second", cwd: repo, retries: 0, timeoutMs: 5000 });
    },
  });
  script.push(() => {
    writeFileSync(join(repo, "first.txt"), "kept\n");
    return { status: "finished", result: "ok" };
  });
  script.push(() => {
    writeFileSync(join(repo, "second.txt"), "reverted\n");
    return { hang: true };
  });
  const controller = new AbortController();
  const outcome = await runWorkflow(wf, {}, {
    cwd,
    runId: "r-two",
    signal: controller.signal,
    onEvent: (e) => {
      if (e.type === "step-start" && e.label === "second") setTimeout(() => controller.abort(), 10);
    },
  });
  assert.equal(outcome.status, "cancelled");
  assert.equal(read(repo, "first.txt"), "kept\n", "the completed step's work is in the journal and stays on disk");
  assert.ok(!existsSync(join(repo, "second.txt")));
});
