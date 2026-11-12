// Seam 2, the process: `wf doctor` is spawned (against the fake Cursor SDK) in a temporary repo with a temporary home, as
// the IDE's environment would be: the kit sits at ~/.cursor-workflows/kit, the repo has the MCP configs `wf init` writes,
// and `gh` and `node` are whatever the PATH of the process says. The tests read the report, the exit code and the
// messages; they never import the doctor.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
/** Where the real `node` that runs these tests lives: the PATH of a doctor run holds this and the fakes, nothing else. */
const NODE_DIR = dirname(process.execPath);

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-doctor-"));
  home = join(sandbox, "home");
  mkdirSync(join(home, ".cursor-workflows"), { recursive: true });
  symlinkSync(KIT_ROOT, join(home, ".cursor-workflows", "kit"));
  ghLoggedIn = fakeBin("gh", "exit 0");

  initialisedRepo = join(sandbox, "initialised");
  mkdirSync(initialisedRepo);
  const init = wf(initialisedRepo, ["init"], { bins: [] });
  assert.equal(init.status, 0, init.stderr);
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

/** The environment of a doctor run: only the given directories (then the real node's) on the PATH, so no `gh` of the machine leaks in. */
function env(bins: string[], extra: Record<string, string> = {}, userHome = home, kit = KIT_ROOT): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    PATH: [...bins, NODE_DIR].join(":"),
    HOME: userHome,
    WF_HOME: join(userHome, ".cursor-workflows"),
    TSX_TSCONFIG_PATH: join(kit, "packages", "runtime", "tsconfig.test.json"),
    WF_METRICS: "off",
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

/** A copy of the kit at `version`: the runtime of a doctor or a server run that is not this checkout's own version. */
const kitAt = (version: string): string => copyKit(join(sandbox, `kit-${++counter}`), version);

interface DoctorOptions {
  /** Directories ahead of the real node's on the PATH. Default: a `gh` that is logged in. */
  bins?: string[];
  env?: Record<string, string>;
  home?: string;
  args?: string[];
  /** The kit whose `wf` runs. Default: this checkout. */
  kit?: string;
}

/** Runs `wf doctor` against `repo`. */
function doctor(repo: string, { bins = [ghLoggedIn], env: extra, home: userHome, args = ["--json"], kit = KIT_ROOT }: DoctorOptions = {}) {
  return wf(repo, ["doctor", ...args], { bins, env: extra, home: userHome, kit });
}

/** Runs `wf <args>` of the kit at `kit` against `repo`. */
function wf(repo: string, args: string[], { bins = [ghLoggedIn], env: extra, home: userHome, kit = KIT_ROOT }: Omit<DoctorOptions, "args"> = {}) {
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(kit, "packages", "runtime", "src", "cli.ts"), ...args, "--cwd", repo], {
    env: env(bins, extra, userHome, kit),
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
    ["node", "dependencies", "login", "models", "gh", "mcp-server", "config", "kit-version"],
  );
  for (const c of report.checks) assert.ok(c.status === "pass" && c.hint === undefined, `${c.id}: ${c.message}`);
  assert.equal(r.stderr, "", "the doctor writes its report to stdout and nothing to stderr");
});

test("without --json the report is text, one block per check with the fix hint under each failure, and the exit code is the same", () => {
  const healthy = doctor(repoCopy(), { args: [] });
  assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr);
  assert.match(healthy.stdout, /\[ok\]\s+Node\.js: v\d+/);
  assert.match(healthy.stdout, /Tudo certo: 8 verificações passaram\./);

  // Logged out and no gh: login, models (no catalog without a login) and gh fail.
  const r = doctor(repoCopy(), { args: [], bins: [], env: { FAKE_SDK_LOGGED_OUT: "1" } });
  assert.equal(r.status, 1);
  assert.throws(() => JSON.parse(r.stdout), "text, not JSON");
  assert.match(r.stdout, /\[ok\]\s+Node\.js/);
  assert.match(r.stdout, /\[FALHA\] Login no Cursor SDK: /);
  assert.match(r.stdout, /como corrigir: Faça login com `wf login`/);
  assert.match(r.stdout, /\[FALHA\] GitHub CLI \(gh\): /);
  assert.match(r.stdout, /3 de 8 verificações falharam\./);
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
  put(repoConfigPath(repo), { workflows: { "implement-issue": { labels: { "desenhar:*": { model: { id: "only-in-a-label" } } } } } });
  const models = checkOf(reportOf(doctor(repo)), "models");
  assert.equal(models.status, "fail");
  assert.match(models.message, /"only-in-defaults" \(modeled\.defaults\)/);
  assert.match(models.message, /"only-in-a-label" \(implement-issue\.labels\.desenhar:\*\)/);
});

test("the models check does not guess when the config does not resolve", () => {
  const repo = repoCopy();
  put(repoConfigPath(repo), "{ not json");
  const models = checkOf(reportOf(doctor(repo)), "models");
  assert.equal(models.status, "fail");
  assert.match(models.message, /configuração/i);
  assert.ok(models.hint);
});

test("the gh check passes for a logged-in gh, and fails with what gh said and `gh auth login` when it is logged out, or with where to get it when it is missing", () => {
  const repo = repoCopy();
  const ok = checkOf(reportOf(doctor(repo)), "gh");
  assert.equal(ok.status, "pass", ok.message);

  const loggedOutGh = fakeBin("gh", 'echo "You are not logged into any GitHub hosts." >&2\nexit 1');
  const loggedOut = checkOf(reportOf(doctor(repo, { bins: [loggedOutGh] })), "gh");
  assert.equal(loggedOut.status, "fail");
  assert.match(loggedOut.message, /not logged into any GitHub hosts/);
  assert.match(loggedOut.hint ?? "", /gh auth login/);

  const missing = checkOf(reportOf(doctor(repo, { bins: [] })), "gh");
  assert.equal(missing.status, "fail");
  assert.match(missing.message, /PATH/);
  assert.match(missing.hint ?? "", /cli\.github\.com/);
  assert.match(missing.hint ?? "", /gh auth login/);
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
  assert.match(server.message, /não respondeu em 1\.5s/);
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
  assert.match(undeclared.message, /não declara/);
});

test("a kit older than the repo's range fails, says so, and tells how to get a kit inside the range", () => {
  const r = doctor(repoAccepting(">=1.5.0 <2.0.0"), { kit: kitAt("1.4.0") });
  assert.equal(r.status, 1);
  const check = checkOf(reportOf(r), "kit-version");
  assert.equal(check.status, "fail");
  assert.match(check.message, /1\.4\.0/);
  assert.match(check.message, />=1\.5\.0 <2\.0\.0/);
  assert.match(check.message, /mais antigo/);
  assert.match(check.message, /\.agents\/workflows\/config\.json/);
  assert.match(check.hint ?? "", /Atualize o kit/);
});

test("a kit newer than the repo's range fails too, and the hint is about the repo's range", () => {
  const check = checkOf(reportOf(doctor(repoAccepting(">=0.2.0 <0.3.0"), { kit: kitAt("1.4.0") })), "kit-version");
  assert.equal(check.status, "fail");
  assert.match(check.message, /mais novo/);
  assert.match(check.hint ?? "", /atualize "kit" em \.agents\/workflows\/config\.json/);
});

test("a kit range that is not semver fails with an example of one", () => {
  for (const range of ["banana", ">=x.y"]) {
    const check = checkOf(reportOf(doctor(repoAccepting(range), { kit: kitAt("1.4.0") })), "kit-version");
    assert.equal(check.status, "fail", range);
    assert.match(check.message, /não é uma faixa semver/);
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
    assert.match(textOf(refused), /mais antigo/);
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
