// Seam: the points where an id from outside (a job id, a run id to resume) becomes a path under `.workflows/`. A job id or
// run id that is not a plain name (letters, digits, "_" and "-") is refused there, so no entry point (CLI, MCP, the engine)
// reads or creates anything outside the repo's state folder. Asserts on the readers' answers, on what the CLI prints, and on
// the files left outside.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { newRunId } from "../src/runtime/engine.js";
import { createJob } from "../src/runtime/jobs.js";
import { cancelJob, listJobs, readJob, readJobRecord, waitJob } from "../src/runtime/job-state.js";
import { RunStore } from "../src/runtime/run-store.js";
import { isPlainName } from "../src/runtime/state.js";

const PACKAGE = join(import.meta.dirname, "..");
const sandbox = join(import.meta.dirname, ".tmp", `plain-ids-${process.pid}`);
const repo = join(sandbox, "repo");
const outside = join(sandbox, "outside");
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

/** A job record planted outside `.workflows/jobs`, reachable from there through `../../../outside/planted`. */
function plantOutside(): string {
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(repo, ".workflows", "jobs"), { recursive: true });
  const record = { jobId: "planted", runId: "proc-12345678", pid: process.pid, heartbeat: new Date().toISOString() };
  writeFileSync(join(outside, "planted.json"), JSON.stringify(record));
  return "../../../outside/planted";
}

test("a job id that is not a plain name is no job: the readers never open the record it points at outside the jobs folder", async () => {
  const id = plantOutside();
  assert.equal(readJobRecord(repo, id), undefined);
  assert.equal(readJob(repo, id), undefined);
  assert.equal(await waitJob(repo, id, 0), undefined);
  assert.equal(await cancelJob(repo, id, 0), undefined);
});

test("wf status with a job id that walks out of the jobs folder answers job not found", () => {
  const id = plantOutside();
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", "cli.ts"), "status", id, "--cwd", repo], {
    env: { ...process.env, TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"), WF_DASH_AUTOSTART: "off" },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(r.stdout), { error: "job not found" }, r.stderr);
});

test("a job record whose run id is not a plain name is not a record the runtime wrote: listing and reading skip it", () => {
  mkdirSync(join(outside, "run"), { recursive: true });
  writeFileSync(join(outside, "run", "events.jsonl"), "");
  mkdirSync(join(repo, ".workflows", "jobs"), { recursive: true });
  writeFileSync(join(repo, ".workflows", "jobs", "abcd1234.json"), JSON.stringify({ jobId: "abcd1234", runId: "../../../outside/run", pid: 1, heartbeat: new Date().toISOString() }));
  assert.equal(readJob(repo, "abcd1234"), undefined);
  assert.deepEqual(listJobs(repo), []);
});

test("a job is not created for a run id to resume that is not a plain name", () => {
  assert.throws(() => createJob(repo, "proc", { runId: "../../outside/run" }), /invalid runId "\.\.\/\.\.\/outside\/run"/);
  const jobs = join(repo, ".workflows", "jobs");
  assert.deepEqual(existsSync(jobs) ? readdirSync(jobs) : [], []);
});

test("the run's state is not opened, nor its folder made, for a run id that is not a plain name", () => {
  const dir = join(repo, ".workflows", "runs", "../../../outside/run");
  assert.throws(() => RunStore.open(dir, "../../../outside/run"), /invalid runId/);
  assert.equal(existsSync(join(outside, "run")), false);
});

test("wf run --resume with a run id that walks out of the runs folder is refused and creates nothing outside", () => {
  mkdirSync(repo, { recursive: true });
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", "cli.ts"), "run", "smoke", "--resume", "../../../outside/run", "--cwd", repo], {
    env: { ...process.env, TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"), WF_DASH_AUTOSTART: "off", FAKE_SDK_AUTO_SUBMIT: "1" },
    encoding: "utf8",
  });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /invalid runId/);
  assert.equal(existsSync(join(outside, "run")), false);
});

test("start_workflow with a resumeRunId that walks out of the runs folder is an error, and no job is created", async () => {
  mkdirSync(repo, { recursive: true });
  const env = { ...(getDefaultEnvironment() as Record<string, string>), TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"), WF_HOME: process.env.WF_HOME!, WF_METRICS: "off", WF_DASH_AUTOSTART: "off", WF_CWD: repo };
  const client = new Client({ name: "plain-ids-test", version: "0.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", "mcp-server.ts")], cwd: repo, env }));
    const reply = (await client.callTool({ name: "start_workflow", arguments: { name: "smoke", resumeRunId: "../../../outside/run" } })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(reply.isError, true, reply.content[0]!.text);
    assert.match(JSON.parse(reply.content[0]!.text).error, /^invalid runId/);
  } finally {
    await client.close();
  }
  const jobs = join(repo, ".workflows", "jobs");
  assert.deepEqual(existsSync(jobs) ? readdirSync(jobs) : [], []);
});

test("a new run id is a plain name whatever the workflow is called", () => {
  for (const name of ["team.deploy", "my flow", "a/b", "implement-issue"]) assert.ok(isPlainName(newRunId(name)), newRunId(name));
});
