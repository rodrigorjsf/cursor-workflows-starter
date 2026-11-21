// Seam: the process. `wf start` and the MCP server's `start_workflow` are real child processes against the fake Cursor SDK, a
// temporary repository and a temporary home with a global config; the jobs they start are real detached processes running a
// workflow whose only step hangs (`[fake:hang]`). A start the repository's caps do not allow is refused before a job record or a
// process exists: at most `caps.maxRunningJobs` jobs run at once, and a job that runs the same workflow with the same args is
// never started a second time.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { blockedUserDir, withUserDir } from "./isolate-home.js";

const PACKAGE = join(import.meta.dirname, "..");
let sandbox: string;
let repo: string;
let env: Record<string, string>;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-job-cap-"));
  repo = join(sandbox, "repo");
  mkdirSync(join(repo, ".agents", "workflows"), { recursive: true });
  mkdirSync(join(sandbox, "home"));
  writeFileSync(
    join(repo, ".agents", "workflows", "hold.mjs"),
    `export default {\n  meta: { name: "hold", description: "one step that hangs until the job is cancelled" },\n  defaults: { model: { id: "m" } },\n  async run(ctx) { return ctx.agent("[fake:hang] hold", { label: "hold", retries: 0, timeoutMs: 120000 }); },\n};\n`,
  );
  env = {
    ...(getDefaultEnvironment() as Record<string, string>),
    TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"),
    WF_HOME: join(sandbox, "home"),
    WF_METRICS: "off",
    WF_DASH_AUTOSTART: "off", // the tests must not leave a dashboard behind
    WF_CWD: repo,
  };
});
afterEach(() => {
  for (const jobId of jobIds()) wf("cancel", jobId, "--timeout", "20");
  // a cancelled job can still be flushing its last files when cancel returns: retry ENOTEMPTY instead of failing the hook
  rmSync(join(repo, ".workflows"), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(join(sandbox, "home", "config.json"), { force: true });
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

const tsx = (script: string) => ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", script)];
const jobIds = (): string[] => {
  try {
    return readdirSync(join(repo, ".workflows", "jobs")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  } catch {
    return []; // nothing was ever started here
  }
};
/** Waits until the job's step is running: from then on its process handles a cancel the way a running job's does. */
async function stepRunning(started: { out: Record<string, any> }): Promise<void> {
  for (const stop = performance.now() + 30_000; performance.now() < stop; await new Promise((r) => setTimeout(r, 50))) {
    if (readEventLog(eventLogPath(repo, started.out.runId)).events.some((e) => e.type === "step-start")) return;
  }
  throw new Error("timed out waiting for the job's step to start");
}
const globalCaps = (caps: Record<string, unknown>) => writeFileSync(join(sandbox, "home", "config.json"), JSON.stringify({ caps }));

/** Runs `wf <args>` in the temporary repo: its exit code, its stderr and its stdout parsed as JSON (when it has any). */
function wf(...args: string[]) {
  const r = spawnSync(process.execPath, [...tsx("cli.ts"), ...args, "--cwd", repo], { env, encoding: "utf8" });
  return { status: r.status, stderr: r.stderr, out: r.stdout.trim() ? (JSON.parse(r.stdout) as Record<string, any>) : {} };
}
const start = (args: unknown) => wf("start", "hold", "--args", JSON.stringify(args));

/** Starts an MCP server, hands `use` a way to call its tools (reply and `isError`), and closes it afterwards. */
async function withServer<T>(use: (call: (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; body: Record<string, any> }>) => Promise<T>): Promise<T> {
  const client = new Client({ name: "job-cap-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: tsx("mcp-server.ts"), cwd: repo, env }));
  try {
    return await use(async (name, args) => {
      const reply = await client.callTool({ name, arguments: args });
      return { isError: reply.isError === true, body: JSON.parse((reply.content as Array<{ text: string }>)[0]!.text) as Record<string, any> };
    });
  } finally {
    await client.close();
  }
}

test("wf start refuses a job past caps.maxRunningJobs, names the cap, and starts no process and writes no job record", () => {
  globalCaps({ maxRunningJobs: 1 });
  const first = start({ n: 1 });
  assert.equal(first.status, 0, first.stderr);

  const second = start({ n: 2 });
  assert.equal(second.status, 1, "the second start fails");
  assert.match(second.stderr, /1 job is already running in this repository \(caps\.maxRunningJobs is 1\)/);
  assert.deepEqual(jobIds(), [first.out.jobId], "no job record for the refused start");
});

test("a job that has ended no longer counts toward the cap", async () => {
  globalCaps({ maxRunningJobs: 1 });
  const first = start({ n: 1 });
  await stepRunning(first);
  assert.equal(wf("cancel", first.out.jobId, "--timeout", "20").out.status, "cancelled");

  const second = start({ n: 2 });
  assert.equal(second.status, 0, second.stderr);
});

test("wf start refuses a job that runs the same workflow with the same args, however the keys are ordered, and allows other args", () => {
  globalCaps({ maxRunningJobs: 3 });
  const first = start({ a: 1, b: { c: 2, d: 3 } });
  assert.equal(first.status, 0, first.stderr);

  const same = start({ b: { d: 3, c: 2 }, a: 1 });
  assert.equal(same.status, 1);
  assert.match(same.stderr, new RegExp(`job ${first.out.jobId} already runs workflow hold with the same args`));
  assert.deepEqual(jobIds(), [first.out.jobId]);

  assert.equal(start({ a: 1 }).status, 0, "other args are another job");
});

test("without the key the cap is 3, and a null lifts it", () => {
  for (const n of [1, 2, 3]) assert.equal(start({ n }).status, 0, `job ${n}`);
  const fourth = start({ n: 4 });
  assert.equal(fourth.status, 1);
  assert.match(fourth.stderr, /3 jobs are already running in this repository \(caps\.maxRunningJobs is 3\)/);

  globalCaps({ maxRunningJobs: null });
  assert.equal(start({ n: 4 }).status, 0, "no cap");
});

test("start_workflow answers isError for a job past the cap or one that is already running, and starts no process", async () => {
  globalCaps({ maxRunningJobs: 1 });
  await withServer(async (call) => {
    const first = await call("start_workflow", { name: "hold", args: { n: 1 } });
    assert.equal(first.isError, false, JSON.stringify(first.body));

    const over = await call("start_workflow", { name: "hold", args: { n: 2 } });
    assert.equal(over.isError, true);
    assert.match(over.body.error, /1 job is already running in this repository \(caps\.maxRunningJobs is 1\)/);

    globalCaps({ maxRunningJobs: 3 });
    const same = await call("start_workflow", { name: "hold", args: { n: 1 } });
    assert.equal(same.isError, true);
    assert.match(same.body.error, new RegExp(`job ${first.body.jobId} already runs workflow hold with the same args`));
  });
  assert.equal(jobIds().length, 1, "neither refused call left a job record");
});

test("the cap is the global file's: a caps key in the repository's config does not raise it", () => {
  globalCaps({ maxRunningJobs: 1 });
  writeFileSync(join(repo, ".agents", "workflows", "config.json"), JSON.stringify({ caps: { maxRunningJobs: 9 } }));
  try {
    assert.equal(start({ n: 1 }).status, 0);
    assert.equal(start({ n: 2 }).status, 1);
  } finally {
    rmSync(join(repo, ".agents", "workflows", "config.json"));
  }
});

test("the jobs of another repository do not count", () => {
  globalCaps({ maxRunningJobs: 1 });
  assert.equal(start({ n: 1 }).status, 0);
  const other = join(sandbox, "other");
  mkdirSync(join(other, ".agents", "workflows"), { recursive: true });
  writeFileSync(join(other, ".agents", "workflows", "hold.mjs"), readFileSync(join(repo, ".agents", "workflows", "hold.mjs")));
  const r = spawnSync(process.execPath, [...tsx("cli.ts"), "start", "hold", "--args", "{}", "--cwd", other], { env, encoding: "utf8" });
  try {
    assert.equal(r.status, 0, r.stderr);
  } finally {
    spawnSync(process.execPath, [...tsx("cli.ts"), "cancel", JSON.parse(r.stdout).jobId, "--timeout", "20", "--cwd", other], { env });
  }
});

const SANDBOX_REFUSAL = /cannot write to the user directory .*agent sandbox/;


test("wf start with a user directory that cannot be created exits 1 and names the agent sandbox, before any run directory exists", async () => {
  const refused = await withUserDir(env, blockedUserDir(sandbox), () => start({ n: 1 }));
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(refused.out.jobId, undefined);
  assert.match(refused.stderr, SANDBOX_REFUSAL);
  assert.equal(existsSync(join(repo, ".workflows")), false, "no run directory, no job record");
});

test("wf start with a read-only user directory exits 1 and names the agent sandbox, before any run directory exists", { skip: process.getuid?.() === 0 }, async () => {
  const readOnly = join(sandbox, "read-only-home");
  mkdirSync(readOnly);
  chmodSync(readOnly, 0o500);
  try {
    const refused = await withUserDir(env, readOnly, () => start({ n: 1 }));
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, SANDBOX_REFUSAL);
    assert.equal(existsSync(join(repo, ".workflows")), false);
  } finally {
    chmodSync(readOnly, 0o700);
  }
});

test("start_workflow with an unwritable user directory answers isError that names the agent sandbox, and creates no job record", async () => {
  await withUserDir(env, blockedUserDir(sandbox), () =>
    withServer(async (call) => {
      const refused = await call("start_workflow", { name: "hold", args: { n: 1 } });
      assert.equal(refused.isError, true, JSON.stringify(refused.body));
      assert.match(refused.body.error, SANDBOX_REFUSAL);
    }),
  );
  assert.equal(existsSync(join(repo, ".workflows")), false);
});

test("a writable user directory is left with no probe file behind after a start", () => {
  const started = start({ n: 1 });
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(readdirSync(join(sandbox, "home")).filter((f) => f.startsWith(".write-probe")), []);
});
