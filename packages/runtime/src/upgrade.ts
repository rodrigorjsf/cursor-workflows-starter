// `wf upgrade`: moves the installed kit (the clone at `~/.cursor-workflows/kit` that `scripts/install.sh --tag` made) to the
// newest release tag, then runs that tag's own `install.sh --refresh`, which reinstalls the dependencies and redoes the
// `wf` shim, the global skill links and the default config. A dev install (the kit location is a link to a working copy)
// and a `wf` that does not run from the installed kit are refused: both would move a checkout the user did not hand over. So
// is a kit with local changes (`kit-state.ts`): a checkout keeps some of them, and the installer would run them.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { assertKitClean, kitGit } from "./kit-state.js";
import { readKitPackage } from "./kit-version.js";
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

const installerOf = (kit: string): string => join(kit, "scripts", "install.sh");

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
    kitGit(kit, "fetch", "--quiet", "--tags", "--force");
  } catch (err) {
    throw new Error(`could not fetch the tags of the kit's origin repository: ${errorText(err)}`);
  }
  const releases = kitGit(kit, "tag", "--list", "v*")
    .split("\n")
    .filter((tag) => semver.valid(tag) !== null && semver.prerelease(tag) === null)
    .sort(semver.rcompare);
  if (releases.length === 0) throw new Error("the kit's origin repository has no version tag (vX.Y.Z)");
  return releases[0]!;
}

/** Moves the installed kit to the newest release; does nothing when it is already there. Progress goes to stderr. */
export function upgradeKit(): UpgradeResult {
  const kit = installedKit();
  assertKitClean(kit); // before anything else: even at the newest tag, a kit that was edited is for the user to hear about
  const from = readKitPackage().version;
  const tag = newestReleaseTag(kit);
  const to = semver.parse(tag)!.version;
  if (semver.lte(to, from)) return { upgraded: false, from, to: from, tag };

  try {
    kitGit(kit, "-c", "advice.detachedHead=false", "checkout", "--quiet", tag);
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
