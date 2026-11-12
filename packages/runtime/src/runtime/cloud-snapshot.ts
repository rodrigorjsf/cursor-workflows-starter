// The snapshot a cloud step runs against, and the way back from it. A cloud agent sees only what was pushed to a remote, never
// the local worktree, so before a cloud step the worktree's state, uncommitted changes included, is committed to a throwaway
// branch and pushed (ADR-0005); when the step ends the branch is deleted again.
//
// The user's checkout is not disturbed to take it: the commit is built from a temporary copy of the index, so nothing is
// staged, no branch moves, HEAD stays and the working files are only read. The snapshot holds what `git add -A` would
// stage (tracked files as they are on disk, and untracked files git does not ignore); the run's own state (`.workflows/`)
// never goes. The commit's parent is HEAD, so the remote only needs to send the difference. A worktree that has no change
// needs no commit of its own: the snapshot is HEAD itself, so the history a step leaves behind holds the agent's commits only.
//
// A step that writes gets its work back (`bringBack`): the agent commits on the snapshot branch, the engine fetches the branch
// and fast-forwards the local worktree to it. The snapshot commit of a worktree that had changes becomes part of the local
// history that way (it is what the agent built on), and the worktree ends clean at the agent's tree.
//
// Limit: a branch left behind (the process died between the push and the deletion, or the remote refused the deletion) is not
// swept by `wf gc` yet: see #44. One a crash left behind is deleted when the resumed run reattaches to the step's agent: the
// event log keeps its name with the agent's id.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The prefix of every snapshot branch: under `wf/`, the workflow's own, so a CI that skips `wf/**` skips the snapshots too. */
export const SNAPSHOT_BRANCH_PREFIX = "wf/cloud-snapshot/";
/** How long the push (or the deletion) of a snapshot may take: it goes over the network. */
const NETWORK_TIMEOUT_MS = 5 * 60_000;
/** How long each `git` that only works on the local repository may take. */
const LOCAL_TIMEOUT_MS = 60_000;

/** A snapshot that is on the remote. */
export interface PushedSnapshot {
  /** The checkout's top directory: the deletion runs from there. */
  top: string;
  remote: string;
  /** What the remote calls its repository (`git remote get-url`). */
  remoteUrl: string;
  branch: string;
  /** The snapshot's commit: what the agent starts from, and what `bringBack` checks the worktree against. */
  commit: string;
}

/**
 * The name of a new snapshot branch for a run: unique, so two steps (or two executions of a run) never meet on a branch. The
 * run id is made a valid ref component (a run id can be anything its caller passes): letters, digits, dots and dashes; it
 * starts with a letter or digit, has no `..`, and neither ends with a dot nor with `.lock`.
 */
export function snapshotBranch(runId: string): string {
  const safe =
    runId
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/^[^A-Za-z0-9]+/, "")
      .replace(/\.+$/, "")
      .replace(/\.lock$/, "-lock") || "run";
  return `${SNAPSHOT_BRANCH_PREFIX}${safe}/${randomUUID().slice(0, 8)}`;
}

/** The first line git said on stderr, or the error's own message. */
function gitErrorLine(err: unknown): string {
  const stderr = (err as { stderr?: unknown } | undefined)?.stderr;
  const text = typeof stderr === "string" && stderr.trim() ? stderr.trim() : err instanceof Error ? err.message : String(err);
  return text.split("\n")[0]!;
}

async function git(cwd: string, args: string[], options: { env?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs ?? LOCAL_TIMEOUT_MS,
      signal: options.signal,
      // A push that asks for a password would wait for ever: it fails instead.
      env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim();
  } catch (err) {
    if (options.signal?.aborted) throw options.signal.reason; // the abort, not git's complaint about being killed
    throw new Error(`git ${args[0]}: ${gitErrorLine(err)}`);
  }
}

const IDENTITY = { GIT_AUTHOR_NAME: "cursor-workflows", GIT_AUTHOR_EMAIL: "cursor-workflows@localhost", GIT_COMMITTER_NAME: "cursor-workflows", GIT_COMMITTER_EMAIL: "cursor-workflows@localhost" };

/**
 * Commits the state of the worktree `cwd` to the branch `branch` of `remote` and pushes it. Rejects with the reason when it
 * cannot (not a git repository, no such remote, no commit yet, the push is refused) and with the signal's reason when
 * `signal` aborts before the push starts; a failure leaves nothing on the remote. An abort that comes during the push does not
 * stop it: the snapshot that results is returned, and the caller (which sees the abort at once) deletes it.
 */
export async function pushSnapshot({ cwd, remote, branch, signal }: { cwd: string; remote: string; branch: string; signal?: AbortSignal }): Promise<PushedSnapshot> {
  /** Runs a git command that tells the user something about their setup when it fails; an abort is never that. */
  const asked = (dir: string, args: string[], whenItFails: string): Promise<string> =>
    git(dir, args, { signal }).catch((err: unknown) => {
      throw signal?.aborted ? err : new Error(whenItFails);
    });
  const top = await asked(cwd, ["rev-parse", "--show-toplevel"], `${cwd} is not inside a git repository: a cloud step runs against a snapshot of the repository's worktree`);
  const remoteUrl = await asked(top, ["remote", "get-url", remote], `the remote "${remote}" does not exist in ${top}: add it, or point \`cloud.remote\` in the config at one that does`);
  const head = await asked(top, ["rev-parse", "--verify", "--quiet", "HEAD"], `${top} has no commit yet: a cloud step needs one to start the snapshot from`);

  const tree = await worktreeTree(top, signal);
  // Nothing changed since HEAD: HEAD is the snapshot. Otherwise a commit on top of it holds the changes.
  const commit = tree === (await git(top, ["rev-parse", `${head}^{tree}`], { signal }))
    ? head
    : await git(top, ["commit-tree", tree, "-p", head, "-m", `wf: snapshot of the worktree for ${branch}`], { env: IDENTITY, signal });
  // The push is not cut by an abort that comes while it runs. A remote that has the objects goes on to accept the branch after its
  // client is gone, so a killed push can leave a branch that no one knows about; run to its end (the network timeout bounds it),
  // the push hands the branch to the caller, whose cleanup deletes it. A cancel during a push therefore waits for the push.
  signal?.throwIfAborted();
  await git(top, ["push", "--quiet", "--no-verify", remote, `${commit}:refs/heads/${branch}`], { timeoutMs: NETWORK_TIMEOUT_MS });
  return { top, remote, remoteUrl, branch, commit };
}

/**
 * The tree of the worktree at `top` as the snapshot sees it: what `git add -A` would stage, minus the run's own state. Built in
 * a temporary copy of the index, so the checkout is only read.
 */
async function worktreeTree(top: string, signal?: AbortSignal): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "wf-snapshot-"));
  try {
    const index = join(scratch, "index");
    const live = resolve(top, await git(top, ["rev-parse", "--git-path", "index"], { signal }));
    await copyFile(live, index).catch(() => {}); // no index yet: the empty one gets every file
    const env = { GIT_INDEX_FILE: index };
    await git(top, ["add", "-A", "--", ":(top)", ":(top,exclude,glob)**/.workflows/**"], { env, signal });
    return await git(top, ["write-tree"], { env, signal });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Deletes a snapshot branch from the remote. Rejects with the reason when it cannot. `top` is any directory of the checkout the
 * remote belongs to: the branch of an attempt that was interrupted is known only by its remote and name.
 */
export async function deleteSnapshot(snapshot: Pick<PushedSnapshot, "top" | "remote" | "branch">): Promise<void> {
  await git(snapshot.top, ["push", "--quiet", "--no-verify", snapshot.remote, "--delete", `refs/heads/${snapshot.branch}`], { timeoutMs: NETWORK_TIMEOUT_MS });
}

/** Why a cloud agent's work could not be brought back into the worktree. */
export class BringBackError extends Error {
  /** The index or the working files may have been changed before it failed: whoever owns the step puts them back. */
  constructor(
    message: string,
    readonly touched = false,
  ) {
    super(message);
  }
}

/**
 * Brings the work of a cloud agent that committed on `branch` of `remote` into the worktree it was snapshotted from: fetches
 * the branch and fast-forwards the worktree's checked-out branch to it, working files and index included, so the worktree ends
 * clean at the agent's tree. `base` is the snapshot commit the agent started from. Resolves with how many commits the worktree
 * moved forward (0 when the agent made none).
 *
 * It is a fast-forward or it is nothing. It refuses, changing nothing, when
 *  - the agent's branch no longer contains the snapshot (the agent rewrote the history), or
 *  - the worktree's branch moved while the agent ran (a commit, a reset), or
 *  - the working files are no longer what was snapshotted: bringing the work back would overwrite the changes made meanwhile, or
 *  - the agent adds a file where the worktree has one that git ignores (the snapshot does not hold it, and the move would overwrite it).
 * Once it starts to change the worktree (`BringBackError.touched`) the index and the files are all it touches, and the branch
 * moves last: a failure leaves HEAD where it was.
 *
 * The signal ends the fetch. The part that changes the worktree is not interrupted by it: a half-applied checkout is worse than
 * a late one, and it takes a moment.
 */
export async function bringBack({ cwd, remote, branch, base, signal }: { cwd: string; remote: string; branch: string; base: string; signal?: AbortSignal }): Promise<number> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"], { signal }).catch((err: unknown) => {
    throw signal?.aborted ? err : new BringBackError(`${cwd} is not inside a git repository`);
  });
  // A private ref: two steps in one repository must not meet on FETCH_HEAD.
  const fetched = `refs/wf/cloud-result/${randomUUID().slice(0, 8)}`;
  try {
    await git(top, ["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:${fetched}`], { signal, timeoutMs: NETWORK_TIMEOUT_MS }).catch((err: unknown) => {
      throw signal?.aborted ? err : new BringBackError(`could not fetch the cloud agent's branch ${branch} from ${remote} (${gitErrorLine(err)}): its work is not in the worktree`);
    });
    const tip = await git(top, ["rev-parse", `${fetched}^{commit}`], { signal });
    const head = await git(top, ["rev-parse", "HEAD"], { signal });
    const isAncestor = (ancestor: string, of: string) => git(top, ["merge-base", "--is-ancestor", ancestor, of], { signal }).then(() => true, () => false);

    if (tip === base) return 0; // the agent made no commit: there is nothing to bring back
    if (!(await isAncestor(base, tip))) {
      throw new BringBackError(`not a fast-forward: the cloud agent's branch ${branch} (${tip.slice(0, 7)}) does not contain the snapshot it started from (${base.slice(0, 7)}), so the agent rewrote the history; its work was not brought back`);
    }
    if (!(await isAncestor(head, base))) {
      throw new BringBackError(`not a fast-forward: the local branch moved while the cloud agent ran (it is at ${head.slice(0, 7)}, the snapshot was taken from a commit it no longer has); the agent's work was not brought back`);
    }
    if ((await worktreeTree(top, signal)) !== (await git(top, ["rev-parse", `${base}^{tree}`], { signal }))) {
      throw new BringBackError("the working files changed while the cloud agent ran, and bringing its work back would overwrite those changes: the agent's work was not brought back");
    }

    // Files git ignores are not in the snapshot, so the check above did not see them: one the agent adds at a path where the worktree
    // has such a file would be overwritten by the move.
    const added = (await git(top, ["diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", base, tip], { signal })).split("\0").filter(Boolean);
    for (const path of added) {
      if (await lstat(join(top, path)).then(() => true, () => false)) {
        throw new BringBackError(`the cloud agent adds ${path}, which exists in the worktree and is not part of the snapshot (git ignores it), and bringing its work back would overwrite it: the agent's work was not brought back`);
      }
    }

    const commits = Number(await git(top, ["rev-list", "--count", `${head}..${tip}`], { signal }));
    signal?.throwIfAborted();
    let touched = false;
    try {
      // The working files are the snapshot (checked above), so nothing in them is lost: the index is made to hold the snapshot, so
      // that what the agent deleted is deleted, and then index and files go to the agent's tree, as `git reset --hard` does it.
      // The branch moves last, which is the one thing that can still fail.
      touched = true;
      await git(top, ["read-tree", base]);
      await git(top, ["read-tree", "--reset", "-u", tip]);
      await git(top, ["update-ref", "-m", `wf: fast-forward to the cloud agent's work on ${branch}`, "HEAD", tip, head]);
    } catch (err) {
      throw new BringBackError(`could not move the worktree to the cloud agent's work (${gitErrorLine(err)})`, touched);
    }
    return commits;
  } finally {
    await git(top, ["update-ref", "-d", fetched]).catch(() => {});
  }
}

/**
 * The repository URL a cloud agent is created with. The SDK wants the code host's web URL: an `ssh` remote (`git@host:org/repo.git`,
 * `ssh://git@host/org/repo.git`) and the `.git` of an `https` one are rewritten to `https://host/org/repo`. Anything else (a
 * path, a `file:` URL) is passed as it is.
 */
export function cloudRepoUrl(remoteUrl: string): string {
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(remoteUrl);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(remoteUrl);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return /^https?:\/\//.test(remoteUrl) ? remoteUrl.replace(/\.git\/?$/, "") : remoteUrl;
}
