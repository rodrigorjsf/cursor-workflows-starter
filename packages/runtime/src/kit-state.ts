// What state the installed kit (the clone at `~/.cursor-workflows/kit`) is in, as git sees it. The kit holds the engine that
// enforces the caps, the redaction and the tool allowlists, and any unsandboxed step can write to it. `git checkout` of a
// newer tag keeps a modified tracked file that the two tags share and every untracked file, and the installer's `npm ci`
// then reads an `.npmrc` planted in the clone, so `wf upgrade`, the installer (`scripts/install.sh` repeats `kitChanges`
// in bash) and `wf doctor` all ask for a clean tree first. It does not decide what to do about a dirty one: each caller
// refuses and says to reinstall. A development install (a link to a working copy) is the user's own and is never asked.

import { execFileSync } from "node:child_process";
import { errorText } from "./runtime/error-text.js";

/** What the kit's own install leaves that git ignores: its `node_modules/` (at any depth, for a workspace package). */
const INSTALLED_DEPENDENCIES = /^!! (.*\/)?node_modules\/$/;

/** Runs `git` in the kit's clone and returns its trimmed stdout; throws with what git printed on stderr when it fails. */
export function kitGit(kit: string, ...args: string[]): string {
  try {
    return execFileSync("git", ["-C", kit, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    throw new Error((err as { stderr?: string }).stderr?.trim() || errorText(err));
  }
}

/**
 * The changes in the kit's clone, one entry per path, as `git status --porcelain` prints them (`M path`, `?? path`): an edited
 * tracked file, an untracked file, and a file the ignore rules hide. The ignored files count because the tree must be clean
 * for real: a step that plants an `.npmrc` can also list it in `.git/info/exclude`, which `--untracked-files=all` alone obeys.
 * The kit's own `node_modules/` is the one ignored thing an install leaves, so it is the one left out. Empty for a clean kit.
 */
export function kitChanges(kit: string): string[] {
  return kitGit(kit, "status", "--porcelain", "--untracked-files=all", "--ignored=matching")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !INSTALLED_DEPENDENCIES.test(line));
}

/** Throws unless the kit's tree is clean, listing what is not. */
export function assertKitClean(kit: string): void {
  const changes = kitChanges(kit);
  if (changes.length > 0) throw new Error(`the kit at ${kit} has local changes: ${changes.join(", ")}; reinstall it`);
}

/** The tags that name the commit the kit is on (none when it sits on a commit no tag names, or on a branch). */
export function kitTagsAtHead(kit: string): string[] {
  return kitGit(kit, "tag", "--points-at", "HEAD").split("\n").filter((tag) => tag !== "");
}
