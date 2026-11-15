// Seam 2, the process: the installer (`scripts/install.sh`) and `wf upgrade` run against a temporary home. A local git
// repository stands in for GitHub (see kit-origin.ts) and a fake `npm` on the PATH stands in for the registry: it logs
// how it was called and links `node_modules` to this checkout's. The tests read the files the installer leaves in the
// home (the kit, the `wf` shim, the skill links, the global config), what the shim runs, the exit codes and the messages.
// The GitHub releases API, which both ask whether a release is immutable, is a child process (release-api-job.ts) that
// the tests steer through files, because `spawnSync` blocks this process while the installer runs. The release check
// covers only the official repository, so the tests give the installer its URL and make git rewrite it to the local
// repository (`url.<path>.insteadOf`, in the environment): the kit's origin is then the official URL, as on a user's machine.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { EDITED_FILE, KIT_TAMPERING, type KitTampering, PLANTED_NPMRC, git, makeOrigin, release } from "./kit-origin.js";

const KIT_ROOT = join(import.meta.dirname, "..", "..", "..");
const NODE_DIR = dirname(process.execPath);

let sandbox: string;
/** The stand-in for GitHub: releases v0.3.0 and, for the upgrade tests, more. Tests that add releases clone their own. */
let origin: string;
let npmBin: string;
let npmLog: string;
let counter = 0;
/** The stand-in for the releases API: its directory (the tests' controls), its child process and its base URL. */
let releaseApiDir: string;
let releaseApi: ChildProcess;
let releaseApiUrl: string;

before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-install-"));
  origin = makeOrigin(join(sandbox, "origin"), "0.3.0");
  npmLog = join(sandbox, "npm.log");
  npmBin = join(sandbox, "npm-bin");
  mkdirSync(npmBin);
  // `npm ci` empties node_modules first; `npm install` keeps it. Both end with a real node_modules folder (the kit's .gitignore
  // ignores a folder, not a link) whose entries are links to this checkout's own packages.
  const packages = join(KIT_ROOT, "node_modules");
  writeFileSync(join(npmBin, "npm"), `#!/bin/sh\necho "$PWD $*" >> "$NPM_LOG"\nrm -rf node_modules\nmkdir node_modules\nln -s "${packages}"/* "${packages}/.bin" node_modules/\n`);
  chmodSync(join(npmBin, "npm"), 0o755);

  releaseApiDir = join(sandbox, "release-api");
  mkdirSync(releaseApiDir);
  releaseApi = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(import.meta.dirname, "release-api-job.ts"), releaseApiDir], {
    env: { ...process.env, TSX_TSCONFIG_PATH: join(import.meta.dirname, "..", "tsconfig.test.json") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  releaseApiUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the release API stand-in did not start within 30 s")), 30_000);
    releaseApi.once("exit", (code) => reject(new Error(`the release API stand-in exited early with code ${code}`)));
    releaseApi.stdout!.on("data", (chunk: Buffer) => {
      const port = /port (\d+)/.exec(chunk.toString())?.[1];
      if (port === undefined) return;
      clearTimeout(timer);
      resolve(`http://127.0.0.1:${port}`);
    });
  });
});
after(async () => {
  releaseApi.kill();
  await new Promise((resolve) => (releaseApi.exitCode === null && releaseApi.signalCode === null ? releaseApi.once("exit", resolve) : resolve(undefined)));
  rmSync(sandbox, { recursive: true, force: true });
});

/** An empty home directory for one test. */
function newHome(): string {
  const home = join(sandbox, `home-${++counter}`);
  mkdirSync(home);
  return home;
}

function env(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: [npmBin, NODE_DIR, "/usr/bin", "/bin"].join(":"),
    HOME: home,
    NPM_LOG: npmLog,
    TSX_TSCONFIG_PATH: join(home, ".cursor-workflows", "kit", "packages", "runtime", "tsconfig.test.json"),
    WF_METRICS: "off",
    // Tests only: ask the stand-in, not api.github.com, and take the test origins for the official repository.
    WF_GITHUB_API_URL: releaseApiUrl,
    ...extra,
  };
}

/** The official repository's clone URL, which the installer clones by default and the release check covers. */
const OFFICIAL_URL = "https://github.com/rodrigorjsf/cursor-workflows-starter.git";
/** For each home, the local repository that stands for the official one there. */
const officialAt = new Map<string, string>();

/** The environment that makes git read the official URL from the local repository `repo`, whatever the clone's own config says. */
const officialRedirect = (repo: string): Record<string, string> => ({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${repo}.insteadOf`, GIT_CONFIG_VALUE_0: OFFICIAL_URL });

/** Runs the installer of `from` (default: the origin's own copy, like a downloaded file), `--repo` as given. */
function installFrom(home: string, args: string[], { from = origin, ...extra }: { from?: string } & Record<string, string> = {}) {
  const r = spawnSync("bash", [join(from, "scripts", "install.sh"), ...args], { env: env(home, extra), encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Runs the installer as installFrom does, but with the local repository that `--repo` names standing for the official one:
 * the installer gets the official URL, and git reads that URL from the local repository. A later call for the same home
 * without `--repo` (or `wf upgrade`) keeps the stand-in.
 */
function install(home: string, args: string[], { from = origin, ...extra }: { from?: string } & Record<string, string> = {}) {
  const at = args.indexOf("--repo");
  const given = at === -1 ? [...args] : args.map((arg, i) => (i === at + 1 ? OFFICIAL_URL : arg));
  if (at !== -1) officialAt.set(home, args[at + 1]!);
  const stand = officialAt.get(home);
  return installFrom(home, given, { from, ...(stand === undefined ? {} : officialRedirect(stand)), ...extra });
}

const kitOf = (home: string) => join(home, ".cursor-workflows", "kit");
const shimOf = (home: string) => join(home, ".local", "bin", "wf");
const npmCalls = () => (existsSync(npmLog) ? readFileSync(npmLog, "utf8").trim().split("\n").filter(Boolean) : []);

/** Two changes that do not hide each other, for the tests that list every change. */
const TWO_CHANGES = [EDITED_FILE, PLANTED_NPMRC];

test("the installer clones the kit at the tag, installs its dependencies and writes a wf shim that runs the kit", () => {
  const home = newHome();
  const before = npmCalls().length;
  const r = install(home, ["--tag", "v0.3.0", "--repo", origin]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /detached HEAD/, "git's advice about a detached HEAD is noise to whoever reads the installer's output");

  const kit = kitOf(home);
  assert.equal(git(kit, "describe", "--tags", "--exact-match"), "v0.3.0");
  assert.deepEqual(npmCalls().slice(before), [`${kit} ci --no-audit --no-fund`]);

  // The shim is on the PATH the way a user has it, and runs the installed kit's CLI.
  const repo = join(home, "repo");
  mkdirSync(repo);
  const listed = spawnSync(shimOf(home), ["list", "--cwd", repo], { env: env(home), encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok((JSON.parse(listed.stdout) as Array<{ name: string }>).some((w) => w.name === "implement-issue"), listed.stdout);
});

/** The directory names under a skills folder. */
const skillNames = (dir: string) => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

test("the installer links every distributed skill into ~/.claude/skills as a symlink into the kit", () => {
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", origin]).status, 0);

  const names = skillNames(join(kitOf(home), "skills"));
  assert.ok(names.length > 0, "the kit distributes skills");
  for (const name of names) {
    const link = join(home, ".claude", "skills", name);
    assert.ok(lstatSync(link).isSymbolicLink(), `${link} must be a symlink`);
    // Through the fixed kit location, so the link survives a switch between a tag install and a dev install.
    assert.equal(readlinkSync(link), join(kitOf(home), "skills", name));
    assert.ok(existsSync(join(link, "SKILL.md")), `${link} must resolve to the skill`);
  }
});

const globalConfigOf = (home: string) => join(home, ".cursor-workflows", "config.json");

test("the installer writes the default global config with the agreed caps, which the kit accepts", () => {
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", origin]).status, 0);

  const written = JSON.parse(readFileSync(globalConfigOf(home), "utf8")) as { caps: Record<string, unknown> };
  assert.deepEqual(written.caps, {
    maxTokens: 3_000_000,
    maxTokensPerStep: 600_000,
    maxCents: 500,
    allowedModels: null,
    allowedSettingSources: ["project", "user", "team", "mdm", "plugins"],
    allowedLocations: ["local"],
    maxConcurrency: 4,
    requireSandbox: true,
  });

  // `wf config show` validates the file against the shipped schema and reports where it found it.
  const repo = join(home, "repo");
  mkdirSync(repo);
  const shown = spawnSync(shimOf(home), ["config", "show", "implement-issue", "--cwd", repo], { env: env(home), encoding: "utf8" });
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual((JSON.parse(shown.stdout) as { files: { global: unknown } }).files.global, { path: globalConfigOf(home), found: true });
});

test("the installer leaves an existing global config as it is", () => {
  const home = newHome();
  mkdirSync(join(home, ".cursor-workflows"));
  const mine = '{ "caps": { "maxCents": 50 } }\n';
  writeFileSync(globalConfigOf(home), mine);

  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", origin]).status, 0);
  assert.equal(readFileSync(globalConfigOf(home), "utf8"), mine);
});

test("running the installer again at the same tag changes nothing and still succeeds", () => {
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", origin]).status, 0);
  const shim = readFileSync(shimOf(home), "utf8");

  const again = install(home, ["--tag", "v0.3.0", "--repo", origin]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(shimOf(home), "utf8"), shim);
  assert.equal(git(kitOf(home), "describe", "--tags", "--exact-match"), "v0.3.0");
  assert.equal(
    git(kitOf(home), "status", "--porcelain", "--untracked-files=all", "--ignored=matching"),
    "!! node_modules/",
    "an installed kit has a clean tree, and its node_modules/ is the one ignored thing in it: that is what the upgrade and the doctor rely on",
  );
  for (const name of skillNames(join(kitOf(home), "skills"))) assert.equal(readlinkSync(join(home, ".claude", "skills", name)), join(kitOf(home), "skills", name));
});

test("the installer does not touch a skill folder, a skill link or a wf command that is the user's, and says so", () => {
  const home = newHome();
  mkdirSync(join(home, ".claude", "skills", "run-workflow"), { recursive: true });
  writeFileSync(join(home, ".claude", "skills", "run-workflow", "SKILL.md"), "mine\n");
  mkdirSync(join(home, "elsewhere"));
  symlinkSync(join(home, "elsewhere"), join(home, ".claude", "skills", "skill-to-workflow"));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(shimOf(home), "#!/bin/sh\necho my own wf\n");

  const r = install(home, ["--tag", "v0.3.0", "--repo", origin]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(home, ".claude", "skills", "run-workflow", "SKILL.md"), "utf8"), "mine\n");
  assert.equal(readlinkSync(join(home, ".claude", "skills", "skill-to-workflow")), join(home, "elsewhere"));
  assert.equal(readFileSync(shimOf(home), "utf8"), "#!/bin/sh\necho my own wf\n");
  for (const left of ["run-workflow", "skill-to-workflow", shimOf(home)]) assert.ok(r.stderr.includes(left), `the warnings should name ${left}: ${r.stderr}`);
  // What it could link, it linked.
  assert.equal(readlinkSync(join(home, ".claude", "skills", "cursor-workflow-authoring")), join(kitOf(home), "skills", "cursor-workflow-authoring"));
});

test("the installer tells the user to put the wf command's folder on the PATH only when it is not there", () => {
  const home = newHome();
  const bin = join(home, ".local", "bin");
  const off = install(home, ["--tag", "v0.3.0", "--repo", origin]);
  assert.equal(off.status, 0, off.stderr);
  assert.ok(off.stderr.includes(bin) && off.stderr.includes("PATH"), `expected a PATH hint naming ${bin}: ${off.stderr}`);

  const onHome = newHome();
  const onBin = join(onHome, ".local", "bin");
  const on = install(onHome, ["--tag", "v0.3.0", "--repo", origin], { PATH: [onBin, npmBin, NODE_DIR, "/usr/bin", "/bin"].join(":") });
  assert.equal(on.status, 0, on.stderr);
  assert.ok(!on.stderr.includes("PATH"), `no PATH hint expected: ${on.stderr}`);
});

/** A working copy of the kit, as a maintainer has it: a clone of the origin. */
function workingCopy(withDependencies: boolean): string {
  const dir = join(sandbox, `working-copy-${++counter}`);
  git(sandbox, "clone", "--quiet", origin, dir);
  if (withDependencies) symlinkSync(join(KIT_ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

test("--dev points the kit location at the working copy that holds the installer, and installs what is missing there", () => {
  const home = newHome();
  const copy = workingCopy(false);
  const before = npmCalls().length;
  const r = install(home, ["--dev"], { from: copy });
  assert.equal(r.status, 0, r.stderr);

  assert.equal(readlinkSync(kitOf(home)), copy);
  assert.deepEqual(npmCalls().slice(before), [`${kitOf(home)} install --no-audit --no-fund`], "install, never ci: ci would empty a maintainer's node_modules");
  assert.equal(readlinkSync(join(home, ".claude", "skills", "run-workflow")), join(kitOf(home), "skills", "run-workflow"));

  const repo = join(home, "repo");
  mkdirSync(repo);
  const listed = spawnSync(shimOf(home), ["list", "--cwd", repo], { env: env(home), encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(listed.stdout.includes("implement-issue"), listed.stdout);
});

test("--dev leaves a working copy that already has its dependencies alone", () => {
  const home = newHome();
  const copy = workingCopy(true);
  const before = npmCalls().length;
  assert.equal(install(home, ["--dev"], { from: copy }).status, 0);
  assert.deepEqual(npmCalls().slice(before), []);
});

test("a tag install and a dev install never overwrite each other: the installer asks the user to move the other one", () => {
  const dev = newHome();
  assert.equal(install(dev, ["--dev"], { from: workingCopy(true) }).status, 0);
  const onDev = install(dev, ["--tag", "v0.3.0", "--repo", origin]);
  assert.equal(onDev.status, 1);
  assert.ok(onDev.stderr.includes(kitOf(dev)) && /development install/.test(onDev.stderr), onDev.stderr);

  const tagged = newHome();
  assert.equal(install(tagged, ["--tag", "v0.3.0", "--repo", origin]).status, 0);
  const copy = workingCopy(true);
  const onTag = install(tagged, ["--dev"], { from: copy });
  assert.equal(onTag.status, 1);
  assert.ok(onTag.stderr.includes(kitOf(tagged)), onTag.stderr);
  assert.equal(git(kitOf(tagged), "describe", "--tags", "--exact-match"), "v0.3.0", "the tag install is still there");
});

test("--refresh redoes the dependencies, the shim, the links and the config for the kit that is in place, and drops links to skills that left", () => {
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", origin]).status, 0);
  const kit = kitOf(home);
  // The kit gains a skill and loses one, the way a new tag does.
  mkdirSync(join(kit, "skills", "brand-new"));
  writeFileSync(join(kit, "skills", "brand-new", "SKILL.md"), "---\nname: brand-new\n---\n");
  rmSync(join(kit, "skills", "skill-to-workflow"), { recursive: true });
  const before = npmCalls().length;

  const r = install(home, ["--refresh"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(npmCalls().slice(before), [`${kit} ci --no-audit --no-fund`]);
  assert.equal(readlinkSync(join(home, ".claude", "skills", "brand-new")), join(kit, "skills", "brand-new"));
  assert.ok(!existsSync(join(home, ".claude", "skills", "skill-to-workflow")) && !lstatExists(join(home, ".claude", "skills", "skill-to-workflow")), "the link to the skill that left must go");
  assert.ok(lstatSync(join(home, ".claude", "skills", "run-workflow")).isSymbolicLink());
});

/** Whether anything, a dangling link included, is at `path`. */
function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

test("--refresh on a dev install never runs npm ci in the working copy", () => {
  const home = newHome();
  const copy = workingCopy(true);
  assert.equal(install(home, ["--dev"], { from: copy }).status, 0);
  const before = npmCalls().length;
  assert.equal(install(home, ["--refresh"]).status, 0);
  assert.deepEqual(npmCalls().slice(before), [], "the working copy has its dependencies: nothing to install, and ci would empty them");

  // Without them, only `install` fills the gap.
  rmSync(join(copy, "node_modules"));
  assert.equal(install(home, ["--refresh"]).status, 0);
  assert.deepEqual(npmCalls().slice(before), [`${kitOf(home)} install --no-audit --no-fund`]);
});

test("a skill whose folder stays in the kit without a SKILL.md loses its link on --refresh", () => {
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", origin]).status, 0);
  const folder = join(kitOf(home), "skills", "half-removed");
  mkdirSync(folder);
  writeFileSync(join(folder, "SKILL.md"), "---\nname: half-removed\n---\n");
  assert.equal(install(home, ["--refresh"]).status, 0);
  assert.ok(lstatSync(join(home, ".claude", "skills", "half-removed")).isSymbolicLink());

  // A checkout leaves untracked leftovers behind; the folder is there, the skill is not.
  rmSync(join(folder, "SKILL.md"));
  writeFileSync(join(folder, "notes.txt"), "left over\n");
  assert.equal(install(home, ["--refresh"]).status, 0);
  assert.ok(!lstatExists(join(home, ".claude", "skills", "half-removed")));
});

test("the installer works in a home whose path has spaces, quotes and a dollar sign, and the shim runs the kit from there", () => {
  const home = join(sandbox, `home ${++counter} it's $HOME "x"`);
  mkdirSync(home);
  const r = install(home, ["--tag", "v0.3.0", "--repo", origin]);
  assert.equal(r.status, 0, r.stderr);
  const repo = join(home, "repo");
  mkdirSync(repo);
  const listed = spawnSync(shimOf(home), ["list", "--cwd", repo], { env: env(home), encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(listed.stdout.includes("implement-issue"), listed.stdout);
  assert.equal(readlinkSync(join(home, ".claude", "skills", "run-workflow")), join(kitOf(home), "skills", "run-workflow"));
});

/** A fork of the origin: a clone, so it has the origin's v0.3.0 (the same commit), and its own release `version`. */
function fork(version = "0.4.0"): string {
  const dir = join(sandbox, `fork-${++counter}`);
  git(sandbox, "clone", "--quiet", origin, dir);
  release(dir, version);
  return dir;
}

test("--repo given again points an existing clone at that repository before it fetches the tag", () => {
  const home = newHome();
  // Forks, not the official repository: --allow-mutable-tag skips the release check, which is not what this test is about.
  assert.equal(installFrom(home, ["--tag", "v0.3.0", "--repo", origin, "--allow-mutable-tag"]).status, 0);
  const other = fork();

  const r = installFrom(home, ["--tag", "v0.4.0", "--repo", other, "--allow-mutable-tag"], { from: other });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(kitOf(home), "describe", "--tags", "--exact-match"), "v0.4.0");
  assert.equal(git(kitOf(home), "remote", "get-url", "origin"), other);

  // Without --repo the clone keeps the origin it has (a fork, say).
  assert.equal(installFrom(home, ["--tag", "v0.4.0", "--allow-mutable-tag"], { from: other }).status, 0);
  assert.equal(git(kitOf(home), "remote", "get-url", "origin"), other);
});

test("--refresh without an installed kit says how to install one", () => {
  const home = newHome();
  const r = install(home, ["--refresh"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--tag/);
  assert.ok(!existsSync(shimOf(home)));
});

test("a tag the repository does not have is an error that leaves the home as it was", () => {
  const home = newHome();
  const r = install(home, ["--tag", "v9.9.9", "--repo", origin]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("v9.9.9"), r.stderr);
  assert.ok(!existsSync(kitOf(home)) && !existsSync(shimOf(home)) && !existsSync(join(home, ".claude")));
});

test("a Node older than the kit's engines.node stops the installer before it installs anything, naming both versions", () => {
  const home = newHome();
  const old = join(sandbox, `old-node-${++counter}`);
  mkdirSync(old);
  // Only `--version` is faked: the installer's release lookup runs a script on this Node, as it would on a real 22.11.
  writeFileSync(join(old, "node"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v22.11.0; exit 0; fi\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(old, "node"), 0o755);
  const before = npmCalls().length;

  const r = install(home, ["--tag", "v0.3.0", "--repo", origin], { PATH: [old, npmBin, NODE_DIR, "/usr/bin", "/bin"].join(":") });
  assert.equal(r.status, 1);
  const needs = (JSON.parse(readFileSync(join(origin, "package.json"), "utf8")) as { engines: { node: string } }).engines.node.replace(">=", "");
  assert.ok(r.stderr.includes("22.11.0") && r.stderr.includes(needs), r.stderr);
  assert.deepEqual(npmCalls().slice(before), []);
  assert.ok(!existsSync(shimOf(home)) && !existsSync(join(home, ".claude")) && !existsSync(globalConfigOf(home)));
});

/** A kit installed at v0.3.0 from a fresh origin that also has v0.4.0, with `tampering` planted in it: what a test compares afterwards. */
function tamperedKit(tampering: KitTampering[]) {
  const dir = originWithReleases();
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", dir], { from: dir }).status, 0);
  const kit = kitOf(home);
  const head = git(kit, "rev-parse", "HEAD");
  for (const { plant } of tampering) plant(kit);
  return { dir, home, kit, head, npmBefore: npmCalls().length };
}

/** What a refused move leaves: the kit on the tag it was on, no installer step run in it, and the planted files for the user to read. */
function assertKitLeftAlone({ kit, head, npmBefore }: ReturnType<typeof tamperedKit>, tampering: KitTampering[]): void {
  assert.equal(git(kit, "describe", "--tags", "--exact-match"), "v0.3.0");
  assert.equal(git(kit, "rev-parse", "HEAD"), head);
  assert.deepEqual(npmCalls().slice(npmBefore), [], "npm ci reads an .npmrc of the kit: no installer step may run in it");
  for (const { file } of tampering) assert.ok(existsSync(join(kit, file)), `${file} is left for the user to look at`);
}

for (const tampering of KIT_TAMPERING) {
  test(`the installer refuses an existing clone with ${tampering.what} before it moves it to another tag: it names the change and leaves the kit as it was`, () => {
    const planted = tamperedKit([tampering]);
    const r = install(planted.home, ["--tag", "v0.4.0"], { from: planted.dir });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes(`error: the kit at ${planted.kit} has local changes: ${tampering.listed}; reinstall it`), r.stderr);
    assertKitLeftAlone(planted, [tampering]);
  });
}

test("the installer says it cannot read the state of a clone whose git data is broken, and moves nothing", () => {
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", origin]).status, 0);
  const kit = kitOf(home);
  writeFileSync(join(kit, ".git", "HEAD"), "not a ref\n");
  const before = npmCalls().length;

  const r = install(home, ["--tag", "v0.3.0", "--repo", origin]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(`error: could not read the state of the kit at ${kit}`) && r.stderr.includes("reinstall it"), r.stderr);
  assert.deepEqual(npmCalls().slice(before), []);
});

test("the installer lists every change of the clone, also when it is asked for the tag the clone is on", () => {
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", origin]).status, 0);
  const kit = kitOf(home);
  for (const { plant } of TWO_CHANGES) plant(kit);

  const r = install(home, ["--tag", "v0.3.0", "--repo", origin]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(`the kit at ${kit} has local changes: ${TWO_CHANGES.map((k) => k.listed).join(", ")}; reinstall it`), r.stderr);
});

// ---- wf upgrade ----

/** An origin of its own (the shared one must stay at v0.3.0) with a skill added, a skill dropped and a pre-release after it. */
function originWithReleases(): string {
  const dir = makeOrigin(join(sandbox, `origin-${++counter}`), "0.3.0");
  release(dir, "0.4.0", (d) => {
    mkdirSync(join(d, "skills", "extra-skill"));
    writeFileSync(join(d, "skills", "extra-skill", "SKILL.md"), "---\nname: extra-skill\ndescription: a skill the newer tag adds\n---\n");
    rmSync(join(d, "skills", "skill-to-workflow"), { recursive: true });
    // The installer of the new tag is the one `wf upgrade` must run: it says so.
    const script = join(d, "scripts", "install.sh");
    writeFileSync(script, readFileSync(script, "utf8").replace('echo "kit ready at $kit"', 'echo "kit ready at $kit (installer 0.4.0)"'));
  });
  release(dir, "0.5.0-rc.1");
  return dir;
}

/** Runs `wf upgrade` through the installed shim, the way a user does. */
function upgrade(home: string, args: string[] = [], extra: Record<string, string> = {}) {
  const stand = officialAt.get(home);
  const r = spawnSync(shimOf(home), ["upgrade", ...args], { env: env(home, { ...(stand === undefined ? {} : officialRedirect(stand)), ...extra }), encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("wf upgrade checks out the newest release tag, reinstalls dependencies and keeps the skill links valid", () => {
  const dir = originWithReleases();
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", dir], { from: dir }).status, 0);
  const kit = kitOf(home);
  const configBefore = readFileSync(globalConfigOf(home), "utf8");
  const before = npmCalls().length;

  const r = upgrade(home);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { upgraded: true, from: "0.3.0", to: "0.4.0", tag: "v0.4.0" }); // v0.5.0-rc.1 is newer, but not a release
  assert.equal(git(kit, "describe", "--tags", "--exact-match"), "v0.4.0");
  assert.deepEqual(npmCalls().slice(before), [`${kit} ci --no-audit --no-fund`]);
  assert.ok(r.stderr.includes("installer 0.4.0"), `the new tag's installer must run: ${r.stderr}`);

  const skills = join(home, ".claude", "skills");
  assert.equal(readlinkSync(join(skills, "extra-skill")), join(kit, "skills", "extra-skill"), "a skill the new tag adds is linked");
  assert.ok(!lstatExists(join(skills, "skill-to-workflow")), "a skill the new tag drops loses its link");
  for (const name of skillNames(join(kit, "skills"))) assert.ok(existsSync(join(skills, name, "SKILL.md")), `${name} must resolve`);
  assert.equal(readFileSync(globalConfigOf(home), "utf8"), configBefore, "the user's config is not rewritten");

  // The shim still runs the kit, now at the new version.
  const repo = join(home, "repo");
  mkdirSync(repo);
  assert.equal(spawnSync(shimOf(home), ["list", "--cwd", repo], { env: env(home), encoding: "utf8" }).status, 0);
});

test("wf upgrade at the newest tag reports it and changes nothing", () => {
  const dir = originWithReleases();
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.4.0", "--repo", dir], { from: dir }).status, 0);
  const before = npmCalls().length;
  const asked = releaseRequests().length;

  const r = upgrade(home);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { upgraded: false, from: "0.4.0", to: "0.4.0", tag: "v0.4.0" });
  assert.deepEqual(npmCalls().slice(before), []);
  assert.deepEqual(releaseRequests().slice(asked), [], "no checkout is coming, so the release is not looked up");
});

test("wf upgrade refuses a dev install and leaves the working copy where it is", () => {
  const home = newHome();
  const copy = workingCopy(true);
  assert.equal(install(home, ["--dev"], { from: copy }).status, 0);
  const head = git(copy, "rev-parse", "HEAD");

  const r = upgrade(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /development install/);
  assert.equal(git(copy, "rev-parse", "HEAD"), head);
});

test("wf upgrade only upgrades the installed kit: a wf that runs from somewhere else refuses", () => {
  const dir = originWithReleases();
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", dir], { from: dir }).status, 0);

  // This checkout's own CLI, with the installed kit in the home.
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(KIT_ROOT, "packages", "runtime", "src", "cli.ts"), "upgrade"], {
    env: env(home, { TSX_TSCONFIG_PATH: join(KIT_ROOT, "packages", "runtime", "tsconfig.test.json") }),
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(kitOf(home)), r.stderr);
  assert.equal(git(kitOf(home), "describe", "--tags", "--exact-match"), "v0.3.0");
});

test("wf upgrade that cannot reach the repository fails and leaves the kit as it was", () => {
  const dir = originWithReleases();
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", dir], { from: dir }).status, 0);
  rmSync(dir, { recursive: true });
  const before = npmCalls().length;

  const r = upgrade(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tags/);
  assert.equal(git(kitOf(home), "describe", "--tags", "--exact-match"), "v0.3.0");
  assert.deepEqual(npmCalls().slice(before), []);
});

test("wf upgrade whose checkout fails says which tag it could not move to and leaves the kit where it was", () => {
  const dir = originWithReleases();
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", dir], { from: dir }).status, 0);
  const kit = kitOf(home);
  // A leftover lock in the clone: the tree is clean, so the upgrade goes ahead, and git cannot take the lock to move HEAD.
  writeFileSync(join(kit, ".git", "index.lock"), "");
  const before = npmCalls().length;

  const r = upgrade(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not move the kit to v0\.4\.0/);
  assert.equal(git(kit, "describe", "--tags", "--exact-match"), "v0.3.0");
  assert.deepEqual(npmCalls().slice(before), []);
});

for (const tampering of KIT_TAMPERING) {
  test(`wf upgrade refuses a kit with ${tampering.what}: it names the change, runs no installer and leaves the kit on its tag`, () => {
    const planted = tamperedKit([tampering]);
    const r = upgrade(planted.home);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes(`the kit at ${planted.kit} has local changes: ${tampering.listed}; reinstall it`), r.stderr);
    assert.equal(r.stdout, "");
    assertKitLeftAlone(planted, [tampering]);
  });
}

test("wf upgrade says it cannot read the state of a kit whose git data is broken, as the installer does, and moves nothing", () => {
  const dir = originWithReleases();
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", dir], { from: dir }).status, 0);
  const kit = kitOf(home);
  writeFileSync(join(kit, ".git", "HEAD"), "not a ref\n");
  const before = npmCalls().length;

  const r = upgrade(home);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(`could not read the state of the kit at ${kit}`) && r.stderr.includes("reinstall it"), r.stderr);
  assert.deepEqual(npmCalls().slice(before), []);
});

test("wf upgrade lists every change of the kit, and refuses even when the kit is already at the newest tag", () => {
  const dir = originWithReleases();
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.4.0", "--repo", dir], { from: dir }).status, 0);
  const kit = kitOf(home);
  for (const { plant } of TWO_CHANGES) plant(kit);

  const r = upgrade(home);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(`the kit at ${kit} has local changes: ${TWO_CHANGES.map((k) => k.listed).join(", ")}; reinstall it`), r.stderr);
  assert.equal(git(kit, "describe", "--tags", "--exact-match"), "v0.4.0");
});

// ---- a tag that moved, and a release that is not immutable ----

afterEach(() => {
  for (const file of readdirSync(releaseApiDir)) if (file.endsWith(".json")) rmSync(join(releaseApiDir, file));
});

/** The request paths the releases API stand-in has answered so far, oldest first. */
function releaseRequests(): string[] {
  const log = join(releaseApiDir, "requests.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
}

/** The stand-in answers for `tag` with the recorded release whose `immutable` field is `immutable` (`undefined` leaves the field out; by default every tag is immutable). */
function serveRelease(tag: string, immutable: boolean | undefined): void {
  writeFileSync(join(releaseApiDir, `${tag}.json`), JSON.stringify({ immutable: immutable ?? null }));
}

/** The stand-in answers for `tag` with the recorded 404 of a tag that has no release. */
function serveNoRelease(tag: string): void {
  writeFileSync(join(releaseApiDir, `${tag}.json`), JSON.stringify({ release: "missing" }));
}

/** The URL of a port nothing listens on (fetch refuses the well-known low ports as "bad port", so a port the OS just gave and took back). */
async function closedApiUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return `http://127.0.0.1:${port}`;
}

const OFFICIAL_RELEASE_PATH = "/repos/rodrigorjsf/cursor-workflows-starter/releases/tags";

/** A bare repository, as GitHub serves a repository, with the releases of `originWithReleases()`; `dir` holds the installer to run. */
function bareRemote(): { dir: string; bare: string } {
  const dir = originWithReleases();
  const bare = join(sandbox, `remote-${++counter}.git`);
  git(sandbox, "clone", "--quiet", "--bare", dir, bare);
  return { dir, bare };
}

test("the installer refuses a tag that moved upstream since the kit fetched it, and leaves the kit where it was", () => {
  const { dir, bare } = bareRemote();
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", bare], { from: dir }).status, 0);
  const kit = kitOf(home);
  const pinned = git(kit, "rev-parse", "v0.3.0^{commit}");
  git(bare, "tag", "-f", "v0.3.0", "v0.4.0^{commit}"); // whoever holds a token re-points the release
  const before = npmCalls().length;

  const r = install(home, ["--tag", "v0.3.0", "--repo", bare], { from: dir });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /moved/);
  assert.ok(r.stderr.includes(OFFICIAL_URL), `the message names the repository: ${r.stderr}`);
  assert.equal(git(kit, "rev-parse", "v0.3.0^{commit}"), pinned, "the local tag was not overwritten");
  assert.equal(git(kit, "rev-parse", "HEAD"), pinned);
  assert.deepEqual(npmCalls().slice(before), []);
});

test("wf upgrade refuses a release tag that moved upstream and leaves the kit on its tag", () => {
  const { dir, bare } = bareRemote();
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", bare], { from: dir }).status, 0);
  const kit = kitOf(home);
  const newest = git(kit, "rev-parse", "v0.4.0^{commit}");
  git(bare, "tag", "-f", "v0.4.0", "v0.3.0^{commit}");
  const before = npmCalls().length;

  const r = upgrade(home);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /moved/);
  assert.equal(git(kit, "rev-parse", "v0.4.0^{commit}"), newest, "the local tag was not overwritten");
  assert.equal(git(kit, "describe", "--tags", "--exact-match"), "v0.3.0");
  assert.deepEqual(npmCalls().slice(before), []);
});

test("the installer asks the releases API about the official repository's tag before it clones anything", () => {
  const home = newHome();
  const asked = releaseRequests().length;
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", origin]).status, 0);
  assert.deepEqual(releaseRequests().slice(asked), [`${OFFICIAL_RELEASE_PATH}/v0.3.0`]);
});

test("the installer refuses a release that is not immutable and clones nothing", () => {
  const home = newHome();
  serveRelease("v0.3.0", false);
  const before = npmCalls().length;

  const r = install(home, ["--tag", "v0.3.0", "--repo", origin]);
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.stderr.includes("v0.3.0") && /not immutable/.test(r.stderr) && r.stderr.includes("--allow-mutable-tag"), `the message names the tag, the reason and the flag: ${r.stderr}`);
  assert.ok(!existsSync(kitOf(home)) && !existsSync(shimOf(home)) && !existsSync(join(home, ".claude")));
  assert.deepEqual(npmCalls().slice(before), []);

  serveRelease("v0.3.0", undefined); // a release the API gives no immutable field for is not immutable either
  assert.equal(install(newHome(), ["--tag", "v0.3.0", "--repo", origin]).status, 1);
});

test("the installer refuses a release that is not immutable before it moves an existing clone, which stays on its tag", () => {
  const dir = originWithReleases();
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", dir], { from: dir }).status, 0);
  serveRelease("v0.4.0", false);

  const r = install(home, ["--tag", "v0.4.0", "--repo", dir], { from: dir });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /not immutable/);
  assert.equal(git(kitOf(home), "describe", "--tags", "--exact-match"), "v0.3.0");
});

test("--allow-mutable-tag installs a release that is not immutable without asking the API", () => {
  const home = newHome();
  serveRelease("v0.3.0", false);
  const asked = releaseRequests().length;

  const r = install(home, ["--tag", "v0.3.0", "--repo", origin, "--allow-mutable-tag"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(kitOf(home), "describe", "--tags", "--exact-match"), "v0.3.0");
  assert.deepEqual(releaseRequests().slice(asked), []);
});

test("a tag with no release is an error: only a published release installs", () => {
  const home = newHome();
  serveNoRelease("v0.3.0");
  const r = install(home, ["--tag", "v0.3.0", "--repo", origin]);
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.stderr.includes("v0.3.0") && /no release/.test(r.stderr), r.stderr);
  assert.ok(!existsSync(kitOf(home)));
});

test("a releases API that cannot be reached stops the installer: the check is never skipped", async () => {
  const home = newHome();
  const r = install(home, ["--tag", "v0.3.0", "--repo", origin], { WF_GITHUB_API_URL: await closedApiUrl() });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /could not read the release of v0\.3\.0 from .*ECONNREFUSED/);
  assert.ok(!existsSync(kitOf(home)) && !existsSync(shimOf(home)));
});

test("a repository other than the official one is refused unless --allow-mutable-tag says to skip the release check, even when a releases API answers", () => {
  const home = newHome();
  const asked = releaseRequests().length;
  const refused = installFrom(home, ["--tag", "v0.3.0", "--repo", origin]);
  assert.equal(refused.status, 1, refused.stdout);
  assert.ok(refused.stderr.includes(origin) && refused.stderr.includes("--allow-mutable-tag"), refused.stderr);
  assert.ok(!existsSync(kitOf(home)));
  assert.deepEqual(releaseRequests().slice(asked), [], "the answer for the official repository's tag of that name says nothing about this one: it is not asked");

  const allowed = installFrom(home, ["--tag", "v0.3.0", "--repo", origin, "--allow-mutable-tag"]);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(git(kitOf(home), "describe", "--tags", "--exact-match"), "v0.3.0");
});

test("a refused install leaves an existing clone alone: its origin stays, and no tag is fetched", () => {
  const home = newHome();
  const dir = originWithReleases();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", dir], { from: dir }).status, 0);
  const kit = kitOf(home);
  const newer = fork("0.9.0");

  // Not the official repository: refused before the origin is replaced.
  const foreign = installFrom(home, ["--tag", "v0.9.0", "--repo", newer], { from: newer });
  assert.equal(foreign.status, 1, foreign.stdout);
  assert.equal(git(kit, "config", "--get", "remote.origin.url"), OFFICIAL_URL);
  assert.equal(git(kit, "tag", "--list", "v0.9.0"), "", "nothing was fetched from the refused repository");

  // The official repository's release is not immutable: refused before the tags are fetched.
  serveRelease("v0.9.0", false);
  const mutable = install(home, ["--tag", "v0.9.0", "--repo", newer], { from: newer });
  assert.equal(mutable.status, 1, mutable.stdout);
  assert.match(mutable.stderr, /not immutable/);
  assert.equal(git(kit, "tag", "--list", "v0.9.0"), "", "the tag of a release that is not immutable was not fetched");
  assert.equal(git(kit, "describe", "--tags", "--exact-match"), "v0.3.0");
});

test("--allow-mutable-tag belongs to a tag install: with --dev or --refresh it is a usage error", () => {
  for (const mode of ["--dev", "--refresh"]) {
    const r = installFrom(newHome(), [mode, "--allow-mutable-tag"], { from: workingCopy(true) });
    assert.equal(r.status, 2, `${mode}: ${r.stdout}`);
    assert.match(r.stderr, /--allow-mutable-tag/);
  }
});

test("wf upgrade refuses a release that is not immutable and leaves the kit on its old tag; --allow-mutable-tag goes ahead", () => {
  const dir = originWithReleases();
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", dir], { from: dir }).status, 0);
  const kit = kitOf(home);
  serveRelease("v0.4.0", false);
  const before = npmCalls().length;
  const asked = releaseRequests().length;

  const refused = upgrade(home);
  assert.equal(refused.status, 1, refused.stdout);
  assert.ok(refused.stderr.includes("v0.4.0") && /not immutable/.test(refused.stderr) && refused.stderr.includes("--allow-mutable-tag"), refused.stderr);
  assert.equal(git(kit, "describe", "--tags", "--exact-match"), "v0.3.0");
  assert.deepEqual(npmCalls().slice(before), []);
  assert.deepEqual(releaseRequests().slice(asked), [`${OFFICIAL_RELEASE_PATH}/v0.4.0`]);

  const allowed = upgrade(home, ["--allow-mutable-tag"]);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.deepEqual(JSON.parse(allowed.stdout), { upgraded: true, from: "0.3.0", to: "0.4.0", tag: "v0.4.0" });
  assert.equal(git(kit, "describe", "--tags", "--exact-match"), "v0.4.0");
});

test("wf upgrade with a releases API that cannot be reached fails and leaves the kit on its old tag", async () => {
  const dir = originWithReleases();
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", dir], { from: dir }).status, 0);

  const r = upgrade(home, [], { WF_GITHUB_API_URL: await closedApiUrl() });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /could not read the release of v0\.4\.0 from .*ECONNREFUSED/);
  assert.equal(git(kitOf(home), "describe", "--tags", "--exact-match"), "v0.3.0");
});

test("wf upgrade of a kit whose origin is not the official repository is refused unless --allow-mutable-tag says to skip the release check", () => {
  const dir = originWithReleases();
  const home = newHome();
  assert.equal(installFrom(home, ["--tag", "v0.3.0", "--repo", dir, "--allow-mutable-tag"], { from: dir }).status, 0);
  const asked = releaseRequests().length;

  const refused = upgrade(home);
  assert.equal(refused.status, 1, refused.stdout);
  assert.ok(refused.stderr.includes(dir) && refused.stderr.includes("--allow-mutable-tag"), refused.stderr);
  assert.equal(git(kitOf(home), "describe", "--tags", "--exact-match"), "v0.3.0");
  assert.deepEqual(releaseRequests().slice(asked), []);

  assert.equal(upgrade(home, ["--allow-mutable-tag"]).status, 0);
  assert.equal(git(kitOf(home), "describe", "--tags", "--exact-match"), "v0.4.0");
});
