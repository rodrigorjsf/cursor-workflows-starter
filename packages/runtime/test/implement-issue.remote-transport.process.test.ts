// Seam: the network `git` commands of implement-issue (`push`, the delete push, `ls-remote` of one branch and of the workflow's
// branches) and `wf gc`, which runs them. Real git, real processes, a temporary repository. A remote whose URL uses a plain-text transport
// (http://, git://) or a remote helper (`ext::<command>`, which runs the command) is refused by git itself before it opens a connection or
// starts a helper: the commands set GIT_ALLOW_PROTOCOL to `file:https:ssh`, which overrides a user's `protocol.<name>.allow`. A push goes to
// the push URL (`pushurl`, `pushInsteadOf`) and `ls-remote` to the fetch URL, and git applies the allowance to the one it uses, so each
// command is tried against a remote whose OTHER URL is the unsafe one. What a connection would show is a listening socket that counts them.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { BringBackError, bringBack, deleteSnapshot } from "../src/runtime/cloud-snapshot.js";
import { type Commands, CommandError } from "../workflows/implement-issue/commands.js";
import { directCommands } from "../workflows/implement-issue/gc.js";
import { waitFor } from "./wait-for.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

let root = "";
let repo = "";
let bare = "";
let server: Server;
let connections = 0;
let port = 0;
let commands: Commands;
const savedEnv: Record<string, string | undefined> = {};

/** Sets variables of this process for one test: every `git` the commands start inherits them. */
function setEnv(vars: Record<string, string>) {
  for (const [name, value] of Object.entries(vars)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "wf-transport-"));
  repo = join(root, "repo");
  bare = join(root, "origin.git");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-qm", "a");
  git(root, "init", "-q", "--bare", bare);
  git(repo, "remote", "add", "origin", bare);
  git(repo, "branch", "wf/issue-1-x");
  // A user whose git config lets a remote helper run: the kit must refuse it all the same.
  setEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.ext.allow", GIT_CONFIG_VALUE_0: "always", GIT_TERMINAL_PROMPT: "0" });
  connections = 0;
  server = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as { port: number }).port;
  commands = directCommands(20);
});
afterEach(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});

/** Lets the server's pending accepts run: a connection git opened is counted before the test reads the count. */
const settled = async () => {
  await new Promise((done) => setImmediate(done));
  await new Promise((done) => setImmediate(done));
};

const httpUrl = () => `http://127.0.0.1:${port}/x.git`;
const gitUrl = () => `git://127.0.0.1:${port}/x.git`;

/** Every network command of the workflow, against the remote `origin` as it is configured now: what each did, as an error or as nothing. */
async function networkCommands(): Promise<Record<string, Error | undefined>> {
  const tried = async (run: () => Promise<unknown>) => run().then(() => undefined, (err: Error) => err);
  return {
    push: await tried(() => commands.push(repo, "origin", "wf/issue-1-x")),
    pushOwned: await tried(() => commands.pushOwned(repo, "wf/issue-1-x", undefined)),
    deleteOwned: await tried(() => commands.deleteOwned(repo, "wf/issue-1-x", "0".repeat(40))),
    remoteBranchHead: await tried(() => commands.remoteBranchHead(repo, "wf/issue-1-x")),
    remoteOwnedHeads: await tried(() => commands.remoteOwnedHeads(repo)),
  };
}

function assertAllRefused(results: Record<string, Error | undefined>, transport: string) {
  for (const [command, err] of Object.entries(results)) {
    assert.ok(err instanceof CommandError, `${command} was not refused: ${err}`);
    assert.match(err.message, new RegExp(`refused: the ${transport} transport`), `${command}: ${err.message}`);
  }
}

test("a remote over http:// is refused by every network command, and no connection is opened", async () => {
  git(repo, "remote", "set-url", "origin", httpUrl());
  assertAllRefused(await networkCommands(), "http");
  await settled();
  assert.equal(connections, 0, "git connected to the plain-text remote");
});

test("a remote over git:// is refused by every network command, and no connection is opened", async () => {
  git(repo, "remote", "set-url", "origin", gitUrl());
  assertAllRefused(await networkCommands(), "git");
  await settled();
  assert.equal(connections, 0, "git connected to the git:// remote");
});

test("a remote helper (`ext::`) is refused by every network command and runs nothing, even where the user's git config allows it", async () => {
  const marker = join(root, "helper-ran");
  git(repo, "remote", "set-url", "origin", `ext::touch ${marker}`);
  assertAllRefused(await networkCommands(), "ext");
  assert.equal(existsSync(marker), false, "the helper command ran");
});

test("the push goes by the push URL and ls-remote by the fetch URL: an unsafe one in either place refuses only the commands that use it", async () => {
  git(repo, "remote", "set-url", "--push", "origin", httpUrl()); // fetch URL: the bare repository, push URL: http
  const pushUnsafe = await networkCommands();
  assertAllRefused({ push: pushUnsafe.push, pushOwned: pushUnsafe.pushOwned, deleteOwned: pushUnsafe.deleteOwned }, "http");
  assert.equal(pushUnsafe.remoteBranchHead, undefined, "ls-remote reads the fetch URL, which is safe");
  assert.equal(pushUnsafe.remoteOwnedHeads, undefined);

  git(repo, "config", "--unset-all", "remote.origin.pushurl");
  git(repo, "remote", "set-url", "origin", httpUrl()); // fetch URL: http, push URL: the same
  git(repo, "remote", "set-url", "--push", "origin", bare); // push URL: the bare repository
  const fetchUnsafe = await networkCommands();
  assertAllRefused({ remoteBranchHead: fetchUnsafe.remoteBranchHead, remoteOwnedHeads: fetchUnsafe.remoteOwnedHeads }, "http");
  assert.equal(fetchUnsafe.push, undefined, "the push goes to the bare repository");
  await settled();
  assert.equal(connections, 0);
});

test("a url.<base>.pushInsteadOf that moves the push to http is refused: git applies the allowance to the URL it ends up using", async () => {
  git(repo, "config", `url.${httpUrl()}.pushInsteadOf`, bare);
  const results = await networkCommands();
  assertAllRefused({ push: results.push, pushOwned: results.pushOwned }, "http");
  await settled();
  assert.equal(connections, 0);
});

test("a local path, https and ssh stay allowed: https opens a connection, ssh starts the ssh command, a local remote works end to end", async () => {
  // A local remote: the whole cycle the workflow runs.
  await commands.pushOwned(repo, "wf/issue-1-x", undefined);
  assert.match(git(bare, "branch", "--list", "wf/*"), /wf\/issue-1-x/);
  assert.equal((await commands.remoteBranchHead(repo, "wf/issue-1-x"))?.length, 40);
  assert.deepEqual([...(await commands.remoteOwnedHeads(repo)).keys()], ["wf/issue-1-x"]);
  const sha = git(repo, "rev-parse", "wf/issue-1-x").trim();
  await commands.deleteOwned(repo, "wf/issue-1-x", sha);
  assert.equal(git(bare, "branch", "--list", "wf/*").trim(), "");

  // https: refused by nothing of ours; the socket that stands for the server sees the connection and drops it.
  git(repo, "remote", "set-url", "origin", `https://127.0.0.1:${port}/x.git`);
  const https = await commands.remoteBranchHead(repo, "wf/issue-1-x").then(() => undefined, (err: Error) => err);
  assert.ok(https instanceof CommandError, "the dropped connection is an error");
  assert.doesNotMatch(https.message, /not allowed/);
  await waitFor("git to connect over https", () => connections > 0);

  // ssh: git starts the command GIT_SSH_COMMAND names, which here only leaves a mark.
  const mark = join(root, "ssh-ran");
  const fakeSsh = join(root, "fake-ssh");
  writeFileSync(fakeSsh, `#!/bin/sh\necho "$@" > "${mark}"\nexit 255\n`);
  chmodSync(fakeSsh, 0o755);
  setEnv({ GIT_SSH_COMMAND: fakeSsh });
  git(repo, "remote", "set-url", "origin", "git@example.com:o/r.git");
  const ssh = await commands.remoteBranchHead(repo, "wf/issue-1-x").then(() => undefined, (err: Error) => err);
  assert.ok(ssh instanceof CommandError);
  assert.doesNotMatch(ssh.message, /not allowed/);
  assert.match(readFileSync(mark, "utf8"), /example\.com/, "git did not start ssh");
});

test("wf gc over a repository whose origin is http:// lists nothing and removes nothing: it says why on stderr, exits 1, and opens no connection", async () => {
  git(repo, "remote", "set-url", "origin", httpUrl());
  const env: NodeJS.ProcessEnv = { ...process.env, TSX_TSCONFIG_PATH: join(import.meta.dirname, "..", "tsconfig.test.json"), WF_METRICS: "off", WF_HOME: join(root, "home") };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(import.meta.dirname, "..", "src", "cli.ts"), "gc", "--cwd", repo], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
  const status = await new Promise<number | null>((done) => child.on("close", done));
  assert.equal(status, 1, stderr);
  const plan = JSON.parse(stdout) as { errors: string[]; remove: unknown[] };
  assert.ok(plan.errors.some((e) => /origin's branches cannot be listed/.test(e) && /refused: the http transport/.test(e)), plan.errors.join("\n"));
  assert.deepEqual(plan.remove, []);
  await settled();
  assert.equal(connections, 0);
});

// The cloud snapshot code checks the push URL before its first push, but it also fetches the agent's branch back (the fetch URL, which that
// check never looks at) and deletes the snapshot (a push again): the same allowance holds for both.
test("the cloud snapshot's fetch and delete refuse a plain-text transport and a remote helper, whichever URL the check before the first push did not look at", async () => {
  const marker = join(root, "helper-ran");
  git(repo, "remote", "set-url", "origin", `ext::touch ${marker}`);
  const head = git(repo, "rev-parse", "HEAD").trim();
  await assert.rejects(bringBack({ cwd: repo, remote: "origin", branch: "wf/cloud-snapshot/x/abcd1234", base: head }), (err: Error) => err instanceof BringBackError && /could not fetch/.test(err.message) && /ext/.test(err.message));
  assert.equal(existsSync(marker), false, "the fetch ran the helper");

  git(repo, "remote", "set-url", "origin", httpUrl());
  await assert.rejects(deleteSnapshot({ top: repo, remote: "origin", branch: "wf/cloud-snapshot/x/abcd1234" }), /transport 'http' not allowed/);
  await assert.rejects(bringBack({ cwd: repo, remote: "origin", branch: "wf/cloud-snapshot/x/abcd1234", base: head }), /transport 'http' not allowed/);
  await settled();
  assert.equal(connections, 0);
});
