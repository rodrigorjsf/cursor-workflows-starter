// Seam: the MCP server as the chat reaches it. `start_workflow` makes sure the dashboard is running and returns its link
// (`dashboardUrl`) next to the job; the dashboard then lists the run it was just given. The MCP server and the dashboard
// are real child processes against the fake Cursor SDK, a temporary repo and a temporary home.
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dashboardListens, freePort } from "./dashboard-fixtures.js";

const PACKAGE = join(import.meta.dirname, "..");
let sandbox: string;
let repo: string;
let home: string;
let port: number;

beforeEach(async () => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-start-dash-"));
  repo = join(sandbox, "repo");
  home = join(sandbox, "home");
  mkdirSync(join(repo, ".agents", "workflows"), { recursive: true });
  writeFileSync(
    join(repo, ".agents", "workflows", "quick.mjs"),
    'export default { meta: { name: "quick", description: "finishes at once" }, async run(ctx) { ctx.phase("work"); return "ok"; } };\n',
  );
  port = await freePort();
});
afterEach(async () => {
  try {
    const pid = JSON.parse(readFileSync(join(home, "dashboard.pid"), "utf8")).pid as number;
    process.kill(pid, "SIGKILL");
  } catch {
    /* no dashboard was started */
  }
  rmSync(sandbox, { recursive: true, force: true });
});

/** Runs `use` against an MCP server started the way Cursor starts it, with `extra` added to its environment. */
async function withServer<T>(extra: Record<string, string>, use: (call: (name: string, args: Record<string, unknown>) => Promise<any>) => Promise<T>): Promise<T> {
  const client = new Client({ name: "dashboard-test", version: "0.0.0" });
  const env = {
    ...(getDefaultEnvironment() as Record<string, string>),
    TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"),
    WF_HOME: home,
    WF_METRICS: "off",
    WF_CWD: repo,
    WF_DASH_PORT: String(port),
    WF_DASH_START_TIMEOUT_MS: "30000", // a start may be slow while the whole suite runs
    ...extra,
  };
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", "mcp-server.ts")], cwd: repo, env }));
    return await use(async (name, args) => JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text));
  } finally {
    await client.close();
  }
}

test("start_workflow starts the dashboard once and returns its link; the dashboard lists the run that was just started", async () => {
  await withServer({}, async (call) => {
    const first = await call("start_workflow", { name: "quick", args: {} });
    assert.equal(first.dashboardUrl, `http://127.0.0.1:${port}`, JSON.stringify(first));
    assert.match(first.jobId, /^[0-9a-f]{8}$/);

    const second = await call("start_workflow", { name: "quick", args: {} });
    assert.equal(second.dashboardUrl, first.dashboardUrl);
    assert.equal(dashboardListens(home), 1, "the second start found the dashboard running");

    const wait = async (jobId: string) => {
      let state = await call("wait_workflow", { jobId, timeoutSec: 5 });
      for (const stop = Date.now() + 30_000; state.status === "running" && Date.now() < stop; ) state = await call("wait_workflow", { jobId, timeoutSec: 5 });
      return state;
    };
    assert.equal((await wait(first.jobId)).status, "finished");

    const listed = (await (await fetch(`${first.dashboardUrl}/api/runs`)).json()) as { runs: Array<{ runId: string; repo: string; workflow: string; status: string; phase?: string }> };
    const run = listed.runs.find((r) => r.runId === first.runId);
    assert.ok(run, JSON.stringify(listed));
    assert.deepEqual([run.repo, run.workflow, run.status, run.phase], [repo, "quick", "finished", "work"]);
    const detail = (await (await fetch(`${first.dashboardUrl}/api/runs/${first.runId}`)).json()) as { result: unknown };
    assert.equal(detail.result, "ok");
  });
});

test("with auto-start off, start_workflow still starts the job and returns no link", async () => {
  await withServer({ WF_DASH_AUTOSTART: "off" }, async (call) => {
    const started = await call("start_workflow", { name: "quick", args: {} });
    assert.match(started.jobId, /^[0-9a-f]{8}$/);
    assert.equal("dashboardUrl" in started, false, JSON.stringify(started));
    assert.equal("dashboardWarning" in started, false);
    assert.equal(existsSync(join(home, "dashboard.pid")), false);
    assert.equal(await fetch(`http://127.0.0.1:${port}/api/health`).then(() => true, () => false), false, "nothing listens");
  });
});

test("a dashboard that cannot start never stops the job: the reason comes back as dashboardWarning", async () => {
  const squatter = createHttpServer((_req, res) => res.end("not a dashboard"));
  await new Promise<void>((ok) => squatter.listen(port, "127.0.0.1", ok));
  try {
    await withServer({}, async (call) => {
      const started = await call("start_workflow", { name: "quick", args: {} });
      assert.match(started.jobId, /^[0-9a-f]{8}$/, JSON.stringify(started));
      assert.equal("dashboardUrl" in started, false);
      assert.match(started.dashboardWarning, /port \d+ is in use by another program/);
    });
  } finally {
    squatter.close();
  }
});

test("the dashboard setting in a repo config is reported in the violations and has no effect", async () => {
  mkdirSync(join(repo, ".agents", "workflows"), { recursive: true });
  writeFileSync(join(repo, ".agents", "workflows", "config.json"), JSON.stringify({ dashboard: { autoStart: false } }));
  await withServer({}, async (call) => {
    const started = await call("start_workflow", { name: "quick", args: {} });
    assert.deepEqual(started.violations.map((v: { path: string }) => v.path), ["/dashboard"], JSON.stringify(started));
    assert.equal(started.dashboardUrl, `http://127.0.0.1:${port}`, "a repo file cannot switch the dashboard off");
  });
});
