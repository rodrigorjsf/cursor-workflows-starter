// Shared by the cloud tests: a git repository with a commit and a temporary bare remote, the way a user's checkout and its
// `origin` are, and readers of what a snapshot push left on the remote.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** A repository at `repo` with one commit (`a.txt`, `b.txt`) and a bare repository at `remote`, added as `remoteName`. */
export function repoWithRemote(repo: string, remote: string, remoteName = "origin"): void {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
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
