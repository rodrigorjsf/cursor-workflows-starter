// The kit's own version, and whether it fits the repo it runs in. A repo declares the kit versions it accepts as a semver
// range in `.agents/workflows/config.json` (`kit`); a kit outside that range is refused, so an old kit never runs against
// a config written for a newer one. The manifest is read from the install location (the runtime package, one level above
// `src/`), never from the repo.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { REPO_CONFIG_FILE, repoConfigPath } from "./config/index.js";

const PACKAGE_JSON = join(import.meta.dirname, "..", "package.json");

export interface KitPackage {
  version: string;
  /** The Node versions the kit supports (`engines.node`), as a semver range. */
  nodeRange: string;
}

export function readKitPackage(): KitPackage {
  const { version, engines } = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version: string; engines: { node: string } };
  return { version, nodeRange: engines.node };
}

export interface KitCompatibility {
  /** The version that was tested. */
  version: string;
  /** The range the repo declares; undefined when it declares none. */
  range: string | undefined;
  /** Set when the kit does not fit: what is wrong, and how to fix it. */
  problem?: { message: string; hint: string };
}

/**
 * The `kit` range of the repo's config. Read leniently, as plain JSON and without the config schema: a config written for a
 * newer kit may carry keys this kit's schema rejects, and the version mismatch is the error worth reporting then.
 */
function declaredRange(cwd: string): unknown {
  const path = repoConfigPath(cwd);
  if (!existsSync(path)) return undefined;
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { kit?: unknown }).kit;
  } catch {
    return undefined; // not JSON: the config check reports that, with its path
  }
}

/** Whether `version` (default: the running kit's) fits the range the repo at `cwd` declares. */
export function kitCompatibility(cwd: string, version: string = readKitPackage().version): KitCompatibility {
  const declared = declaredRange(cwd);
  if (declared === undefined) return { version, range: undefined };
  const range = String(declared);
  if (typeof declared !== "string" || semver.validRange(declared) === null) {
    return {
      version,
      range,
      problem: {
        message: `a faixa "kit" de ${REPO_CONFIG_FILE} (${JSON.stringify(declared)}) não é uma faixa semver válida`,
        hint: `Escreva uma faixa semver em "kit", por exemplo ">=1.0.0 <2.0.0" (o \`wf init\` escreve a do kit que o rodou).`,
      },
    };
  }
  if (semver.satisfies(version, range)) return { version, range };
  const where = `o kit instalado é a versão ${version}, fora da faixa "${range}" que o repositório declara em ${REPO_CONFIG_FILE} ("kit")`;
  if (semver.ltr(version, range)) {
    return { version, range, problem: { message: `${where}: ele é mais antigo que a faixa`, hint: `Atualize o kit para uma versão dentro de "${range}".` } };
  }
  if (semver.gtr(version, range)) {
    return {
      version,
      range,
      problem: {
        message: `${where}: ele é mais novo que a faixa`,
        hint: `Instale um kit dentro de "${range}" ou, depois de conferir que o repositório funciona com o kit ${version}, atualize "kit" em ${REPO_CONFIG_FILE}.`,
      },
    };
  }
  return { version, range, problem: { message: where, hint: `Instale um kit dentro de "${range}" ou ajuste "kit" em ${REPO_CONFIG_FILE}.` } };
}

/** Throws when the running kit is outside the repo's declared range. Called before a run starts. */
export function assertKitCompatible(cwd: string): void {
  const { problem } = kitCompatibility(cwd);
  if (problem) throw new Error(`${problem.message}. ${problem.hint}`);
}
