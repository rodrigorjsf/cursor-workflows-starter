// `wf upgrade`: moves the installed kit (the clone at `~/.cursor-workflows/kit` that `scripts/install.sh --tag` made) to the
// newest release tag, then runs that tag's own `install.sh --refresh`, which reinstalls the dependencies and redoes the
// `wf` shim, the global skill links and the default config. A dev install (the kit location is a link to a working copy)
// and a `wf` that does not run from the installed kit are refused: both would move a checkout the user did not hand over.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { readKitPackage } from "./kit-version.js";
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

const git = (kit: string, ...args: string[]): string => {
  try {
    return execFileSync("git", ["-C", kit, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (err instanceof Error ? err.message : String(err)));
  }
};

/** Throws unless the kit running this code is the clone the installer made. */
function installedKit(): string {
  const kit = join(userDir(), "kit");
  if (!existsSync(kit)) throw new Error(`não há kit instalado em ${kit}. Instale com o guia INSTALL-AGENT.md.`);
  if (lstatSync(kit).isSymbolicLink()) {
    throw new Error(`o kit em ${kit} é uma instalação de desenvolvimento (aponta para ${realpathSync(kit)}): o wf upgrade não mexe numa cópia de trabalho. Atualize-a com git (git pull ou git checkout <tag>) e rode \`scripts/install.sh --refresh\` nela.`);
  }
  if (realpathSync(RUNNING_KIT) !== realpathSync(kit)) {
    throw new Error(`o wf upgrade só atualiza o kit instalado em ${kit}, e este wf roda de ${realpathSync(RUNNING_KIT)}. Rode o \`wf\` do kit instalado.`);
  }
  return kit;
}

/** The newest release tag (`vX.Y.Z`; pre-releases are not releases) of the clone, after fetching the tags of its origin. */
function newestReleaseTag(kit: string): string {
  try {
    git(kit, "fetch", "--quiet", "--tags", "--force");
  } catch (err) {
    throw new Error(`não consegui buscar as tags do repositório de origem do kit: ${err instanceof Error ? err.message : String(err)}`);
  }
  const releases = git(kit, "tag", "--list", "v*")
    .split("\n")
    .filter((tag) => semver.valid(tag) !== null && semver.prerelease(tag) === null)
    .sort(semver.rcompare);
  if (releases.length === 0) throw new Error("o repositório de origem do kit não tem nenhuma tag de versão (vX.Y.Z)");
  return releases[0]!;
}

/** Moves the installed kit to the newest release; does nothing when it is already there. Progress goes to stderr. */
export function upgradeKit(): UpgradeResult {
  const kit = installedKit();
  const from = readKitPackage().version;
  const tag = newestReleaseTag(kit);
  const to = semver.parse(tag)!.version;
  if (semver.lte(to, from)) return { upgraded: false, from, to: from, tag };

  git(kit, "-c", "advice.detachedHead=false", "checkout", "--quiet", tag);
  // The new tag's installer, not this one: it knows what the new tag ships. Its output must not mix into our stdout.
  const refresh = spawnSync("bash", [join(kit, "scripts", "install.sh"), "--refresh"], { stdio: ["ignore", 2, 2] });
  if (refresh.status !== 0) {
    throw new Error(`o kit já está em ${tag}, mas o instalador falhou ao refazer dependências, comando e links. Rode \`bash ${join(kit, "scripts", "install.sh")} --refresh\` depois de corrigir o erro acima.`);
  }
  return { upgraded: true, from, to, tag };
}
