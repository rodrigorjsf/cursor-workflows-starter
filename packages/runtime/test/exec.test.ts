// Seam 1, the run: `ctx.exec` runs a command a workflow needs (tests, git, gh) asynchronously, with a timeout, streams its
// output into the run's event log and records the call as a step node. Runs `runWorkflow` with the fake Cursor SDK against a
// real child process and asserts on what the workflow gets back and on the replayed event log.
import assert from "node:assert/strict";
import "./isolate-home.js";
import { spawn } from "node:child_process";
import { existsSync as existsSyncSafe, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { calls, costConfig, script, stats } from "./fake-sdk.js";
import { runWorkflow } from "../src/runtime/engine.js";
import type { ContentEvent, ExecEndEvent, ExecStartEvent, WorkflowEvent } from "../src/runtime/events.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { runStartOf, writeRepoConfig } from "./config-fixtures.js";
import { type ExecResult, type WorkflowContext, defineWorkflow } from "../src/runtime/workflow.js";

let dir: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-exec-"));
  cwd = join(dir, "repo");
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined });
});

/** A workflow whose only job is to run `body` and return what it returns. */
const workflow = <R>(run: (ctx: WorkflowContext) => Promise<R>) =>
  defineWorkflow<unknown, R>({ meta: { name: "execwf", description: "exec" }, defaults: { model: { id: "m" } }, run });

/** `node -e <code>` as a `ctx.exec` call: the one portable way to produce a given output and exit code. */
const node = (code: string): [string, string[]] => [process.execPath, ["-e", code]];

test("ctx.exec returns the exit code and the output of a command that succeeds", async () => {
  const wf = workflow(async (ctx) => ctx.exec(...node("process.stdout.write('hello\\n')")));
  const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  assert.equal(r.status, "finished");
  assert.deepEqual(r.result, { ok: true, exitCode: 0, timedOut: false, tail: "hello\n" });
});

test("env adds variables to the process's own, and undefined removes one (a nested `node --test` must not see NODE_TEST_CONTEXT)", async () => {
  process.env.EXEC_TEST_INHERITED = "inherited";
  try {
    const code = "process.stdout.write(JSON.stringify([process.env.EXEC_TEST_INHERITED, process.env.EXEC_TEST_ADDED ?? null]))";
    const wf = workflow(async (ctx) => [
      (await ctx.exec(...node(code), { env: { EXEC_TEST_ADDED: "added" } })).tail,
      (await ctx.exec(...node(code), { env: { EXEC_TEST_INHERITED: undefined } })).tail,
    ]);
    const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
    assert.deepEqual(r.result, ['["inherited","added"]', "[null,null]"]);
  } finally {
    delete process.env.EXEC_TEST_INHERITED;
  }
});

test("a command that exits non-zero is a result, not an error: the workflow decides what it means", async () => {
  const wf = workflow(async (ctx) => ctx.exec(...node("process.stdout.write('out\\n'); process.stderr.write('boom\\n'); process.exit(3)")));
  const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  assert.equal(r.status, "finished");
  const result = r.result as ExecResult;
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
  assert.match(result.tail, /out\n/);
  assert.match(result.tail, /boom\n/);
});

test("a command that cannot start is a result too: no exit code, and why", async () => {
  const wf = workflow(async (ctx) => ctx.exec("definitely-not-a-command-wf", ["x"]));
  const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  assert.equal(r.status, "finished");
  const result = r.result as ExecResult;
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.match(result.error!, /ENOENT/);
});

test("the command runs in the cwd and the env the call asks for", async () => {
  writeFileSync(join(cwd, "marker.txt"), "here");
  const wf = workflow(async (ctx) =>
    ctx.exec(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync('marker.txt','utf8') + process.env.EXEC_TEST_VAR)"], { env: { EXEC_TEST_VAR: "-and-env" } }),
  );
  const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  assert.equal((r.result as ExecResult).tail, "here-and-env");
});

const eventsOf = (runId: string): WorkflowEvent[] => readEventLog(eventLogPath(cwd, runId)).events;
const execStarts = (events: WorkflowEvent[]) => events.filter((e): e is ExecStartEvent => e.type === "exec-start");
const execEnds = (events: WorkflowEvent[]) => events.filter((e): e is ExecEndEvent => e.type === "exec-end");

test("each call is a step node: it continues from the step before it, and the step after continues from it", async () => {
  const wf = workflow(async (ctx) => {
    await ctx.agent("first", { label: "first" });
    const tests = await ctx.exec(...node("process.stdout.write('ok')"), { label: "tests" });
    await ctx.agent("second", { label: "second" });
    return tests.ok;
  });
  const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  assert.equal(r.status, "finished");

  const events = eventsOf(r.runId);
  const stepStarts = events.filter((e) => e.type === "step-start");
  const [start] = execStarts(events);
  const [end] = execEnds(events);
  assert.ok(start && end && stepStarts.length === 2);
  assert.equal(start.label, "tests");
  assert.equal(start.command, process.execPath);
  assert.equal(start.groupId, null);
  assert.equal(start.parentId, stepStarts[0]!.stepId, "continues from the step before it");
  assert.equal(stepStarts[1]!.parentId, start.stepId, "the next step continues from the command");
  assert.equal(end.stepId, start.stepId);
  assert.equal(end.attemptId, start.attemptId);
  assert.deepEqual([end.parentId, end.groupId, end.label, end.command], [start.parentId, start.groupId, "tests", process.execPath]);
  assert.equal(end.ok, true);
  assert.equal(end.outcome, "exit");
  assert.equal(end.exitCode, 0);
  assert.equal(end.outputChars, 2);
  assert.ok(end.durationMs >= 0);
  const order = events.map((e) => e.type);
  assert.ok(order.indexOf("step-end") < order.indexOf("exec-start") && order.indexOf("exec-end") < order.lastIndexOf("step-start"));
});

test("calls inside a parallel group carry its group id and continue from it; a failed command ends its node as not ok", async () => {
  const wf = workflow(async (ctx) => {
    await ctx.parallel([() => ctx.exec(...node("0"), { label: "a" }), () => ctx.exec(...node("process.exit(2)"), { label: "b" })]);
    await ctx.exec(...node("0"), { label: "after" });
  });
  const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  assert.equal(r.status, "finished");

  const events = eventsOf(r.runId);
  const group = events.find((e) => e.type === "group-start");
  assert.ok(group && group.type === "group-start");
  const starts = execStarts(events);
  assert.deepEqual(starts.map((e) => [e.label, e.groupId, e.parentId]), [["a", group.groupId, group.groupId], ["b", group.groupId, group.groupId], ["after", null, group.groupId]]);
  assert.equal(new Set(starts.map((e) => e.stepId)).size, 3, "three nodes");
  const b = execEnds(events).find((e) => e.label === "b")!;
  assert.deepEqual([b.ok, b.outcome, b.exitCode], [false, "exit", 2]);
});

test("the same call made twice is two nodes; a resume numbers them the same way", async () => {
  const wf = workflow(async (ctx) => {
    await ctx.exec(...node("0"), { label: "again" });
    await ctx.exec(...node("0"), { label: "again" });
  });
  const first = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  const second = await runWorkflow(wf, {}, { cwd, metricsDb: false, runId: first.runId });
  assert.equal(second.status, "finished");
  const ids = execStarts(eventsOf(first.runId)).map((e) => e.stepId);
  assert.equal(ids.length, 4, "a resume runs the commands again: exec is not journaled");
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(ids.slice(2), ids.slice(0, 2));
});

test("listeners see the command's start and end, never its output", async () => {
  const seen: WorkflowEvent[] = [];
  const wf = workflow(async (ctx) => (await ctx.exec(...node("process.stdout.write('OUTPUT-MARKER')"))).ok); // the result is the workflow's to return: only the output is content
  const r = await runWorkflow(wf, {}, { cwd, metricsDb: false, onEvent: (e) => seen.push(e) });
  assert.equal(r.status, "finished");
  assert.deepEqual(seen.map((e) => e.type).filter((t) => t.startsWith("exec") || t === "content"), ["exec-start", "exec-end"]);
  assert.ok(!JSON.stringify(seen).includes("OUTPUT-MARKER"));
});

const contentOf = (events: WorkflowEvent[]) => events.filter((e): e is ContentEvent => e.type === "content");
const outputText = (events: WorkflowEvent[], stream: "stdout" | "stderr") =>
  contentOf(events).filter((c) => c.kind === "command-output" && c.stream === stream).map((c) => c.text ?? "").join("");
const sleepJs = (ms: number) => `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});`;

test("the output is content of the command's node: stdout and stderr apart, after the command line and before the end", async () => {
  const code = "process.stdout.write('to out\\n'); process.stderr.write('to err\\n')";
  const wf = workflow(async (ctx) => (await ctx.exec(...node(code), { label: "talk" })).ok);
  const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  assert.equal(r.status, "finished");

  const events = eventsOf(r.runId);
  const [start] = execStarts(events);
  const content = contentOf(events);
  assert.ok(start);
  assert.deepEqual(content.map((c) => c.kind), ["tool-call", "command-output", "command-output"]);
  assert.deepEqual(content.slice(1).map((c) => [c.tool, c.callId, c.stream]).sort(), [["exec", start.attemptId, "stderr"], ["exec", start.attemptId, "stdout"]]);
  assert.deepEqual([content[0]!.tool, content[0]!.callId], ["exec", start.attemptId]);
  assert.deepEqual(JSON.parse(content[0]!.text!), { command: process.execPath, args: ["-e", code], cwd });
  assert.equal(outputText(events, "stdout"), "to out\n");
  assert.equal(outputText(events, "stderr"), "to err\n");
  for (const c of content) {
    assert.deepEqual([c.stepId, c.parentId, c.groupId, c.attemptId], [start.stepId, start.parentId, start.groupId, start.attemptId], `${c.kind}: the node it belongs to`);
    assert.equal(c.chars, c.text!.length);
  }
  const order = events.map((e) => e.type);
  assert.ok(order.indexOf("exec-start") < order.indexOf("content") && order.lastIndexOf("content") < order.indexOf("exec-end"));
});

test("the output reaches the log while the command is still running", async () => {
  const wf = workflow(async (ctx) => (await ctx.exec(...node(`process.stdout.write('first\\n'); ${sleepJs(1500)} process.stdout.write('second\\n')`))).ok);
  const running = runWorkflow(wf, {}, { cwd, metricsDb: false, runId: "streaming" });
  const early = await until("the first line in the log", () => {
    try {
      return outputText(eventsOf("streaming"), "stdout").includes("first") ? eventsOf("streaming") : undefined;
    } catch {
      return undefined; // the log does not exist yet
    }
  });
  assert.equal(execEnds(early).length, 0, "the command had not ended");
  assert.ok(!outputText(early, "stdout").includes("second"));
  const r = await running;
  assert.equal(r.status, "finished");
  assert.equal(outputText(eventsOf("streaming"), "stdout"), "first\nsecond\n");
});

test("secrets are redacted from the output in the log, also one split across two writes; the workflow still gets the real output", async () => {
  const token = `ghp_${"a1B2".repeat(9)}`; // 36 characters after the prefix: the shape of a GitHub token
  const [one, two] = [token.slice(0, 20), token.slice(20)];
  process.env.EXEC_TEST_API_KEY = "env-secret-value-1234";
  try {
    // The halves travel in the env: the command line (logged too) must not carry them. The pause after the stderr write keeps the
    // two pipes' arrival order fixed, so the real output has the token whole.
    const code = `const e = process.env; process.stdout.write(e.ONE + e.TWO + '\\n'); process.stderr.write(e.EXEC_TEST_API_KEY + '\\n'); ${sleepJs(300)} process.stdout.write('split ' + e.ONE); ${sleepJs(600)} process.stdout.write(e.TWO + '\\n');`;
    // The workflow returns a flag, not the tail: a result is the workflow's to return, and the tail is real output.
    const wf = workflow(async (ctx) => (await ctx.exec(...node(code), { label: "leaky", env: { ONE: one, TWO: two } })).tail.includes(token));
    const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
    assert.equal(r.status, "finished");
    const events = eventsOf(r.runId);
    const log = JSON.stringify(events);
    assert.ok(!log.includes(token) && !log.includes(one) && !log.includes(two), "the token, or a half of it, is in no event");
    assert.ok(!log.includes("env-secret-value-1234"), "the value of a secret-named variable is not in the log");
    assert.equal(outputText(events, "stdout"), "[REDACTED]\nsplit [REDACTED]\n");
    assert.equal(outputText(events, "stderr"), "[REDACTED]\n");
    assert.equal(r.result, true, "the call's tail is the real output");
  } finally {
    delete process.env.EXEC_TEST_API_KEY;
  }
});

test("the value of a secret-named variable the command runs with is redacted from its output: one passed in the call's env, and one the workflow set after the run started", async () => {
  const passed = "passed-only-in-exec-env-42";
  const late = "set-in-process-env-late-42";
  try {
    const wf = workflow(async (ctx) => {
      process.env.EXEC_TEST_LATE_TOKEN = late; // after the run opened its log
      return (await ctx.exec(...node("process.stdout.write(process.env.MY_TOKEN + ' ' + process.env.EXEC_TEST_LATE_TOKEN + '\\n')"), { env: { MY_TOKEN: passed } })).tail;
    });
    const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
    assert.equal(r.status, "finished", r.error);
    assert.equal(r.result, `${passed} ${late}\n`, "the workflow gets the real output");
    const log = readFileSync(eventLogPath(cwd, r.runId), "utf8");
    assert.ok(!log.includes(passed), "the secret passed in ExecOptions.env is not in the log");
    assert.ok(!log.includes(late), "the secret set in process.env after the run started is not in the log");
    assert.equal(outputText(eventsOf(r.runId), "stdout"), "[REDACTED] [REDACTED]\n");
  } finally {
    delete process.env.EXEC_TEST_LATE_TOKEN;
  }
});

test("a private key block written across several reads is redacted whole, not only its first piece", async () => {
  const env = { BEGIN: "-----BEGIN RSA PRIVATE KEY-----", END: "-----END RSA PRIVATE KEY-----", L1: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7", L2: "VwnRmTqDyH3Yp0Hn5cJd0k2yQ9Lr8XgS1eT4uZb7NfW6aMiOvPxK" };
  const code = `const e = process.env; process.stdout.write('before\\n' + e.BEGIN + '\\n' + e.L1 + '\\n'); ${sleepJs(600)} process.stdout.write(e.L2 + '\\n' + e.END + '\\nafter\\n');`;
  const r = await runWorkflow(workflow((ctx) => ctx.exec(...node(code), { env })), {}, { cwd, metricsDb: false });
  const events = eventsOf(r.runId);
  const log = JSON.stringify(events);
  assert.ok(!log.includes(env.L1) && !log.includes(env.L2), "no line of the key is in the log");
  assert.equal(outputText(events, "stdout"), "before\n[REDACTED]\nafter\n");
});

test("a batch longer than an event holds is cut between lines, so a token is never cut in two", async () => {
  const token = `ghp_${"a1B2".repeat(9)}`;
  // 327 lines of 100 characters, then a line whose token starts at offset 32750 of the batch and so straddles the 32768 cut.
  const code = `const e = process.env; process.stdout.write(('x'.repeat(99) + '\\n').repeat(327) + 'y'.repeat(50) + e.TOKEN_SHAPE + ' end\\n' + 'z'.repeat(40000) + '\\n');`;
  const r = await runWorkflow(workflow((ctx) => ctx.exec(...node(code), { env: { TOKEN_SHAPE: token } })), {}, { cwd, metricsDb: false });
  const events = eventsOf(r.runId);
  const text = outputText(events, "stdout");
  assert.ok(!JSON.stringify(events).includes(token.slice(0, 20)) && !JSON.stringify(events).includes(token.slice(20)), "no part of the token is in the log");
  assert.ok(text.includes(`${"y".repeat(50)}[REDACTED] end\n`));
  assert.ok(text.endsWith(`${"z".repeat(40000)}\n`), "an over-long line is still written whole");
});

test("the numbering of the same call in parallel branches does not depend on which branch gets there first", async () => {
  const wf = workflow(async (ctx) => {
    const slow = (ctx.args as { slow: number }).slow;
    await ctx.parallel([0, 1].map((i) => async () => {
      await new Promise((r) => setTimeout(r, slow === i ? 300 : 0));
      return ctx.exec(...node("0"), { label: `branch-${i}` });
    }));
  });
  const first = await runWorkflow(wf, { slow: 0 }, { cwd, metricsDb: false });
  const second = await runWorkflow(wf, { slow: 1 }, { cwd, metricsDb: false, runId: first.runId });
  assert.equal(second.status, "finished");
  const starts = execStarts(eventsOf(first.runId));
  assert.equal(starts.length, 4);
  const idOf = (execution: ExecStartEvent[], label: string) => execution.find((e) => e.label === label)!.stepId;
  for (const label of ["branch-0", "branch-1"]) assert.equal(idOf(starts.slice(2), label), idOf(starts.slice(0, 2), label), `${label} keeps its id across executions`);
  assert.notEqual(idOf(starts, "branch-0"), idOf(starts, "branch-1"), "the branches are two nodes");
});

test("a process the command left running, holding its output, is killed when the call ends: nothing outlives the call", async () => {
  const r = await runWorkflow(workflow((ctx) => ctx.exec("bash", ["-c", "sleep 60 & echo $!"], { label: "leaves-one" })), {}, { cwd, metricsDb: false });
  const result = r.result as ExecResult;
  assert.equal(result.ok, true, "the command itself exited 0");
  const child = Number(result.tail.trim());
  assert.ok(child > 1);
  await expectGone(child, "the call");
});

test("a command has no stdin and no terminal: whatever would wait for someone to type (a credential prompt) fails at once", async () => {
  const started = performance.now();
  const wf = workflow(async (ctx) => [await ctx.exec("bash", ["-c", "cat; echo read-stdin-ended"], { label: "stdin", timeoutMs: 20_000 }), await ctx.exec("bash", ["-c", "echo asking > /dev/tty"], { label: "tty", timeoutMs: 20_000 })] as const);
  const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  const [stdin, tty] = r.result as [ExecResult, ExecResult];
  assert.deepEqual([stdin.ok, stdin.tail], [true, "read-stdin-ended\n"], "stdin is empty, not an open terminal");
  assert.equal(tty.ok, false, "there is no controlling terminal to open");
  assert.equal(tty.timedOut, false);
  assert.ok(performance.now() - started < 10_000);
});

test("the output is pruned with the rest of the content: the text goes, the node and the sizes stay", async () => {
  const wf = workflow(async (ctx) => (await ctx.exec(...node("process.stdout.write('PRIVATE-MARKER\\n')"))).ok);
  const first = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  assert.ok(outputText(eventsOf(first.runId), "stdout").includes("PRIVATE-MARKER"));
  await runWorkflow(workflow(async () => 0), {}, { cwd, metricsDb: false, retention: { runs: 1 } }); // starting another run prunes the old runs' content
  const events = eventsOf(first.runId);
  const output = contentOf(events).filter((c) => c.kind === "command-output");
  assert.equal(output.length, 1);
  assert.equal(output[0]!.text, undefined);
  assert.equal(output[0]!.chars, "PRIVATE-MARKER\n".length);
  assert.equal(execEnds(events).length, 1, "the command's node stays");
});

test("a command that writes a lot is cut at what the log keeps per command, in pieces no event cuts; the workflow still gets the tail", async () => {
  const wf = workflow((ctx) => ctx.exec(...node("for (let i = 0; i < 4000; i++) process.stdout.write('x'.repeat(98) + i.toString().padStart(4, '0') + '\\n')")));
  const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  assert.equal(r.status, "finished");
  const events = eventsOf(r.runId);
  const pieces = contentOf(events).filter((c) => c.kind === "command-output");
  assert.ok(pieces.every((c) => c.text!.length <= 32_768 && !c.truncated), "no piece is cut by the event's own limit");
  assert.equal(pieces.reduce((n, c) => n + c.text!.length, 0), 262_144, "the log keeps 256 KiB of the command's output");
  assert.ok(outputText(events, "stdout").startsWith("x".repeat(98) + "0000\n"));
  const [end] = execEnds(events);
  assert.equal(end!.outputChars, 4000 * 103);
  assert.equal(end!.outputTruncated, true);
  const tail = (r.result as ExecResult).tail;
  assert.equal(tail.length, 32_768);
  assert.ok(tail.endsWith("x".repeat(98) + "3999\n"), "the tail is the end of the output");
});

test("one line longer than an event holds is split across events, whole", async () => {
  const wf = workflow((ctx) => ctx.exec(...node("process.stdout.write('y'.repeat(70000) + '\\n')")));
  const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  const events = eventsOf(r.runId);
  const pieces = contentOf(events).filter((c) => c.kind === "command-output");
  assert.ok(pieces.length >= 3);
  assert.equal(outputText(events, "stdout"), `${"y".repeat(70000)}\n`);
  assert.equal(execEnds(events)[0]!.outputTruncated, undefined);
});

/** The state letter of the process in `/proc/<pid>/stat` (`S` sleeping, `Z` zombie, ...); `undefined` where there is no `/proc`, or no such process. */
const stateOf = (pid: number): string | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); // `pid (command) S ...`: the command may hold spaces and parentheses
    return stat[stat.lastIndexOf(")") + 2];
  } catch {
    return undefined;
  }
};

/**
 * Whether the process is running. A process that died but whose parent has not reaped it yet (a zombie, state `Z`: the
 * command's `sleep` is reparented to init when its `bash` dies, and init reaps it a moment later) still answers
 * `kill(pid, 0)`, and is not running. Where there is no `/proc` to read the state from, the answer is `kill`'s.
 */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const state = stateOf(pid);
  return state !== "Z" && state !== "X";
};

/** Waits for the process to be gone. One still running after 3 s is killed, so it does not run on after the test, and fails the test. */
async function expectGone(pid: number, boundary: string): Promise<void> {
  await until(`process ${pid} to be gone`, () => !alive(pid) || undefined, 3_000).catch(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* it went just now: it still outlived the wait */
    }
    assert.fail(`process ${pid} outlived ${boundary}`);
  });
}

// A zombie answers `kill(pid, 0)` like a live process. `exec sleep` makes one on purpose: once the shell has become a
// program that never waits for children, a child of it that dies stays dead and unreaped for as long as the parent lives.
// The child is killed only after the `exec` (a shell reaps its children, so one that died before it would leave no zombie).
test("alive() counts a process that is running, and not one that died but was not yet reaped (a zombie)", { skip: !existsSyncSafe("/proc/self/stat") && "needs /proc" }, async () => {
  const parent = spawn("bash", ["-c", "sleep 60 & echo $!; exec sleep 30"], { stdio: ["ignore", "pipe", "ignore"] });
  const parentPid = parent.pid!;
  try {
    const child = await new Promise<number>((resolve) => parent.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim()))));
    await until("the shell to have become `sleep`", () => readFileSync(`/proc/${parentPid}/comm`, "utf8").trim() === "sleep" || undefined);
    assert.equal(alive(child), true, "the child is running");
    process.kill(child, "SIGKILL");
    await until("the child to have died", () => stateOf(child) === "Z" || undefined);
    process.kill(child, 0); // it still answers: this is what `alive` used to take for "running"
    assert.equal(alive(parentPid), true, "the parent is running");
    assert.equal(alive(child), false, "the dead child is not");
  } finally {
    parent.kill("SIGKILL");
  }
});

test("a command is killed at its timeout and the call returns: the workflow is not stuck behind it", async () => {
  const wf = workflow(async (ctx) => ctx.exec(...node("setInterval(() => {}, 1000)"), { label: "hang", timeoutMs: 400 }));
  const started = performance.now();
  const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  assert.equal(r.status, "finished");
  assert.ok(performance.now() - started < 5_000, "returned long before the command would have");
  const result = r.result as ExecResult;
  assert.deepEqual([result.ok, result.exitCode, result.timedOut], [false, null, true]);
  const [end] = execEnds(eventsOf(r.runId));
  assert.deepEqual([end!.ok, end!.outcome, end!.exitCode, end!.signal], [false, "timeout", undefined, "SIGTERM"]);
  assert.equal(execStarts(eventsOf(r.runId))[0]!.timeoutMs, 400);
});

test("the whole process tree is killed, not only the process the call started", async () => {
  const wf = workflow((ctx) => ctx.exec("bash", ["-c", "sleep 60 & echo $!; wait"], { label: "tree", timeoutMs: 600 }));
  const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  const result = r.result as ExecResult;
  assert.equal(result.timedOut, true);
  const child = Number(result.tail.trim());
  assert.ok(child > 1, `the command printed its child's pid: ${JSON.stringify(result.tail)}`);
  await expectGone(child, "the command's timeout");
});

test("a command that ignores SIGTERM is killed for good two seconds later", async () => {
  const wf = workflow((ctx) => ctx.exec("bash", ["-c", "trap '' TERM; sleep 60 & wait"], { label: "stubborn", timeoutMs: 300 }));
  const started = performance.now();
  const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  assert.equal((r.result as ExecResult).timedOut, true);
  assert.ok(performance.now() - started >= 2_000 && performance.now() - started < 8_000, `took ${performance.now() - started} ms`);
  assert.equal(execEnds(eventsOf(r.runId))[0]!.signal, "SIGKILL");
});

test("the default timeout comes from the config: the workflow's execTimeoutMs, 10 minutes when it sets none; the call's own timeoutMs wins", async () => {
  const slow = "setTimeout(() => process.stdout.write('late'), 1200)";
  const wf = workflow(async (ctx) => [await ctx.exec(...node(slow), { label: "by-config" }), await ctx.exec(...node(slow), { label: "by-call", timeoutMs: 20_000 })] as const);

  const unconfigured = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  assert.equal(runStartOf(eventsOf(unconfigured.runId)).config.execTimeoutMs, 600_000);
  assert.deepEqual(execStarts(eventsOf(unconfigured.runId)).map((e) => e.timeoutMs), [600_000, 20_000]);

  writeRepoConfig(cwd, { workflows: { execwf: { execTimeoutMs: 300 } } });
  const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
  assert.equal(r.status, "finished");
  const [byConfig, byCall] = r.result as [ExecResult, ExecResult];
  assert.deepEqual([byConfig.timedOut, byCall.timedOut, byCall.tail], [true, false, "late"]);
  const start = runStartOf(eventsOf(r.runId));
  assert.equal(start.config.execTimeoutMs, 300);
  assert.deepEqual(start.provenance["/execTimeoutMs"]?.layer, "repo");
  assert.deepEqual(execStarts(eventsOf(r.runId)).map((e) => e.timeoutMs), [300, 20_000]);
});

test("a timeout that is not a positive number is a bug in the workflow, and fails it; so does one in the config file", async () => {
  for (const timeoutMs of [0, -1, Number.NaN]) {
    const r = await runWorkflow(workflow((ctx) => ctx.exec(...node("0"), { timeoutMs })), {}, { cwd, metricsDb: false });
    assert.equal(r.status, "failed", `timeoutMs ${timeoutMs}`);
    assert.match(r.error!, /ctx\.exec: timeoutMs must be a positive number/);
  }
  writeRepoConfig(cwd, { workflows: { execwf: { execTimeoutMs: 0 } } });
  const refused = await runWorkflow(workflow((ctx) => ctx.exec(...node("0"))), {}, { cwd, metricsDb: false });
  assert.equal(refused.refused, true);
  assert.match(refused.error!, /\/workflows\/execwf\/execTimeoutMs/);
});

test("cancelling the run kills the running commands, ends their nodes as cancelled, and stops the workflow where it is", async () => {
  const marker = join(cwd, "after-the-commands");
  const controller = new AbortController();
  const wf = workflow(async (ctx) => {
    await ctx.parallel([
      () => ctx.exec("bash", ["-c", "sleep 60 & echo $!; wait"], { label: "one", timeoutMs: 120_000 }),
      () => ctx.exec("bash", ["-c", "sleep 61 & echo $!; wait"], { label: "two", timeoutMs: 120_000 }),
    ]);
    writeFileSync(marker, "the workflow went on");
  });
  const seen: WorkflowEvent[] = [];
  const running = runWorkflow(wf, {}, { cwd, metricsDb: false, signal: controller.signal, onEvent: (e) => seen.push(e) });
  await until("both commands to start", () => seen.filter((e) => e.type === "exec-start").length === 2 || undefined);
  const printed = () => contentOf(eventsOf(seen[0]!.runId)).filter((c) => c.kind === "command-output").length;
  await until("both commands to print their child's pid", () => printed() === 2 || undefined);
  const cancelledAt = performance.now();
  controller.abort();
  const r = await running;

  assert.equal(r.status, "cancelled");
  assert.match(r.error!, new RegExp(`resumeRunId="${r.runId}"`));
  assert.ok(performance.now() - cancelledAt < 5_000, `the commands stopped in ${performance.now() - cancelledAt} ms`);
  assert.equal(existsSyncSafe(marker), false, "the workflow did not go on");
  const events = eventsOf(r.runId);
  assert.deepEqual(execEnds(events).map((e) => [e.label, e.ok, e.outcome, e.signal]).sort(), [["one", false, "cancelled", "SIGTERM"], ["two", false, "cancelled", "SIGTERM"]]);
  assert.equal(events.at(-1)!.type, "run-end", "no node event trails the run's end");
  const pids = contentOf(events).filter((c) => c.kind === "command-output").map((c) => Number(c.text!.trim()));
  assert.equal(pids.length, 2);
  // The signal reached the whole group before the run returned; the processes need a moment to act on it, and on a busy machine that moment is not short.
  await Promise.all(pids.map((pid) => expectGone(pid, "the cancelled run")));
});

test("a call made after the run was cancelled never starts: no node, the run ends cancelled", async () => {
  const controller = new AbortController();
  const wf = workflow(async (ctx) => {
    await ctx.exec(...node("0"), { label: "before" });
    await ctx.exec(...node("0"), { label: "after" });
  });
  const r = await runWorkflow(wf, {}, { cwd, metricsDb: false, signal: controller.signal, onEvent: (e) => e.type === "exec-end" && controller.abort() });
  assert.equal(r.status, "cancelled");
  assert.deepEqual(execStarts(eventsOf(r.runId)).map((e) => e.label), ["before"]);
});

test("the process stays responsive while a command runs: its event loop is never blocked behind the command", async () => {
  const ticks: number[] = [];
  const timer = setInterval(() => ticks.push(performance.now()), 20);
  try {
    const wf = workflow((ctx) => ctx.exec(...node(`${sleepJs(1500)}`), { label: "long" }));
    const r = await runWorkflow(wf, {}, { cwd, metricsDb: false });
    assert.equal(r.status, "finished");
  } finally {
    clearInterval(timer);
  }
  const gaps = ticks.slice(1).map((t, i) => t - ticks[i]!);
  assert.ok(ticks.length > 40, `${ticks.length} ticks in 1.5 s`);
  assert.ok(Math.max(...gaps) < 1_000, `the longest stall was ${Math.max(...gaps)} ms`); // a blocked loop would stall for the command's 1.5 s
});

async function until<T>(what: string, read: () => T | undefined, ms = 10_000): Promise<T> {
  for (const stop = performance.now() + ms; ; await new Promise((r) => setTimeout(r, 25))) {
    const value = read();
    if (value) return value;
    if (performance.now() > stop) throw new Error(`timed out waiting for ${what}`);
  }
}
