// State files survive a crash. Whole-file state (job records, memo entries, workflow progress) is replaced atomically;
// append-only state is JSON Lines that tolerates a torn last line.
//
// "Atomically" is observed through what it guarantees: the target is never opened and rewritten in place, it is replaced
// by a complete new file. So after every write the file is a different inode, and no temp file is left behind.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { defaultDbPath } from "../src/observability/db.js";
import { type JobRecord, jobsDir, writeJob } from "../src/runtime/jobs.js";
import { MemoStore } from "../src/runtime/memo.js";
import { stateDir, userDir } from "../src/runtime/state.js";
import { appendJsonl, readJsonl, writeFileAtomic } from "../src/runtime/state-files.js";
import { ProgressStore } from "../workflows/implement-issue/tdd.js";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-state-files-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const inode = (file: string) => statSync(file).ino;
const strayFiles = (d: string) => readdirSync(d).filter((f) => f.endsWith(".tmp"));

test("writeFileAtomic replaces the file with a complete new one and leaves no temp file", () => {
  const file = join(dir, "a.json");
  writeFileAtomic(file, '{"v":1}');
  const first = inode(file);
  writeFileAtomic(file, '{"v":2}');
  assert.equal(readFileSync(file, "utf8"), '{"v":2}');
  assert.notEqual(inode(file), first, "replaced, not rewritten in place");
  assert.deepEqual(strayFiles(dir), []);
});

test("writeFileAtomic that fails keeps the old content and leaves no temp file", () => {
  const sub = join(dir, "fail");
  mkdirSync(join(sub, "target.json"), { recursive: true }); // renaming a file over a directory fails
  assert.throws(() => writeFileAtomic(join(sub, "target.json"), "x"));
  assert.deepEqual(strayFiles(sub), []);
});

test("job records are replaced atomically", () => {
  const cwd = join(dir, "job-repo");
  const job: JobRecord = { jobId: "j1", runId: "r1", pid: process.pid, heartbeat: "2026-01-01T00:00:00.000Z" };
  writeJob(cwd, job);
  const file = join(jobsDir(cwd), "j1.json");
  const first = inode(file);
  writeJob(cwd, { ...job, heartbeat: "2026-01-01T00:00:05.000Z" });
  assert.notEqual(inode(file), first);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).heartbeat, "2026-01-01T00:00:05.000Z");
  assert.deepEqual(strayFiles(jobsDir(cwd)), []);
});

test("memo entries are replaced atomically", () => {
  const cwd = join(dir, "memo-repo");
  const memo = new MemoStore(cwd);
  memo.set("k", { a: 1 });
  const file = join(cwd, ".workflows", "memo", "k.json");
  const first = inode(file);
  memo.set("k", { a: 2 });
  assert.notEqual(inode(file), first);
  assert.deepEqual(memo.get("k"), { a: 2 });
  assert.deepEqual(strayFiles(join(cwd, ".workflows", "memo")), []);
});

test("workflow progress is replaced atomically", () => {
  const cwd = join(dir, "progress-repo");
  const progress = new ProgressStore(cwd, "run-1");
  progress.save();
  const first = inode(progress.file);
  progress.save();
  assert.notEqual(inode(progress.file), first);
  assert.deepEqual(new ProgressStore(cwd, "run-1").data, { slices: [] });
});

test("appendJsonl closes a torn last line first, so the new record stays readable", () => {
  const file = join(dir, "log.jsonl");
  writeFileSync(file, '{"n":1}\n{"n":2,"tor');
  appendJsonl(file, { n: 3 });
  const read = readJsonl(file, (v): v is { n: number } => typeof v === "object" && v !== null && "n" in v);
  assert.deepEqual(read.records, [{ n: 1 }, { n: 3 }]);
  assert.equal(read.skipped, 1);
});

test("the per-user directory follows WF_HOME, and so does the metrics database", () => {
  const previous = { home: process.env.WF_HOME, db: process.env.WF_METRICS_DB };
  try {
    process.env.WF_HOME = join(dir, "wf-home");
    delete process.env.WF_METRICS_DB;
    assert.equal(userDir(), join(dir, "wf-home"));
    assert.equal(defaultDbPath(), join(dir, "wf-home", "metrics.db"));
  } finally {
    for (const [key, value] of [["WF_HOME", previous.home], ["WF_METRICS_DB", previous.db]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("state lives in a linked worktree, where .git is a file, and stays out of git", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
  const main = join(dir, "wt-main");
  const linked = join(dir, "wt-linked");
  mkdirSync(main);
  git(main, "init", "-q");
  git(main, "commit", "-q", "--allow-empty", "-m", "init");
  git(main, "worktree", "add", "-q", linked);

  const runs = stateDir(linked, "runs");
  assert.equal(runs, join(linked, ".workflows", "runs"));
  writeFileSync(join(runs, "probe.json"), "{}");
  assert.equal(git(linked, "status", "--porcelain", "--untracked-files=all"), "", ".workflows/ must not show up as untracked");
});
