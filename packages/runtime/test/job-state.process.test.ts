// Seam 2, the process: `wf start|wait|status|jobs` and the MCP tools `get_workflow_status` / `wait_workflow` return the job
// state projected from the run's event log, and the job record on disk holds identity only. The CLI and the MCP server are
// real child processes against the fake Cursor SDK, a temporary repo and a temporary home directory.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const PACKAGE = join(import.meta.dirname, "..");
let sandbox: string;
let repo: string;
let env: Record<string, string>;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-job-process-"));
  repo = join(sandbox, "repo");
  mkdirSync(join(repo, ".agents", "workflows"), { recursive: true });
  writeFileSync(
    join(repo, ".agents", "workflows", "proc.mjs"),
    `export default {
  meta: { name: "proc", description: "process-seam fixture" },
  defaults: { model: { id: "m" } },
  async run(ctx) {
    ctx.phase("work");
    ctx.log("working");
    await ctx.agent("PROMPT-MARKER do it", { label: "do" });
    return { status: "done", answer: 42 };
  },
};\n`,
  );
  env = {
    ...(process.env as Record<string, string>),
    TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"),
    WF_HOME: join(sandbox, "home"),
    WF_METRICS: "off",
    WF_CWD: repo,
  };
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

/** Runs `wf <args>` in the temporary repo and returns its stdout parsed as JSON. */
function wf(...args: string[]): Record<string, unknown> | Array<Record<string, unknown>> {
  const out = execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", "cli.ts"), ...args, "--cwd", repo], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out);
}

const jobRecord = (jobId: string) => JSON.parse(readFileSync(join(repo, ".workflows", "jobs", `${jobId}.json`), "utf8")) as Record<string, unknown>;

/** The job state, whichever door it comes through, as the doors promise it. */
function assertFinishedState(state: Record<string, unknown>, jobId: string, via: string) {
  assert.equal(state.jobId, jobId, via);
  assert.equal(state.status, "finished", via);
  assert.equal(state.workflow, "proc", via);
  assert.equal(state.phase, "work", via);
  assert.deepEqual(state.result, { status: "done", answer: 42 }, via);
  assert.deepEqual(state.recent, ["== work", "working", "▶ do [m]", "✓ do 9¢ cache-read 60"], via);
  assert.equal(state.spentCents, 9, via);
  assert.equal(state.spentTokens, 110, via);
  assert.doesNotMatch(JSON.stringify(state), /PROMPT-MARKER/, `${via}: no prompt text`);
}

test("wf start, wait, status and jobs return the state projected from the event log; the record holds identity only", () => {
  const started = wf("start", "proc") as { jobId: string; runId: string };
  assert.match(started.jobId, /^[0-9a-f]{8}$/);

  const waited = wf("wait", started.jobId, "--timeout", "60") as Record<string, unknown>;
  assertFinishedState(waited, started.jobId, "wf wait");
  assertFinishedState(wf("status", started.jobId) as Record<string, unknown>, started.jobId, "wf status");

  const listed = wf("jobs") as Array<Record<string, unknown>>;
  assert.deepEqual(listed, [{ jobId: started.jobId, workflow: "proc", status: "finished", phase: "work", runId: started.runId }]);

  assert.deepEqual(Object.keys(jobRecord(started.jobId)).sort(), ["heartbeat", "jobId", "pid", "runId"]);
  assert.deepEqual(readdirSync(join(repo, ".workflows", "jobs")).filter((f) => f.endsWith(".json")), [`${started.jobId}.json`]);
});

test("the MCP tools get_workflow_status and wait_workflow return the same projection, for jobs started by either door", async () => {
  const client = new Client({ name: "job-process-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", "mcp-server.ts")],
    cwd: repo,
    env: { ...getDefaultEnvironment(), ...env },
  });
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
  try {
    await client.connect(transport);

    const started = await call("start_workflow", { name: "proc" });
    const waited = await call("wait_workflow", { jobId: started.jobId, timeoutSec: 50 });
    assertFinishedState(waited, String(started.jobId), "wait_workflow");
    assertFinishedState(await call("get_workflow_status", { jobId: started.jobId }), String(started.jobId), "get_workflow_status");
    assert.deepEqual(Object.keys(jobRecord(String(started.jobId))).sort(), ["heartbeat", "jobId", "pid", "runId"]);

    const fromCli = wf("start", "proc") as { jobId: string };
    wf("wait", fromCli.jobId, "--timeout", "60");
    assertFinishedState(await call("get_workflow_status", { jobId: fromCli.jobId }), fromCli.jobId, "get_workflow_status of a job started by the CLI");

    assert.deepEqual(await call("get_workflow_status", { jobId: "nope" }), { error: "job não encontrado" });
  } finally {
    await client.close();
  }
});
