// Shared by the `wf gc` process tests (implement-issue.gc.process.test.ts, implement-issue.gc.forges.process.test.ts): the CLI as a
// child process against the temp repo of implement-issue.fixture.ts, and the runs it leaves for gc to judge. The runs are real:
// `runWorkflow` with the fake SDK makes the worktrees, the branches, the pushes and the run state.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GcPlan } from "../workflows/implement-issue/gc.js";
import { branchOf, fx, git, originBranches, progressFileOf, run, worktreeOf } from "./implement-issue.fixture.js";
import { ageRunLog } from "./run-fixtures.js";

const PACKAGE = join(import.meta.dirname, "..");

/** What `wf gc` prints on stdout: the plan, with the result of each action. */
export type GcOutput = GcPlan & { dryRun: boolean };

/** `wf gc <args>` in the temp repo. The child inherits the PATH with the fake forge CLIs and the throwaway home. */
export function gc(...args: string[]): { status: number | null; stderr: string; out: GcOutput } {
  const env = { ...process.env, TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"), WF_METRICS: "off" };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", "cli.ts"), "gc", "--cwd", fx.repo, ...args], { encoding: "utf8", env });
  assert.notEqual(r.stdout, "", `wf gc printed no result (exit ${r.status}): ${r.stderr}`);
  return { status: r.status, stderr: r.stderr, out: JSON.parse(r.stdout) as GcOutput };
}

export const localBranches = () => git(fx.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/wf/").split("\n").filter(Boolean);

/** A run that delivered: its PR is open on the forge, its branch is on the origin, its worktree and local branch are here. */
export async function delivered() {
  const r = await run({ openPr: true });
  const result = r.result as { status: string; branch: string; worktree: string };
  assert.equal(result.status, "done", JSON.stringify(result));
  return { runId: r.runId, branch: result.branch, worktree: result.worktree };
}

/** A run that failed before it delivered: its suite is red from the start, so it stops with `baseline-red` and leaves its worktree and branch. */
export async function failedRun() {
  const r = await run({ testCommand: "exit 1" });
  assert.equal((r.result as { status: string }).status, "baseline-red", JSON.stringify(r.result));
  return { runId: r.runId, branch: branchOf(r.runId), worktree: worktreeOf(r.runId) };
}

/** Moves everything the run did `days` days into the past, as if it had happened then. */
export const age = (runId: string, days: number) => ageRunLog(fx.repo, runId, days);

export const stillThere = (r: { branch: string; worktree: string }) => ({
  worktree: existsSync(r.worktree),
  localBranch: localBranches().includes(r.branch),
  originBranch: originBranches().includes(r.branch),
});

/** Rewrites the progress record of a run: `change` edits what the workflow wrote (a run from before a field, or from a newer kit). */
export function editRecord(runId: string, change: (record: Record<string, unknown>) => void) {
  const file = progressFileOf(runId);
  const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  change(record);
  writeFileSync(file, JSON.stringify(record));
}
