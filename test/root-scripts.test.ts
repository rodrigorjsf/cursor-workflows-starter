// Seam: the process. `npm run wf`, `npm run mcp`, `npm run dash` and `npm run stats` keep working from the repo root now
// that the runtime and the dashboard are workspace packages. Each script's command line is run the way npm runs it (shell, with
// node_modules/.bin on PATH, cwd = repo root), offline: the fake Cursor SDK replaces `@cursor/sdk`.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FAKE_SDK_TSCONFIG, MCP_TOOLS, ROOT, withMcpServer } from "./mcp-support.js";

const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<string, string>;

let home: string;
before(() => {
  home = mkdtempSync(join(tmpdir(), "wf-root-scripts-"));
});
after(() => rmSync(home, { recursive: true, force: true }));

const scriptEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  PATH: `${join(ROOT, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
  TSX_TSCONFIG_PATH: FAKE_SDK_TSCONFIG,
  WF_METRICS_DB: join(home, "metrics.db"),
  ...extra,
});

test("npm run wf: the CLI runs from the repo root and lists the built-in workflows", () => {
  const r = spawnSync("sh", ["-c", `${scripts.wf} list`], { cwd: ROOT, env: scriptEnv(), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok((JSON.parse(r.stdout) as Array<{ name: string }>).some((w) => w.name === "implement-issue"), r.stdout);
});

test("npm run mcp: the MCP server runs from the repo root and answers tools/list", async () => {
  const tools = await withMcpServer(
    { command: "sh", args: ["-c", scripts.mcp!], cwd: ROOT, env: { ...getDefaultEnvironment(), ...scriptEnv() } },
    async (client) => (await client.listTools()).tools.map((t) => t.name).sort(),
  );
  assert.deepEqual(tools, MCP_TOOLS);
});

test("npm run stats: the metrics summary runs from the repo root", () => {
  const stats = spawnSync("sh", ["-c", scripts.stats!], { cwd: ROOT, env: scriptEnv(), encoding: "utf8" });
  assert.equal(stats.status, 0, stats.stderr);
});

test("npm run dash: the dashboard runs from the repo root and starts on a machine with no metrics database", async () => {
  const port = await freePort();
  const fresh = join(home, "no-history"); // neither a runs index nor a metrics database
  const env = scriptEnv({ WF_HOME: fresh, WF_METRICS_DB: join(fresh, "metrics.db"), WF_DASH_PORT: String(port) });
  const dash: ChildProcess = spawn("sh", ["-c", `exec ${scripts.dash}`], { cwd: ROOT, env, stdio: "ignore" });
  try {
    const summary = await fetchWhenUp(`http://127.0.0.1:${port}/api/summary`);
    assert.deepEqual(summary.totals, [], "no database yet: an empty state, not a failure");
    assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json()), { runs: [] });
  } finally {
    dash.kill("SIGTERM");
  }
});

test("npm run dash: the dashboard builds its web app as it starts, before any page asks for it", async () => {
  const port = await freePort();
  const fresh = join(home, "builds");
  const env = scriptEnv({ WF_HOME: fresh, WF_METRICS_DB: join(fresh, "metrics.db"), WF_DASH_PORT: String(port) });
  const dash: ChildProcess = spawn("sh", ["-c", `exec ${scripts.dash}`], { cwd: ROOT, env, stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  dash.stderr!.on("data", (chunk: Buffer) => (log += chunk));
  try {
    const deadline = Date.now() + 30_000;
    while (!/web app built/.test(log)) {
      assert.ok(Date.now() < deadline, `the dashboard never said its web app was built; it said: ${log}`);
      await new Promise((r) => setTimeout(r, 100)); // no request is made meanwhile: nothing but the start asked for the build
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/runs/any`)).status, 200);
  } finally {
    dash.kill("SIGTERM");
  }
});

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => ok(port));
    });
  });
}

async function fetchWhenUp(url: string): Promise<{ totals: unknown }> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      return (await (await fetch(url)).json()) as { totals: unknown };
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
