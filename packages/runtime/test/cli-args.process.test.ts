// Seam: the `wf` command line, as a real child process. A flag the CLI does not know, or a flag value it cannot use, is a
// usage error: one English line on stderr, nothing on stdout, exit 2, and nothing done. `wf run --job` (the child mode of
// `wf start`) is refused inside a workflow step like `run` and `start` are. Asserts on the exit code, the output and the
// files left behind.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createJob } from "../src/runtime/jobs.js";

const PACKAGE = join(import.meta.dirname, "..");
let sandbox: string;
let repo: string;
let env: Record<string, string>;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-cli-args-"));
  repo = join(sandbox, "repo");
  mkdirSync(repo);
  env = {
    ...(process.env as Record<string, string>),
    TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"),
    WF_HOME: join(sandbox, "home"),
    WF_METRICS: "off",
    WF_DASH_AUTOSTART: "off", // the tests must not leave a dashboard behind
    FAKE_SDK_AUTO_SUBMIT: "1",
  };
  delete env.WF_INSIDE_WORKFLOW;
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

function wf(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", "cli.ts"), ...args, "--cwd", repo], { env: { ...env, ...extraEnv }, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A usage error: exit 2, stdout empty, and stderr one line that matches `message`. */
function assertUsageError(r: ReturnType<typeof wf>, message: RegExp) {
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, "");
  const lines = r.stderr.trimEnd().split("\n");
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0]!, message);
}

test("an unknown flag is one usage line on stderr and exit 2, not a stack trace", () => {
  assertUsageError(wf(["status", "abcd1234", "--bogus"]), /Unknown option '--bogus'/);
});

test("a flag that needs a value and gets none is a usage error", () => {
  assertUsageError(wf(["wait", "abcd1234", "--timeout"]), /--timeout/);
});

test("--days that is not a number of days is a usage error that names the flag", () => {
  assertUsageError(wf(["stats", "--days", "abc"]), /^--days must be a number of days, more than 0; got "abc"$/);
  assertUsageError(wf(["stats", "--days", "0"]), /^--days must be a number of days, more than 0; got "0"$/);
});

test("--format other than csv or json is a usage error, and nothing is exported", () => {
  const out = join(sandbox, "export");
  assertUsageError(wf(["metrics", "export", "--format", "xml", "--out", out]), /^--format must be csv or json; got "xml"$/);
  assert.equal(existsSync(out), false);
});

test("the numeric flags that were already checked are usage errors too", () => {
  assertUsageError(wf(["wait", "abcd1234", "--timeout", "soon"]), /^--timeout must be a number of seconds/);
  assertUsageError(wf(["run", "smoke", "--max-cents", "lots"]), /^--max-cents must be a number/);
});

test("--args or --overrides that is not JSON is a usage error that names the flag, and no job or run is created", () => {
  assertUsageError(wf(["run", "smoke", "--args", "{"]), /^--args must be JSON: /);
  assertUsageError(wf(["start", "smoke", "--args", "{"]), /^--args must be JSON: /);
  assertUsageError(wf(["start", "smoke", "--overrides", "{"]), /^--overrides must be JSON: /);
  assert.equal(existsSync(join(repo, ".workflows", "jobs")), false);
  assert.equal(existsSync(join(repo, ".workflows", "runs")), false);
});

test("wf run --job is refused inside a workflow step, like run and start", () => {
  const job = createJob(repo, "smoke");
  const r = wf(["run", "smoke", "--job", job.jobId], { WF_INSIDE_WORKFLOW: "1" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /workflows cannot be started from inside a workflow step/);
  assert.equal(existsSync(join(repo, ".workflows", "runs", job.runId)), false);
});
