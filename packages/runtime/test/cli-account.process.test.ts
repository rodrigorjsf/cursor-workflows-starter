// Seam: the account commands of the `wf` command line (`login`, `models`), as a real child process on the fake SDK. `login`
// says who is logged in and when the key expires and never prints the key; `models` lists the account's catalog with the
// aliases and the parameters of each model. Asserts on the exit code and the JSON on stdout.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { FAKE_LOGIN_API_KEY } from "./fake-sdk.js";

const PACKAGE = join(import.meta.dirname, "..");
let sandbox: string;
let repo: string;
let env: Record<string, string>;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-cli-account-"));
  repo = join(sandbox, "repo");
  mkdirSync(repo);
  env = {
    ...(process.env as Record<string, string>),
    TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"),
    WF_HOME: join(sandbox, "home"),
    WF_METRICS: "off",
    WF_DASH_AUTOSTART: "off", // the tests must not leave a dashboard behind
  };
  delete env.WF_INSIDE_WORKFLOW;
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

function wf(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", "cli.ts"), ...args, "--cwd", repo], { env: { ...env, ...extraEnv }, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("wf login says who logged in and when the key expires, and prints neither the key nor anything else", () => {
  const r = wf(["login"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { loggedIn: true, email: "dev@example.com", expiresAt: "2026-12-31T00:00:00.000Z" });
  assert.ok(!r.stdout.includes(FAKE_LOGIN_API_KEY) && !r.stderr.includes(FAKE_LOGIN_API_KEY), "the API key must not reach the output");
});

test("wf models lists the account's models with their aliases and the parameters a model takes", () => {
  const r = wf(["models"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [
    { id: "composer-2.5", displayName: "composer-2.5", aliases: ["composer-2.5-alias"] },
    { id: "grok-4.7", displayName: "grok-4.7", aliases: ["grok-4.7-alias"], params: ["reasoning_effort=low|high"] },
  ]);
});

test("wf models lists the models the catalog is steered to, none of them with parameters", () => {
  const r = wf(["models"], { FAKE_SDK_MODELS: "alpha,beta" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [
    { id: "alpha", displayName: "alpha", aliases: ["alpha-alias"] },
    { id: "beta", displayName: "beta", aliases: ["beta-alias"] },
  ]);
});
