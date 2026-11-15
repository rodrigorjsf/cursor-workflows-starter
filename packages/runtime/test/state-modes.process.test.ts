// Seam: the engine with the fake Cursor SDK, and real job processes: what a run leaves in `.workflows/` is private to its user. Under the default umask of most machines (0o022) a
// file or folder made without a mode is readable by every local user, and the event log, the journal and the memo hold the
// private source and the step results of the repository. The first test runs a workflow with the fake Cursor SDK in this
// process; the second starts a real detached job (`wf start`, which the job's own process, its heartbeat worker and the
// `ctx.exec` command it sits in all write for). Both read the modes of everything under `.workflows/` back, `worktrees/`
// excluded: its checked-out source keeps its git modes.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { calls, script } from "./fake-sdk.js";
import { runWorkflow } from "../src/runtime/engine.js";
import { defineWorkflow } from "../src/runtime/workflow.js";
import { waitFor } from "./wait-for.js";

const PACKAGE = join(import.meta.dirname, "..");
let sandbox: string;
let repo: string;
let env: Record<string, string>;
let umaskBefore: number;

before(() => {
  umaskBefore = process.umask(0o022); // what a user's shell usually has: the children inherit it too
  sandbox = mkdtempSync(join(tmpdir(), "wf-state-modes-"));
  repo = join(sandbox, "repo");
  mkdirSync(join(repo, ".agents", "workflows"), { recursive: true });
  mkdirSync(join(sandbox, "home"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(repo, "a.txt"), "1");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  writeFileSync(
    join(repo, ".agents", "workflows", "sits-in-exec.mjs"),
    `export default {\n  meta: { name: "sits-in-exec", description: "a job that sits in a long ctx.exec" },\n  async run(ctx) { await ctx.exec("sleep", ["600"], { timeoutMs: 120000 }); },\n};\n`,
  );
  env = {
    PATH: process.env.PATH!,
    HOME: process.env.HOME!,
    TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"),
    WF_HOME: join(sandbox, "home"),
    WF_METRICS: "off",
    WF_DASH_AUTOSTART: "off", // the test must not leave a dashboard behind
    WF_HEARTBEAT_MS: "50", // the heartbeat worker rewrites the job record every 50 ms
  };
});
afterEach(() => {
  script.length = 0;
  calls.length = 0;
});
after(() => {
  process.umask(umaskBefore);
  rmSync(sandbox, { recursive: true, force: true });
});

const stateRoot = () => join(repo, ".workflows");

/** One entry of the state folder: its permission bits, and whether it is a folder. */
interface Entry {
  mode: number;
  folder: boolean;
}

/** `.workflows/` and everything under it but `worktrees/`, by path relative to the repo. */
function entriesUnderState(dir = stateRoot()): Record<string, Entry> {
  const entries: Record<string, Entry> = {};
  if (dir === stateRoot()) entries[relative(repo, dir)] = { mode: statSync(dir).mode & 0o777, folder: true };
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (path === join(stateRoot(), "worktrees")) continue;
    const stat = lstatSync(path);
    entries[relative(repo, path)] = { mode: stat.mode & 0o777, folder: stat.isDirectory() };
    if (stat.isDirectory()) Object.assign(entries, entriesUnderState(path));
  }
  return entries;
}

/** What is not private: a folder that is not 0700 or a file that is not 0600, as `path -> octal mode`. */
function notPrivate(entries: Record<string, Entry>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries)
      .filter(([, { mode, folder }]) => mode !== (folder ? 0o700 : 0o600))
      .map(([path, { mode }]) => [path, mode.toString(8)]),
  );
}

const present = (entries: Record<string, Entry>, pattern: RegExp) => Object.keys(entries).some((path) => pattern.test(path));

test("a run writes its event log, journal, lock and memo, and the folders around them, for its user alone", async () => {
  const seenDuringRun: { entries?: Record<string, Entry> } = {};
  const wf = defineWorkflow({
    meta: { name: "private-state", description: "one memoised read step" },
    defaults: { model: { id: "m" } },
    run: async (ctx) => {
      const answer = await ctx.agent<string>("plan", { label: "plan", tools: ["read"], memo: true });
      seenDuringRun.entries = entriesUnderState(); // the run lock is held, and the step's journal line and memo entry are written
      return answer;
    },
  });

  const outcome = await runWorkflow(wf, {}, { cwd: repo });

  assert.equal(outcome.status, "finished", outcome.error);
  const during = seenDuringRun.entries!;
  for (const pattern of [/^\.workflows$/, /runs\/[^/]+\/events\.jsonl$/, /runs\/[^/]+\/journal\.jsonl$/, /runs\/[^/]+\/run\.lock$/, /memo\/[0-9a-f]+\.json$/]) {
    assert.ok(present(during, pattern), `the run created a file that matches ${pattern}`);
  }
  assert.deepEqual(notPrivate(during), {}, "while the run executes");
  assert.deepEqual(notPrivate(entriesUnderState()), {}, "after the run");
});

test("a folder or a file that exists keeps its mode: the runtime never chmods, and what it makes inside them is private", async () => {
  rmSync(stateRoot(), { recursive: true, force: true }); // a clean slate: the other tests' state is private, this one sets up its own
  mkdirSync(join(stateRoot(), "runs"), { recursive: true });
  chmodSync(stateRoot(), 0o755); // as an older kit (or a loose umask) left it
  chmodSync(join(stateRoot(), "runs"), 0o750);
  const wf = defineWorkflow({ meta: { name: "keeps-modes", description: "one step" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent<string>("plan", { label: "plan" }) });
  const first = await runWorkflow(wf, {}, { cwd: repo, runId: "kept-run" });
  assert.equal(first.status, "finished", first.error);
  const log = join(stateRoot(), "runs", "kept-run", "events.jsonl");
  chmodSync(log, 0o644); // a log an older kit made

  const resumed = await runWorkflow(wf, {}, { cwd: repo, runId: "kept-run" }); // appends to the log that exists
  assert.equal(resumed.status, "finished", resumed.error);

  const modes = entriesUnderState();
  assert.equal(modes[".workflows"]!.mode, 0o755, "the folder that existed");
  assert.equal(modes[".workflows/runs"]!.mode, 0o750, "the folder that existed");
  assert.equal(modes[".workflows/runs/kept-run/events.jsonl"]!.mode, 0o644, "the log that existed is appended to, not chmodded");
  assert.equal(modes[".workflows/runs/kept-run"]!.mode, 0o700, "the folder the run made is private");
  assert.equal(modes[".workflows/runs/kept-run/journal.jsonl"]!.mode, 0o600, "and so is the journal it made");
  rmSync(stateRoot(), { recursive: true, force: true }); // the folder this test opened up must not reach the next one
});

test("a detached job writes its record, its log and the record of its command's process group for its user alone", async () => {
  const wf = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", "cli.ts"), ...args, "--cwd", repo], { env, encoding: "utf8" });
    return { status: r.status, stderr: r.stderr, out: r.stdout.trim() ? (JSON.parse(r.stdout) as Record<string, any>) : {} };
  };
  const started = wf("start", "sits-in-exec", "--args", "{}");
  assert.equal(started.status, 0, started.stderr);
  const jobId: string = started.out.jobId;
  const jobs = join(stateRoot(), "jobs");
  const heartbeat = () => (JSON.parse(readFileSync(join(jobs, `${jobId}.json`), "utf8")) as { heartbeat: string }).heartbeat;
  try {
    // The command is running (its group is recorded) and the heartbeat worker has rewritten the record on its own thread.
    await waitFor("the job's command to be running", () => readdirSync(jobs).some((name) => name.startsWith(`${jobId}.exec-group.`)));
    const first = heartbeat();
    await waitFor("the heartbeat worker to rewrite the job record", () => Date.parse(heartbeat()) - Date.parse(first) >= 150);

    const entries = entriesUnderState();
    for (const pattern of [/jobs\/[^/]+\.json$/, /jobs\/[^/]+\.log$/, /jobs\/[^/]+\.exec-group\.\d+$/, /runs\/[^/]+\/events\.jsonl$/, /runs\/[^/]+\/run\.lock$/]) {
      assert.ok(present(entries, pattern), `the job created a file that matches ${pattern}`);
    }
    assert.deepEqual(notPrivate(entries), {});
  } finally {
    wf("cancel", jobId, "--timeout", "20");
  }
});
