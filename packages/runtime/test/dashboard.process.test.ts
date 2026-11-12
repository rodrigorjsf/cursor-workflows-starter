// Seam: the process. `ensureDashboard` starts the dashboard as a detached process of its own, once, and answers with its
// link. The dashboard is the real one (packages/dashboard), a child process on a free loopback port, against a throwaway
// per-user home; nothing here touches the user's real `~/.cursor-workflows`.
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { type DashboardStatus, dashboardPidPath, ensureDashboard, readInstance } from "../src/runtime/dashboard-instance.js";

const KEYS = ["WF_HOME", "WF_DASH_PORT", "WF_DASH_AUTOSTART", "WF_METRICS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let home: string;
let port: number;
const spawned = new Set<number>();

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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (what: string, ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(ok(), what);
};
const log = () => (existsSync(join(home, "dashboard.log")) ? readFileSync(join(home, "dashboard.log"), "utf8") : "");

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "wf-dashboard-proc-"));
  port = await freePort();
  Object.assign(process.env, { WF_HOME: home, WF_DASH_PORT: String(port), WF_METRICS: "off" });
  delete process.env.WF_DASH_AUTOSTART;
});
afterEach(() => {
  const recorded = readInstance()?.pid; // a test that failed before it saw the status still leaves its dashboard behind
  if (recorded !== undefined) spawned.add(recorded);
  for (const pid of spawned) if (alive(pid)) process.kill(pid, "SIGKILL");
  spawned.clear();
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
  rmSync(home, { recursive: true, force: true });
});
after(() => {
  for (const pid of spawned) if (alive(pid)) process.kill(pid, "SIGKILL");
});

/** The status when it is `running`, remembering the process so the test can end it. */
function running(status: DashboardStatus) {
  assert.equal(status.status, "running", JSON.stringify(status));
  if (status.status !== "running") throw new Error("unreachable");
  spawned.add(status.pid);
  return status;
}

test("ensureDashboard starts the dashboard detached when nothing answers, and returns its link", async () => {
  const first = running(await ensureDashboard());
  assert.equal(first.url, `http://127.0.0.1:${port}`);
  assert.equal(first.started, true);
  assert.notEqual(first.pid, process.pid, "the dashboard is a process of its own");

  const health = await (await fetch(`${first.url}/api/health`)).json();
  assert.deepEqual(health, { app: "cursor-workflows-dashboard", pid: first.pid });
  assert.equal((await fetch(`${first.url}/api/runs`)).status, 200);

  assert.deepEqual({ pid: readInstance()?.pid, port: readInstance()?.port }, { pid: first.pid, port }, "the pid file names the instance");
});

test("a second call finds the dashboard running and starts nothing", async () => {
  const first = running(await ensureDashboard());
  const second = running(await ensureDashboard());
  assert.equal(second.started, false);
  assert.equal(second.pid, first.pid);
  assert.equal(second.url, first.url);
  assert.equal(log().match(/dashboard listening/g)?.length, 1);
});

test("calls that overlap, as the parallel tool calls of a chat do, start exactly one dashboard", async () => {
  const all = (await Promise.all(Array.from({ length: 5 }, () => ensureDashboard()))).map(running);
  assert.equal(new Set(all.map((s) => s.pid)).size, 1, "everyone gets the same instance");
  assert.equal(all.filter((s) => s.started).length, 1, "and only one of them started it");
  assert.equal(log().match(/dashboard listening/g)?.length, 1);
  assert.doesNotMatch(log(), /already running/, "no second process was even started");
});

test("a dashboard that was killed leaves a stale pid file, and the next call starts a new one", async () => {
  const first = running(await ensureDashboard());
  process.kill(first.pid, "SIGKILL");
  await until("the old dashboard to be gone", () => !alive(first.pid));
  assert.ok(existsSync(dashboardPidPath()), "a killed process cannot clean up");

  const next = running(await ensureDashboard());
  assert.equal(next.started, true);
  assert.notEqual(next.pid, first.pid);
});

test("SIGTERM stops the dashboard and removes its pid file", async () => {
  const first = running(await ensureDashboard());
  process.kill(first.pid, "SIGTERM");
  await until("the dashboard to exit", () => !alive(first.pid));
  assert.equal(existsSync(dashboardPidPath()), false);
});

test("the WF_DASH_AUTOSTART=off switch starts nothing, but still returns the link of a dashboard that is already up", async () => {
  process.env.WF_DASH_AUTOSTART = "off";
  assert.deepEqual(await ensureDashboard(), { status: "disabled" });
  assert.equal(existsSync(dashboardPidPath()), false);

  delete process.env.WF_DASH_AUTOSTART;
  const up = running(await ensureDashboard());
  process.env.WF_DASH_AUTOSTART = "off";
  const again = running(await ensureDashboard());
  assert.equal(again.pid, up.pid);
  assert.equal(again.started, false);
});

test("the global config file switches auto-start off with dashboard.autoStart: false", async () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ dashboard: { autoStart: false } }));
  assert.deepEqual(await ensureDashboard(), { status: "disabled" });

  writeFileSync(join(home, "config.json"), JSON.stringify({ dashboard: { autoStart: true } }));
  running(await ensureDashboard());
});

test("a port taken by another program is reported, not fought over", async () => {
  const squatter = createHttpServer((_req, res) => res.end("not a dashboard"));
  await new Promise<void>((ok) => squatter.listen(port, "127.0.0.1", ok));
  try {
    const status = await ensureDashboard({ startTimeoutMs: 10_000 });
    assert.equal(status.status, "unavailable");
    assert.match((status as { reason: string }).reason, new RegExp(`port ${port} is in use by another program.*WF_DASH_PORT`));
  } finally {
    squatter.close();
  }
});

test("an install without the dashboard package says so instead of failing", async () => {
  const status = await ensureDashboard({ entry: join(home, "nowhere", "main.ts") });
  assert.equal(status.status, "unavailable");
  assert.match((status as { reason: string }).reason, /dashboard package is not part of this install/);
});

test("a WF_DASH_PORT that is not a port is unavailable, with the reason", async () => {
  process.env.WF_DASH_PORT = "dashboard";
  const status = await ensureDashboard();
  assert.equal(status.status, "unavailable");
  assert.match((status as { reason: string }).reason, /WF_DASH_PORT/);
});
