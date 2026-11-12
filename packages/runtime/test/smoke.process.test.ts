// Seam 2, the process: the `smoke` workflow through the `wf` CLI and through the MCP server, the way the chat reaches it
// (list_workflows, start_workflow, wait_workflow). Both are real child processes against the fake Cursor SDK, a
// temporary repo and a temporary home. `FAKE_SDK_AUTO_SUBMIT=1` makes the fake agent answer a structured step with an
// object that satisfies the step's schema, which is what a model does when it follows the prompt.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  sandbox = mkdtempSync(join(tmpdir(), "wf-smoke-"));
  repo = join(sandbox, "repo");
  mkdirSync(repo);
  env = {
    ...(getDefaultEnvironment() as Record<string, string>),
    TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"),
    WF_HOME: join(sandbox, "home"),
    WF_METRICS: "off",
    WF_DASH_AUTOSTART: "off", // the tests must not leave a dashboard behind
    WF_CWD: repo,
    FAKE_SDK_AUTO_SUBMIT: "1",
  };
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

const tsx = (script: string) => ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", script)];

function wf(...args: string[]) {
  const r = spawnSync(process.execPath, [...tsx("cli.ts"), ...args, "--cwd", repo], { env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function withServer<T>(use: (call: (name: string, args: Record<string, unknown>) => Promise<any>) => Promise<T>): Promise<T> {
  const client = new Client({ name: "smoke-test", version: "0.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: tsx("mcp-server.ts"), cwd: repo, env }));
    return await use(async (name, args) => JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text));
  } finally {
    await client.close();
  }
}

test("wf list shows smoke next to the other built-in workflows", () => {
  const listed = JSON.parse(wf("list").stdout) as Array<{ name: string }>;
  assert.ok(listed.some((w) => w.name === "smoke"), JSON.stringify(listed));
});

test("wf run smoke finishes with the structured answer and exit code 0", () => {
  const r = wf("run", "smoke", "--args", "{}");
  assert.equal(r.status, 0, r.stderr);
  const outcome = JSON.parse(r.stdout);
  assert.equal(outcome.status, "finished", r.stdout);
  assert.equal(outcome.result.status, "ok");
  assert.equal(outcome.result.answer, "pong");
});

test("from the chat's side: list_workflows offers smoke, start_workflow runs it detached, wait_workflow reports a finished job with its result", async () => {
  await withServer(async (call) => {
    const listed = (await call("list_workflows", {})) as Array<{ name: string; whenToUse?: string; roles?: Array<{ name: string; cloud: string }> }>;
    const smoke = listed.find((w) => w.name === "smoke");
    assert.ok(smoke, JSON.stringify(listed.map((w) => w.name)));
    assert.ok(smoke.whenToUse, "the chat agent needs to know when to pick it");
    assert.deepEqual(smoke.roles?.map((r) => `${r.name}:${r.cloud}`), ["ping:ok"]);

    const started = await call("start_workflow", { name: "smoke", args: {} });
    assert.match(started.jobId, /^[0-9a-f]{8}$/, JSON.stringify(started));
    let state = await call("wait_workflow", { jobId: started.jobId, timeoutSec: 5 });
    for (const stop = Date.now() + 40_000; state.status === "running" && Date.now() < stop; ) state = await call("wait_workflow", { jobId: started.jobId, timeoutSec: 5 });

    assert.equal(state.status, "finished", JSON.stringify(state));
    assert.equal(state.result.answer, "pong");
    assert.ok(state.spentTokens > 0 && state.spentTokens <= 50_000, `a smoke job is cheap: ${state.spentTokens} tokens`);
  });
});
