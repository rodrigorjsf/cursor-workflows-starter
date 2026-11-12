// Seam 1, the run, for a write step in the cloud: `runWorkflow` with the fake Cursor SDK in cloud mode, a temp repository and a
// temporary bare repository as its `origin`. The fake agent's work is real git on the remote (test/cloud-fixtures.ts): it commits
// on the snapshot branch the engine pushed. The assertions are on the outcome, the agent the SDK was asked for, the replayed
// event log and the git state of the worktree and of the remote: what the local worktree holds after the step, and what a
// command that runs on this machine afterwards sees.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { calls, costConfig, resetCloud, script, stats } from "@cursor/sdk";
import { runWorkflow } from "../src/runtime/engine.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { clearConfig, configWorkflow, writeGlobalConfig } from "./config-fixtures.js";
import { agentCommits, agentRewritesHistory, git, remoteBranches, repoWithRemote, worktreeState } from "./cloud-fixtures.js";

const root = join(import.meta.dirname, ".tmp", `cloud-write-${process.pid}`);
const cwd = join(root, "repo");
const remote = join(root, "origin.git");

beforeEach(() => {
  repoWithRemote(cwd, remote);
  writeGlobalConfig({ caps: { allowedLocations: ["local", "cloud"] }, workflows: { cfg: { roles: { classify: { location: "cloud" } } } } });
});
afterEach(() => {
  clearConfig(cwd);
  rmSync(root, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
  resetCloud();
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0, cancels: 0, cancelled: 0, turnsDelivered: 0, sends: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined });
});

const logOf = (runId: string) => readEventLog(eventLogPath(cwd, runId)).events;
const warningsOf = (runId: string) => logOf(runId).flatMap((e) => (e.type === "warning" ? [e.message] : []));
/** The workflow of one step that can write, on the `classify` role (cloud `ok`), and no retries: one attempt. */
const writeStep = () => configWorkflow((ctx) => ctx.agent("write it", { role: "classify", label: "write", retries: 0 }));
const read = (path: string) => readFileSync(join(cwd, path), "utf8");
const subjects = () => git(cwd, "log", "--format=%s").trim().split("\n");
/** A command of this machine, the way a TDD loop checks the work: prints what the worktree holds. */
const CHECK = `const fs=require("fs");process.stdout.write([fs.readFileSync("a.txt","utf8").trim(),fs.existsSync("b.txt"),fs.readFileSync("src/c.txt","utf8").trim()].join("|"))`;

test("a write step of a role configured for the cloud works on the snapshot branch, the engine fast-forwards the local worktree to the agent's commits, and the next local command runs on them", async () => {
  const base = git(cwd, "rev-parse", "HEAD").trim();
  let sent = "";
  script.push((o, msg) => {
    sent = msg;
    agentCommits(remote, o.cloud.repos[0].startingRef, { "a.txt": "a, by the agent\n", "src/c.txt": "c\n", "b.txt": null }, "agent: add c");
    return { result: "done" };
  });
  const wf = configWorkflow(async (ctx) => {
    await ctx.agent("write it", { role: "classify", label: "write" }); // no `tools`: the step can write
    return ctx.exec(process.execPath, ["-e", CHECK], { label: "tests" });
  });
  const r = await runWorkflow(wf, {}, { cwd });

  assert.equal(r.status, "finished", r.error);
  assert.deepEqual(r.result, { ok: true, exitCode: 0, timedOut: false, tail: "a, by the agent|false|c" }, "the command ran on this machine, on the agent's work");
  const [created] = calls;
  assert.equal(created.cloud.workOnCurrentBranch, true, "the agent commits on the snapshot branch");
  assert.equal(created.cloud.autoCreatePR, false, "the workflow keeps delivery");
  assert.match(sent, /commit/i, "and it is told to commit there");
  assert.equal(read("src/c.txt"), "c\n");
  assert.equal(existsSync(join(cwd, "b.txt")), false);
  assert.equal(git(cwd, "status", "--porcelain"), "", "the worktree is clean at the agent's tree");
  assert.deepEqual(subjects(), ["agent: add c", "init"], "the history gained the agent's commit only: a clean worktree needs no snapshot commit");
  assert.equal(git(cwd, "rev-parse", "HEAD~1").trim(), base);
  assert.deepEqual(remoteBranches(remote), [], "the snapshot branch is deleted when the step ends");
  const end = logOf(r.runId).find((e) => e.type === "step-end" && e.label === "write");
  assert.ok(end && end.type === "step-end");
  assert.deepEqual([end.ok, end.location], [true, "cloud"]);
});

test("the changes the worktree had that no commit holds are what the agent builds on, and the snapshot commit joins the history with the agent's", async () => {
  writeFileSync(join(cwd, "a.txt"), "a, edited\n");
  writeFileSync(join(cwd, "new.txt"), "new\n");
  script.push((o) => (agentCommits(remote, o.cloud.repos[0].startingRef, { "c.txt": "c\n" }, "agent: add c"), { result: "done" }));
  const r = await runWorkflow(writeStep(), {}, { cwd });

  assert.equal(r.status, "finished", r.error);
  assert.deepEqual([read("a.txt"), read("new.txt"), read("c.txt")], ["a, edited\n", "new\n", "c\n"], "the agent's tree holds the person's changes and its own");
  assert.equal(git(cwd, "status", "--porcelain"), "", "all of it is committed now");
  const [agent, snapshot, init] = subjects();
  assert.deepEqual([agent, snapshot?.startsWith("wf: snapshot of the worktree for wf/cloud-snapshot/"), init], ["agent: add c", true, "init"]);
  assert.deepEqual(remoteBranches(remote), []);
});

test("a cloud agent that rewrote the history is not a fast-forward: the step fails and the worktree, the branch and the remote are as they were", async () => {
  writeFileSync(join(cwd, "a.txt"), "a, edited\n");
  const before = worktreeState(cwd);
  script.push((o) => (agentRewritesHistory(remote, o.cloud.repos[0].startingRef, { "z.txt": "z\n" }), { result: "done" }));
  const r = await runWorkflow(writeStep(), {}, { cwd });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /not a fast-forward: the cloud agent's branch .* does not contain the snapshot it started from/);
  assert.deepEqual(worktreeState(cwd), before, "HEAD, the index, the files and the refs: nothing moved");
  assert.equal(existsSync(join(cwd, "z.txt")), false);
  assert.deepEqual(remoteBranches(remote), [], "the snapshot branch is deleted on a failed step too");
  const end = logOf(r.runId).find((e) => e.type === "step-end");
  assert.ok(end && end.type === "step-end");
  assert.deepEqual([end.ok, end.reverted, end.errorKind], [false, undefined, "exception"], "nothing was changed, so there was nothing to put back");
});

test("a local branch that moved while the agent ran is not a fast-forward either: the person's commit stays, the agent's work is not brought back", async () => {
  script.push((o) => {
    agentCommits(remote, o.cloud.repos[0].startingRef, { "c.txt": "c\n" });
    git(cwd, "commit", "--allow-empty", "-qm", "the person committed meanwhile");
    return { result: "done" };
  });
  const r = await runWorkflow(writeStep(), {}, { cwd });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /not a fast-forward: the local branch moved while the cloud agent ran/);
  assert.deepEqual(subjects(), ["the person committed meanwhile", "init"]);
  assert.equal(existsSync(join(cwd, "c.txt")), false);
});

test("working files that changed while the agent ran are never overwritten: the step fails and the change is still there", async () => {
  writeFileSync(join(cwd, "a.txt"), "a, edited\n");
  script.push((o) => {
    agentCommits(remote, o.cloud.repos[0].startingRef, { "a.txt": "a, by the agent\n", "c.txt": "c\n" });
    writeFileSync(join(cwd, "a.txt"), "a, edited again while the agent worked\n");
    return { result: "done" };
  });
  const r = await runWorkflow(writeStep(), {}, { cwd });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /the working files changed while the cloud agent ran, and bringing its work back would overwrite those changes/);
  assert.equal(read("a.txt"), "a, edited again while the agent worked\n");
  assert.equal(existsSync(join(cwd, "c.txt")), false);
  assert.deepEqual(subjects(), ["init"]);
});

test("an agent that made no commit changes nothing, and the step says so: the person's uncommitted changes do not end up committed for it", async () => {
  for (const dirty of [false, true]) {
    if (dirty) writeFileSync(join(cwd, "a.txt"), "a, edited\n");
    const before = worktreeState(cwd);
    const r = await runWorkflow(writeStep(), {}, { cwd });

    assert.equal(r.status, "finished", r.error);
    assert.deepEqual(worktreeState(cwd), before, dirty ? "the edit is still an edit, and HEAD did not move to the snapshot" : "nothing moved");
    assert.ok(warningsOf(r.runId).some((w) => /the cloud agent made no commit on wf\/cloud-snapshot\/.*nothing came back to the worktree/.test(w)), warningsOf(r.runId).join("\n"));
  }
});

test("a move of the worktree that fails half way is put back by the engine: files, index and branch are as they were before the step", async () => {
  writeFileSync(join(cwd, "a.txt"), "a, edited\n");
  writeFileSync(join(cwd, "new.txt"), "new\n");
  const before = worktreeState(cwd);
  script.push((o) => {
    agentCommits(remote, o.cloud.repos[0].startingRef, { "a.txt": "a, by the agent\n", "new.txt": null, "c.txt": "c\n" });
    writeFileSync(join(cwd, ".git", "refs", "heads", "main.lock"), ""); // the branch cannot move: the last thing that happens fails
    return { result: "done" };
  });
  const r = await runWorkflow(writeStep(), {}, { cwd });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /could not move the worktree to the cloud agent's work/);
  assert.deepEqual(worktreeState(cwd), before);
  assert.deepEqual([read("a.txt"), read("new.txt"), existsSync(join(cwd, "c.txt"))], ["a, edited\n", "new\n", false]);
  const end = logOf(r.runId).find((e) => e.type === "step-end");
  assert.ok(end && end.type === "step-end");
  assert.equal(end.reverted, true, "the step-end says the engine undid it");
});

test("a structured write step brings its commits back and takes its result from the artifact its role asks for, so the result never has to be parsed from the text", async () => {
  writeGlobalConfig({ caps: { allowedLocations: ["local", "cloud"] }, workflows: { cfg: { roles: { classify: { location: "cloud", resultVia: "artifact" } } } } });
  const SCHEMA = { type: "object", required: ["files"], properties: { files: { type: "integer" } } };
  script.push((o) => (agentCommits(remote, o.cloud.repos[0].startingRef, { "c.txt": "c\n" }, "agent: add c"), { result: "Done: 1 file.", artifacts: { "result.json": '{"files": 1}' } }));
  const r = await runWorkflow(configWorkflow((ctx) => ctx.agent<{ files: number }>("write it", { role: "classify", label: "write", schema: SCHEMA })), {}, { cwd });

  assert.equal(r.status, "finished", r.error);
  assert.deepEqual(r.result, { files: 1 });
  assert.equal(read("c.txt"), "c\n");
  assert.deepEqual(subjects(), ["agent: add c", "init"]);
});

test("a step that has its work brought back when its first attempt could not is retried from a worktree that is as it was", async () => {
  writeFileSync(join(cwd, "a.txt"), "a, edited\n");
  script.push(
    (o) => (agentRewritesHistory(remote, o.cloud.repos[0].startingRef, { "z.txt": "z\n" }), { result: "first" }),
    (o) => (agentCommits(remote, o.cloud.repos[0].startingRef, { "c.txt": "c\n" }, "agent: add c"), { result: "second" }),
  );
  const r = await runWorkflow(configWorkflow((ctx) => ctx.agent<string>("write it", { role: "classify", label: "write" })), {}, { cwd });

  assert.equal(r.status, "finished", r.error);
  assert.equal(r.result, "second");
  assert.equal(calls.length, 2, "a new agent, from a new snapshot");
  assert.notEqual(calls[0].cloud.repos[0].startingRef, calls[1].cloud.repos[0].startingRef);
  assert.deepEqual([read("a.txt"), read("c.txt"), existsSync(join(cwd, "z.txt"))], ["a, edited\n", "c\n", false]);
  assert.deepEqual(remoteBranches(remote), []);
});

test("a machine that converts line endings (core.autocrlf) gets its work back and a clean status: the checks compare what git stores, not the bytes on disk", async () => {
  git(cwd, "config", "core.autocrlf", "true");
  writeFileSync(join(cwd, "a.txt"), "a\r\nedited\r\n"); // how such a machine has the file on disk
  script.push((o) => (agentCommits(remote, o.cloud.repos[0].startingRef, { "c.txt": "c\n" }, "agent: add c"), { result: "done" }));
  const r = await runWorkflow(writeStep(), {}, { cwd });

  assert.equal(r.status, "finished", r.error);
  assert.equal(git(cwd, "status", "--porcelain"), "");
  assert.deepEqual(subjects().slice(0, 1), ["agent: add c"]);
  assert.equal(git(cwd, "show", "HEAD:a.txt"), "a\nedited\n", "git stores the file with plain line ends");
});
