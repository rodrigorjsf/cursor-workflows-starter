// Seam 1 on the shipped workflow: `implement-issue` runs every command it needs (the tests of the TDD loop, `git`, `gh`)
// through `ctx.exec`. A command never blocks the process, is killed at its timeout and shows in the run's event log as a
// step node; a `gh` failure is an error, never "no PR". Runs `runWorkflow` with the fake SDK and the environment of
// implement-issue.fixture.ts (fake gh, temp repo, real git and real `node --test`) and reads the replayed event log.
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ContentEvent, ExecEndEvent, ExecStartEvent, WorkflowEvent } from "../src/runtime/events.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { runWorkflow } from "../src/runtime/engine.js";
import implementIssue from "../workflows/implement-issue.js";
import { Commands, type Exec } from "../workflows/implement-issue/commands.js";
import { runnerConfigChanged } from "../workflows/implement-issue/tdd.js";
import { writeRepoConfig } from "./config-fixtures.js";
import { PLAN, SUB_CODE, SUB_TEST, failForge, fx, forgeState, git, issue, names, onOrigin, run, setup, submit, teardown, worktreeOf, write } from "./implement-issue.fixture.js";

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
  // The tap reporter, named: the runner's default is spec since Node 24 and tap before it, and the assertions below read tap lines.
  const r = await run({ testCommand: "node --test --test-reporter=tap" });
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
  const r = await run({ testCommand: "sleep 60" });
  assert.equal(res(r).status, "tests-timeout", `the command was killed at its limit, not waited for: ${JSON.stringify(res(r))}`);
  const suite = execStarts(eventsOf(r.runId)).find((s) => s.label === "suite:baseline");
  assert.equal(suite?.timeoutMs, 1000, "the configured limit is the command's limit");
});

test("a refactor suite that outlives its limit ends tests-timeout like every other suite, and the refactor is undone", async () => {
  issue(["complexity:low"]);
  writeRepoConfig(fx.repo, { workflows: { "implement-issue": { settings: { testTimeoutSec: 3 } } } });
  let standards = 0;
  fx.handlers["review:standards"] = (o) =>
    submit(o, ++standards === 1 ? { findings: [{ file: "src/math.js", rule: "Mysterious Name", kind: "hard", note: "name" }], worst: "name" } : { findings: [], worst: "" });
  fx.handlers["refactor-1"] = (o) => {
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
  fx.handlers["refactor-1"] = (o) => {
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

/** Runs `fn` with `secrets` in the environment of this process, and restores it. */
async function withEnv(secrets: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(secrets).map((name) => [name, process.env[name]]));
  Object.assign(process.env, secrets);
  try {
    await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Fake secrets built at run time, so no literal in this file has the shape of a credential (gitleaks reads the file). */
const fake = (what: string) => `${what}-${"x".repeat(24)}`;
const SECRETS = { CURSOR_API_KEY: fake("cursor"), GH_TOKEN: fake("github") };

test("the test command does not inherit a secret of the environment: `env` prints neither CURSOR_API_KEY nor GH_TOKEN", async () => {
  issue(["complexity:low"]);
  await withEnv({ ...SECRETS, DEPLOY_PASSWORD: fake("deploy"), NPM_CONFIG_REGISTRY: "https://registry.example/" }, async () => {
    const r = await run({ testCommand: "env; node --test" });
    assert.equal(res(r).status, "done", JSON.stringify(res(r)));
    const events = eventsOf(r.runId);
    const baseline = execStarts(events).find((s) => s.label === "suite:baseline")!;
    const printed = outputOf(events, baseline);
    assert.match(printed, /NPM_CONFIG_REGISTRY=/, "the rest of the environment is still there");
    for (const name of ["CURSOR_API_KEY", "GH_TOKEN", "DEPLOY_PASSWORD"]) assert.doesNotMatch(printed, new RegExp(name), `${name} reached the test command`);
  });
});

test("the setup command gets the same scrubbed environment as the tests", async () => {
  issue(["complexity:low"]);
  await withEnv(SECRETS, async () => {
    const r = await run({ setupCommand: "env" });
    assert.equal(res(r).status, "done", JSON.stringify(res(r)));
    const events = eventsOf(r.runId);
    const setup = execStarts(events).find((s) => s.label === "setup")!;
    assert.match(outputOf(events, setup), /PATH=/, "the command ran and printed its environment");
    for (const name of Object.keys(SECRETS)) assert.doesNotMatch(outputOf(events, setup), new RegExp(name), `${name} reached the setup command`);
  });
});

test("the workflow's own gh and git calls still see GH_TOKEN: only the commands that run the target repository's code are scrubbed", async () => {
  issue(["complexity:low"]);
  const hook = join(fx.repo, ".git", "hooks", "pre-push");
  writeFileSync(hook, `#!/bin/sh\nprintf '%s' "\${GH_TOKEN-unset}" > "${join(fx.root, "git-saw-token")}"\n`);
  chmodSync(hook, 0o755);
  await withEnv(SECRETS, async () => {
    const r = await run({ openPr: true });
    assert.equal(res(r).status, "done", JSON.stringify(res(r)));
  });
  assert.equal(readFileSync(join(fx.root, "git-saw-token"), "utf8"), SECRETS.GH_TOKEN, "git push ran its hook with the token");
  const seen = forgeState().ghToken!;
  assert.ok(seen.length > 0 && seen.every((s) => s === "set"), `gh calls without the token: ${seen.join(",")}`);
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
  const r = await runWorkflow(implementIssue, { issue: 7, testCommand: "sleep 60" } as any, {
    cwd: fx.repo,
    signal: controller.signal,
    onEvent: (e) => {
      if (e.type === "exec-start" && e.label === "suite:baseline") setTimeout(() => controller.abort(), 50);
    },
  });
  assert.equal(r.status, "cancelled");
  const events = eventsOf(r.runId);
  const suite = execStarts(events).find((s) => s.label === "suite:baseline")!;
  assert.equal(execEnd(events, suite).outcome, "cancelled");
});

// ── gh: a failure is an error ─────────────────────────────────────────────────────────

test("a gh error in the existing-PR lookup fails the run with gh's error, not as 'no PR'; the resume delivers once gh works", async () => {
  issue(["complexity:low"]);
  failForge("pr view", "HTTP 401: Bad credentials (https://api.github.com/graphql)");
  const first = await run({ openPr: true });
  assert.equal(first.status, "failed", JSON.stringify(first.result));
  assert.match(first.error!, /gh pr view/);
  assert.match(first.error!, /Bad credentials/, "the error says what gh said");
  assert.equal(forgeState().prs.length, 0, "no PR is created on the strength of a failed lookup");
  assert.ok(!onOrigin(), "nothing is pushed either");

  failForge("pr view", undefined);
  const second = await run({ openPr: true }, first.runId);
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));
  assert.equal(forgeState().prs.length, 1);
});

test("a branch with no PR yet is not an error: the lookup finds nothing and the PR is created", async () => {
  issue(["complexity:low"]);
  failForge("pr view", 'no pull requests found for branch "wf/issue-7-x"');
  const r = await run({ openPr: true });
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
  assert.equal(forgeState().prs.length, 1);
});

// ── What gh and git say is read whole ─────────────────────────────────────────────────

/** `ctx.exec` hands back the last 32768 characters of a command's output; an issue, its comments or a diff can be longer. */
const LONG = "a line of context that makes the text longer than a tail\n".repeat(2000);

test("an issue longer than the tail of a command's output is read whole", async () => {
  issue(["complexity:low"]);
  const state = JSON.parse(readFileSync(fx.forgeStateFile, "utf8"));
  state.issue.body = `Exportar \`subtract(a, b)\` em src/math.js, que devolve a - b.\n${LONG}`;
  writeFileSync(fx.forgeStateFile, JSON.stringify(state));
  const r = await run({});
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
});

test("the comments of an issue longer than the tail are read whole", async () => {
  issue(["complexity:medium"]);
  const state = JSON.parse(readFileSync(fx.forgeStateFile, "utf8"));
  state.comments = [LONG, LONG];
  writeFileSync(fx.forgeStateFile, JSON.stringify(state));
  const r = await run({});
  assert.equal(res(r).status, "seams-proposed", JSON.stringify(res(r)));
  assert.equal(forgeState().comments.length, 3);
});

// ── git push: a network command with a limit ──────────────────────────────────────────

test("a git push that hangs fails the step at its limit instead of hanging the run; the resume delivers", async () => {
  issue(["complexity:low"]);
  const hook = join(fx.repo, ".git", "hooks", "pre-push");
  writeFileSync(hook, "#!/bin/sh\nexec sleep 60\n"); // a push waiting for a credential, a stalled connection
  chmodSync(hook, 0o755);
  writeRepoConfig(fx.repo, { workflows: { "implement-issue": { settings: { networkTimeoutSec: 2 } } } });
  const first = await run({ openPr: true });
  assert.equal(first.status, "failed", JSON.stringify(first.result));
  assert.match(first.error!, /git push .*timed out after 2s/, "the push was killed at its limit, not waited for");
  assert.equal(forgeState().prs.length, 0, "no PR was created for a branch that was not pushed");
  const push = execStarts(eventsOf(first.runId)).find((s) => s.label === "git push")!;
  assert.equal(push.timeoutMs, 2000);

  rmSync(hook);
  const second = await run({ openPr: true }, first.runId);
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));
  assert.equal(forgeState().prs.length, 1);
  assert.ok(onOrigin());
});

test("a secret at the top of a diff longer than the tail of a command's output still blocks the delivery", async () => {
  issue(["complexity:low"]);
  const key = "crsr_" + "x".repeat(40);
  fx.handlers["code-1"] = (o) => {
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
  fx.handlers["code-1"] = (o) => {
    write(o, "src/math.js", `${SUB_CODE}// half-made edit\n`);
    return { hang: true };
  };
  const controller = new AbortController();
  const first = await runWorkflow(implementIssue, { issue: 7, testCommand: "node --test" } as any, {
    cwd: fx.repo,
    signal: controller.signal,
    onEvent: (e) => {
      if (e.type === "step-start" && e.label === "code-1") setTimeout(() => controller.abort(), 100);
    },
  });
  assert.equal(first.status, "cancelled");
  const math = readFileSync(join(worktreeOf(first.runId), "src", "math.js"), "utf8");
  assert.ok(!math.includes("half-made"), "the step's edit is undone");
  assert.equal(readFileSync(join(worktreeOf(first.runId), "test", "sub.test.js"), "utf8"), SUB_TEST, "the slice's test, made before the step, stays");

  fx.handlers["code-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE);
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  const second = await run({}, first.runId);
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));
});

// ── A test command the model chose runs only after a person saw it ─────────────────────

/** The programs and arguments every `ctx.exec` call of the run started, from the `tool-call` content of each command node. */
const execCalls = (events: WorkflowEvent[]) =>
  events
    .filter((e): e is ContentEvent => e.type === "content" && e.kind === "tool-call" && e.tool === "exec")
    .map((e) => JSON.parse(e.text ?? "null") as { command: string; args: string[]; cwd: string });
const ranAsSuite = (events: WorkflowEvent[], suiteCommand: string) => execCalls(events).some((c) => c.command === "bash" && c.args.join(" ") === `-c ${suiteCommand}`);
/** Did any command of the run mention `text`, as the program or in an argument? The check behind "it never ran", wider than the exact suite line. */
const mentioned = (events: WorkflowEvent[], text: string) => execCalls(events).some((c) => `${c.command} ${c.args.join(" ")}`.includes(text));
/** Resumes a run with the args of a `next` line, as given: unlike `run`, it adds no default test command. */
const resume = (args: Record<string, unknown>, runId: string) => runWorkflow(implementIssue, args as any, { cwd: fx.repo, runId });
/** What the `next` line of a stopped run relaunches: the args after `--args` and the run id after `--resume`. */
const relaunchOf = (next: string) => {
  const m = /^npm run wf -- run implement-issue --args '(.*)' --resume (\S+)$/.exec(next);
  assert.ok(m, `not a relaunch line: ${next}`);
  return { args: JSON.parse(m[1]!.replace(/'\\''/g, "'")) as Record<string, unknown>, runId: m[2]! };
};
const PWNED_PLAN = { ...PLAN, testCommand: "touch PWNED" };

test("MED with seams and no test command: the planner's command is proposed on the issue, not run", async () => {
  issue(["complexity:medium"]);
  fx.handlers.plan = (o) => submit(o, PWNED_PLAN);
  const r = await run({ seams: ["x"], testCommand: undefined });
  assert.equal(r.status, "finished", r.error);
  assert.equal(res(r).status, "test-command-proposed", JSON.stringify(res(r)));

  assert.ok(!mentioned(eventsOf(r.runId), "PWNED"), "the command the model wrote did not run");
  assert.ok(!existsSync(join(fx.repo, "PWNED")) && !existsSync(worktreeOf(r.runId)), "no file PWNED, and no worktree was made for the run");
  const comments = forgeState().comments;
  assert.equal(comments.length, 1);
  assert.ok(comments[0]!.includes("`touch PWNED`"), `the command is shown inside a code span: ${comments[0]}`);
});

test("the next line approves the stored plan: no seams in it, and resuming it runs the proposed command with no new planner call", async () => {
  issue(["complexity:medium"]);
  fx.handlers.plan = (o) => submit(o, PWNED_PLAN);
  const first = await run({ seams: ["x"], testCommand: undefined });
  assert.equal(res(first).status, "test-command-proposed", JSON.stringify(res(first)));

  const { args, runId } = relaunchOf(res(first).next);
  assert.equal(runId, first.runId);
  assert.equal(args.approveSeams, true);
  assert.ok(!("seams" in args), `the relaunch line carries no seams: ${JSON.stringify(args)}`);
  assert.equal(args.testCommand, undefined, "and no test command either: the plan's is the one shown");
  assert.ok(forgeState().comments[0]!.includes(res(first).next), "the issue comment holds the same line");

  const plannerCalls = names().filter((n) => n === "plan").length;
  const second = await resume(args, runId);
  assert.equal(second.status, "finished", second.error);
  assert.equal(names().filter((n) => n === "plan").length, plannerCalls, "the stored plan is used: the planner does not run again");
  assert.ok(ranAsSuite(eventsOf(first.runId), "touch PWNED"), "the approved plan's command is the suite command");
  assert.ok(existsSync(join(worktreeOf(first.runId), "PWNED")), "and it ran, in the run's worktree");
  const comments = forgeState().comments;
  assert.equal(comments.length, 2, "the resume posts the approval and no second test command comment");
  assert.match(comments[1]!, /Seams approved/);
});

test("seams with a test command the user typed: that command runs, the planner's is ignored, and the run does not stop", async () => {
  issue(["complexity:medium"]);
  fx.handlers.plan = (o) => submit(o, PWNED_PLAN);
  const r = await run({ seams: ["x"], testCommand: "node --test" });
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
  const events = eventsOf(r.runId);
  assert.ok(ranAsSuite(events, "node --test"), "the typed command is the suite command");
  assert.ok(!mentioned(events, "PWNED"), "the planner's is never run");
  assert.equal(forgeState().comments.length, 0, "nothing to approve, nothing posted");
});

test("HIGH follows the same rule: the judge's test command is proposed, not run, when the run has seams and no test command", async () => {
  issue(["complexity:high"]);
  const design = (o: any) => submit(o, { interface: "subtract(a, b)", usage: "subtract(5, 3)", hides: "-", dependencies: "-", tradeoffs: "-" });
  for (const kind of ["minimal", "flexible", "common"]) fx.handlers[`design:${kind}`] = design;
  fx.handlers.judge = (o) => submit(o, PWNED_PLAN);
  const r = await run({ seams: ["x"], testCommand: undefined });
  assert.equal(res(r).status, "test-command-proposed", JSON.stringify(res(r)));
  assert.ok(!mentioned(eventsOf(r.runId), "PWNED"));
  assert.ok(!existsSync(join(fx.repo, "PWNED")) && !existsSync(worktreeOf(r.runId)));
  assert.ok(forgeState().comments[0]!.includes("`touch PWNED`"));
  assert.equal(relaunchOf(res(r).next).args.seams, undefined);

  const second = await resume(relaunchOf(res(r).next).args, r.runId);
  assert.equal(second.status, "finished", second.error);
  assert.equal(names().filter((n) => n === "judge").length, 1, "the judge does not run again");
  assert.ok(ranAsSuite(eventsOf(r.runId), "touch PWNED"), "the approved plan's command runs");
});

test("LOW without a test command takes the kit's npm test: nothing proposed, nothing stops", async () => {
  issue(["complexity:low"]);
  const r = await run({ seams: ["x"], testCommand: undefined });
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
  assert.ok(ranAsSuite(eventsOf(r.runId), "npm test"));
  assert.equal(forgeState().comments.length, 0);
});

test("a planner that proposes no command (a blank one) is no proposal: the run takes npm test and does not stop", async () => {
  issue(["complexity:medium"]);
  fx.handlers.plan = (o) => submit(o, { ...PLAN, testCommand: "  " });
  const r = await run({ seams: ["x"], testCommand: undefined });
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
  const events = eventsOf(r.runId);
  assert.ok(ranAsSuite(events, "npm test"));
  assert.ok(!execCalls(events).some((c) => c.command === "bash" && c.args[1]?.trim() === ""), "no empty command was run");
});

test("a blank planner command: the seams comment shows the command that will run (npm test), not an empty span", async () => {
  issue(["complexity:medium"]);
  fx.handlers.plan = (o) => submit(o, { ...PLAN, testCommand: "  " });
  const first = await run({ testCommand: undefined });
  assert.equal(res(first).status, "seams-proposed", JSON.stringify(res(first)));
  assert.ok(forgeState().comments[0]!.includes("\nTest command: `npm test`\n"), forgeState().comments[0]);
  const second = await run({ testCommand: undefined, approveSeams: true }, first.runId);
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));
  assert.ok(ranAsSuite(eventsOf(first.runId), "npm test"), "what ran is what the comment showed");
});

test("the same stopped run resumed with the same args stops again and posts the command once", async () => {
  issue(["complexity:medium"]);
  fx.handlers.plan = (o) => submit(o, PWNED_PLAN);
  const first = await run({ seams: ["x"], testCommand: undefined });
  const again = await run({ seams: ["x"], testCommand: undefined }, first.runId);
  assert.equal(res(again).status, "test-command-proposed", JSON.stringify(res(again)));
  assert.equal(names().filter((n) => n === "plan").length, 1, "the planner's answer comes from the journal");
  const comments = forgeState().comments;
  assert.equal(comments.filter((body) => body.includes("<!-- wf:implement-issue:test-command -->")).length, 1, "one test command comment per run");
  assert.equal(comments.length, 2, "and the resume with seams is a decision of its own");
  assert.match(comments[1]!, /Seams replaced/);
});

test("a run that proposed seams and is then resumed with seams still posts the test command: the two comments have their own markers", async () => {
  issue(["complexity:medium"]);
  fx.handlers.plan = (o) => submit(o, PWNED_PLAN);
  const first = await run({ testCommand: undefined });
  assert.equal(res(first).status, "seams-proposed", JSON.stringify(res(first)));
  const second = await run({ seams: ["x"], testCommand: undefined }, first.runId);
  assert.equal(res(second).status, "test-command-proposed", JSON.stringify(res(second)));
  const comments = forgeState().comments;
  assert.equal(comments.length, 3, "the seams, the decision to replace them, and the test command");
  assert.match(comments[1]!, /Seams replaced/);
  assert.ok(comments[2]!.includes("`touch PWNED`") && /Test command proposed/.test(comments[2]!));
});
