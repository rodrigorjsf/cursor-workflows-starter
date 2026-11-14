// Seam: the wait of `wait_workflow` (and `waitJob` under it). The seconds the chat asks for become a bounded wait, 1 to 50 s,
// 45 when absent; a value that is not a number is refused instead of turning into a wait with no end. Asserts on the
// seconds `waitSeconds` gives, on how long `waitJob` takes for a job that is still running, and on what the MCP server
// answers.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { waitJob, waitSeconds, writeJob } from "../src/runtime/job-state.js";

const PACKAGE = join(import.meta.dirname, "..");
const repo = join(import.meta.dirname, ".tmp", `wait-timeout-${process.pid}`);
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("the seconds of a wait are 45 when absent and always between 1 and 50", () => {
  assert.equal(waitSeconds(undefined), 45);
  assert.equal(waitSeconds(30), 30);
  assert.equal(waitSeconds(0), 1);
  assert.equal(waitSeconds(-5), 1);
  assert.equal(waitSeconds(999), 50);
});

test("null is an absent wait, and a numeric string is its number, as before the check", () => {
  assert.equal(waitSeconds(null), 45);
  assert.equal(waitSeconds("30"), 30);
  assert.equal(waitSeconds(" 12.5 "), 12.5);
  assert.equal(waitSeconds("999"), 50);
});

test("seconds that are not a number are refused", () => {
  for (const raw of ["30s", "", "  ", Number.NaN, Number.POSITIVE_INFINITY, "Infinity", true, {}]) {
    assert.throws(() => waitSeconds(raw), /^Error: timeoutSec must be a number of seconds/, String(raw));
  }
});

test("a wait for a running job that is given no usable time returns at once instead of waiting forever", { timeout: 30_000 }, async () => {
  mkdirSync(repo, { recursive: true });
  writeJob(repo, { jobId: "running1", runId: "proc-12345678", pid: process.pid, heartbeat: new Date().toISOString() }); // this process: alive and beating
  // The job beats forever (it is this process): only the test's timeout tells "at once" from "forever", so no tighter bound.
  const state = await waitJob(repo, "running1", Number.NaN);
  assert.equal(state?.status, "running");
});

test("wait_workflow with a timeoutSec that is not a number is an error that names it", { timeout: 20_000 }, async () => {
  mkdirSync(repo, { recursive: true });
  const env = { ...(getDefaultEnvironment() as Record<string, string>), TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"), WF_HOME: process.env.WF_HOME!, WF_METRICS: "off", WF_DASH_AUTOSTART: "off", WF_CWD: repo };
  const client = new Client({ name: "wait-timeout-test", version: "0.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", "mcp-server.ts")], cwd: repo, env }));
    const reply = (await client.callTool({ name: "wait_workflow", arguments: { jobId: "abcd1234", timeoutSec: "30s" } })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(reply.isError, true, reply.content[0]!.text);
    assert.match(JSON.parse(reply.content[0]!.text).error, /^timeoutSec must be a number of seconds/);
  } finally {
    await client.close();
  }
});
