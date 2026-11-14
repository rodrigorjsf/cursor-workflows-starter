// Shared by the install, upgrade and doctor process tests: a git repository laid out like the kit's own repo (the installer, the
// distributed skills, the templates, the runtime package) that stands in for GitHub. The installer clones it, `wf upgrade`
// fetches its tags. Every release is a commit that sets the version of both package manifests, and a tag `v<version>`.
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const KIT_ROOT = join(import.meta.dirname, "..", "..", "..");

/** What an installed kit needs, relative to the kit root. The docs, the tests and the handoffs stay out: they are not installed. */
const KIT_PATHS = [
  ".gitattributes", // eol=lf: a clone made with core.autocrlf=true (this user's) must not turn the installer into CRLF
  ".gitignore", // ignores node_modules/: an installed kit holds its dependencies and must still have a clean tree
  "package.json",
  "package-lock.json",
  "scripts/install.sh",
  "skills",
  "templates",
  "packages/runtime/package.json",
  "packages/runtime/src",
  "packages/runtime/workflows",
  "packages/runtime/schema",
  "packages/runtime/tsconfig.json",
  "packages/runtime/tsconfig.test.json",
  "packages/runtime/test/fake-sdk.ts",
];

/** Runs git in `cwd` with a fixed identity; returns trimmed stdout and throws with stderr on failure. */
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${r.stderr}`);
  return r.stdout.trim();
}

function setVersion(dir: string, version: string): void {
  for (const manifest of ["package.json", "packages/runtime/package.json"]) {
    const file = join(dir, manifest);
    writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), version }, null, 2)}\n`);
  }
}

/** Commits the working tree as release `version` and tags it `v<version>`. */
export function release(dir: string, version: string, edit?: (dir: string) => void): void {
  edit?.(dir);
  setVersion(dir, version);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", `release ${version}`);
  git(dir, "tag", `v${version}`);
}

/** A new kit repository at `dir` whose first release is `version`. Its files are this checkout's, tracked or not. */
export function makeOrigin(dir: string, version: string): string {
  for (const path of KIT_PATHS) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(join(KIT_ROOT, path), join(dir, path), { recursive: true });
  }
  git(dir, "init", "--quiet", "-b", "main");
  release(dir, version);
  return dir;
}

/** Something an unsandboxed step can leave in the installed kit, and the line `git status --porcelain` shows for it. */
export interface KitTampering {
  what: string;
  /** The planted file, relative to the kit. */
  file: string;
  /** The line `git status --porcelain` shows for it. */
  listed: string;
  plant: (kit: string) => void;
}

/**
 * None of the three is something `git checkout` of a newer tag removes or refuses: the research reproduced the first two
 * surviving it with exit code 0. The tracked file is one that no release of the test origin changes.
 */
export const EDITED_FILE: KitTampering = {
  what: "a modified tracked file",
  file: "packages/runtime/src/runtime/engine.ts",
  listed: "M packages/runtime/src/runtime/engine.ts",
  plant: (kit) => appendFileSync(join(kit, "packages", "runtime", "src", "runtime", "engine.ts"), "\n// planted by a step\n"),
};

export const PLANTED_NPMRC: KitTampering = {
  what: "an untracked .npmrc",
  file: ".npmrc",
  listed: "?? .npmrc",
  plant: (kit) => writeFileSync(join(kit, ".npmrc"), "ignore-scripts=false\n"),
};

/** The planted `.npmrc` made invisible to a `git status` that does not ask for ignored files: the step lists it in `.git/info/exclude`. */
export const HIDDEN_NPMRC: KitTampering = {
  what: "an .npmrc that a step hid in .git/info/exclude",
  file: "packages/runtime/.npmrc",
  listed: "!! packages/runtime/.npmrc",
  plant: (kit) => {
    appendFileSync(join(kit, ".git", "info", "exclude"), "/packages/runtime/.npmrc\n");
    writeFileSync(join(kit, "packages", "runtime", ".npmrc"), "ignore-scripts=false\n");
  },
};

export const KIT_TAMPERING: KitTampering[] = [EDITED_FILE, PLANTED_NPMRC, HIDDEN_NPMRC];
