// The installed kit (the clone at `~/.cursor-workflows/kit`) as git sees it: `git` run in the clone, the changes in its tree
// and the tags on its HEAD, and the refusal (`assertKitClean`) that `wf upgrade` raises for a dirty tree. The kit holds the
// engine that enforces the caps, the redaction and the tool allowlists, and any unsandboxed step can write to it. `git checkout`
// of a newer tag keeps a modified tracked file that the two tags share and every untracked file, and the installer's `npm ci`
// then reads an `.npmrc` planted in the clone, so `wf upgrade`, the installer (`scripts/install.sh` repeats `kitChanges` in
// bash) and `wf doctor` all ask for a clean tree first. What to do about a dirty kit is the user's: the text says to reinstall
// it, and docs/usage/01-instalacao.md says how. A development install (a link to a working copy) is the user's own and is
// never asked: the callers check for the link first.

import { execFileSync } from "node:child_process";
import { errorText } from "./runtime/error-text.js";

/** What the kit's own install leaves that git ignores: its `node_modules/` (at any depth, for a workspace package). */
const INSTALLED_DEPENDENCIES = /^!! (.*\/)?node_modules\/$/;

/** Runs `git` in the kit's clone and returns its trimmed stdout; throws with what git printed on stderr when it fails. */
export function kitGit(kit: string, ...args: string[]): string {
  try {
    // LC_ALL=C: `wf upgrade` reads git's own words (a rejected tag), which a translated git would not say the same way.
    return execFileSync("git", ["-C", kit, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } }).trim();
  } catch (err) {
    throw new Error((err as { stderr?: string }).stderr?.trim() || errorText(err));
  }
}

/** `kitGit` for a read of the kit's state: a failure says which kit could not be read, as `install.sh` does. */
function readKitState(kit: string, ...args: string[]): string {
  try {
    return kitGit(kit, ...args);
  } catch (err) {
    throw new Error(`could not read the state of the kit at ${kit}: ${errorText(err)}`);
  }
}

/**
 * The changes in the kit's clone, one entry per path, as `git status --porcelain` prints them (`M path`, `?? path`): an edited
 * tracked file, an untracked file, and a file the ignore rules hide. The ignored files count because the tree must be clean
 * for real: a step that plants an `.npmrc` can also list it in `.git/info/exclude`, which `--untracked-files=all` alone obeys.
 * The kit's own `node_modules/` is the one ignored thing an install leaves, so it is the one left out. Empty for a clean kit.
 */
export function kitChanges(kit: string): string[] {
  return readKitState(kit, "status", "--porcelain", "--untracked-files=all", "--ignored=matching")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !INSTALLED_DEPENDENCIES.test(line));
}

/** What `wf upgrade` and `wf doctor` say about a kit whose tree is not clean (`scripts/install.sh` says the same in bash). */
export const kitChangesMessage = (kit: string, changes: string[]): string => `the kit at ${kit} has local changes: ${changes.join(", ")}`;

/** Throws, with the remedy, unless the kit's tree is clean (or cannot be read, which is no better). */
export function assertKitClean(kit: string): void {
  const reinstall = (problem: string): Error => new Error(`${problem}; reinstall it`);
  let changes: string[];
  try {
    changes = kitChanges(kit);
  } catch (err) {
    throw reinstall(errorText(err));
  }
  if (changes.length > 0) throw reinstall(kitChangesMessage(kit, changes));
}

/** The tags that name the commit the kit is on (none when it sits on a commit no tag names, or on a branch). */
export function kitTagsAtHead(kit: string): string[] {
  return readKitState(kit, "tag", "--points-at", "HEAD").split("\n").filter((tag) => tag !== "");
}
