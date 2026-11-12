// Shared by the cloud tests: a git repository with a commit and a temporary bare remote, the way a user's checkout and its
// `origin` are, and readers of what a snapshot push left on the remote.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** A repository at `repo` with one commit (`a.txt`, `b.txt`) and a bare repository at `remote`, added as `remoteName`. */
export function repoWithRemote(repo: string, remote: string, remoteName = "origin"): void {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "core.autocrlf", "false"); // a machine's global line-ending setting must not decide what a checkout writes
  writeFileSync(join(repo, "a.txt"), "a\n");
  writeFileSync(join(repo, "b.txt"), "b\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  mkdirSync(remote, { recursive: true });
  git(remote, "init", "-q", "--bare");
  git(repo, "remote", "add", remoteName, remote);
}

/** The branches the bare repository has. */
export const remoteBranches = (remote: string): string[] =>
  git(remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
    .split("\n")
    .filter(Boolean);

/** The files of a branch of the bare repository, with their contents. */
export function remoteFiles(remote: string, branch: string): Record<string, string> {
  const paths = git(remote, "ls-tree", "-r", "--name-only", branch).split("\n").filter(Boolean);
  return Object.fromEntries(paths.map((path) => [path, git(remote, "show", `${branch}:${path}`)]));
}

/** What a snapshot must not disturb: HEAD, the index, the working files and the refs. */
export const worktreeState = (repo: string) => ({
  head: git(repo, "rev-parse", "HEAD").trim(),
  status: git(repo, "status", "--porcelain=v1", "-uall"),
  index: git(repo, "ls-files", "--stage"),
  refs: git(repo, "for-each-ref"),
  stashes: git(repo, "stash", "list"),
});

/** The agent's own clone of the remote, for as long as `work` runs: what a cloud agent has in its VM. */
function inAgentClone<T>(remote: string, branch: string, work: (clone: string) => T): T {
  const clone = mkdtempSync(join(tmpdir(), "wf-agent-clone-"));
  try {
    git(clone, "clone", "-q", "-c", "core.autocrlf=false", "--branch", branch, remote, "."); // the setting also decides what the clone checks out
    git(clone, "config", "user.email", "agent@example.com");
    git(clone, "config", "user.name", "Cloud agent");
    return work(clone);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

/** Writes `files` (a `null` deletes the file) into `clone`. */
function write(clone: string, files: Record<string, string | null>): void {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      unlinkSync(join(clone, path));
      continue;
    }
    mkdirSync(dirname(join(clone, path)), { recursive: true });
    writeFileSync(join(clone, path), content);
  }
}

/** What a cloud agent does on its branch: commits `files` on `branch` of the bare `remote` and pushes. Returns the commit. */
export function agentCommits(remote: string, branch: string, files: Record<string, string | null>, message = "agent: the work"): string {
  return inAgentClone(remote, branch, (clone) => {
    write(clone, files);
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", message);
    git(clone, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    return git(clone, "rev-parse", "HEAD").trim();
  });
}

/** What a cloud agent does that is not a fast-forward: replaces the history of `branch` with a commit that has no parent (a reset and a force push). */
export function agentRewritesHistory(remote: string, branch: string, files: Record<string, string>): string {
  return inAgentClone(remote, branch, (clone) => {
    git(clone, "checkout", "-q", "--orphan", "rewritten");
    git(clone, "rm", "-rfq", ".");
    write(clone, files);
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "agent: a history of its own");
    git(clone, "push", "-q", "--force", "origin", `HEAD:refs/heads/${branch}`);
    return git(clone, "rev-parse", "HEAD").trim();
  });
}
