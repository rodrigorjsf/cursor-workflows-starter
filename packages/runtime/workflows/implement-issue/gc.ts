// `wf gc`: removes what finished `implement-issue` runs leave behind. Every run owns a worktree, a local branch and (once
// it pushed) a branch on the origin, all named in its `tdd-progress.json`; none of them is ever removed by the run itself.
// gc plans first (`planGc` reads and asks, changes nothing) and then applies the plan (`applyGc`), so `--dry-run` is the
// plan alone.
//
// It cleans a run up when its PR was merged or closed, or when the run failed longer ago than `gcFailedAfterDays`. It
// never touches a run a process is executing, a branch outside `wf/`, or a worktree outside `.workflows/worktrees/`. The
// origin's branch of a merged or closed PR goes with the run; the one of a run that merely failed goes only if no PR is
// open on it (deleting the branch would close the PR) and it points at a commit the run pushed. A `wf/` branch on the
// origin that no run of this repo owns (the run was made in another clone) goes when its PR was merged or closed, and
// stays otherwise. The branch `wf/issue-<n>` that every run of an issue shared before runs owned theirs goes, with its
// worktree, when its PR was merged or closed and no process executes one of those runs. The run's own state
// (`.workflows/runs/<runId>/`, its event log and journal) stays: it is the history, and the metrics read it.
//
// It also sweeps the cloud snapshot branches (`wf/cloud-snapshot/<run>/<id>`) that cloud steps push to the remote `cloud.remote`
// names and delete when the step ends: the ones a crash, a `kill -9` or a remote that refused the deletion left behind. A snapshot
// has no PR, so it is judged by its run (`planSnapshots`): it goes when the run is one of this repo's, no process executes it,
// and its last event is older than the grace period (`gcSnapshotGraceHours`: a cloud agent may still be starting from the ref
// shortly after the process died). A run cut off in the middle of the cloud step that owns the branch keeps it longer, for as long
// as gc keeps a failed run (`gcFailedAfterDays`), and for ever when the run was cancelled, which gc keeps too: a resume may reattach
// to that agent, and a write step's work is on that branch. gc does not ask the cloud whether it will: when the agent is gone, or
// its newest run was cancelled (any cancel of the run does that, whatever state its job was in), the resume starts a new agent instead. Either
// way the resume deletes the branch.
import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { SNAPSHOT_BRANCH_PREFIX, snapshotBranchSegment, snapshotRunSegment } from "../../src/runtime/cloud-snapshot.js";
import { errorText } from "../../src/runtime/error-text.js";
import { runCommand, toExecResult } from "../../src/runtime/command-runner.js";
import type { WorkflowEvent } from "../../src/runtime/events.js";
import { outcomeClass } from "../../src/runtime/outcome.js";
import { interruptedCloudSteps } from "../../src/runtime/projection.js";
import { EVENTS_FILE, isRunExecuting, readEventLog, runDirIn, runsDirIn, tryAcquireRunLock } from "../../src/runtime/run-store.js";
import { type Exec, type PrState, Commands, LOCAL_GIT_TIMEOUT_MS, NETWORK_TIMEOUT_SEC, ORIGIN, WORKFLOW_BRANCH_PREFIX, worktreeOf, worktreesDirIn } from "./commands.js";
import { type Progress, ProgressStore } from "./tdd.js";

/** Why something is cleaned up: its PR was merged or closed, its run failed longer ago than the limit, or it is a cloud snapshot branch its step never deleted. */
export type GcReason = "pr-merged" | "pr-closed" | "failed" | "snapshot";

/** The reason a PR in this state gives to clean its branch up: only a PR that is done (merged or closed) gives one. */
const DONE_PR: Partial<Record<PrState, GcReason>> = { MERGED: "pr-merged", CLOSED: "pr-closed" };

/** One thing to remove. `head` is the commit an origin branch points at (the lease its deletion carries). */
export interface GcAction {
  kind: "worktree" | "local-branch" | "remote-branch";
  /** The worktree's path, or the branch's name. */
  target: string;
  head?: string;
  /** The remote a `remote-branch` is on. Absent: the origin. */
  remote?: string;
  /** Set by `applyGc`. `skipped`: a process started executing the run after the plan was made, so nothing of it was touched. */
  result?: "removed" | "failed" | "skipped";
  error?: string;
}

/**
 * What is cleaned up for one run, or (no `runId`) for one origin branch that no run of this repo owns, or for the branch and
 * worktree every run of an issue shared before runs owned theirs (`sharedBy`: those runs, locked while it is removed). A cloud
 * snapshot branch (`reason: "snapshot"`) is cleaned up for the run that made it: `runId`, locked while the branch is deleted.
 */
export interface GcCleanup {
  runId?: string;
  sharedBy?: string[];
  reason: GcReason;
  actions: GcAction[];
  /** What stays although the rest is cleaned up, and what is lost with it. */
  notes: string[];
}

export interface GcPlan {
  repo: string;
  /** A run that failed more days ago than this is cleaned up. */
  failedAfterDays: number;
  remove: GcCleanup[];
  /** What still exists and is not cleaned up: a run, or a remote branch that no run owns (`remote`: not the origin), with why. */
  kept: Array<{ runId?: string; branch?: string; remote?: string; why: string }>;
  /** What could not be read or asked, or (after `applyGc`) removed. */
  errors: string[];
}

/** `ctx.exec` without a run: the same asynchronous, time-limited command, with nobody to log it to. */
const directExec: Exec = async (command, args = [], opts = {}) =>
  toExecResult(await runCommand({ command, args, cwd: opts.cwd ?? process.cwd(), env: opts.env, timeoutMs: opts.timeoutMs ?? LOCAL_GIT_TIMEOUT_MS }, () => {}));

/** The commands of implement-issue, run outside a workflow run. `networkTimeoutSec`: the workflow's setting of that name. */
export const directCommands = (networkTimeoutSec = NETWORK_TIMEOUT_SEC) => new Commands(directExec, { localMs: LOCAL_GIT_TIMEOUT_MS, networkMs: networkTimeoutSec * 1000 });

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


/** The ids of the repo's runs: the directories of `.workflows/runs/`. */
function runIdsOf(cwd: string): string[] {
  const runsDir = runsDirIn(cwd);
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** The events of a run's log, in order, without the `content` ones (the bulk of a log, which gc never reads). */
const runEvents = (cwd: string, runId: string): WorkflowEvent[] => readEventLog(join(runDirIn(cwd, runId), EVENTS_FILE), { content: false }).events;

/** The runs of the repo that have a progress file. A run with no (or an unreadable) progress file is not an implement-issue run. */
function implementIssueRuns(cwd: string, errors: string[]): Array<{ runId: string; progress: Progress }> {
  const runs: Array<{ runId: string; progress: Progress }> = [];
  for (const runId of runIdsOf(cwd)) {
    try {
      const store = new ProgressStore(cwd, runId);
      if (existsSync(store.file)) runs.push({ runId, progress: store.data });
    } catch (err) {
      errors.push(`run ${runId}: its progress file cannot be read: ${errorText(err)}`);
    }
  }
  return runs;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const ago = (ms: number) => (ms < DAY_MS ? "less than a day ago" : `${plural(Math.floor(ms / DAY_MS), "day")} ago`);
const hoursAgo = (ms: number) => (ms < HOUR_MS ? "less than an hour ago" : ms < DAY_MS ? `${plural(Math.floor(ms / HOUR_MS), "hour")} ago` : ago(ms));

/**
 * How the latest execution of the run ended, and when. An execution that never wrote its end (the process died, the machine
 * went down) counts as failed, at its last event: that is what `wf status` calls it. Undefined when the log has no execution.
 */
function lastEnd(events: WorkflowEvent[]): { how: "failed" | "cancelled" | "other"; at: number } | undefined {
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

/** What deleting the run's worktree and branch would lose: files nobody committed, and commits that are on no remote. */
async function unsavedWork(commands: Commands, cwd: string, run: { worktree?: string; branch?: string; baseCommit?: string }): Promise<string[]> {
  const notes: string[] = [];
  try {
    if (run.worktree && existsSync(run.worktree) && (await commands.gitRead(run.worktree, "status", "--porcelain")).trim()) {
      notes.push("the worktree has uncommitted changes, which go with it");
    }
    if (run.branch && run.baseCommit) {
      const unpushed = Number((await commands.gitRead(cwd, "rev-list", "--count", run.branch, "--not", run.baseCommit, "--remotes")).trim());
      if (unpushed > 0) notes.push(`${plural(unpushed, "commit")} on ${run.branch} ${unpushed === 1 ? "is" : "are"} on no remote, and go with the branch`);
    }
  } catch (err) {
    notes.push(`could not tell whether anything unsaved goes with it: ${errorText(err)}`);
  }
  return notes;
}

/** The name every run's branch had before runs owned theirs (`wf/issue-<n>`): `planShared` decides on it, not the per-run rules. */
const SHARED_BRANCH = new RegExp(`^${WORKFLOW_BRANCH_PREFIX}issue-\\d+$`);

/**
 * Looks at every run of the repo and decides what to remove; changes nothing. The runs are the repo's own (`.workflows/runs/`):
 * the global runs index is for tools that are not inside a repo.
 */
export async function planGc(options: { cwd: string; commands: Commands; failedAfterDays: number; snapshots: SnapshotSweep }): Promise<GcPlan> {
  const { cwd, commands, failedAfterDays, snapshots } = options;
  const now = Date.now();
  const plan: GcPlan = { repo: cwd, failedAfterDays, remove: [], kept: [], errors: [] };
  const worktreesDir = worktreesDirIn(cwd);

  const runs = implementIssueRuns(cwd, plan.errors);
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
    plan.errors.push(`the origin's branches cannot be listed, so no origin branch is removed: ${errorText(err)}`);
  }

  for (const { runId, progress } of runs) {
    const { branch, worktree } = progress;
    if (!branch || !worktree) continue; // a run that stopped before it made its worktree has nothing to clean, and an older run's are the shared ones below
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
      state = (progress.pushed?.length ?? 0) > 0 ? await commands.prState(cwd, branch, progress.repo) : undefined;
    } catch (err) {
      plan.errors.push(`run ${runId}: the state of its PR cannot be read, so it is kept: ${errorText(err)}`);
      continue;
    }
    const end = lastEnd(runEvents(cwd, runId));
    const failedFor = end?.how === "failed" ? now - end.at : undefined;
    const failedLongAgo = failedFor !== undefined && failedFor > failedAfterDays * DAY_MS;
    const reason: GcReason | undefined = (state && DONE_PR[state]) ?? (failedLongAgo ? "failed" : undefined);
    if (!reason) {
      plan.kept.push({ runId, why: keptBecause(state, end, failedFor, failedAfterDays) });
      continue;
    }

    const actions: GcAction[] = [];
    const notes: string[] = reason === "failed" ? await unsavedWork(commands, cwd, { worktree: hasWorktree ? worktree : undefined, branch: hasLocal ? branch : undefined, baseCommit: progress.baseCommit }) : [];
    if (hasWorktree) actions.push({ kind: "worktree", target: worktree });
    if (hasLocal) actions.push({ kind: "local-branch", target: branch });
    if (remoteHead) {
      // A merged or closed PR is done with its branch. Otherwise the branch goes only when deleting it closes no PR and loses no commit.
      if (reason !== "failed" || (state !== "OPEN" && progress.pushed?.includes(remoteHead))) actions.push({ kind: "remote-branch", target: branch, head: remoteHead });
      else notes.push(state === "OPEN" ? `origin branch ${branch} kept: its PR is open` : `origin branch ${branch} kept: it points at ${remoteHead.slice(0, 7)}, a commit this workflow did not push`);
    }
    plan.remove.push({ runId, reason, actions, notes });
  }

  await planShared(plan, commands, runs, locals, registered, remote);
  await planSnapshots(plan, commands, snapshots, now);

  // The origin's `wf/` branches that none of these runs owns: made by a run in another clone, or by one whose state is gone.
  // Nothing says whether that run is still going, so only a PR that is done (merged or closed) says the branch is a leftover.
  const owned = new Set(runs.flatMap((r) => (r.progress.branch ? [r.progress.branch] : [])));
  for (const [branch, head] of remote ?? []) {
    if (branch.startsWith(SNAPSHOT_BRANCH_PREFIX)) {
      // A snapshot never has a PR: `planSnapshots` judges those on the remote cloud steps push to, and no other is asked about.
      if (snapshots.remote !== ORIGIN) plan.kept.push({ branch, why: `a cloud snapshot branch, but cloud steps push to ${snapshots.remote} (cloud.remote), and gc sweeps snapshots only there` });
      continue;
    }
    if (owned.has(branch) || SHARED_BRANCH.test(branch)) continue;
    try {
      const state = await commands.prState(cwd, branch);
      const done = state && DONE_PR[state];
      if (done) plan.remove.push({ reason: done, actions: [{ kind: "remote-branch", target: branch, head }], notes: [] });
      else plan.kept.push({ branch, why: state === "OPEN" ? "its PR is open, and no run of this repo owns it" : "no run of this repo owns it, and it has no PR" });
    } catch (err) {
      plan.errors.push(`origin branch ${branch}: the state of its PR cannot be read, so it is kept: ${errorText(err)}`);
    }
  }
  return plan;
}

/** Where cloud steps push their snapshot branches, and how long gc leaves one alone after its run was last active. */
export interface SnapshotSweep {
  /** The remote `cloud.remote` names. */
  remote: string;
  /** `gcSnapshotGraceHours`. */
  graceHours: number;
}

/** The runs of the repo by the run segment `snapshotBranch` puts in a branch name: the sanitized id says which run made the branch. */
function runsBySegment(cwd: string): Map<string, string[]> {
  const bySegment = new Map<string, string[]>();
  for (const runId of runIdsOf(cwd)) {
    const segment = snapshotRunSegment(runId);
    bySegment.set(segment, [...(bySegment.get(segment) ?? []), runId]);
  }
  return bySegment;
}

/**
 * The cloud snapshot branches of `snapshots.remote`: each is removed when it is the branch of a run of this repo that no process
 * executes and whose last event is past the grace period, and is kept, with the reason, otherwise. Not one of them is asked
 * about as a PR: a snapshot has none.
 */
async function planSnapshots(plan: GcPlan, commands: Commands, snapshots: SnapshotSweep, now: number): Promise<void> {
  const { remote, graceHours } = snapshots;
  const cwd = plan.repo;
  let heads: Map<string, string>;
  try {
    heads = await commands.remoteOwnedHeads(cwd, remote, SNAPSHOT_BRANCH_PREFIX);
  } catch (err) {
    plan.errors.push(`the cloud snapshot branches of ${remote} cannot be listed, so none is removed: ${errorText(err)}`);
    return;
  }
  const runs = runsBySegment(cwd);
  for (const [branch, head] of heads) {
    const keep = (why: string) => void plan.kept.push({ branch, remote, why });
    const segment = snapshotBranchSegment(branch);
    if (segment === undefined) {
      keep(`not a name a cloud step gives its snapshot branch (${SNAPSHOT_BRANCH_PREFIX}<run>/<8 hex digits>): not touched`);
      continue;
    }
    const owners = runs.get(segment) ?? [];
    if (owners.length === 0) {
      keep(`no run of this repo made it (there is no run ${segment} here): another clone may own it`);
      continue;
    }
    if (owners.length > 1) {
      keep(`the runs ${owners.join(" and ")} all appear as ${segment} in a branch name, so gc cannot tell which one made it`);
      continue;
    }
    const runId = owners[0]!;
    if (isRunExecuting(cwd, runId)) {
      keep(`a process is executing run ${runId}`);
      continue;
    }
    // The log is the one source of when a run last did anything (ADR-0008): a run with no event gives gc nothing to wait on, so it stays.
    const events = runEvents(cwd, runId);
    const lastEvent = Date.parse(events.at(-1)?.ts ?? "");
    if (!Number.isFinite(lastEvent)) {
      keep(`run ${runId} has no event log, so gc cannot tell when it was last active`);
      continue;
    }
    const idle = now - lastEvent;
    if (idle <= graceHours * HOUR_MS) {
      keep(`run ${runId} was last active ${hoursAgo(idle)}, and gc waits for more than ${plural(graceHours, "hour")}: a cloud agent may still be starting from it`);
      continue;
    }
    // A step cut off with its agent running is resumed by reattaching to the agent, and a step that writes has its work on this branch.
    // (Not when the agent's newest run was cancelled: the resume then starts a new agent. The log does not say so, and gc asks no cloud.)
    // The run is given up on like gc gives up on a failed one; a cancelled run is never given up on: gc keeps it because it can be resumed.
    const cutOff = [...interruptedCloudSteps(events).values()].find((step) => step.snapshot?.branch === branch);
    const cancelled = lastEnd(events)?.how === "cancelled";
    if (cutOff && (cancelled || idle <= plan.failedAfterDays * DAY_MS)) {
      const wait = cancelled ? "it was cancelled, and a cancelled run can be resumed" : `gc waits for more than ${plural(plan.failedAfterDays, "day")} (gcFailedAfterDays) before it gives up on the run`;
      keep(`run ${runId} was ${cancelled ? "cancelled" : "cut off"} in the middle of the cloud step this branch belongs to (agent ${cutOff.agentId}): a resume reattaches to the agent if it is still running and takes its work from the branch, and ${wait}`);
      continue;
    }
    plan.remove.push({ runId, reason: "snapshot", actions: [{ kind: "remote-branch", target: branch, head, remote }], notes: [] });
  }
}

/**
 * The branches `wf/issue-<n>` (here, on the origin, or both) and their worktrees `.workflows/worktrees/wf-issue-<n>`, which every
 * run of an issue shared before runs owned theirs. Their progress names neither, so nothing says which of those runs used which;
 * they go together, once the PR on the branch is merged or closed and no process executes any of those runs.
 */
async function planShared(
  plan: GcPlan,
  commands: Commands,
  runs: Array<{ runId: string; progress: Progress }>,
  locals: Set<string>,
  registered: Set<string>,
  remote: Map<string, string> | undefined,
): Promise<void> {
  const cwd = plan.repo;
  const older = runs.filter((r) => !r.progress.branch && r.progress.baseCommit !== undefined).map((r) => r.runId);
  const branches = [...new Set([...locals, ...(remote?.keys() ?? [])])].filter((b) => SHARED_BRANCH.test(b)).sort();
  for (const branch of branches) {
    const worktree = worktreeOf(cwd, branch);
    const hasWorktree = existsSync(worktree) || registered.has(normal(worktree));
    const remoteHead = remote?.get(branch);
    const executing = older.filter((runId) => isRunExecuting(cwd, runId));
    if (executing.length) {
      plan.kept.push({ branch, why: `the branch every run of its issue shared before runs owned theirs, and a process is executing one of those runs (${executing.join(", ")})` });
      continue;
    }
    let state: PrState | undefined;
    try {
      state = await commands.prState(cwd, branch);
    } catch (err) {
      plan.errors.push(`shared branch ${branch}: the state of its PR cannot be read, so it is kept: ${errorText(err)}`);
      continue;
    }
    const reason = state && DONE_PR[state];
    if (!reason) {
      plan.kept.push({ branch, why: `the branch every run of its issue shared before runs owned theirs: ${state === "OPEN" ? "its PR is open" : "it has no merged or closed PR"}` });
      continue;
    }
    const actions: GcAction[] = [];
    if (hasWorktree) actions.push({ kind: "worktree", target: worktree });
    if (locals.has(branch)) actions.push({ kind: "local-branch", target: branch });
    if (remoteHead) actions.push({ kind: "remote-branch", target: branch, head: remoteHead });
    plan.remove.push({ sharedBy: older, reason, actions, notes: [] });
  }
}

/**
 * Removes what the plan lists, and records on each action how it went. A run is worked on under its own lock, the one a
 * process executing it holds: if one started since the plan, the run is skipped. A failed action does not stop the others.
 */
export async function applyGc(plan: GcPlan, commands: Commands): Promise<void> {
  const cwd = plan.repo;
  for (const cleanup of plan.remove) {
    const release = lockAll(cwd, cleanup.runId === undefined ? (cleanup.sharedBy ?? []) : [cleanup.runId]);
    if (!release) {
      for (const action of cleanup.actions) action.result = "skipped";
      cleanup.notes.push("skipped: a process started executing the run after the plan was made");
      continue;
    }
    try {
      for (const action of cleanup.actions) {
        try {
          if (action.kind === "worktree") await removeWorktree(commands, cwd, action.target);
          else if (action.kind === "local-branch") await commands.git(cwd, "branch", "-D", action.target);
          else await commands.deleteOwned(cwd, action.target, action.head!, action.remote);
          action.result = "removed";
        } catch (err) {
          action.result = "failed";
          action.error = errorText(err);
          const what = cleanup.runId !== undefined ? `run ${cleanup.runId}` : cleanup.sharedBy ? "shared branch" : "origin branch";
          plan.errors.push(`${what}: ${action.kind} ${action.target}: ${action.error}`);
        }
      }
    } finally {
      release();
    }
  }
}

/** Takes the lock of every run, or none: undefined when a process is executing one of them. */
function lockAll(cwd: string, runIds: string[]): (() => void) | undefined {
  const held: Array<() => void> = [];
  const releaseAll = () => held.splice(0).forEach((release) => release());
  for (const runId of runIds) {
    const release = tryAcquireRunLock(cwd, runId);
    if (!release) {
      releaseAll();
      return undefined;
    }
    held.push(release);
  }
  return releaseAll;
}

async function removeWorktree(commands: Commands, cwd: string, worktree: string): Promise<void> {
  try {
    await commands.git(cwd, "worktree", "remove", "--force", worktree);
  } catch (err) {
    // A directory git does not know (an interrupted `git worktree add` left it) is the run's own all the same.
    if (!/is not a working tree/i.test(errorText(err))) throw err;
    rmSync(worktree, { recursive: true, force: true });
  }
  await commands.git(cwd, "worktree", "prune"); // a registration whose directory is gone would keep its branch from being deleted
}

const LABEL: Record<GcAction["kind"], string> = { worktree: "worktree", "local-branch": "local branch", "remote-branch": "origin branch" };
const labelOf = (a: GcAction) => (a.kind === "remote-branch" && a.remote ? `${a.remote} branch` : LABEL[a.kind]).padEnd(14);
const REASON: Record<GcReason, string> = { "pr-merged": "PR merged", "pr-closed": "PR closed", failed: "failed long ago", snapshot: "left behind by its step" };

/** The plan as a person reads it: what will go, and what stays and why. */
export function formatPlan(plan: GcPlan): string {
  const lines = [plan.remove.length ? `wf gc: ${plural(plan.remove.length, "thing")} to clean up in ${plan.repo}` : `wf gc: nothing to clean up in ${plan.repo}`];
  for (const c of plan.remove) {
    const what = c.reason === "snapshot" ? `cloud snapshot of run ${c.runId}` : c.runId !== undefined ? `run ${c.runId}` : c.sharedBy ? "branch the older runs of an issue shared" : "origin branch of no run here";
    lines.push(`  ${what} (${REASON[c.reason]})`);
    for (const a of c.actions) lines.push(`    ${labelOf(a)}${a.target}`);
    for (const note of c.notes) lines.push(`    ${note}`);
  }
  for (const k of plan.kept) lines.push(`  kept: ${k.runId === undefined ? `branch ${k.branch}${k.remote ? ` on ${k.remote}` : ""}` : `run ${k.runId}`}: ${k.why}`);
  return lines.join("\n") + "\n";
}
