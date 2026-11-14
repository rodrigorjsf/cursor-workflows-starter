// `wf upgrade`: moves the installed kit (the clone at `~/.cursor-workflows/kit` that `scripts/install.sh --tag` made) to the
// newest release tag, then runs that tag's own `install.sh --refresh`, which reinstalls the dependencies and redoes the
// `wf` shim, the global skill links and the default config. A dev install (the kit location is a link to a working copy)
// and a `wf` that does not run from the installed kit are refused: both would move a checkout the user did not hand over.
// The tags are fetched without `--force`, so a tag that moved upstream fails the fetch instead of being overwritten, and the
// release of the new tag must be immutable (GitHub's `immutable` field) before it is checked out: a tag someone can move
// would make this command run their code. `--allow-mutable-tag` is the one explicit skip, for a kit installed from a fork.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { KIT_REPO, readKitPackage } from "./kit-version.js";
import { errorText } from "./runtime/error-text.js";
import { userDir } from "./runtime/state.js";

/** The kit this code runs from: two levels above the runtime package. */
const RUNNING_KIT = join(import.meta.dirname, "..", "..", "..");

export interface UpgradeResult {
  upgraded: boolean;
  /** The kit version before. */
  from: string;
  /** The kit version after; the same as `from` when already on the newest release. */
  to: string;
  /** The newest release tag. */
  tag: string;
}

/** The official repository, as the installer clones it. */
const OFFICIAL_ORIGIN = `https://github.com/${KIT_REPO}`;

/** Tests only: the base URL of the GitHub API, in place of `https://api.github.com`. When set, the kit's origin is taken to be the official repository. */
const API_URL_ENV = "WF_GITHUB_API_URL";

/** How long the release lookup may take before it is a failure. */
const RELEASE_LOOKUP_TIMEOUT_MS = 20_000;

const installerOf = (kit: string): string => join(kit, "scripts", "install.sh");

const git = (kit: string, ...args: string[]): string => {
  try {
    // LC_ALL=C: `newestReleaseTag` reads git's own words, which a translated git would not say the same way.
    return execFileSync("git", ["-C", kit, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } }).trim();
  } catch (err) {
    throw new Error((err as { stderr?: string }).stderr?.trim() || errorText(err));
  }
};

/** Throws unless the kit running this code is the clone the installer made. */
function installedKit(): string {
  const kit = join(userDir(), "kit");
  if (!existsSync(kit)) throw new Error(`no kit is installed at ${kit}. Install it with the INSTALL-AGENT.md guide.`);
  if (lstatSync(kit).isSymbolicLink()) {
    throw new Error(`the kit at ${kit} is a development install (it points to ${realpathSync(kit)}): wf upgrade does not touch a working copy. Update it with git (git pull or git checkout <tag>) and run \`scripts/install.sh --refresh\` in it.`);
  }
  if (realpathSync(RUNNING_KIT) !== realpathSync(kit)) {
    throw new Error(`wf upgrade only updates the kit installed at ${kit}, and this wf runs from ${realpathSync(RUNNING_KIT)}. Run the installed kit's \`wf\`.`);
  }
  return kit;
}

/** The newest release tag (`vX.Y.Z`; pre-releases are not releases) of the clone, after fetching the tags of its origin. */
function newestReleaseTag(kit: string): string {
  try {
    // Not --force, and not --quiet (which hides the line that names a rejected tag): the output is captured either way.
    git(kit, "fetch", "--tags");
  } catch (err) {
    const reason = errorText(err).replace(/\s*\n\s*/g, " "); // one line, as every error
    if (reason.includes("would clobber existing tag")) {
      throw new Error(`a release tag of the kit's origin repository moved upstream since this kit fetched it: git refuses to overwrite the local tag (${reason}), and the kit stays where it was. Do not upgrade until the repository owner explains the move.`);
    }
    throw new Error(`could not fetch the tags of the kit's origin repository: ${reason}`);
  }
  const releases = git(kit, "tag", "--list", "v*")
    .split("\n")
    .filter((tag) => semver.valid(tag) !== null && semver.prerelease(tag) === null)
    .sort(semver.rcompare);
  if (releases.length === 0) throw new Error("the kit's origin repository has no version tag (vX.Y.Z)");
  return releases[0]!;
}

/** Whether two clone URLs name the same repository, ignoring a trailing slash and `.git`. */
const sameRepository = (a: string, b: string): boolean => a.replace(/\/$/, "").replace(/\.git$/, "") === b.replace(/\/$/, "").replace(/\.git$/, "");

/**
 * Throws unless the GitHub release of `tag` says `immutable: true`: an immutable release locks its tag to its commit, so whoever
 * steals a token cannot move the tag to code that this upgrade then runs. The release API needs no token. Only the official
 * repository is covered, so a kit with another origin is refused too (the answer for a tag of the same name in the official
 * repository says nothing about the fork's). A missing release, one that is not immutable and a failed call are all errors,
 * never a skip.
 */
async function assertImmutableRelease(kit: string, tag: string): Promise<void> {
  const testApi = process.env[API_URL_ENV];
  if (!testApi) {
    const origin = git(kit, "remote", "get-url", "origin");
    if (!sameRepository(origin, OFFICIAL_ORIGIN)) {
      throw new Error(`the release check covers only ${OFFICIAL_ORIGIN}, and this kit's origin is ${origin}. Run \`wf upgrade --allow-mutable-tag\` to upgrade from it without the check.`);
    }
  }
  const url = `${testApi || "https://api.github.com"}/repos/${KIT_REPO}/releases/tags/${tag}`;
  const unreadable = (reason: string) => new Error(`could not read the release of ${tag} from ${url} (${reason}). Check the network and run again, or pass --allow-mutable-tag to skip the check.`);
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "cursor-workflows-upgrade" }, signal: AbortSignal.timeout(RELEASE_LOOKUP_TIMEOUT_MS) });
  } catch (err) {
    const cause = err instanceof Error && err.cause !== undefined ? errorText(err.cause) : "";
    throw unreadable(cause || errorText(err)); // `fetch failed` says nothing: the reason (`connect ECONNREFUSED ...`) is in the cause
  }
  if (response.status === 404) throw new Error(`${KIT_REPO} has no release for tag ${tag}, and only a published release installs. Install a released tag, or pass --allow-mutable-tag to upgrade to this one anyway.`);
  if (!response.ok) throw unreadable(`HTTP ${response.status}`);
  const release: unknown = await response.json().catch((err: unknown) => {
    throw unreadable(errorText(err));
  });
  if (typeof release !== "object" || release === null || !("immutable" in release) || release.immutable !== true) {
    throw new Error(`the release ${tag} of ${KIT_REPO} is not immutable, so its tag may have been moved to other code. Install an immutable release, or pass --allow-mutable-tag to upgrade to it anyway.`);
  }
}

/** Moves the installed kit to the newest release; does nothing when it is already there. Progress goes to stderr. */
export async function upgradeKit({ allowMutableTag = false }: { allowMutableTag?: boolean } = {}): Promise<UpgradeResult> {
  const kit = installedKit();
  const from = readKitPackage().version;
  const tag = newestReleaseTag(kit);
  const to = semver.parse(tag)!.version;
  if (semver.lte(to, from)) return { upgraded: false, from, to: from, tag };

  if (!allowMutableTag) await assertImmutableRelease(kit, tag);
  try {
    git(kit, "-c", "advice.detachedHead=false", "checkout", "--quiet", tag);
  } catch (err) {
    throw new Error(`could not move the kit to ${tag}; it stays at version ${from}: ${errorText(err)}`);
  }
  // The new tag's installer, not this one: it knows what the new tag ships. Its output must not mix into our stdout.
  const refresh = spawnSync("bash", [installerOf(kit), "--refresh"], { stdio: ["ignore", 2, 2] });
  if (refresh.status !== 0) {
    throw new Error(`the kit is at ${tag} now, but the installer failed to redo the dependencies, the command and the links. Run \`bash ${installerOf(kit)} --refresh\` after fixing the error above.`);
  }
  return { upgraded: true, from, to, tag };
}
