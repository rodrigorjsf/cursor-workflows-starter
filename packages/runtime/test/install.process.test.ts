// Seam 2, the process: the installer (`scripts/install.sh`) and `wf upgrade` run against a temporary home. A local git
// repository stands in for GitHub (see kit-origin.ts) and a fake `npm` on the PATH stands in for the registry: it logs
// how it was called and links `node_modules` to this checkout's. The tests read the files the installer leaves in the
// home (the kit, the `wf` shim, the skill links, the global config), what the shim runs, the exit codes and the messages.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { git, makeOrigin, release } from "./kit-origin.js";

const KIT_ROOT = join(import.meta.dirname, "..", "..", "..");
const NODE_DIR = dirname(process.execPath);

let sandbox: string;
/** The stand-in for GitHub: releases v0.3.0 and, for the upgrade tests, more. Tests that add releases clone their own. */
let origin: string;
let npmBin: string;
let npmLog: string;
let counter = 0;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-install-"));
  origin = makeOrigin(join(sandbox, "origin"), "0.3.0");
  npmLog = join(sandbox, "npm.log");
  npmBin = join(sandbox, "npm-bin");
  mkdirSync(npmBin);
  // `npm ci` empties node_modules first; `npm install` keeps it. Both end with the checkout's own node_modules linked in.
  writeFileSync(join(npmBin, "npm"), `#!/bin/sh\necho "$PWD $*" >> "$NPM_LOG"\nrm -rf node_modules\nln -s "${join(KIT_ROOT, "node_modules")}" node_modules\n`);
  chmodSync(join(npmBin, "npm"), 0o755);
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

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
    ...extra,
  };
}

/** Runs the installer of `from` (default: the origin's own copy, like a downloaded file). */
function install(home: string, args: string[], { from = origin, ...extra }: { from?: string } & Record<string, string> = {}) {
  const r = spawnSync("bash", [join(from, "scripts", "install.sh"), ...args], { env: env(home, extra), encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const kitOf = (home: string) => join(home, ".cursor-workflows", "kit");
const shimOf = (home: string) => join(home, ".local", "bin", "wf");
const npmCalls = () => (existsSync(npmLog) ? readFileSync(npmLog, "utf8").trim().split("\n").filter(Boolean) : []);

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
  assert.equal(git(kitOf(home), "status", "--porcelain", "--untracked-files=no"), "");
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
  assert.ok(onDev.stderr.includes(kitOf(dev)) && /desenvolvimento/.test(onDev.stderr), onDev.stderr);

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

test("--repo given again points an existing clone at that repository before it fetches the tag", () => {
  const home = newHome();
  assert.equal(install(home, ["--tag", "v0.3.0", "--repo", origin]).status, 0);
  const other = originWithReleases();

  const r = install(home, ["--tag", "v0.4.0", "--repo", other], { from: other });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(kitOf(home), "describe", "--tags", "--exact-match"), "v0.4.0");
  assert.equal(git(kitOf(home), "remote", "get-url", "origin"), other);

  // Without --repo the clone keeps the origin it has (a fork, say).
  assert.equal(install(home, ["--tag", "v0.4.0"], { from: other }).status, 0);
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
  writeFileSync(join(old, "node"), '#!/bin/sh\n[ "$1" = "--version" ] && echo v22.11.0\n');
  chmodSync(join(old, "node"), 0o755);
  const before = npmCalls().length;

  const r = install(home, ["--tag", "v0.3.0", "--repo", origin], { PATH: [old, npmBin, NODE_DIR, "/usr/bin", "/bin"].join(":") });
  assert.equal(r.status, 1);
  const needs = (JSON.parse(readFileSync(join(origin, "package.json"), "utf8")) as { engines: { node: string } }).engines.node.replace(">=", "");
  assert.ok(r.stderr.includes("22.11.0") && r.stderr.includes(needs), r.stderr);
  assert.deepEqual(npmCalls().slice(before), []);
  assert.ok(!existsSync(shimOf(home)) && !existsSync(join(home, ".claude")) && !existsSync(globalConfigOf(home)));
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
    writeFileSync(script, readFileSync(script, "utf8").replace('echo "kit pronto em $kit"', 'echo "kit pronto em $kit (instalador 0.4.0)"'));
  });
  release(dir, "0.5.0-rc.1");
  return dir;
}

/** Runs `wf upgrade` through the installed shim, the way a user does. */
function upgrade(home: string) {
  const r = spawnSync(shimOf(home), ["upgrade"], { env: env(home), encoding: "utf8" });
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
  assert.ok(r.stderr.includes("instalador 0.4.0"), `the new tag's installer must run: ${r.stderr}`);

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

  const r = upgrade(home);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { upgraded: false, from: "0.4.0", to: "0.4.0", tag: "v0.4.0" });
  assert.deepEqual(npmCalls().slice(before), []);
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
  // A local edit to a file that v0.4.0 changes: git will not overwrite it.
  writeFileSync(join(kit, "package.json"), `${readFileSync(join(kit, "package.json"), "utf8")}\n`);
  const before = npmCalls().length;

  const r = upgrade(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not move the kit to v0\.4\.0/);
  assert.equal(git(kit, "describe", "--tags", "--exact-match"), "v0.3.0");
  assert.deepEqual(npmCalls().slice(before), []);
});
