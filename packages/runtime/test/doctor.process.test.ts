// Seam 2, the process: `wf doctor` is spawned (against the fake Cursor SDK) in a temporary repo with a temporary home, as
// the IDE's environment would be: the kit sits at ~/.cursor-workflows/kit, the repo has the MCP configs `wf init` writes,
// and `gh`, `glab` and `node` are whatever the PATH of the process says (git is the real one). The tests read the report,
// the exit code and the messages; they never import the doctor.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyKit } from "./kit-copy.js";

const PACKAGE = join(import.meta.dirname, "..");
const KIT_ROOT = join(PACKAGE, "..", "..");

let sandbox: string;
/** The user's home: the kit is linked at `.cursor-workflows/kit`, the per-user state (global config) is `.cursor-workflows`. */
let home: string;
/** A repo that `wf init` already set up: each test works on its own copy. */
let initialisedRepo: string;
let counter = 0;

/** A directory holding one executable `name` that runs `script`; returned so it can lead a PATH. */
function fakeBin(name: string, script: string): string {
  const dir = join(sandbox, `bin-${++counter}`);
  mkdirSync(dir);
  writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, name), 0o755);
  return dir;
}

let ghLoggedIn: string;
/** A directory holding only `git`, the real one: the forge check reads the repository's `origin` with it. */
let gitDir: string;
/** Where the real `node` that runs these tests lives: the PATH of a doctor run holds this, the fakes and `git`, nothing else. */
const NODE_DIR = dirname(process.execPath);

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-doctor-"));
  home = join(sandbox, "home");
  mkdirSync(join(home, ".cursor-workflows"), { recursive: true });
  symlinkSync(KIT_ROOT, join(home, ".cursor-workflows", "kit"));
  ghLoggedIn = fakeBin("gh", "exit 0");
  gitDir = fakeBin("git", `exec "${execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()}" "$@"`);

  initialisedRepo = join(sandbox, "initialised");
  mkdirSync(initialisedRepo);
  const init = wf(initialisedRepo, ["init"], { bins: [] });
  assert.equal(init.status, 0, init.stderr);
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

/** The environment of a doctor run: only the given directories (then the real node's and `git`) on the PATH, so no `gh` or `glab` of the machine leaks in. */
function env(bins: string[], extra: Record<string, string> = {}, userHome = home, kit = KIT_ROOT): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    PATH: [...bins, NODE_DIR, gitDir].join(":"),
    HOME: userHome,
    WF_HOME: join(userHome, ".cursor-workflows"),
    TSX_TSCONFIG_PATH: join(kit, "packages", "runtime", "tsconfig.test.json"),
    WF_METRICS: "off",
    WF_DASH_AUTOSTART: "off", // the tests must not leave a dashboard behind
    ...extra,
  };
}

const put = (path: string, content: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
};

/** A copy of the initialised repo, for a test to change. */
function repoCopy(): string {
  const repo = join(sandbox, `repo-${++counter}`);
  cpSync(initialisedRepo, repo, { recursive: true });
  return repo;
}
const repoConfigPath = (repo: string) => join(repo, ".agents", "workflows", "config.json");

/** A copy of the initialised repo that is a git repository, with an `origin` remote when `origin` is given. */
function gitRepoCopy(origin?: string): string {
  const repo = repoCopy();
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: repo, env: env([]), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "--quiet");
  if (origin !== undefined) git("remote", "add", "origin", origin);
  return repo;
}

/** A user's home with a global config file holding `config`, as a user declaring a self-managed host once would have. */
function homeWithConfig(config: unknown): string {
  const userHome = homeWithKit(KIT_ROOT);
  put(join(userHome, ".cursor-workflows", "config.json"), config);
  return userHome;
}

/** A forge CLI that logs its arguments, then answers `auth status` as a logged-in user (or, with `said`, a logged-out one) would. */
function fakeForgeCli(name: "gh" | "glab", said?: string): { dir: string; calls: () => string[] } {
  const log = join(sandbox, `${name}-${++counter}.log`);
  const dir = fakeBin(name, `echo "$*" >> "${log}"\n${said === undefined ? "exit 0" : `echo "${said}" >&2\nexit 1`}`);
  return { dir, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

/** A copy of the kit at `version`: the runtime of a doctor or a server run that is not this checkout's own version. */
const kitAt = (version: string): string => copyKit(join(sandbox, `kit-${++counter}`), version);

/** A user's home whose `~/.cursor-workflows/kit` is `kit`: what an IDE launches when that kit is the installed one. */
function homeWithKit(kit: string): string {
  const userHome = join(sandbox, `home-${++counter}`);
  mkdirSync(join(userHome, ".cursor-workflows"), { recursive: true });
  symlinkSync(kit, join(userHome, ".cursor-workflows", "kit"));
  return userHome;
}

interface DoctorOptions {
  /** Directories ahead of the real node's on the PATH. Default: a `gh` that is logged in. */
  bins?: string[];
  env?: Record<string, string>;
  /** The user's home. Default: the one whose installed kit is `kit`. */
  home?: string;
  args?: string[];
  /** The kit whose `wf` runs. Default: this checkout. */
  kit?: string;
  /** The directory `wf` is started from (it is pointed at the repo with `--cwd`). Default: the test's own. */
  from?: string;
  /** Node options ahead of the script, e.g. `--import <file>` to run something before the CLI does. */
  nodeArgs?: string[];
}

/** Runs `wf doctor` against `repo`. */
function doctor(repo: string, { args = ["--json"], ...rest }: DoctorOptions = {}) {
  return wf(repo, ["doctor", ...args], rest);
}

/** Runs `wf <args>` of the kit at `kit` against `repo`. */
function wf(repo: string, args: string[], { bins = [ghLoggedIn], env: extra, kit = KIT_ROOT, home: userHome = kit === KIT_ROOT ? home : homeWithKit(kit), from, nodeArgs = [] }: Omit<DoctorOptions, "args"> = {}) {
  const r = spawnSync(process.execPath, [...nodeArgs, "--import", import.meta.resolve("tsx"), join(kit, "packages", "runtime", "src", "cli.ts"), ...args, "--cwd", repo], {
    env: env(bins, extra, userHome, kit),
    cwd: from,
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

interface Check {
  id: string;
  status: "pass" | "fail";
  message: string;
  hint?: string;
}
interface Report {
  ok: boolean;
  checks: Check[];
}
const reportOf = (r: { stdout: string }): Report => JSON.parse(r.stdout);
const checkOf = (report: Report, id: string): Check => {
  const check = report.checks.find((c) => c.id === id);
  assert.ok(check, `no check "${id}" in ${report.checks.map((c) => c.id).join()}`);
  return check;
};

test("on a healthy setup every check passes: exit 0, and --json lists the eight checks in a fixed order, none with a hint", () => {
  const r = doctor(repoCopy());
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = reportOf(r);
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.checks.map((c) => c.id),
    ["node", "dependencies", "login", "models", "forge", "mcp-server", "config", "kit-version"],
  );
  for (const c of report.checks) assert.ok(c.status === "pass" && c.hint === undefined, `${c.id}: ${c.message}`);
  assert.equal(r.stderr, "", "the doctor writes its report to stdout and nothing to stderr");
});

test("without --json the report is text, one block per check with the fix hint under each failure, and the exit code is the same", () => {
  const healthy = doctor(repoCopy(), { args: [] });
  assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr);
  assert.match(healthy.stdout, /\[ok\]\s+Node\.js: v\d+/);
  assert.match(healthy.stdout, /All good: 8 checks passed\./);

  // Logged out and no gh in a GitHub repository: login, models (no catalog without a login) and forge fail.
  const r = doctor(gitRepoCopy("https://github.com/acme/widgets.git"), { args: [], bins: [], env: { FAKE_SDK_LOGGED_OUT: "1" } });
  assert.equal(r.status, 1);
  assert.throws(() => JSON.parse(r.stdout), "text, not JSON");
  assert.match(r.stdout, /\[ok\]\s+Node\.js/);
  assert.match(r.stdout, /\[FAIL\]\s+Cursor SDK login: /);
  assert.match(r.stdout, /how to fix: Log in with `wf login`/);
  assert.match(r.stdout, /\[FAIL\]\s+Forge CLI: /);
  assert.match(r.stdout, /3 of 8 checks failed\./);
});

test("wf doctor --json reports an unusable repo config with its file and field path and a fix hint, and exits non-zero", () => {
  const repo = repoCopy();
  put(repoConfigPath(repo), { workflows: { "implement-issue": { roles: { reviwer: { retries: 0 } } } } });
  const r = doctor(repo);
  assert.equal(r.status, 1, r.stderr);

  const report = reportOf(r);
  assert.equal(report.ok, false);
  const config = checkOf(report, "config");
  assert.equal(config.status, "fail");
  assert.match(config.message, new RegExp(repoConfigPath(repo).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(config.message, /\/workflows\/implement-issue\/roles\/reviwer/);
  assert.ok(config.hint, "a failure comes with a fix hint");
});

test("the node check looks at the node on the PATH, which is what starts the MCP server: an old one fails with where it is and how to change it", () => {
  const repo = repoCopy();
  const current = checkOf(reportOf(doctor(repo)), "node");
  assert.equal(current.status, "pass", current.message);
  assert.ok(current.message.includes(process.version), current.message);

  // `node --version` says 22.11.0 and anything else runs the real node, so the rest of the run still works.
  const oldNode = fakeBin("node", `if [ "$1" = "--version" ]; then echo v22.11.0; exit 0; fi\nexec "${process.execPath}" "$@"`);
  const old = checkOf(reportOf(doctor(repo, { bins: [oldNode, ghLoggedIn] })), "node");
  assert.equal(old.status, "fail");
  assert.match(old.message, /22\.11\.0/);
  assert.ok(old.message.includes(join(oldNode, "node")), old.message);
  assert.match(old.message, /22\.13/);
  assert.match(old.hint ?? "", /node/);
});

test("the dependencies check looks for the command the IDE would run, and a missing one says which kit folder needs `npm ci`", () => {
  const repo = repoCopy();
  const installed = checkOf(reportOf(doctor(repo)), "dependencies");
  assert.equal(installed.status, "pass", installed.message);

  // A kit folder with no node_modules: what the MCP log would show only as ENOENT.
  const bare = join(sandbox, "home-without-dependencies");
  mkdirSync(join(bare, ".cursor-workflows", "kit"), { recursive: true });
  const missing = checkOf(reportOf(doctor(repo, { home: bare })), "dependencies");
  assert.equal(missing.status, "fail");
  const kit = join(bare, ".cursor-workflows", "kit");
  assert.ok(missing.message.includes(join(kit, "node_modules", ".bin", "tsx")), missing.message);
  assert.ok(missing.message.includes(".cursor/mcp.json"), missing.message);
  assert.match(missing.hint ?? "", /npm ci/);
  assert.ok(missing.hint?.includes(kit), missing.hint);
  assert.match(missing.hint ?? "", /INSTALL-AGENT\.md/, "a kit that is not installed is installed with the guide");
});

test("a repo with no MCP server entry for the kit fails the dependencies check and points at `wf init`", () => {
  const repo = repoCopy();
  rmSync(join(repo, ".cursor"), { recursive: true });
  rmSync(join(repo, ".mcp.json"));
  const missing = checkOf(reportOf(doctor(repo)), "dependencies");
  assert.equal(missing.status, "fail");
  assert.match(missing.message, /\.cursor\/mcp\.json/);
  assert.match(missing.hint ?? "", /wf init/);
});

test("the login check names the key it authenticated with, and a logged-out SDK fails with how to log in, without echoing the API key", () => {
  const repo = repoCopy();
  const loggedIn = checkOf(reportOf(doctor(repo)), "login");
  assert.equal(loggedIn.status, "pass", loggedIn.message);
  assert.match(loggedIn.message, /fake-key/);
  assert.doesNotMatch(loggedIn.message, /dev@example\.com/); // the account's email stays out of a report that may end up in a chat or an issue

  // The fake SDK fails like a rejected key does: with a message that carries the key it was given.
  const secret = "crsr_0123456789abcdef";
  const r = doctor(repo, { env: { FAKE_SDK_LOGGED_OUT: "1", CURSOR_API_KEY: secret } });
  const loggedOut = checkOf(reportOf(r), "login");
  assert.equal(loggedOut.status, "fail");
  assert.match(loggedOut.hint ?? "", /wf login/);
  assert.match(loggedOut.hint ?? "", /CURSOR_API_KEY/);
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), "the key must not appear in the report");
});

test("the models check compares every model the repo's config ends up using with the account's catalog, ids and aliases alike", () => {
  const repo = repoCopy();
  const ok = checkOf(reportOf(doctor(repo)), "models");
  assert.equal(ok.status, "pass", ok.message);

  // A catalog without the built-in workflow's defaults.
  const none = checkOf(reportOf(doctor(repo, { env: { FAKE_SDK_MODELS: "other-model" } })), "models");
  assert.equal(none.status, "fail");
  assert.match(none.message, /composer-2\.5/);
  assert.match(none.message, /implement-issue\.roles\.classify/);

  // A model the config asks for that the account does not have; the alias of a model that it does have is fine.
  put(repoConfigPath(repo), { workflows: { "implement-issue": { roles: { review: { model: { id: "grok-9000" } }, fix: { model: { id: "grok-4.7-alias" } } } } } });
  const typo = checkOf(reportOf(doctor(repo)), "models");
  assert.equal(typo.status, "fail");
  assert.match(typo.message, /grok-9000/);
  assert.match(typo.message, /implement-issue\.roles\.review/);
  assert.doesNotMatch(typo.message, /grok-4\.7-alias/);
  assert.match(typo.hint ?? "", /wf models/);

  const loggedOut = checkOf(reportOf(doctor(repo, { env: { FAKE_SDK_LOGGED_OUT: "1" } })), "models");
  assert.equal(loggedOut.status, "fail");
  assert.match(loggedOut.message, /not logged in/);
  assert.ok(loggedOut.hint);
});

test("the models check also covers a workflow's default model and the models of label globs", () => {
  const repo = repoCopy();
  put(join(repo, ".agents", "workflows", "modeled.mjs"), 'export default { meta: { name: "modeled", description: "a model by default" }, defaults: { model: { id: "only-in-defaults" } }, async run() { return "ok"; } };\n');
  put(repoConfigPath(repo), { workflows: { "implement-issue": { labels: { "design:*": { model: { id: "only-in-a-label" } } } } } });
  const models = checkOf(reportOf(doctor(repo)), "models");
  assert.equal(models.status, "fail");
  assert.match(models.message, /"only-in-defaults" \(modeled\.defaults\)/);
  assert.match(models.message, /"only-in-a-label" \(implement-issue\.labels\.design:\*\)/);
});

test("the models check does not guess when the config does not resolve", () => {
  const repo = repoCopy();
  put(repoConfigPath(repo), "{ not json");
  const models = checkOf(reportOf(doctor(repo)), "models");
  assert.equal(models.status, "fail");
  assert.match(models.message, /config/i);
  assert.ok(models.hint);
});

test("the forge check of a GitHub repository runs `gh auth status`: it passes for a logged-in gh, and fails with what gh said and `gh auth login` when it is logged out, or with where to get it when it is missing", () => {
  const repo = gitRepoCopy("git@github.com:acme/widgets.git");
  const gh = fakeForgeCli("gh");
  const ok = checkOf(reportOf(doctor(repo, { bins: [gh.dir] })), "forge");
  assert.equal(ok.status, "pass", ok.message);
  assert.deepEqual(gh.calls(), ["auth status"]);

  const loggedOutGh = fakeForgeCli("gh", "You are not logged into any GitHub hosts.");
  const loggedOut = checkOf(reportOf(doctor(repo, { bins: [loggedOutGh.dir] })), "forge");
  assert.equal(loggedOut.status, "fail");
  assert.match(loggedOut.message, /not logged into any GitHub hosts/);
  assert.match(loggedOut.hint ?? "", /gh auth login/);

  const missing = checkOf(reportOf(doctor(repo, { bins: [] })), "forge");
  assert.equal(missing.status, "fail");
  assert.match(missing.message, /`gh` is not on the PATH/);
  assert.match(missing.hint ?? "", /cli\.github\.com/);
  assert.match(missing.hint ?? "", /gh auth login/);
});

test("the forge check of a gitlab.com repository runs `glab auth status --hostname gitlab.com` and needs no gh: a logged-out glab fails with `glab auth login`, a missing one with where to get it", () => {
  const repo = gitRepoCopy("https://gitlab.com/acme/sub/widgets.git");
  const glab = fakeForgeCli("glab");
  const gh = fakeForgeCli("gh");
  const ok = checkOf(reportOf(doctor(repo, { bins: [glab.dir] })), "forge");
  assert.equal(ok.status, "pass", ok.message);
  assert.deepEqual(glab.calls(), ["auth status --hostname gitlab.com"]);
  assert.deepEqual(gh.calls(), [], "gh is never asked about a GitLab repository");

  const loggedOutGlab = fakeForgeCli("glab", "x gitlab.com: No token provided");
  const loggedOut = checkOf(reportOf(doctor(repo, { bins: [loggedOutGlab.dir, gh.dir] })), "forge");
  assert.equal(loggedOut.status, "fail");
  assert.match(loggedOut.message, /No token provided/);
  assert.match(loggedOut.hint ?? "", /glab auth login --hostname gitlab\.com/);

  const missing = checkOf(reportOf(doctor(repo, { bins: [gh.dir] })), "forge");
  assert.equal(missing.status, "fail");
  assert.match(missing.message, /`glab` is not on the PATH/);
  assert.match(missing.hint ?? "", /gitlab\.com\/gitlab-org\/cli/);
  assert.match(missing.hint ?? "", /glab auth login --hostname gitlab\.com/);
});

test("a host the global config or the repo config declares as GitLab is checked with glab for that host, as the origin spells it", () => {
  // Declared once in the user's global config: every repository on the host.
  const glab = fakeForgeCli("glab");
  const global = homeWithConfig({ forges: { "git.example.com": "gitlab" } });
  const scp = checkOf(reportOf(doctor(gitRepoCopy("git@git.example.com:group/sub/project.git"), { bins: [glab.dir], home: global })), "forge");
  assert.equal(scp.status, "pass", scp.message);

  // Declared in the repository's own config; an https remote's port is the web port, an ssh remote's is not.
  const repo = gitRepoCopy("https://git.example.com:8443/group/project.git");
  put(repoConfigPath(repo), { forges: { "git.example.com": "gitlab" } });
  assert.equal(checkOf(reportOf(doctor(repo, { bins: [glab.dir] })), "forge").status, "pass");
  const ssh = gitRepoCopy("ssh://git@git.example.com:2222/group/project.git");
  put(repoConfigPath(ssh), { forges: { "git.example.com": "gitlab" } });
  assert.equal(checkOf(reportOf(doctor(ssh, { bins: [glab.dir] })), "forge").status, "pass");

  assert.deepEqual(glab.calls(), ["auth status --hostname git.example.com", "auth status --hostname git.example.com:8443", "auth status --hostname git.example.com"]);
});

test("a declared GitHub host is checked with gh, and a missing glab does not matter there", () => {
  const repo = gitRepoCopy("git@ghe.example.com:acme/widgets.git");
  put(repoConfigPath(repo), { forges: { "ghe.example.com": "github" } });
  const gh = fakeForgeCli("gh");
  const forge = checkOf(reportOf(doctor(repo, { bins: [gh.dir] })), "forge");
  assert.equal(forge.status, "pass", forge.message);
  assert.deepEqual(gh.calls(), ["auth status"]);
});

test("an origin on a host nobody declared fails the forge check naming the host and the `forges` key, and a hint to declare it", () => {
  const forge = checkOf(reportOf(doctor(gitRepoCopy("https://code.example.org/acme/widgets.git"), { bins: [] })), "forge");
  assert.equal(forge.status, "fail");
  assert.match(forge.message, /code\.example\.org/);
  assert.match(forge.message, /"forges"/);
  assert.match(forge.hint ?? "", /forges/);
});

test("outside a git repository, or in one with no origin, the forge check passes and says why; an origin that names no host is GitHub, as in a run", () => {
  const outside = checkOf(reportOf(doctor(repoCopy(), { bins: [] })), "forge");
  assert.equal(outside.status, "pass", outside.message);
  assert.match(outside.message, /not inside a git repository/);

  const noOrigin = checkOf(reportOf(doctor(gitRepoCopy(), { bins: [] })), "forge");
  assert.equal(noOrigin.status, "pass", noOrigin.message);
  assert.match(noOrigin.message, /no `origin` remote/);

  const gh = fakeForgeCli("gh");
  const local = checkOf(reportOf(doctor(gitRepoCopy("/srv/git/widgets.git"), { bins: [gh.dir] })), "forge");
  assert.equal(local.status, "pass", local.message);
  assert.deepEqual(gh.calls(), ["auth status"]);
});

test("a config that does not resolve fails the forge check only when the origin's host is one it could declare", () => {
  const broken = (origin: string) => {
    const repo = gitRepoCopy(origin);
    put(repoConfigPath(repo), "{ not json");
    return checkOf(reportOf(doctor(repo, { bins: [fakeForgeCli("gh").dir, fakeForgeCli("glab").dir] })), "forge");
  };
  assert.equal(broken("https://github.com/acme/widgets.git").status, "pass");
  assert.equal(broken("https://gitlab.com/acme/widgets.git").status, "pass");
  const unknown = broken("https://git.example.com/acme/widgets.git");
  assert.equal(unknown.status, "fail");
  assert.match(unknown.message, /git\.example\.com/);
  assert.match(unknown.message, /configuration/);
});

test("without git on the PATH the forge check fails and says where to get it, since it cannot read the origin", () => {
  const forge = checkOf(reportOf(doctor(gitRepoCopy("https://github.com/acme/widgets.git"), { env: { PATH: NODE_DIR } })), "forge");
  assert.equal(forge.status, "fail");
  assert.match(forge.message, /`git` is not on the PATH/);
  assert.match(forge.hint ?? "", /git/);
});

/** Replaces the command of the `workflows` entry in a repo's `.mcp.json`, leaving the rest of the repo as `wf init` wrote it. */
function breakClaudeCodeServer(repo: string, sh: string): void {
  put(join(repo, ".mcp.json"), { mcpServers: { workflows: { command: "/bin/sh", args: ["-c", sh] } } });
}

test("the mcp-server check starts the server the way the IDE does, in both configs, and sees its tools", () => {
  const repo = repoCopy();
  const server = checkOf(reportOf(doctor(repo)), "mcp-server");
  assert.equal(server.status, "pass", server.message);
  for (const file of [".cursor/mcp.json", ".mcp.json"]) assert.ok(server.message.includes(file), server.message);
  assert.match(server.message, /start_workflow/);
  assert.match(server.message, /cancel_workflow/);
});

test("a server that dies at launch fails the mcp-server check with what it printed and the command to run by hand", () => {
  const repo = repoCopy();
  breakClaudeCodeServer(repo, 'echo "boom: cannot start" >&2; exit 3');
  const server = checkOf(reportOf(doctor(repo)), "mcp-server");
  assert.equal(server.status, "fail");
  assert.match(server.message, /\.mcp\.json/);
  assert.match(server.message, /boom: cannot start/);
  assert.doesNotMatch(server.message, /\.cursor\/mcp\.json/); // the Cursor entry is fine and is not blamed
  assert.ok(server.hint?.includes("/bin/sh"), server.hint);
});

test("a server that never answers tools/list fails the mcp-server check at the timeout instead of hanging the doctor", () => {
  const repo = repoCopy();
  breakClaudeCodeServer(repo, "while read line; do :; done"); // reads every request and answers none (shell builtins only)
  const server = checkOf(reportOf(doctor(repo, { env: { WF_DOCTOR_TIMEOUT_MS: "1500" } })), "mcp-server");
  assert.equal(server.status, "fail");
  assert.match(server.message, /did not answer within 1\.5s/);
});

/** A repo copy whose config declares `range` as the kit it accepts. */
function repoAccepting(range: unknown): string {
  const repo = repoCopy();
  put(repoConfigPath(repo), { kit: range });
  return repo;
}

test("the kit-version check passes inside the declared range, in any semver spelling, and when the repo declares none", () => {
  const kit = kitAt("1.4.0");
  for (const range of [">=1.0.0 <2.0.0", "^1.2.0", "1.x", "~1.4.0", ">=0.2.0 <0.3.0 || >=1.0.0 <2.0.0"]) {
    const check = checkOf(reportOf(doctor(repoAccepting(range), { kit })), "kit-version");
    assert.equal(check.status, "pass", `${range}: ${check.message}`);
    assert.ok(check.message.includes("1.4.0") && check.message.includes(range), check.message);
  }
  const noRange = repoCopy();
  put(repoConfigPath(noRange), {}); // `wf init` writes a range; a repo that never did declares none
  const undeclared = checkOf(reportOf(doctor(noRange, { kit })), "kit-version");
  assert.equal(undeclared.status, "pass", undeclared.message);
  assert.match(undeclared.message, /declares no range/);
});

test("a kit older than the repo's range fails, says so, and tells how to get a kit inside the range", () => {
  const r = doctor(repoAccepting(">=1.5.0 <2.0.0"), { kit: kitAt("1.4.0") });
  assert.equal(r.status, 1);
  const check = checkOf(reportOf(r), "kit-version");
  assert.equal(check.status, "fail");
  assert.match(check.message, /1\.4\.0/);
  assert.match(check.message, />=1\.5\.0 <2\.0\.0/);
  assert.match(check.message, /older than the range/);
  assert.match(check.message, /\.agents\/workflows\/config\.json/);
  assert.match(check.hint ?? "", /Update the kit/);
  assert.match(check.hint ?? "", /`wf upgrade`/, "the command that moves the kit to a newer release exists now");
});

test("a kit newer than the repo's range fails too, and the hint is about the repo's range", () => {
  const check = checkOf(reportOf(doctor(repoAccepting(">=0.2.0 <0.3.0"), { kit: kitAt("1.4.0") })), "kit-version");
  assert.equal(check.status, "fail");
  assert.match(check.message, /newer than the range/);
  assert.match(check.hint ?? "", /update "kit" in \.agents\/workflows\/config\.json/);
});

test("a kit range that is not semver fails with an example of one", () => {
  for (const range of ["banana", ">=x.y"]) {
    const check = checkOf(reportOf(doctor(repoAccepting(range), { kit: kitAt("1.4.0") })), "kit-version");
    assert.equal(check.status, "fail", range);
    assert.match(check.message, /is not a valid semver range/);
    assert.ok(check.message.includes(range), check.message);
    assert.match(check.hint ?? "", />=1\.0\.0 <2\.0\.0/);
  }
});

const QUICK_WORKFLOW = 'export default { meta: { name: "quick", description: "finishes at once" }, async run() { return "ok"; } };\n';

/** Runs `fn` against the MCP server of `kit` started in `repo`, the way the IDE starts it. */
async function withServer<T>(kit: string, repo: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "doctor-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: join(kit, "node_modules", ".bin", "tsx"), args: [join(kit, "packages", "runtime", "src", "mcp-server.ts")], cwd: repo, env: env([ghLoggedIn], {}, home, kit) }),
  );
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
const textOf = (result: unknown): string => ((result as { content: Array<{ text: string }> }).content[0]!.text);

test("start_workflow refuses a kit outside the repo's range with the versions and the range, and starts no job; inside the range it starts", async () => {
  const kit = kitAt("1.4.0");
  const outside = repoAccepting(">=1.5.0 <2.0.0");
  put(join(outside, ".agents", "workflows", "quick.mjs"), QUICK_WORKFLOW);
  await withServer(kit, outside, async (client) => {
    const refused = await client.callTool({ name: "start_workflow", arguments: { name: "quick" } });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /1\.4\.0/);
    assert.match(textOf(refused), />=1\.5\.0 <2\.0\.0/);
    assert.match(textOf(refused), /older than the range/);
  });
  assert.ok(!existsSync(join(outside, ".workflows", "jobs")), "a refused start leaves no job behind");

  const inside = repoAccepting(">=1.0.0 <2.0.0");
  put(join(inside, ".agents", "workflows", "quick.mjs"), QUICK_WORKFLOW);
  await withServer(kit, inside, async (client) => {
    const started = await client.callTool({ name: "start_workflow", arguments: { name: "quick" } });
    assert.notEqual(started.isError, true, textOf(started));
    const { jobId } = JSON.parse(textOf(started));
    const done = JSON.parse(textOf(await client.callTool({ name: "wait_workflow", arguments: { jobId, timeoutSec: 20 } })));
    assert.equal(done.status, "finished", JSON.stringify(done));
  });
});

test("the CLI's run and start refuse the same way, with exit 1 and no job; the commands that only read still work", () => {
  const kit = kitAt("1.4.0");
  const repo = repoAccepting(">=1.5.0 <2.0.0");
  put(join(repo, ".agents", "workflows", "quick.mjs"), QUICK_WORKFLOW);
  for (const command of ["run", "start"]) {
    const r = wf(repo, [command, "quick"], { kit });
    assert.equal(r.status, 1, `${command}: ${r.stdout}`);
    assert.match(r.stderr, /1\.4\.0/, command);
    assert.match(r.stderr, />=1\.5\.0 <2\.0\.0/, command);
  }
  assert.ok(!existsSync(join(repo, ".workflows", "jobs")));
  assert.equal(wf(repo, ["list"], { kit }).status, 0);
  assert.equal(wf(repo, ["config", "show"], { kit }).status, 0);
});

// ── Findings of the review ─────────────────────────────────────────────────────────────────────────────────────────────

test("relative paths in the MCP entry are the repo's, wherever `wf doctor --cwd` is started from", () => {
  const repo = repoCopy();
  rmSync(join(repo, ".cursor"), { recursive: true });
  symlinkSync(KIT_ROOT, join(repo, "kit"));
  // Like the dogfood `.mcp.json`: the IDE runs these in the repo, so they mean files of the repo.
  put(join(repo, ".mcp.json"), { mcpServers: { workflows: { command: "kit/node_modules/.bin/tsx", args: ["kit/packages/runtime/src/mcp-server.ts"] } } });
  const report = reportOf(doctor(repo, { from: sandbox }));
  const deps = checkOf(report, "dependencies");
  assert.equal(deps.status, "pass", deps.message);
  const server = checkOf(report, "mcp-server");
  assert.equal(server.status, "pass", server.message);
});

test("a check that throws is a failed check naming the workflow, not a crashed doctor: the others still report", () => {
  // A workflow whose roles are not a list: resolving its config throws a TypeError, which is not a ConfigError.
  const repo = repoCopy();
  put(join(repo, ".agents", "workflows", "bad-roles.mjs"), 'export default { meta: { name: "bad-roles", description: "malformed", roles: "oops" }, async run() { return "ok"; } };\n');
  const r = doctor(repo);
  assert.equal(r.status, 1, r.stderr);
  const report = reportOf(r);
  assert.equal(report.checks.length, 8);
  const config = checkOf(report, "config");
  assert.equal(config.status, "fail");
  assert.match(config.message, /bad-roles/);
  assert.equal(checkOf(report, "node").status, "pass");
  assert.equal(checkOf(report, "forge").status, "pass");
});

test("what a failing server printed is redacted like everything else in the report", () => {
  const repo = repoCopy();
  const secret = "crsr_fedcba9876543210";
  breakClaudeCodeServer(repo, 'echo "the key is $CURSOR_API_KEY" >&2; exit 3');
  const r = doctor(repo, { env: { CURSOR_API_KEY: secret } });
  const server = checkOf(reportOf(r), "mcp-server");
  assert.equal(server.status, "fail");
  assert.match(server.message, /the key is \[REDACTED\]/);
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), "the key must not appear in the report");
});

/** Gives the `workflows` entry of one of the repo's MCP configs the environment `entryEnv`, as a user fixing the IDE's PATH would. */
function setEntryEnv(repo: string, file: string, entryEnv: Record<string, string>): void {
  const config = JSON.parse(readFileSync(join(repo, file), "utf8"));
  config.mcpServers.workflows.env = { ...config.mcpServers.workflows.env, ...entryEnv };
  put(join(repo, file), config);
}

test("the node check uses the PATH the mcp.json entry gives the server, which is how the IDE resolves node", () => {
  const oldNode = fakeBin("node", `if [ "$1" = "--version" ]; then echo v22.11.0; exit 0; fi\nexec "${process.execPath}" "$@"`);

  // The shell finds an old node first, but the entry puts a good one on the server's PATH: the fix a user applies.
  const fixed = repoCopy();
  rmSync(join(fixed, ".mcp.json"));
  setEntryEnv(fixed, ".cursor/mcp.json", { PATH: NODE_DIR });
  const ok = checkOf(reportOf(doctor(fixed, { bins: [oldNode, ghLoggedIn] })), "node");
  assert.equal(ok.status, "pass", ok.message);
  assert.ok(ok.message.includes(".cursor/mcp.json") && ok.message.includes(process.version), ok.message);

  // The other way round: the shell is fine, the entry's PATH is where the old node is.
  const worse = repoCopy();
  rmSync(join(worse, ".mcp.json"));
  setEntryEnv(worse, ".cursor/mcp.json", { PATH: `${oldNode}:${NODE_DIR}` });
  const old = checkOf(reportOf(doctor(worse)), "node");
  assert.equal(old.status, "fail");
  assert.ok(old.message.includes(".cursor/mcp.json") && old.message.includes("22.11.0"), old.message);
});

test("an old node running `wf doctor` itself still gets the report, as a node failure with its hint; other commands keep the plain message", () => {
  const preload = join(sandbox, "old-node.mjs");
  writeFileSync(preload, 'Object.defineProperty(process.versions, "node", { value: "22.11.0" });\n'); // the version node-check reads
  const nodeArgs = ["--import", preload];

  const json = doctor(repoCopy(), { nodeArgs });
  assert.equal(json.status, 1, json.stderr);
  const report = reportOf(json);
  assert.equal(report.ok, false);
  const node = checkOf(report, "node");
  assert.equal(node.status, "fail");
  assert.match(node.message, /22\.11\.0/);
  assert.match(node.hint ?? "", /22\.13/);

  const text = doctor(repoCopy(), { nodeArgs, args: [] });
  assert.equal(text.status, 1);
  assert.match(text.stdout, /\[FAIL\]\s+Node\.js: /);

  const list = wf(repoCopy(), ["list"], { nodeArgs });
  assert.equal(list.status, 1);
  assert.equal(list.stdout, "");
  assert.match(list.stderr, /is too old/);
});

test("the kit-version check also tests the kit the IDE would start, which is not always the one running wf", () => {
  const running = kitAt("1.4.0");
  const installed = kitAt("2.0.0");
  const diverging = checkOf(reportOf(doctor(repoAccepting(">=1.0.0 <2.0.0"), { kit: running, home: homeWithKit(installed) })), "kit-version");
  assert.equal(diverging.status, "fail");
  assert.ok(diverging.message.includes(".cursor/mcp.json") && diverging.message.includes("2.0.0"), diverging.message);
  assert.match(diverging.message, /newer than the range/);

  // The same kit on both sides: one verdict that names both.
  const same = checkOf(reportOf(doctor(repoAccepting(">=1.0.0 <2.0.0"), { kit: running })), "kit-version");
  assert.equal(same.status, "pass", same.message);
  assert.ok(same.message.includes("wf") && same.message.includes(".cursor/mcp.json") && same.message.includes("1.4.0"), same.message);
});
