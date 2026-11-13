// Seam 2 on `wf gc`: the `wf` CLI as a child process, against a temporary repo with a bare origin, real git and the fake gh
// of implement-issue.fixture.ts. The runs it cleans up are real: they are made by `runWorkflow` with the fake Cursor SDK,
// so the worktrees, the branches, the pushes and the run state are what the workflow leaves behind. What happened on GitHub
// (a PR merged or closed) is set in the fake gh; what happened to a run in the past (a failure N days ago) is set in its event log.
// Two tests step beside the CLI: one drives gc's plan and apply apart (a run that starts between them), one asks `Commands`
// for the guard that keeps the origin from deleting a branch outside `wf/`. Two run implement-issue itself, to show what a resume
// finds after gc. The cloud snapshot branches are pushed by hand to the temporary remotes, as a cloud step leaves them behind
// (cloud.lifecycle.test.ts has the ones a real crashed cloud step leaves). The CLI helper and the runs it judges are shared with
// implement-issue.gc.forges.process.test.ts (implement-issue.gc.fixture.ts), which runs gc on a GitLab repository too.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { writeRepoConfig } from "./config-fixtures.js";
import { runWorkflow } from "../src/runtime/engine.js";
import { tryAcquireRunLock } from "../src/runtime/run-store.js";
import { Commands, type Exec } from "../workflows/implement-issue/commands.js";
import implementIssue from "../workflows/implement-issue.js";
import { type GcPlan, applyGc, directCommands, planGc } from "../workflows/implement-issue/gc.js";
import { branchOf, failForge, fx, forgeState, git, issue, originBranches, run, setPrState, setup, teardown, worktreeOf } from "./implement-issue.fixture.js";
import { type GcOutput, age, delivered, editRecord, failedRun, gc, localBranches, stillThere } from "./implement-issue.gc.fixture.js";

beforeEach(() => {
  setup();
  issue(["complexity:low"]); // one issue, and a run on it per scenario: a LOW issue is one slice, no planner
});
afterEach(teardown);

test("wf gc removes the worktree, the local branch and the origin branch of a run whose PR was merged, and leaves the run whose PR is still open", async () => {
  const merged = await delivered();
  const open = await delivered();
  setPrState(merged.branch, "MERGED");

  const r = gc();
  assert.equal(r.status, 0, r.stderr);

  assert.deepEqual(stillThere(merged), { worktree: false, localBranch: false, originBranch: false });
  assert.deepEqual(stillThere(open), { worktree: true, localBranch: true, originBranch: true }, "a run whose PR is open is left alone");
  const removed = r.out.remove.find((x) => x.runId === merged.runId);
  assert.equal(removed?.reason, "pr-merged");
  assert.deepEqual(
    removed?.actions.map((a) => [a.kind, a.target, a.result]),
    [
      ["worktree", merged.worktree, "removed"],
      ["local-branch", merged.branch, "removed"],
      ["remote-branch", merged.branch, "removed"],
    ],
  );
  assert.equal(r.out.remove.length, 1);
  assert.match(r.out.kept.find((x) => x.runId === open.runId)?.why ?? "", /PR is open/);
});

test("gc asks for the PR state in the repository the run delivered to (its --repo), not in the one of the cwd", async () => {
  const r = await run({ openPr: true, repo: "acme/fx" });
  const result = r.result as { status: string; branch: string; worktree: string };
  assert.equal(result.status, "done", JSON.stringify(result));
  setPrState(result.branch, "MERGED");

  const out = gc();
  assert.equal(out.status, 0, out.stderr);
  const stateCalls = forgeState().calls.filter((c) => c[0] === "pr" && c[1] === "view" && c[2] === result.branch && c.includes("state"));
  assert.ok(stateCalls.length > 0, "gc asked for the PR state");
  for (const c of stateCalls) assert.deepEqual(c.slice(c.indexOf("--repo"), c.indexOf("--repo") + 2), ["--repo", "acme/fx"], c.join(" "));
  assert.deepEqual(stillThere(result), { worktree: false, localBranch: false, originBranch: false });
});

test("a run that failed more than gcFailedAfterDays ago is cleaned up; one that failed more recently stays, and the days come from the config", async () => {
  const old = await failedRun();
  const recent = await failedRun();
  age(old.runId, 30);
  age(recent.runId, 2);

  const first = gc();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.out.failedAfterDays, 14, "the default");
  assert.deepEqual(stillThere(old), { worktree: false, localBranch: false, originBranch: false });
  assert.deepEqual(stillThere(recent), { worktree: true, localBranch: true, originBranch: false }, "it failed 2 days ago, 14 is the limit");
  assert.match(first.out.kept.find((x) => x.runId === recent.runId)?.why ?? "", /failed 2 days ago/);
  assert.equal(first.out.remove.find((x) => x.runId === old.runId)?.reason, "failed");

  writeRepoConfig(fx.repo, { workflows: { "implement-issue": { settings: { gcFailedAfterDays: 1 } } } });
  const second = gc();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.out.failedAfterDays, 1);
  assert.deepEqual(stillThere(recent), { worktree: false, localBranch: false, originBranch: false }, "with a limit of 1 day, 2 days is long enough");
});

test("a run that failed after it pushed, and whose PR was never made, is cleaned up with its origin branch", async () => {
  failForge("pr create", "HTTP 502");
  const r = await run({ openPr: true });
  assert.equal(r.status, "failed", "the push went through, the PR did not");
  const pushed = { branch: branchOf(r.runId), worktree: worktreeOf(r.runId) };
  assert.deepEqual(stillThere(pushed), { worktree: true, localBranch: true, originBranch: true });
  age(r.runId, 30);

  const result = gc();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(stillThere(pushed), { worktree: false, localBranch: false, originBranch: false });
});

test("a run that a process is executing is never touched, however its PR and its failures read; it is cleaned up once the process ends", async () => {
  const d = await delivered();
  setPrState(d.branch, "MERGED");
  age(d.runId, 30); // a failure this old would qualify too
  // The resume redelivers; its final suite holds it until the gate file exists, so the run is executing while gc looks.
  const started = join(fx.root, "started");
  const gate = join(fx.root, "gate");
  const resuming = run({ openPr: true, testCommand: `touch ${started}; while [ ! -f ${gate} ]; do sleep 0.05; done` }, d.runId);
  try {
    for (let i = 0; i < 400 && !existsSync(started); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(existsSync(started), "the resumed run reached its final suite");

    const during = gc();
    assert.equal(during.status, 0, during.stderr);
    assert.deepEqual(stillThere(d), { worktree: true, localBranch: true, originBranch: true });
    assert.deepEqual(during.out.remove, []);
    assert.match(during.out.kept.find((x) => x.runId === d.runId)?.why ?? "", /executing/);
  } finally {
    writeFileSync(gate, "");
    await resuming;
  }

  const after = gc();
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual(stillThere(d), { worktree: false, localBranch: false, originBranch: false });
});

test("a run that starts executing between the plan and the removal is skipped, not removed (the library seam: plan, then apply)", async () => {
  const d = await delivered();
  setPrState(d.branch, "MERGED");
  const commands = directCommands();
  const plan = await planGc({ cwd: fx.repo, commands, failedAfterDays: 14, snapshots: { remote: "origin", graceHours: 24 } });
  assert.equal(plan.remove.length, 1, "the plan has the run");

  const executing = tryAcquireRunLock(fx.repo, d.runId); // what a resume of the run holds while it executes
  assert.ok(executing, "nothing was executing the run when the lock was taken");
  try {
    await applyGc(plan, commands);
  } finally {
    executing();
  }
  assert.deepEqual(stillThere(d), { worktree: true, localBranch: true, originBranch: true });
  assert.deepEqual(plan.remove[0]!.actions.map((a) => a.result), ["skipped", "skipped", "skipped"]);
  assert.deepEqual(plan.errors, [], "a run that started again is not a failure of gc");
});

test("a run whose PR was closed without merging is cleaned up like a merged one", async () => {
  const closed = await delivered();
  setPrState(closed.branch, "CLOSED");
  const r = gc();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.remove.find((x) => x.runId === closed.runId)?.reason, "pr-closed");
  assert.deepEqual(stillThere(closed), { worktree: false, localBranch: false, originBranch: false });
});

/** Everything gc could change, as a person would see it: the state directory of the repo (every file and directory), its worktrees and the branches of both ends. */
const everything = () => ({
  state: readdirSync(join(fx.repo, ".workflows"), { recursive: true }).map(String).sort(),
  worktrees: git(fx.repo, "worktree", "list", "--porcelain"),
  local: localBranches(),
  origin: originBranches(),
});

test("--dry-run prints the plan and changes nothing; the real run then does what the plan said", async () => {
  const merged = await delivered();
  setPrState(merged.branch, "MERGED");
  const failed = await failedRun();
  age(failed.runId, 30);
  const before = everything();

  const dry = gc("--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.out.dryRun, true);
  assert.deepEqual(everything(), before, "nothing changed");
  assert.deepEqual(dry.out.remove.map((x) => x.runId).sort(), [merged.runId, failed.runId].sort());
  assert.ok(dry.out.remove.every((x) => x.actions.every((a) => a.result === undefined)), "nothing is reported as removed");
  for (const target of [merged.worktree, merged.branch, failed.worktree, failed.branch]) assert.ok(dry.stderr.includes(target), `the plan on stderr names ${target}`);
  assert.match(dry.stderr, /dry run/);

  const real = gc();
  assert.equal(real.status, 0, real.stderr);
  const plan = (o: GcOutput) => o.remove.map((x) => [x.runId, x.reason, x.actions.map((a) => [a.kind, a.target])]).sort();
  assert.deepEqual(plan(real.out), plan(dry.out), "gc removed what the dry run listed, no more");
  assert.deepEqual([stillThere(merged), stillThere(failed)], Array(2).fill({ worktree: false, localBranch: false, originBranch: false }));
});

test("with nothing to clean up gc succeeds and touches nothing: not even the state directory of a repo that has none", () => {
  const r = gc();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.remove, []);
  assert.ok(!existsSync(join(fx.repo, ".workflows")));
});

test("a second gc finds nothing left to do", async () => {
  const merged = await delivered();
  setPrState(merged.branch, "MERGED");
  assert.equal(gc().out.remove.length, 1);
  const again = gc();
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.out.remove, []);
  assert.deepEqual(again.out.kept, [], "the run is clean: it is not listed");
});

test("gc never removes a branch outside the workflow's prefix, nor a wf/ branch of no run it knows that has no merged or closed PR", async () => {
  const merged = await delivered();
  setPrState(merged.branch, "MERGED");
  for (const branch of ["feature/keep", "wf/issue-9-someone-elses-run"]) git(fx.repo, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  git(fx.repo, "branch", "feature/local");

  const r = gc();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(originBranches(), ["wf/issue-9-someone-elses-run"], "a wf/ branch of no run this repo knows, with no PR, is not gc's to delete");
  assert.equal(git(fx.repo, "for-each-ref", "refs/heads/feature/local").includes("feature/local"), true);
  const origin = git(join(fx.root, "origin.git"), "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean);
  assert.deepEqual(origin.sort(), ["feature/keep", "wf/issue-9-someone-elses-run"]);
});

test("an origin branch with a commit the run did not push is kept, though the run is cleaned up", async () => {
  failForge("pr create", "HTTP 502");
  const r = await run({ openPr: true });
  const mine = { branch: branchOf(r.runId), worktree: worktreeOf(r.runId) };
  age(r.runId, 30);
  // somebody pushes to the run's branch
  const clone = join(fx.root, "clone");
  git(fx.root, "clone", "-q", join(fx.root, "origin.git"), clone);
  git(clone, "checkout", "-q", mine.branch);
  git(clone, "-c", "user.name=someone", "-c", "user.email=someone@example.invalid", "commit", "-q", "--allow-empty", "-m", "a reviewer's fix");
  git(clone, "push", "-q", "origin", mine.branch);
  const theirs = git(clone, "rev-parse", "HEAD").trim();

  const result = gc();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(stillThere(mine), { worktree: false, localBranch: false, originBranch: true });
  assert.equal(git(join(fx.root, "origin.git"), "rev-parse", mine.branch).trim(), theirs, "their commit is where they left it");
  assert.match(result.out.remove[0]!.notes.join("\n"), /did not push/);
  assert.match(result.stderr, /did not push/);
});

test("a failed run whose PR is still open loses its worktree and local branch, but its origin branch stays: deleting it would close the PR", async () => {
  const d = await delivered();
  const r = await run({ openPr: true, testCommand: "exit 1" }, d.runId); // the resume fails after the PR was opened
  assert.equal((r.result as { status: string }).status, "tests-failed");
  age(d.runId, 30);

  const result = gc();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(stillThere(d), { worktree: false, localBranch: false, originBranch: true });
  assert.match(result.out.remove[0]!.notes.join("\n"), /its PR is open/);
});

test("when gh cannot say what became of a PR the run is kept and gc fails: an auth error is not \"no PR\"", async () => {
  const merged = await delivered();
  setPrState(merged.branch, "MERGED");
  failForge("pr view", "HTTP 401: authentication required");

  const r = gc();
  assert.equal(r.status, 1);
  assert.deepEqual(stillThere(merged), { worktree: true, localBranch: true, originBranch: true });
  assert.match(r.out.errors.join("\n"), new RegExp(`${merged.runId}.*authentication required`));
  assert.deepEqual(r.out.remove, []);
});

test("gc reads a run whose record has no forge as GitHub: a run from before the field is cleaned up as before", async () => {
  const merged = await delivered();
  editRecord(merged.runId, (record) => {
    assert.equal(record.forge, "github", "the workflow recorded it");
    delete record.forge;
  });
  setPrState(merged.branch, "MERGED");

  const r = gc();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(stillThere(merged), { worktree: false, localBranch: false, originBranch: false });
  assert.equal(r.out.remove.find((x) => x.runId === merged.runId)?.reason, "pr-merged");
});

test("gc keeps a run whose record names a forge this version does not know, and fails: it never asks gh in its place", async () => {
  const merged = await delivered();
  editRecord(merged.runId, (record) => (record.forge = "bitbucket"));
  setPrState(merged.branch, "MERGED");
  const asked = () => forgeState().calls.filter((c) => c[0] === "pr" && c.includes(merged.branch)).length;
  const before = asked();

  const r = gc();
  assert.equal(r.status, 1);
  assert.deepEqual(stillThere(merged), { worktree: true, localBranch: true, originBranch: true });
  assert.match(r.out.errors.join("\n"), new RegExp(`${merged.runId}.*forge "bitbucket".*does not know`));
  assert.equal(asked(), before, "no PR query went to gh for the run");
});

test("a cancelled run is not a failed one: however long ago it stopped, gc keeps it", async () => {
  const controller = new AbortController();
  fx.handlers["test-1"] = () => {
    setTimeout(() => controller.abort(), 100);
    return { hang: true };
  };
  const cancelled = await runWorkflow(implementIssue, { issue: 7, testCommand: "node --test" } as never, { cwd: fx.repo, signal: controller.signal });
  assert.equal(cancelled.status, "cancelled");
  age(cancelled.runId, 90);

  const r = gc();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.remove, []);
  assert.match(r.out.kept.find((x) => x.runId === cancelled.runId)?.why ?? "", /cancelled/);
  assert.ok(existsSync(worktreeOf(cancelled.runId)));
});

/** A run begun when every run of an issue shared `wf/issue-<n>` and `.workflows/worktrees/wf-issue-<n>`: its progress names neither. */
function legacyRun(runId: string) {
  const state = join(fx.repo, ".workflows", "runs", runId);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "tdd-progress.json"), JSON.stringify({ slices: [], baseCommit: git(fx.repo, "rev-parse", "HEAD").trim() }));
  const worktree = join(fx.repo, ".workflows", "worktrees", "wf-issue-7");
  if (!existsSync(worktree)) {
    git(fx.repo, "worktree", "add", "-q", "-b", "wf/issue-7", worktree);
    git(worktree, "push", "-q", "origin", "wf/issue-7");
  }
  return { branch: "wf/issue-7", worktree };
}

test("the branch and worktree every run of an issue shared before runs owned theirs stay while its PR is not done, and go once it is merged or closed", async () => {
  const shared = legacyRun("implement-issue-old");

  const before = gc();
  assert.equal(before.status, 0, before.stderr);
  assert.deepEqual(before.out.remove, []);
  assert.match(before.out.kept.find((x) => x.branch === "wf/issue-7")?.why ?? "", /shared/);
  assert.deepEqual(stillThere(shared), { worktree: true, localBranch: true, originBranch: true });

  addPr("wf/issue-7", "MERGED");
  const after = gc();
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual(stillThere(shared), { worktree: false, localBranch: false, originBranch: false });
  assert.deepEqual(
    after.out.remove.map((x) => [x.runId, x.reason, x.actions.map((a) => [a.kind, a.target, a.result])]),
    [[undefined, "pr-merged", [["worktree", shared.worktree, "removed"], ["local-branch", "wf/issue-7", "removed"], ["remote-branch", "wf/issue-7", "removed"]]]],
  );
});

test("the shared branch of the old runs is not touched while a process executes any of them, whatever its PR says", async () => {
  const shared = legacyRun("implement-issue-old");
  legacyRun("implement-issue-older");
  addPr("wf/issue-7", "CLOSED");
  const release = tryAcquireRunLock(fx.repo, "implement-issue-older")!; // this process stands for the one executing it
  try {
    const r = gc();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out.remove, []);
    assert.match(r.out.kept.find((x) => x.branch === "wf/issue-7")?.why ?? "", /executing/);
    assert.deepEqual(stillThere(shared), { worktree: true, localBranch: true, originBranch: true });
  } finally {
    release();
  }
  assert.equal(gc().status, 0);
  assert.deepEqual(stillThere(shared), { worktree: false, localBranch: false, originBranch: false });
});

test("a progress file that names a path or a branch the workflow does not own is not followed", async () => {
  const outside = await failedRun();
  const foreignBranch = await failedRun();
  for (const r of [outside, foreignBranch]) age(r.runId, 30); // both qualify: they failed long ago
  const victim = join(fx.root, "precious");
  mkdirSync(victim);
  writeFileSync(join(victim, "file"), "keep");
  const tamper = (runId: string, change: Record<string, string>) => {
    const file = join(fx.repo, ".workflows", "runs", runId, "tdd-progress.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...change }));
  };
  tamper(outside.runId, { worktree: victim }); // a directory that is not under .workflows/worktrees
  tamper(foreignBranch.runId, { branch: "main" }); // a branch that is not under wf/

  const r = gc();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.remove, []);
  assert.ok(existsSync(join(victim, "file")));
  assert.ok(existsSync(foreignBranch.worktree), "not even the worktree of a run whose branch is not the workflow's");
  assert.ok(git(fx.repo, "branch", "--list", "main").includes("main"));
  assert.equal(r.out.kept.filter((x) => /not touched/.test(x.why)).length, 2);
});

test("the origin is never asked to delete a branch outside the workflow's prefix, whoever calls", async () => {
  const run: string[][] = [];
  const exec: Exec = async (command, args = []) => {
    run.push([command, ...args]);
    return { ok: true, exitCode: 0, timedOut: false, tail: "" };
  };
  const commands = new Commands(exec, { localMs: 1000, networkMs: 1000 });
  await assert.rejects(commands.deleteOwned(fx.repo, "main", "0".repeat(40)), /only deletes branches under wf\//);
  assert.deepEqual(run, [], "no command ran");
  await commands.deleteOwned(fx.repo, "wf/issue-7-x", "a".repeat(40));
  assert.deepEqual(run.at(-1)?.slice(0, 5), ["git", "push", `--force-with-lease=wf/issue-7-x:${"a".repeat(40)}`, "origin", ":refs/heads/wf/issue-7-x"]);
});

test("resuming a run whose worktree and branch gc removed fails and says so, instead of delivering an empty tree as the finished work", async () => {
  const d = await delivered();
  const failed = await run({ openPr: true, testCommand: "exit 1" }, d.runId); // the resume fails, after the slice was done
  assert.equal((failed.result as { status: string }).status, "tests-failed");
  age(d.runId, 30);
  assert.equal(gc().status, 0);
  assert.deepEqual(stillThere(d), { worktree: false, localBranch: false, originBranch: true });
  const originHead = () => git(join(fx.root, "origin.git"), "rev-parse", d.branch).trim();
  const workOnOrigin = originHead();

  const resumed = await run({ openPr: true }, d.runId);
  assert.equal(resumed.status, "failed", JSON.stringify(resumed.result));
  assert.match(resumed.error!, /gone/);
  assert.match(resumed.error!, /new run/);
  assert.ok(!existsSync(d.worktree), "no empty worktree was made in its place");
  assert.equal(originHead(), workOnOrigin, "the work on the origin was not overwritten with an empty tree");
});

test("a run that failed before its first slice can be resumed after gc: there was nothing to lose, and its worktree is made again", async () => {
  const failed = await failedRun(); // baseline-red: the suite was red from the start
  age(failed.runId, 30);
  assert.equal(gc().status, 0);
  assert.deepEqual(stillThere(failed), { worktree: false, localBranch: false, originBranch: false });

  const resumed = await run({ testCommand: "node --test" }, failed.runId);
  assert.equal((resumed.result as { status: string }).status, "done", JSON.stringify(resumed.result ?? resumed.error));
  assert.ok(existsSync(failed.worktree));
});

/** The cloud snapshot branches of the bare repository at `bare` (the origin by default): what a cloud step's push leaves when nothing deletes it. */
const snapshotsOn = (bare = join(fx.root, "origin.git")) =>
  git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads/wf/cloud-snapshot/")
    .split("\n")
    .filter(Boolean)
    .sort();

/** Pushes `HEAD` as the snapshot branch of `runId` to the remote `remote`, the way a cloud step does, and returns the branch. */
function leaveSnapshot(runId: string, { remote = "origin", id = "00000000" } = {}): string {
  const branch = `wf/cloud-snapshot/${runId}/${id}`;
  git(fx.repo, "push", "-q", remote, `HEAD:refs/heads/${branch}`);
  return branch;
}

test("a cloud snapshot branch that a run of this repo left on the remote is removed once no process executes the run and its last event is past the grace period; --dry-run only lists it", async () => {
  const d = await delivered(); // a run of this repo whose PR is open: the sweep has nothing else to do with it
  age(d.runId, 2);
  const branch = leaveSnapshot(d.runId);
  assert.deepEqual(snapshotsOn(), [branch]);

  const dry = gc("--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(snapshotsOn(), [branch], "a dry run deletes nothing");
  assert.deepEqual(
    dry.out.remove.map((x) => [x.runId, x.reason, x.actions.map((a) => [a.kind, a.target, a.result])]),
    [[d.runId, "snapshot", [["remote-branch", branch, undefined]]]],
  );
  assert.ok(dry.stderr.includes(branch), "the plan on stderr names the branch");
  assert.deepEqual(stillThere(d), { worktree: true, localBranch: true, originBranch: true }, "the run itself is not gc's to clean: its PR is open");

  const real = gc();
  assert.equal(real.status, 0, real.stderr);
  assert.deepEqual(snapshotsOn(), [], "the branch is gone from the remote");
  assert.deepEqual(real.out.remove[0]!.actions.map((a) => [a.target, a.result]), [[branch, "removed"]]);
  assert.deepEqual(stillThere(d), { worktree: true, localBranch: true, originBranch: true });
  assert.deepEqual(gc().out.remove, [], "a second gc finds nothing left");
});

/** What the plan keeps of the cloud snapshot branches: each branch once, with why. */
const keptSnapshots = (out: GcOutput) => out.kept.filter((k) => k.branch?.startsWith("wf/cloud-snapshot/")).map((k) => [k.branch, k.why]);
/** Every `gh` call that names a cloud snapshot branch: a snapshot has no PR, so there must be none. */
const prLookupsForSnapshots = () => forgeState().calls.filter((c) => c.some((arg) => arg.includes("cloud-snapshot")));

test("a snapshot branch of a run still inside the grace period, of a run id this repo does not have, or with a name no cloud step builds, stays; the plan says why, lists each once, and no PR is looked up for any", async () => {
  const fresh = await delivered(); // its last event is from this minute: a cloud agent may still be starting from its snapshot
  const mine = leaveSnapshot(fresh.runId);
  const foreign = leaveSnapshot("implement-issue-made-in-another-clone");
  git(fx.repo, "push", "-q", "origin", "HEAD:refs/heads/wf/cloud-snapshot/hand-made");
  const before = snapshotsOn();
  assert.equal(before.length, 3);

  const r = gc();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshotsOn(), before, "nothing was deleted");
  assert.deepEqual(r.out.remove, []);
  assert.deepEqual(
    keptSnapshots(r.out).map(([branch]) => branch),
    [mine, "wf/cloud-snapshot/hand-made", foreign].sort(),
    "each is kept once: not also as a branch of no run",
  );
  const why = (branch: string) => r.out.kept.find((k) => k.branch === branch)?.why ?? "";
  assert.match(why(mine), new RegExp(`run ${fresh.runId} was last active less than an hour ago, and gc waits for more than 24 hours`));
  assert.match(why(foreign), /no run of this repo made it .*another clone/);
  assert.match(why("wf/cloud-snapshot/hand-made"), /not a name a cloud step gives/);
  for (const branch of [mine, foreign, "wf/cloud-snapshot/hand-made"]) assert.ok(r.stderr.includes(branch), `the plan on stderr names ${branch}`);
  assert.deepEqual(prLookupsForSnapshots(), [], "no PR lookup was made for a snapshot branch");
});

test("a snapshot branch of a run a process is executing stays, whatever the age of its last event; it goes once the process ends", async () => {
  const d = await delivered();
  age(d.runId, 30);
  const branch = leaveSnapshot(d.runId);
  // The resume redelivers; its final suite holds it until the gate file exists, so the run is executing while gc looks.
  const started = join(fx.root, "started");
  const gate = join(fx.root, "gate");
  const resuming = run({ openPr: true, testCommand: `touch ${started}; while [ ! -f ${gate} ]; do sleep 0.05; done` }, d.runId);
  try {
    for (let i = 0; i < 400 && !existsSync(started); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(existsSync(started), "the resumed run reached its final suite");

    const during = gc();
    assert.equal(during.status, 0, during.stderr);
    assert.deepEqual(snapshotsOn(), [branch]);
    assert.deepEqual(during.out.remove, []);
    assert.match(during.out.kept.find((k) => k.branch === branch)?.why ?? "", new RegExp(`a process is executing run ${d.runId}`));
  } finally {
    writeFileSync(gate, "");
    await resuming;
  }
  age(d.runId, 2); // what the run did while it executed is not past the grace period yet

  const after = gc();
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual(snapshotsOn(), []);
});

test("a snapshot branch of a run whose directory has no event log stays: the log is the only record of when a run was last active", async () => {
  mkdirSync(join(fx.repo, ".workflows", "runs", "implement-issue-no-log"), { recursive: true });
  const branch = leaveSnapshot("implement-issue-no-log");

  const r = gc();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshotsOn(), [branch]);
  assert.deepEqual(r.out.remove, []);
  assert.match(r.out.kept.find((k) => k.branch === branch)?.why ?? "", /run implement-issue-no-log has no event log/);
});

test("a snapshot branch of a run that starts executing between the plan and the removal is skipped, not removed", async () => {
  const d = await delivered();
  age(d.runId, 2);
  const branch = leaveSnapshot(d.runId);
  const commands = directCommands();
  const plan = await planGc({ cwd: fx.repo, commands, failedAfterDays: 14, snapshots: { remote: "origin", graceHours: 24 } });
  assert.deepEqual(plan.remove.map((x) => x.actions.map((a) => a.target)), [[branch]], "the plan has the branch");

  const executing = tryAcquireRunLock(fx.repo, d.runId)!; // what a resume of the run holds while it executes
  try {
    await applyGc(plan, commands);
  } finally {
    executing();
  }
  assert.deepEqual(snapshotsOn(), [branch]);
  assert.deepEqual(plan.remove[0]!.actions.map((a) => a.result), ["skipped"]);
  assert.deepEqual(plan.errors, [], "a run that started again is not a failure of gc");
});

/** A second bare repository, added to the temp repo as the remote `name`: a fork that cloud steps can push their snapshots to. */
function addRemote(name: string): string {
  const bare = join(fx.root, `${name}.git`);
  git(fx.root, "init", "-q", "--bare", bare);
  git(fx.repo, "remote", "add", name, bare);
  return bare;
}

test("when cloud.remote names a remote other than the origin, the sweep lists and deletes the snapshot branches there, and the origin's are not touched", async () => {
  const fork = addRemote("fork");
  writeRepoConfig(fx.repo, { cloud: { remote: "fork" } });
  const d = await delivered();
  age(d.runId, 2);
  const onFork = leaveSnapshot(d.runId, { remote: "fork" });
  const onOrigin = leaveSnapshot(d.runId, { id: "0000000f" });

  const dry = gc("--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(dry.out.remove.map((x) => x.actions.map((a) => [a.kind, a.target, a.remote])), [[["remote-branch", onFork, "fork"]]]);
  assert.match(dry.stderr, new RegExp(`fork branch\\s+${onFork}`), "the plan says which remote");
  assert.deepEqual([snapshotsOn(fork), snapshotsOn()], [[onFork], [onOrigin]], "a dry run deletes nothing");

  const real = gc();
  assert.equal(real.status, 0, real.stderr);
  assert.deepEqual([snapshotsOn(fork), snapshotsOn()], [[], [onOrigin]], "the fork's branch is gone, the origin's is where it was");
  assert.deepEqual(real.out.remove[0]!.actions.map((a) => a.result), ["removed"]);
  assert.match(real.out.kept.find((k) => k.branch === onOrigin)?.why ?? "", /cloud steps push to fork/);
  assert.deepEqual(prLookupsForSnapshots(), [], "no PR lookup for the origin's snapshot either");
});

test("a cloud.remote that is not a remote of the repo has no snapshot branch to sweep, and is not an error", async () => {
  writeRepoConfig(fx.repo, { cloud: { remote: "nowhere" } });
  const r = gc();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.errors, []);
});

test("a remote that refuses to delete one snapshot branch is a failure in the plan's errors, and the rest of the sweep goes on", async () => {
  const d = await delivered();
  age(d.runId, 2);
  const refused = leaveSnapshot(d.runId, { id: "00000000" });
  const accepted = leaveSnapshot(d.runId, { id: "deadbeef" });
  // A branch of another clone whose PR was merged: it comes after the snapshots in the plan, and goes although a deletion before it failed.
  git(fx.repo, "push", "-q", "origin", "HEAD:refs/heads/wf/issue-9-merged-elsewhere");
  addPr("wf/issue-9-merged-elsewhere", "MERGED");
  const hook = join(fx.root, "origin.git", "hooks", "pre-receive");
  writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do\n  case "$ref" in */00000000) [ "$new" = "0000000000000000000000000000000000000000" ] && { echo "deletion refused by the remote" >&2; exit 1; } ;; esac\ndone\n');
  chmodSync(hook, 0o755);

  const r = gc();
  assert.equal(r.status, 1, "a failed deletion fails gc");
  assert.deepEqual(snapshotsOn(), [refused], "the branch the remote refused is still there; the other went");
  assert.ok(!originBranches().includes("wf/issue-9-merged-elsewhere"), "the sweep went on past the failure");
  assert.equal(r.out.errors.length, 1);
  assert.match(r.out.errors[0]!, new RegExp(`${d.runId}.*${refused}.*deletion refused by the remote`));
  assert.deepEqual(
    r.out.remove.flatMap((x) => x.actions.map((a) => [a.target, a.result])).sort(),
    [[refused, "failed"], [accepted, "removed"], ["wf/issue-9-merged-elsewhere", "removed"]].sort(),
  );
});

test("the grace period is the setting gcSnapshotGraceHours: a longer one keeps a snapshot that the default would remove, and 0 removes one the default would keep", async () => {
  const d = await delivered();
  age(d.runId, 2);
  const branch = leaveSnapshot(d.runId);

  settingsOfImplementIssue({ gcSnapshotGraceHours: 72 });
  const longer = gc();
  assert.equal(longer.status, 0, longer.stderr);
  assert.deepEqual(snapshotsOn(), [branch]);
  assert.match(longer.out.kept.find((k) => k.branch === branch)?.why ?? "", /last active 2 days ago, and gc waits for more than 72 hours/);

  settingsOfImplementIssue({ gcSnapshotGraceHours: 0 });
  const none = await delivered(); // finished a moment ago
  const fresh = leaveSnapshot(none.runId);
  const shorter = gc();
  assert.equal(shorter.status, 0, shorter.stderr);
  assert.deepEqual(snapshotsOn(), [], "with no grace the snapshot of a run that just stopped goes, as does the older one");
  assert.deepEqual(shorter.out.remove.map((x) => x.actions.map((a) => a.target)).flat().sort(), [branch, fresh].sort());
});

/** Sets `implement-issue`'s settings in the repo config. */
const settingsOfImplementIssue = (settings: Record<string, unknown>) => writeRepoConfig(fx.repo, { workflows: { "implement-issue": { settings } } });

/** A PR on GitHub for a branch this repo has no run for (the run was made in another clone): the fake gh gets it as if `pr create` had made it. */
function addPr(head: string, state: "OPEN" | "MERGED" | "CLOSED") {
  const st = JSON.parse(readFileSync(fx.forgeStateFile, "utf8")) as { prs: unknown[] };
  st.prs.push({ url: `https://example.invalid/pull/${st.prs.length + 1}`, body: "", head, state });
  writeFileSync(fx.forgeStateFile, JSON.stringify(st));
}

test("a wf/ branch on the origin that no run of this repo owns goes when its PR was merged or closed, and stays when its PR is open or it has none", async () => {
  // Runs made in another clone: their branches are on the origin and their PRs on GitHub, but this repo has no state for them.
  const merged = await delivered();
  const closed = await delivered();
  const open = await delivered();
  rmSync(join(fx.repo, ".workflows", "runs"), { recursive: true });
  setPrState(merged.branch, "MERGED");
  setPrState(closed.branch, "CLOSED");
  git(fx.repo, "push", "-q", "origin", "HEAD:refs/heads/wf/issue-9-no-pr-yet");

  const r = gc();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(originBranches().sort(), [open.branch, "wf/issue-9-no-pr-yet"].sort());
  assert.deepEqual(
    r.out.remove.map((x) => [x.runId, x.reason, x.actions.map((a) => [a.kind, a.target, a.result])]).sort(),
    [
      [undefined, "pr-closed", [["remote-branch", closed.branch, "removed"]]],
      [undefined, "pr-merged", [["remote-branch", merged.branch, "removed"]]],
    ].sort(),
  );
  assert.ok(existsSync(merged.worktree) && localBranches().includes(merged.branch), "nothing local is touched: no run here owns it");
  assert.match(r.out.kept.find((x) => x.branch === open.branch)?.why ?? "", /PR is open/);
});

test("the plan says what a failed run's removal loses: uncommitted files in its worktree, and commits that are on no remote", async () => {
  const failed = await failedRun();
  age(failed.runId, 30);
  writeFileSync(join(failed.worktree, "notes.txt"), "half-written\n");
  git(failed.worktree, "add", "notes.txt");
  git(failed.worktree, "commit", "-qm", "work that was never pushed");
  writeFileSync(join(failed.worktree, "scratch.txt"), "uncommitted\n");

  const r = gc("--dry-run");
  assert.equal(r.status, 0, r.stderr);
  const notes = r.out.remove[0]!.notes.join("\n");
  assert.match(notes, /uncommitted/);
  assert.match(notes, /1 commit .*on no remote/);
  assert.match(r.stderr, /uncommitted/);
  assert.ok(existsSync(join(failed.worktree, "scratch.txt")), "a dry run loses nothing");
});
