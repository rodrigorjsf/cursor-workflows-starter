// Seam 1 on the shipped workflow: `implement-issue` is safe to run repeatedly and to resume. Each run owns its branch and
// its worktree, starts from the current head of the default branch and takes a lock on the issue; delivery after a resume
// redelivers with a lease-protected force push and never overwrites commits the workflow did not make. Runs `runWorkflow`
// with the fake SDK and the environment of implement-issue.fixture.ts (fake gh, temp repo with a bare origin, real git).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { calls } from "@cursor/sdk";
import type { ContentEvent, ExecStartEvent } from "../src/runtime/events.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { Commands, type Exec } from "../workflows/implement-issue/commands.js";
import { SUB_CODE, branchOf, failGh, fx, gh, git, issue, names, run, setup, submit, teardown, worktreeOf, write } from "./implement-issue.fixture.js";

beforeEach(setup);
afterEach(teardown);

const res = (r: { result?: unknown }) => r.result as any;
const commitOnMain = (file: string) => {
  writeFileSync(join(fx.repo, file), `${file}\n`);
  git(fx.repo, "add", "-A");
  git(fx.repo, "commit", "-qm", `add ${file}`);
};

// ── Run-owned worktrees and branches ──────────────────────────────────────────────────

test("a fresh run never reuses the worktree of an earlier run, and starts from the current head of the default branch", async () => {
  issue(["complexity:low"]);
  const first = await run({});
  assert.equal(res(first).status, "done", JSON.stringify(res(first)));
  const firstHead = git(worktreeOf(first.runId), "rev-parse", "HEAD").trim();

  commitOnMain("NOTES.md"); // lands on main after the first run

  const second = await run({});
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));
  assert.match(res(second).branch, /^wf\/issue-7-[0-9a-f]{8}$/, "wf/issue-<n>-<run>, the run id without the workflow's name");
  assert.equal(res(second).worktree, worktreeOf(second.runId));
  assert.equal(res(second).branch, branchOf(second.runId));
  assert.notEqual(res(second).worktree, res(first).worktree);
  assert.notEqual(res(second).branch, res(first).branch);
  assert.equal(git(fx.repo, "rev-parse", `${branchOf(second.runId)}~1`).trim(), git(fx.repo, "rev-parse", "main").trim(), "the run starts from the head of main as it is now");
  assert.ok(existsSync(join(worktreeOf(second.runId), "NOTES.md")));

  assert.equal(git(worktreeOf(first.runId), "rev-parse", "HEAD").trim(), firstHead, "the first run's worktree is where it was left");
  assert.equal(git(fx.repo, "rev-parse", branchOf(first.runId)).trim(), firstHead, "and so is its branch");
});

test("the base is the head of the default branch, not of whatever branch the repository has checked out", async () => {
  issue(["complexity:low"]);
  git(fx.repo, "push", "-q", "origin", "main");
  git(fx.repo, "remote", "set-head", "origin", "main"); // what a clone records: origin's default branch is main
  git(fx.repo, "checkout", "-q", "-b", "feature");
  commitOnMain("feature.txt");

  const r = await run({});
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
  assert.equal(git(fx.repo, "rev-parse", `${branchOf(r.runId)}~1`).trim(), git(fx.repo, "rev-parse", "main").trim());
  assert.ok(!existsSync(join(worktreeOf(r.runId), "feature.txt")), "work that is not on the default branch is not in the base");
});

test("a worktree that is in the run's place but that the run did not create is refused, never reused", async () => {
  issue(["complexity:low"]);
  git(fx.repo, "worktree", "add", "-q", "-b", "somebody-elses", worktreeOf("foreign-run")); // a leftover, with whatever base it had
  const r = await run({}, "foreign-run");
  assert.equal(r.status, "failed", JSON.stringify(r.result));
  assert.match(r.error!, /was not created by this run/);
  assert.deepEqual(names(), [], "no agent works in a worktree that is not the run's");
  assert.equal(calls.length, 0);
});

test("a recorded worktree path that is not a worktree (an interrupted `git worktree add`) is made again, and git never acts on the repository around it", async () => {
  issue(["complexity:low"]);
  const runId = "interrupted";
  const state = join(fx.repo, ".workflows", "runs", runId);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "tdd-progress.json"), JSON.stringify({ slices: [], branch: branchOf(runId), worktree: worktreeOf(runId) })); // the run had recorded its place
  mkdirSync(worktreeOf(runId), { recursive: true }); // and `git worktree add` had made the directory when the process died
  const mainBefore = git(fx.repo, "rev-parse", "HEAD").trim();

  const r = await run({}, runId);
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
  assert.equal(git(worktreeOf(runId), "rev-parse", "--show-toplevel").trim(), realpathSync(worktreeOf(runId)), "the run works in a worktree of its own");
  assert.equal(git(fx.repo, "rev-parse", "HEAD").trim(), mainBefore, "the branch checked out in the repository has no new commit");
  assert.equal(git(fx.repo, "status", "--porcelain").trim(), "", "and no change in its files");
});

test("run ids that a branch name cannot hold still get a branch each, and two such ids never get the same one", async () => {
  issue(["complexity:low"]);
  const a = await run({}, "release 1.0");
  const b = await run({}, "release-1-0"); // what the first id looks like once cleaned
  assert.equal(res(a).status, "done", JSON.stringify(res(a)));
  assert.equal(res(b).status, "done", JSON.stringify(res(b)));
  assert.notEqual(res(a).branch, res(b).branch);
  for (const branch of [res(a).branch, res(b).branch]) git(fx.repo, "check-ref-format", "--branch", branch);
});

// ── One active run per issue ──────────────────────────────────────────────────────────

test("a second run on an issue that has an active run is refused with that run's id; the issue is free once the run ends", async () => {
  issue(["complexity:low"]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const atCodeStep = new Promise<void>((resolve) => (reached = resolve));
  let held = false;
  fx.handlers["codigo-1"] = async (o) => {
    if (!held) {
      held = true;
      reached();
      await gate; // the first run is busy writing code; a second one that got this far would not wait
    }
    write(o, "src/math.js", SUB_CODE);
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  const first = run({}, "run-a");
  try {
    await atCodeStep;
    const agentsBefore = calls.length;

    const refused = await run({}, "run-b");
    assert.equal(res(refused).status, "issue-locked", JSON.stringify(refused));
    assert.equal(res(refused).activeRunId, "run-a");
    assert.match(res(refused).reason, /issue #7 .*run-a/);
    assert.equal(calls.length, agentsBefore, "the refused run asks no agent");
    assert.ok(!existsSync(worktreeOf("run-b")), "and makes no worktree");
  } finally {
    release(); // whatever the checks say, the first run is let go
  }
  assert.equal(res(await first).status, "done");
  const after = await run({}, "run-c");
  assert.equal(res(after).status, "done", `the run that ended released the issue: ${JSON.stringify(res(after))}`);
});

test("the lock is on the issue of one repository: issue #7 of another --repo is not locked out, the same --repo is", async () => {
  issue(["complexity:low"]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const atCodeStep = new Promise<void>((resolve) => (reached = resolve));
  let held = false;
  fx.handlers["codigo-1"] = async (o) => {
    if (!held) {
      held = true;
      reached();
      await gate;
    }
    write(o, "src/math.js", SUB_CODE);
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  const first = run({ repo: "acme/a" }, "run-a");
  try {
    await atCodeStep;
    const sameRepo = await run({ repo: "ACME/A" }, "run-b"); // GitHub names ignore case
    assert.equal(res(sameRepo).status, "issue-locked", JSON.stringify(sameRepo));
    assert.equal(res(sameRepo).activeRunId, "run-a");
    const otherRepo = await run({ repo: "acme/b" }, "run-c");
    assert.equal(res(otherRepo).status, "done", `issue #7 of acme/b is another issue: ${JSON.stringify(res(otherRepo))}`);
  } finally {
    release();
  }
  assert.equal(res(await first).status, "done");
});

/**
 * A `gh` in front of the fixture's that knows which repository the cwd is: `gh repo view [repo] --json url -q .url` answers
 * the URL GitHub gives `repo` (any case, any form gh takes), or the cwd's own, `Owner/Repo`. Everything else goes to the fake.
 */
function ghKnowsTheCwdRepository() {
  const bin = join(fx.root, "bin-repo");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const { spawnSync } = require("child_process");
const a = process.argv.slice(2);
if (a[0] === "repo" && a[1] === "view") {
  const named = a[2] && !a[2].startsWith("-") ? a[2].replace(/^https:\\/\\/github\\.com\\//i, "").replace(/^github\\.com\\//i, "") : "owner/repo";
  process.stdout.write("https://github.com/" + (named.toLowerCase() === "owner/repo" ? "Owner/Repo" : named) + "\\n");
  process.exit(0);
}
const r = spawnSync(${JSON.stringify(join(fx.root, "bin", "gh"))}, a, { stdio: "inherit" });
process.exit(r.status ?? 1);
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`; // teardown puts the PATH back
}

test("the lock is on the issue of the cwd's repository whether or not --repo names it: a run with and one without it refuse each other", async () => {
  issue(["complexity:low"]);
  ghKnowsTheCwdRepository();
  /** Runs `active` until it is writing code, then `others` one after the other while it waits; returns their results. */
  const whileActive = async (active: Record<string, unknown>, others: Array<[Record<string, unknown>, string]>) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const atCodeStep = new Promise<void>((resolve) => (reached = resolve));
    let held = false;
    fx.handlers["codigo-1"] = async (o) => {
      if (!held) {
        held = true;
        reached();
        await gate;
      }
      write(o, "src/math.js", SUB_CODE);
      submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
    };
    const activeId = `active-${others[0][1]}`;
    const first = run(active, activeId);
    const results: Array<{ status: string; activeRunId?: string }> = [];
    try {
      await atCodeStep;
      for (const [args, id] of others) results.push(res(await run(args, id)));
    } finally {
      release();
    }
    assert.equal(res(await first).status, "done");
    return { activeId, results };
  };

  const a = await whileActive({}, [[{ repo: "owner/repo" }, "with-repo"], [{ repo: "https://github.com/OWNER/REPO" }, "with-url"], [{ repo: "other/x" }, "other"]]);
  assert.deepEqual(a.results.map((r) => r.status), ["issue-locked", "issue-locked", "done"], JSON.stringify(a.results));
  assert.equal(a.results[0].activeRunId, a.activeId);

  const b = await whileActive({ repo: "Owner/Repo" }, [[{}, "without-repo"]]);
  assert.deepEqual(b.results.map((r) => r.status), ["issue-locked"], JSON.stringify(b.results));
  assert.equal(b.results[0].activeRunId, b.activeId);
});

test("a run that fails, and a run that stops with a status, release the issue", async () => {
  issue(["complexity:low"]);
  failGh("pr view", "HTTP 401: Bad credentials");
  const failed = await run({ openPr: true }, "run-a");
  assert.equal(failed.status, "failed");
  failGh("pr view", undefined);
  const stopped = await run({ testCommand: "exit 1" }, "run-b"); // the suite is red before the first slice: baseline-red
  assert.equal(res(stopped).status, "baseline-red", JSON.stringify(res(stopped)));
  const resumed = await run({}, "run-c");
  assert.equal(res(resumed).status, "done", JSON.stringify(res(resumed)));
});

test("a lock held by another live process refuses the run with the id of the run that took it", async () => {
  issue(["complexity:low"]);
  mkdirSync(join(fx.repo, ".workflows", "locks"), { recursive: true });
  // process.ppid stands for the other process: it is alive, and the lock does not say it is not the one that took it
  writeFileSync(join(fx.repo, ".workflows", "locks", "issue-7.lock"), JSON.stringify({ pid: process.ppid, token: "theirs", startedAt: "2020-01-01T00:00:00.000Z", runId: "implement-issue-0a1b2c3d" }));
  const r = await run({}, "run-a");
  assert.equal(res(r).status, "issue-locked", JSON.stringify(res(r)));
  assert.equal(res(r).activeRunId, "implement-issue-0a1b2c3d");
  assert.match(res(r).lock, new RegExp(`process ${process.ppid}`));
  assert.equal(calls.length, 0);
});

test("a lock left by a process that died does not stop the issue", async () => {
  issue(["complexity:low"]);
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
  mkdirSync(join(fx.repo, ".workflows", "locks"), { recursive: true });
  writeFileSync(join(fx.repo, ".workflows", "locks", "issue-7.lock"), JSON.stringify({ pid: dead, token: "left-over", startedAt: "2020-01-01T00:00:00.000Z", runId: "ghost" }));
  const r = await run({}, "run-a");
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
});

test("a run begun when every run shared the branch wf/issue-<n> resumes on that branch and worktree", async () => {
  issue(["complexity:low"]);
  const first = await run({});
  assert.equal(res(first).status, "done", JSON.stringify(res(first)));
  // what the progress and the repository looked like before runs owned their branches
  const legacyWorktree = join(fx.repo, ".workflows", "worktrees", "wf-issue-7");
  git(fx.repo, "worktree", "move", worktreeOf(first.runId), legacyWorktree);
  git(fx.repo, "branch", "-m", branchOf(first.runId), "wf/issue-7");
  const file = join(fx.repo, ".workflows", "runs", first.runId, "tdd-progress.json");
  const progress = JSON.parse(readFileSync(file, "utf8"));
  delete progress.branch;
  delete progress.worktree;
  writeFileSync(file, JSON.stringify(progress));

  const agentsBefore = calls.length;
  const again = await run({}, first.runId);
  assert.equal(res(again).status, "done", JSON.stringify(res(again)));
  assert.equal(res(again).branch, "wf/issue-7");
  assert.equal(res(again).worktree, legacyWorktree);
  assert.equal(calls.length, agentsBefore, "the resume asks no agent again");
});

// ── Delivery after a resume: a lease-protected force push ─────────────────────────────

const origin = () => join(fx.root, "origin.git");
const onOriginAt = (branch: string) => git(origin(), "rev-parse", `refs/heads/${branch}`).trim();

/** An agent's commit on top of what the run delivered: the resume undoes it (`reset --soft` to the base) and commits the tree again. */
function agentCommits(worktree: string) {
  writeFileSync(join(worktree, "extra.txt"), "made by an agent that committed\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-qm", "agent commit");
}

test("a resume after the PR exists redelivers over the rewritten history with a force push", async () => {
  issue(["complexity:low"]);
  const first = await run({ openPr: true });
  assert.equal(res(first).status, "done", JSON.stringify(res(first)));
  const branch = branchOf(first.runId);
  const delivered = onOriginAt(branch);
  agentCommits(worktreeOf(first.runId));

  const second = await run({ openPr: true }, first.runId);
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));
  assert.equal(gh().prs.length, 1, "the PR that exists is not created again");
  assert.notEqual(onOriginAt(branch), delivered, "the branch on the origin moved to the rewritten history");
  assert.equal(onOriginAt(branch), git(worktreeOf(first.runId), "rev-parse", "HEAD").trim());
  assert.equal(git(origin(), "rev-list", "--count", `${git(fx.repo, "rev-parse", "main").trim()}..${branch}`).trim(), "1", "one commit above the base, as the first delivery had");
  assert.match(git(origin(), "show", `${branch}:extra.txt`), /made by an agent/);

  // the push the run made, as the run's log shows it: a force that holds only while the origin still has what the first delivery pushed
  const events = readEventLog(eventLogPath(fx.repo, second.runId)).events;
  const pushes = events.filter((e): e is ExecStartEvent => e.type === "exec-start" && e.label === "git push");
  assert.equal(pushes.length, 2, "the first delivery and the redelivery");
  const commandLine = events.find((e): e is ContentEvent => e.type === "content" && e.kind === "tool-call" && e.attemptId === pushes[1]!.attemptId)!;
  assert.deepEqual(JSON.parse(commandLine.text!).args, ["push", `--force-with-lease=${branch}:${delivered}`, "-u", "origin", branch]);
});

/** The progress of a run that delivered before runs recorded what they pushed: no `pushed` list. */
function forgetPushes(runId: string) {
  const file = join(fx.repo, ".workflows", "runs", runId, "tdd-progress.json");
  const progress = JSON.parse(readFileSync(file, "utf8"));
  delete progress.pushed;
  delete progress.repo;
  writeFileSync(file, JSON.stringify(progress));
}

test("a run that delivered before runs recorded their pushes still redelivers on resume: the origin's commit is the workflow's own delivery on the run's base", async () => {
  issue(["complexity:low"]);
  const first = await run({ openPr: true });
  assert.equal(res(first).status, "done", JSON.stringify(res(first)));
  const branch = branchOf(first.runId);
  const delivered = onOriginAt(branch);
  forgetPushes(first.runId);
  agentCommits(worktreeOf(first.runId));

  const second = await run({ openPr: true }, first.runId);
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));
  assert.notEqual(onOriginAt(branch), delivered);
  assert.equal(onOriginAt(branch), git(worktreeOf(first.runId), "rev-parse", "HEAD").trim());
  assert.equal(gh().prs.length, 1);
});

test("for a run with no record of its pushes, a commit someone added on top of the delivery is still not overwritten", async () => {
  issue(["complexity:low"]);
  const first = await run({ openPr: true });
  assert.equal(res(first).status, "done", JSON.stringify(res(first)));
  const branch = branchOf(first.runId);
  const clone = join(fx.root, "reviewer");
  git(fx.root, "clone", "-q", "--branch", branch, origin(), clone);
  git(clone, "config", "user.name", "reviewer");
  git(clone, "config", "user.email", "reviewer@example.invalid");
  writeFileSync(join(clone, "FIX.md"), "a review fix\n");
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "review fix");
  git(clone, "push", "-q", "origin", branch);
  const theirs = onOriginAt(branch);
  forgetPushes(first.runId);
  agentCommits(worktreeOf(first.runId));

  const second = await run({ openPr: true }, first.runId);
  assert.equal(res(second).status, "push-refused", JSON.stringify(res(second)));
  assert.equal(onOriginAt(branch), theirs);
});

test("the push is refused when the remote branch has commits the workflow did not make; nothing on the origin is overwritten", async () => {
  issue(["complexity:low"]);
  const first = await run({ openPr: true });
  assert.equal(res(first).status, "done", JSON.stringify(res(first)));
  const branch = branchOf(first.runId);
  // somebody pushes a fix to the PR branch
  const clone = join(fx.root, "reviewer");
  git(fx.root, "clone", "-q", "--branch", branch, origin(), clone);
  git(clone, "config", "user.name", "reviewer");
  git(clone, "config", "user.email", "reviewer@example.invalid");
  writeFileSync(join(clone, "FIX.md"), "a review fix\n");
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "review fix");
  git(clone, "push", "-q", "origin", branch);
  const theirs = onOriginAt(branch);
  agentCommits(worktreeOf(first.runId)); // and the workflow's history is rewritten on top of what it delivered

  const second = await run({ openPr: true }, first.runId);
  assert.equal(res(second).status, "push-refused", JSON.stringify(res(second)));
  assert.match(res(second).reason, new RegExp(`origin/${branch}.*did not make`));
  assert.equal(onOriginAt(branch), theirs, "the reviewer's commit is still the head of the branch on the origin");
  assert.equal(gh().prs.length, 1);
  assert.equal(git(worktreeOf(first.runId), "log", "-1", "--format=%s").trim().includes("#7"), true, "the run's own work is kept for whoever resolves it");
});

test("the workflow force-pushes only branches under its own prefix, and always with a lease on what it believes the origin has", async () => {
  const pushes: string[][] = [];
  const exec: Exec = async (_command, args = []) => {
    pushes.push(args);
    return { ok: true, exitCode: 0, timedOut: false, tail: "" };
  };
  const commands = new Commands(exec, { localMs: 1000, networkMs: 1000 });
  for (const branch of ["main", "release/1.0", "wfx/issue-7", "feature/wf/issue-7"]) {
    await assert.rejects(commands.pushOwned("/x", branch, "abc123"), /only pushes branches under wf\//, branch);
  }
  assert.deepEqual(pushes, [], "nothing was run for a branch the workflow does not own");

  await commands.pushOwned("/x", "wf/issue-7-a", "abc123");
  await commands.pushOwned("/x", "wf/issue-7-a", undefined); // the origin has no such branch yet: the lease says it must not
  assert.deepEqual(pushes, [
    ["push", "--force-with-lease=wf/issue-7-a:abc123", "-u", "origin", "wf/issue-7-a"],
    ["push", "--force-with-lease=wf/issue-7-a:", "-u", "origin", "wf/issue-7-a"],
  ]);
});
