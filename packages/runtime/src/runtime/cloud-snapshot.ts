// The snapshot a cloud step runs against. A cloud agent sees only what was pushed to a remote, never the local worktree, so
// before a cloud step the worktree's state, uncommitted changes included, is committed to a throwaway branch and pushed
// (ADR-0005); when the step ends the branch is deleted again.
//
// The user's checkout is not disturbed to take it: the commit is built from a temporary copy of the index, so nothing is
// staged, no branch moves, HEAD stays and the working files are only read. The snapshot holds what `git add -A` would
// stage (tracked files as they are on disk, and untracked files git does not ignore); the run's own state (`.workflows/`)
// never goes. The commit's parent is HEAD, so the remote only needs to send the difference.
//
// Limit: a branch left behind (the process died between the push and the deletion, or the remote refused the deletion) is not
// swept by `wf gc` yet: see #44. One a crash left behind is deleted when the resumed run reattaches to the step's agent: the
// event log keeps its name with the agent's id.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
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
  /** The snapshot's commit. */
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
 * `signal` aborts; a failure leaves nothing on the remote.
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

  const scratch = await mkdtemp(join(tmpdir(), "wf-snapshot-"));
  try {
    const index = join(scratch, "index");
    const live = resolve(top, await git(top, ["rev-parse", "--git-path", "index"], { signal }));
    await copyFile(live, index).catch(() => {}); // no index yet: the empty one gets every file
    const env = { GIT_INDEX_FILE: index };
    await git(top, ["add", "-A", "--", ":(top)", ":(top,exclude,glob)**/.workflows/**"], { env, signal });
    const tree = await git(top, ["write-tree"], { env, signal });
    const commit = await git(top, ["commit-tree", tree, "-p", head, "-m", `wf: snapshot of the worktree for ${branch}`], { env: IDENTITY, signal });
    await git(top, ["push", "--quiet", "--no-verify", remote, `${commit}:refs/heads/${branch}`], { signal, timeoutMs: NETWORK_TIMEOUT_MS });
    return { top, remote, remoteUrl, branch, commit };
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
