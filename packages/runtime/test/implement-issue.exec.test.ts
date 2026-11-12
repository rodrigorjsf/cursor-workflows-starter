// Seam 1 on the shipped workflow: `implement-issue` runs every command it needs (the tests of the TDD loop, `git`, `gh`)
// through `ctx.exec`. A command never blocks the process, is killed at its timeout and shows in the run's event log as a
// step node; a `gh` failure is an error, never "no PR". Runs `runWorkflow` with the fake SDK and the environment of
// implement-issue.fixture.ts (fake gh, temp repo, real git and real `node --test`) and reads the replayed event log.
import assert from "node:assert/strict";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ContentEvent, ExecEndEvent, ExecStartEvent, WorkflowEvent } from "../src/runtime/events.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { runWorkflow } from "../src/runtime/engine.js";
import implementIssue from "../workflows/implement-issue.js";
import { Commands, type Exec } from "../workflows/implement-issue/commands.js";
import { runnerConfigChanged } from "../workflows/implement-issue/tdd.js";
import { writeRepoConfig } from "./config-fixtures.js";
import { SUB_CODE, SUB_TEST, failGh, fx, gh, git, issue, onOrigin, run, setup, submit, teardown, worktreeOf, write } from "./implement-issue.fixture.js";

beforeEach(setup);
afterEach(teardown);

const res = (r: { result?: unknown }) => r.result as any;
const eventsOf = (runId: string): WorkflowEvent[] => readEventLog(eventLogPath(fx.repo, runId)).events;
const execStarts = (events: WorkflowEvent[]) => events.filter((e): e is ExecStartEvent => e.type === "exec-start");
const execEnd = (events: WorkflowEvent[], start: ExecStartEvent) => events.find((e): e is ExecEndEvent => e.type === "exec-end" && e.attemptId === start.attemptId)!;
const outputOf = (events: WorkflowEvent[], start: ExecStartEvent) =>
  events
    .filter((e): e is ContentEvent => e.type === "content" && e.kind === "command-output" && e.attemptId === start.attemptId)
    .map((e) => e.text ?? "")
    .join("");

test("the test runs of the TDD loop are command nodes in the event log, each with its own output", async () => {
  issue(["complexity:low"]);
  const r = await run({});
  assert.equal(r.status, "finished", r.error);
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));

  const events = eventsOf(r.runId);
  const starts = execStarts(events);
  const labels = starts.map((s) => s.label);
  for (const label of ["suite:baseline", "suite:red:1", "suite:green:1", "suite:final"]) assert.ok(labels.includes(label), `no command node "${label}" in ${labels.join(", ")}`);

  const red = starts.find((s) => s.label === "suite:red:1")!;
  assert.equal(execEnd(events, red).ok, false, "the red run is the failing suite");
  assert.match(outputOf(events, red), /not ok \d+ - test\/sub\.test\.js/, "the failing test's output is in the log, under the red run's node");
  const green = starts.find((s) => s.label === "suite:green:1")!;
  assert.equal(execEnd(events, green).ok, true);
  assert.match(outputOf(events, green), /ok \d+ - subtract/);
});

// ── The test command: its limit, its environment, its output ──────────────────────────

test("a test run that outlives its limit is killed: tests-timeout, and the run goes no further", async () => {
  issue(["complexity:low"]);
  writeRepoConfig(fx.repo, { workflows: { "implement-issue": { settings: { testTimeoutSec: 1 } } } });
  const startedAt = Date.now();
  const r = await run({ testCommand: "sleep 60" });
  assert.equal(res(r).status, "tests-timeout", JSON.stringify(res(r)));
  assert.ok(Date.now() - startedAt < 30_000, "the run did not wait for the command");
  const suite = execStarts(eventsOf(r.runId)).find((s) => s.label === "suite:baseline");
  assert.equal(suite?.timeoutMs, 1000, "the configured limit is the command's limit");
});

test("a refactor suite that outlives its limit ends tests-timeout like every other suite, and the refactor is undone", async () => {
  issue(["complexity:low"]);
  writeRepoConfig(fx.repo, { workflows: { "implement-issue": { settings: { testTimeoutSec: 3 } } } });
  let standards = 0;
  fx.handlers["review:standards"] = (o) =>
    submit(o, ++standards === 1 ? { findings: [{ file: "src/math.js", rule: "Mysterious Name", kind: "hard", note: "name" }], worst: "name" } : { findings: [], worst: "" });
  fx.handlers["refatorar-1"] = (o) => {
    write(o, "src/math.js", `${SUB_CODE}\nawait new Promise((r) => setTimeout(r, 60_000));\n`); // every import of it hangs
    submit(o, { summary: "hangs", filesChanged: ["src/math.js"] });
  };
  const r = await run({});
  assert.equal(res(r).status, "tests-timeout", JSON.stringify(res(r)));
  assert.ok(execStarts(eventsOf(r.runId)).some((s) => s.label === "suite:refactor"), "the suite that timed out is the refactor's");
  assert.equal(readFileSync(join(worktreeOf(r.runId), "src", "math.js"), "utf8"), SUB_CODE, "the worktree is back at the last green");
});

test("a refactor suite killed by a signal ends tests-killed like every other suite, and the refactor is undone", async () => {
  issue(["complexity:low"]);
  let standards = 0;
  fx.handlers["review:standards"] = (o) =>
    submit(o, ++standards === 1 ? { findings: [{ file: "src/math.js", rule: "Mysterious Name", kind: "hard", note: "name" }], worst: "name" } : { findings: [], worst: "" });
  fx.handlers["refatorar-1"] = (o) => {
    write(o, "src/math.js", `${SUB_CODE}\nprocess.kill(process.ppid, "SIGKILL");\n`); // a test file that imports it kills the runner
    submit(o, { summary: "kills", filesChanged: ["src/math.js"] });
  };
  const r = await run({});
  assert.equal(res(r).status, "tests-killed", JSON.stringify(res(r)));
  const events = eventsOf(r.runId);
  const refactor = execStarts(events).find((s) => s.label === "suite:refactor");
  assert.ok(refactor, "the suite that was killed is the refactor's");
  assert.equal(execEnd(events, refactor).ok, false);
  assert.equal(readFileSync(join(worktreeOf(r.runId), "src", "math.js"), "utf8"), SUB_CODE, "the worktree is back at the last green");
});

test("the command limits come from the repo config when the run passes none: tests and network from the settings, local git from execTimeoutMs", async () => {
  issue(["complexity:low"]);
  writeRepoConfig(fx.repo, { workflows: { "implement-issue": { execTimeoutMs: 123_456, settings: { testTimeoutSec: 1, networkTimeoutSec: 7 } } } });
  const r = await run({ testCommand: "sleep 60" });
  assert.equal(res(r).status, "tests-timeout", JSON.stringify(res(r)));
  const starts = execStarts(eventsOf(r.runId));
  assert.equal(starts.find((s) => s.label === "suite:baseline")?.timeoutMs, 1000, "testTimeoutSec from the repo file");
  assert.equal(starts.find((s) => s.label === "gh issue view")?.timeoutMs, 7000, "networkTimeoutSec from the repo file");
  const localGit = starts.filter((s) => s.label.startsWith("git ") && s.label !== "git push" && s.label !== "git ls-remote");
  assert.ok(localGit.length > 0, "the run ran local git");
  for (const s of localGit) assert.equal(s.timeoutMs, 123_456, `${s.label}: local git takes the workflow's execTimeoutMs`);
});

test("a run cannot set the command limits through its args: they are workflow settings, which only the config files tune (ADR-0001)", async () => {
  issue(["complexity:low"]);
  for (const args of [{ testTimeoutSec: 1 }, { networkTimeoutSec: 9 }]) {
    const r = await run(args);
    assert.equal(r.status, "failed", JSON.stringify(r));
    assert.match(r.error!, /invalid args: .*additional properties/, JSON.stringify(args));
  }
});

test("a suite that writes far more than the log keeps is not a failure", async () => {
  issue(["complexity:low"]);
  const r = await run({ testCommand: "head -c 2000000 /dev/zero | tr '\\0' a; echo; node --test" });
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
});

test("the suite runs with the caller's PATH, not the login shell's", async () => {
  // Measured: `bash -lc` reloaded the profile and swapped the npm of `mise exec` for a broken one.
  issue(["complexity:low"]);
  const npm = join(fx.root, "bin", "npm");
  writeFileSync(npm, "#!/bin/sh\necho npm-from-the-caller\nexec node --test\n");
  chmodSync(npm, 0o755);
  const r = await run({ testCommand: "npm test" });
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
  const events = eventsOf(r.runId);
  const baseline = execStarts(events).find((s) => s.label === "suite:baseline")!;
  assert.match(outputOf(events, baseline), /npm-from-the-caller/);
});

test("a suite that was killed (not by its limit) is not a red: tests-killed, and no agent is asked to make it pass", async () => {
  issue(["complexity:low"]);
  const r = await run({ testCommand: "kill -9 $$" }); // what the OOM killer does to a runner that eats the memory
  assert.equal(res(r).status, "tests-killed", JSON.stringify(res(r)));
});

test("a failing suite is red even when the workflow itself runs under `node --test` (NODE_TEST_CONTEXT is not inherited)", async () => {
  // Measured: a nested `node --test` inherits NODE_TEST_CONTEXT=child-v8 and exits 0 with a test failing.
  const saved = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = "child-v8";
  try {
    issue(["complexity:low"]);
    writeFileSync(join(fx.repo, "test", "broken.test.js"), 'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("falha", () => assert.equal(1, 2));\n');
    git(fx.repo, "add", "-A");
    git(fx.repo, "commit", "-qm", "broken");
    const r = await run({});
    assert.equal(res(r).status, "baseline-red", JSON.stringify(res(r)));
  } finally {
    if (saved === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = saved;
  }
});

test("cancelling the run while the suite is running kills the suite at once instead of waiting for it", async () => {
  issue(["complexity:low"]);
  const controller = new AbortController();
  const startedAt = Date.now();
  const r = await runWorkflow(implementIssue, { issue: 7, testCommand: "sleep 60" } as any, {
    cwd: fx.repo,
    signal: controller.signal,
    onEvent: (e) => {
      if (e.type === "exec-start" && e.label === "suite:baseline") setTimeout(() => controller.abort(), 50);
    },
  });
  assert.equal(r.status, "cancelled");
  assert.ok(Date.now() - startedAt < 30_000, "the run did not wait for the suite");
  const events = eventsOf(r.runId);
  const suite = execStarts(events).find((s) => s.label === "suite:baseline")!;
  assert.equal(execEnd(events, suite).outcome, "cancelled");
});

// ── gh: a failure is an error ─────────────────────────────────────────────────────────

test("a gh error in the existing-PR lookup fails the run with gh's error, not as 'no PR'; the resume delivers once gh works", async () => {
  issue(["complexity:low"]);
  failGh("pr view", "HTTP 401: Bad credentials (https://api.github.com/graphql)");
  const first = await run({ openPr: true });
  assert.equal(first.status, "failed", JSON.stringify(first.result));
  assert.match(first.error!, /gh pr view/);
  assert.match(first.error!, /Bad credentials/, "the error says what gh said");
  assert.equal(gh().prs.length, 0, "no PR is created on the strength of a failed lookup");
  assert.ok(!onOrigin(), "nothing is pushed either");

  failGh("pr view", undefined);
  const second = await run({ openPr: true }, first.runId);
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));
  assert.equal(gh().prs.length, 1);
});

test("a branch with no PR yet is not an error: the lookup finds nothing and the PR is created", async () => {
  issue(["complexity:low"]);
  failGh("pr view", 'no pull requests found for branch "wf/issue-7-x"');
  const r = await run({ openPr: true });
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
  assert.equal(gh().prs.length, 1);
});

// ── What gh and git say is read whole ─────────────────────────────────────────────────

/** `ctx.exec` hands back the last 32768 characters of a command's output; an issue, its comments or a diff can be longer. */
const LONG = "a line of context that makes the text longer than a tail\n".repeat(2000);

test("an issue longer than the tail of a command's output is read whole", async () => {
  issue(["complexity:low"]);
  const state = JSON.parse(readFileSync(fx.ghState, "utf8"));
  state.issue.body = `Exportar \`subtract(a, b)\` em src/math.js, que devolve a - b.\n${LONG}`;
  writeFileSync(fx.ghState, JSON.stringify(state));
  const r = await run({});
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
});

test("the comments of an issue longer than the tail are read whole", async () => {
  issue(["complexity:medium"]);
  const state = JSON.parse(readFileSync(fx.ghState, "utf8"));
  state.comments = [LONG, LONG];
  writeFileSync(fx.ghState, JSON.stringify(state));
  const r = await run({});
  assert.equal(res(r).status, "seams-proposed", JSON.stringify(res(r)));
  assert.equal(gh().comments.length, 3);
});

// ── git push: a network command with a limit ──────────────────────────────────────────

test("a git push that hangs fails the step at its limit instead of hanging the run; the resume delivers", async () => {
  issue(["complexity:low"]);
  const hook = join(fx.repo, ".git", "hooks", "pre-push");
  writeFileSync(hook, "#!/bin/sh\nexec sleep 60\n"); // a push waiting for a credential, a stalled connection
  chmodSync(hook, 0o755);
  writeRepoConfig(fx.repo, { workflows: { "implement-issue": { settings: { networkTimeoutSec: 2 } } } });
  const startedAt = Date.now();
  const first = await run({ openPr: true });
  assert.equal(first.status, "failed", JSON.stringify(first.result));
  assert.match(first.error!, /git push .*timed out after 2s/);
  assert.ok(Date.now() - startedAt < 40_000, "the run did not wait for the push");
  assert.equal(gh().prs.length, 0, "no PR was created for a branch that was not pushed");
  const push = execStarts(eventsOf(first.runId)).find((s) => s.label === "git push")!;
  assert.equal(push.timeoutMs, 2000);

  rmSync(hook);
  const second = await run({ openPr: true }, first.runId);
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));
  assert.equal(gh().prs.length, 1);
  assert.ok(onOrigin());
});

test("a secret at the top of a diff longer than the tail of a command's output still blocks the delivery", async () => {
  issue(["complexity:low"]);
  const key = "crsr_" + "x".repeat(40);
  fx.handlers["codigo-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE);
    write(o, "src/data.js", `export const k = "${key}";\n${LONG}`); // the key is the first line the diff adds; the last 32768 characters are filler
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  const r = await run({ openPr: true });
  assert.equal(res(r).status, "secret-blocked", JSON.stringify(res(r)));
  assert.ok(!JSON.stringify(res(r)).includes(key));
  assert.ok(!onOrigin());
});

// ── Failures of git are not answers ───────────────────────────────────────────────────

test("a git that times out is an error, not 'there is no package.json': a step is never judged on a command that did not answer", async () => {
  const limits = { localMs: 1000, networkMs: 1000 };
  const timedOut: Exec = async () => ({ ok: false, exitCode: null, timedOut: true, tail: "" });
  await assert.rejects(runnerConfigChanged(new Commands(timedOut, limits), "/x", "tree-a", "tree-b"), /timed out after 1s/);

  const noSuchFile: Exec = async () => ({ ok: false, exitCode: 128, timedOut: false, tail: "fatal: path 'package.json' does not exist in 'tree-a'" });
  assert.equal(await runnerConfigChanged(new Commands(noSuchFile, limits), "/x", "tree-a", "tree-b"), false, "a tree without package.json on both sides did not change it");
});

// ── Cancelling in the middle of a write step ──────────────────────────────────────────

test("cancelling in the middle of a write step leaves the worktree as before the step, and the resume goes on to deliver", async () => {
  issue(["complexity:low"]);
  fx.handlers["codigo-1"] = (o) => {
    write(o, "src/math.js", `${SUB_CODE}// half-made edit\n`);
    return { hang: true };
  };
  const controller = new AbortController();
  const first = await runWorkflow(implementIssue, { issue: 7, testCommand: "node --test" } as any, {
    cwd: fx.repo,
    signal: controller.signal,
    onEvent: (e) => {
      if (e.type === "step-start" && e.label === "codigo-1") setTimeout(() => controller.abort(), 100);
    },
  });
  assert.equal(first.status, "cancelled");
  const math = readFileSync(join(worktreeOf(first.runId), "src", "math.js"), "utf8");
  assert.ok(!math.includes("half-made"), "the step's edit is undone");
  assert.equal(readFileSync(join(worktreeOf(first.runId), "test", "sub.test.js"), "utf8"), SUB_TEST, "the slice's test, made before the step, stays");

  fx.handlers["codigo-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE);
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  const second = await run({}, first.runId);
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));
});
