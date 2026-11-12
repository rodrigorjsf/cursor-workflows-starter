// `wf gc`: removes what finished `implement-issue` runs leave behind. Every run owns a worktree, a local branch and (once
// it pushed) a branch on the origin, all named in its `tdd-progress.json`; none of them is ever removed by the run itself.
// gc plans first (`planGc` reads and asks, changes nothing) and then applies the plan (`applyGc`), so `--dry-run` is the
// plan alone.
//
// It cleans a run up when its PR was merged or closed, or when the run failed longer ago than `gcFailedAfterDays`. It
// never touches a run a process is executing, a branch outside `wf/`, or a worktree outside `.workflows/worktrees/`. The
// origin's branch of a merged or closed PR goes with the run; the one of a run that merely failed goes only if no PR is
// open on it (deleting the branch would close the PR) and it points at a commit the run pushed. The run's own state
// (`.workflows/runs/<runId>/`, its event log and journal) stays: it is the history, and the metrics read it.
import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runCommand } from "../../src/runtime/command-runner.js";
import { outcomeClass } from "../../src/runtime/outcome.js";
import { EVENTS_FILE, isRunExecuting, readEventLog, tryAcquireRunLock } from "../../src/runtime/run-store.js";
import type { ExecResult } from "../../src/runtime/workflow.js";
import { type Exec, type PrState, Commands, LOCAL_GIT_TIMEOUT_MS, NETWORK_TIMEOUT_SEC, WORKFLOW_BRANCH_PREFIX } from "./commands.js";
import { ProgressStore } from "./tdd.js";

/** Why a run is cleaned up: its PR was merged or closed, or it failed longer ago than the limit. */
export type GcReason = "pr-merged" | "pr-closed" | "failed";

/** One thing to remove. `head` is the commit an origin branch points at (the lease its deletion carries). */
export interface GcAction {
  kind: "worktree" | "local-branch" | "remote-branch";
  /** The worktree's path, or the branch's name. */
  target: string;
  head?: string;
  /** Set by `applyGc`. `skipped`: a process started executing the run after the plan was made, so nothing of it was touched. */
  result?: "removed" | "failed" | "skipped";
  error?: string;
}

export interface GcRunPlan {
  runId: string;
  reason: GcReason;
  actions: GcAction[];
  /** What of the run stays although the run is cleaned up, and why. */
  notes: string[];
}

export interface GcPlan {
  repo: string;
  /** A run that failed more days ago than this is cleaned up. */
  failedAfterDays: number;
  /** The runs to clean up, with what to remove from each. */
  remove: GcRunPlan[];
  /** The runs that still have something and are not cleaned up, with why. */
  kept: Array<{ runId: string; why: string }>;
  /** What could not be read or asked, or (after `applyGc`) removed. */
  errors: string[];
}

/** `ctx.exec` without a run: the same asynchronous, time-limited command, with nobody to log it to. */
const directExec: Exec = async (command, args = [], opts = {}): Promise<ExecResult> => {
  const o = await runCommand({ command, args, cwd: opts.cwd ?? process.cwd(), env: opts.env, timeoutMs: opts.timeoutMs ?? LOCAL_GIT_TIMEOUT_MS }, () => {});
  return { ok: o.outcome === "exit" && o.exitCode === 0, exitCode: o.exitCode, timedOut: o.outcome === "timeout", tail: o.tail, ...(o.error === undefined ? {} : { error: o.error }) };
};

/** The commands of implement-issue, run outside a workflow run. */
export const directCommands = () => new Commands(directExec, { localMs: LOCAL_GIT_TIMEOUT_MS, networkMs: NETWORK_TIMEOUT_SEC * 1000 });

/** The path as git prints it (symlinks resolved); a leaf that does not exist keeps its name. */
const normal = (path: string) => {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The runs of the repo that have a progress file, and their ids. A run with no (or an unreadable) progress file is not an implement-issue run. */
function implementIssueRuns(cwd: string, errors: string[]): Array<{ runId: string; progress: ProgressStore["data"] }> {
  const runsDir = join(cwd, ".workflows", "runs");
  if (!existsSync(runsDir)) return [];
  const runs: Array<{ runId: string; progress: ProgressStore["data"] }> = [];
  for (const runId of readdirSync(runsDir).sort()) {
    try {
      const store = new ProgressStore(cwd, runId);
      if (existsSync(store.file)) runs.push({ runId, progress: store.data });
    } catch (err) {
      errors.push(`run ${runId}: its progress file cannot be read: ${message(err)}`);
    }
  }
  return runs;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const ago = (ms: number) => (ms < DAY_MS ? "less than a day ago" : `${plural(Math.floor(ms / DAY_MS), "day")} ago`);

/**
 * How the latest execution of the run ended, and when. An execution that never wrote its end (the process died, the machine
 * went down) counts as failed, at its last event: that is what `wf status` calls it. Undefined when the log has no execution.
 */
function lastEnd(cwd: string, runId: string): { how: "failed" | "cancelled" | "other"; at: number } | undefined {
  const { events } = readEventLog(join(cwd, ".workflows", "runs", runId, EVENTS_FILE), { content: false });
  const start = events.findLastIndex((e) => e.type === "run-start");
  if (start < 0) return undefined;
  const end = events.slice(start).find((e) => e.type === "run-end");
  if (!end) return { how: "failed", at: Date.parse(events.at(-1)!.ts) };
  const how = outcomeClass(end.status, end.outcomeStatus);
  return { how: how === "error" || how === "failed" ? "failed" : how === "cancelled" ? "cancelled" : "other", at: Date.parse(end.ts) };
}

/** Why a run that is not cleaned up stays. */
function keptBecause(state: PrState | undefined, end: ReturnType<typeof lastEnd>, failedFor: number | undefined, failedAfterDays: number): string {
  if (state === "OPEN") return "its PR is open";
  if (failedFor !== undefined) return `it failed ${ago(failedFor)}, and gc waits for more than ${plural(failedAfterDays, "day")}`;
  if (end?.how === "cancelled") return "it was cancelled, and can be resumed";
  return "it has no merged or closed PR";
}

/**
 * Looks at every run of the repo and decides what to remove; changes nothing. The runs are the repo's own (`.workflows/runs/`):
 * the global runs index is for tools that are not inside a repo.
 */
export async function planGc(options: { cwd: string; commands: Commands; failedAfterDays: number }): Promise<GcPlan> {
  const { cwd, commands, failedAfterDays } = options;
  const now = Date.now();
  const plan: GcPlan = { repo: cwd, failedAfterDays, remove: [], kept: [], errors: [] };
  const worktreesDir = join(cwd, ".workflows", "worktrees");

  const runs = implementIssueRuns(cwd, plan.errors);
  if (!runs.length) return plan;

  const locals = new Set((await commands.gitRead(cwd, "for-each-ref", "--format=%(refname:short)", `refs/heads/${WORKFLOW_BRANCH_PREFIX}`)).split("\n").filter(Boolean));
  const registered = new Set(
    (await commands.gitRead(cwd, "worktree", "list", "--porcelain"))
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => normal(l.slice("worktree ".length))),
  );
  let remote: Map<string, string> | undefined;
  try {
    remote = await commands.remoteOwnedHeads(cwd);
  } catch (err) {
    plan.errors.push(`the origin's branches cannot be listed, so no origin branch is removed: ${message(err)}`);
  }

  for (const { runId, progress } of runs) {
    const { branch, worktree } = progress;
    if (!branch || !worktree) {
      if (progress.baseCommit !== undefined) plan.kept.push({ runId, why: `begun when every run shared the branch wf/issue-<n> and its worktree: nothing here says which they are, remove them by hand` });
      continue; // a run that stopped before it made its worktree has nothing to clean
    }
    const inside = relative(worktreesDir, resolve(worktree));
    if (!branch.startsWith(WORKFLOW_BRANCH_PREFIX) || inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
      plan.kept.push({ runId, why: `its progress names ${branch} and ${worktree}, which are not under ${WORKFLOW_BRANCH_PREFIX} and ${worktreesDir}: not touched` });
      continue;
    }

    const hasWorktree = existsSync(worktree) || registered.has(normal(worktree));
    const hasLocal = locals.has(branch);
    const remoteHead = remote?.get(branch);
    if (!hasWorktree && !hasLocal && !remoteHead) continue; // already clean

    if (isRunExecuting(cwd, runId)) {
      plan.kept.push({ runId, why: "a process is executing it" });
      continue;
    }

    let state: PrState | undefined;
    try {
      state = (progress.pushed?.length ?? 0) > 0 ? await commands.prState(cwd, branch) : undefined;
    } catch (err) {
      plan.errors.push(`run ${runId}: the state of its PR cannot be read, so it is kept: ${message(err)}`);
      continue;
    }
    const end = lastEnd(cwd, runId);
    const failedFor = end?.how === "failed" ? now - end.at : undefined;
    const failedLongAgo = failedFor !== undefined && failedFor > failedAfterDays * DAY_MS;
    const reason: GcReason | undefined = state === "MERGED" ? "pr-merged" : state === "CLOSED" ? "pr-closed" : failedLongAgo ? "failed" : undefined;
    if (!reason) {
      plan.kept.push({ runId, why: keptBecause(state, end, failedFor, failedAfterDays) });
      continue;
    }

    const actions: GcAction[] = [];
    const notes: string[] = [];
    if (hasWorktree) actions.push({ kind: "worktree", target: worktree });
    if (hasLocal) actions.push({ kind: "local-branch", target: branch });
    if (remoteHead) {
      // A merged or closed PR is done with its branch. Otherwise the branch goes only when deleting it closes no PR and loses no commit.
      if (reason !== "failed" || (state !== "OPEN" && progress.pushed?.includes(remoteHead))) actions.push({ kind: "remote-branch", target: branch, head: remoteHead });
      else notes.push(state === "OPEN" ? `origin branch ${branch} kept: its PR is open` : `origin branch ${branch} kept: it points at ${remoteHead.slice(0, 7)}, a commit this workflow did not push`);
    }
    plan.remove.push({ runId, reason, actions, notes });
  }
  return plan;
}

/**
 * Removes what the plan lists, and records on each action how it went. A run is worked on under its own lock, the one a
 * process executing it holds: if one started since the plan, the run is skipped. A failed action does not stop the others.
 */
export async function applyGc(plan: GcPlan, commands: Commands): Promise<void> {
  const cwd = plan.repo;
  for (const run of plan.remove) {
    const release = tryAcquireRunLock(cwd, run.runId);
    if (!release) {
      for (const action of run.actions) action.result = "skipped";
      run.notes.push("skipped: a process started executing the run after the plan was made");
      continue;
    }
    try {
      for (const action of run.actions) {
        try {
          if (action.kind === "worktree") await removeWorktree(commands, cwd, action.target);
          else if (action.kind === "local-branch") await commands.git(cwd, "branch", "-D", action.target);
          else await commands.deleteOwned(cwd, action.target, action.head!);
          action.result = "removed";
        } catch (err) {
          action.result = "failed";
          action.error = message(err);
          plan.errors.push(`run ${run.runId}: ${action.kind} ${action.target}: ${action.error}`);
        }
      }
    } finally {
      release();
    }
  }
}

async function removeWorktree(commands: Commands, cwd: string, worktree: string): Promise<void> {
  try {
    await commands.git(cwd, "worktree", "remove", "--force", worktree);
  } catch (err) {
    // A directory git does not know (an interrupted `git worktree add` left it) is the run's own all the same.
    if (!/is not a working tree/i.test(message(err))) throw err;
    rmSync(worktree, { recursive: true, force: true });
  }
  await commands.git(cwd, "worktree", "prune"); // a registration whose directory is gone would keep its branch from being deleted
}

const LABEL: Record<GcAction["kind"], string> = { worktree: "worktree      ", "local-branch": "local branch  ", "remote-branch": "origin branch " };
const REASON: Record<GcReason, string> = { "pr-merged": "PR merged", "pr-closed": "PR closed", failed: "failed long ago" };

/** The plan as a person reads it: what will go, and what stays and why. */
export function formatPlan(plan: GcPlan): string {
  const lines = [plan.remove.length ? `wf gc: ${plan.remove.length} run(s) to clean up in ${plan.repo}` : `wf gc: nothing to clean up in ${plan.repo}`];
  for (const run of plan.remove) {
    lines.push(`  run ${run.runId} (${REASON[run.reason]})`);
    for (const a of run.actions) lines.push(`    ${LABEL[a.kind]}${a.target}`);
    for (const note of run.notes) lines.push(`    ${note}`);
  }
  for (const k of plan.kept) lines.push(`  kept: run ${k.runId}: ${k.why}`);
  return lines.join("\n") + "\n";
}
