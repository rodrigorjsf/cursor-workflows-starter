// Seam: the process. `ensureDashboard` starts the dashboard as a detached process of its own, once, and answers with its
// link. The dashboard is the real one (packages/dashboard), a child process on a free loopback port, against a throwaway
// per-user home; nothing here touches the user's real `~/.cursor-workflows`.
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { type DashboardStatus, dashboardPidPath, ensureDashboard, readInstance, writeInstance } from "../src/runtime/dashboard-instance.js";
import { isAlive } from "../src/runtime/pid.js";
import { dashboardListens, dashboardLog, freePort } from "./dashboard-fixtures.js";

const KEYS = ["WF_HOME", "WF_DASH_PORT", "WF_DASH_AUTOSTART", "WF_DASH_START_TIMEOUT_MS", "WF_METRICS", "CURSOR_API_KEY"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let home: string;
let port: number;
const spawned = new Set<number>();

const until = async (what: string, ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(ok(), what);
};
const log = () => dashboardLog(home);

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "wf-dashboard-proc-"));
  port = await freePort();
  Object.assign(process.env, { WF_HOME: home, WF_DASH_PORT: String(port), WF_DASH_START_TIMEOUT_MS: "30000", WF_METRICS: "off" }); // a start may be slow while the whole suite runs
  delete process.env.WF_DASH_AUTOSTART;
});
afterEach(() => {
  const recorded = readInstance()?.pid; // a test that failed before it saw the status still leaves its dashboard behind
  if (recorded !== undefined) spawned.add(recorded);
  for (const pid of spawned) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  spawned.clear();
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
  rmSync(home, { recursive: true, force: true });
});
after(() => {
  for (const pid of spawned) if (isAlive(pid)) process.kill(pid, "SIGKILL");
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
  assert.equal(dashboardListens(home), 1);
});

test("calls that overlap, as the parallel tool calls of a chat do, start exactly one dashboard", async () => {
  const all = (await Promise.all(Array.from({ length: 5 }, () => ensureDashboard()))).map(running);
  assert.equal(new Set(all.map((s) => s.pid)).size, 1, "everyone gets the same instance");
  assert.equal(all.filter((s) => s.started).length, 1, "and only one of them started it");
  assert.equal(dashboardListens(home), 1);
  assert.doesNotMatch(log(), /already running/, "no second process was even started");
});

test("a dashboard that was killed leaves a stale pid file, and the next call starts a new one", async () => {
  const first = running(await ensureDashboard());
  process.kill(first.pid, "SIGKILL");
  await until("the old dashboard to be gone", () => !isAlive(first.pid));
  assert.ok(existsSync(dashboardPidPath()), "a killed process cannot clean up");

  const next = running(await ensureDashboard());
  assert.equal(next.started, true);
  assert.notEqual(next.pid, first.pid);
});

test("SIGTERM stops the dashboard and removes its pid file", async () => {
  const first = running(await ensureDashboard());
  process.kill(first.pid, "SIGTERM");
  await until("the dashboard to exit", () => !isAlive(first.pid));
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
    assert.equal(existsSync(dashboardPidPath()), false, "a start that failed leaves no claim behind");
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

test("a live dashboard that is too busy to answer the probe is waited for, not replaced: no second process, and the pid file keeps naming it", async () => {
  const up = running(await ensureDashboard());
  process.kill(up.pid, "SIGSTOP"); // alive, holds the port, answers nothing
  try {
    await new Promise((r) => setTimeout(r, 700)); // fixed-wait-ok: older than the start timeout below: a record that is "old" is not a stale one
    const status = await ensureDashboard({ startTimeoutMs: 600 });
    assert.equal(status.status, "unavailable");
    assert.match((status as { reason: string }).reason, new RegExp(`dashboard \\(pid ${up.pid}\\) does not answer`));
    assert.equal(readInstance()?.pid, up.pid);
    assert.equal(dashboardListens(home), 1);
    assert.doesNotMatch(log(), /in use by another program/, "nothing else was started");
  } finally {
    process.kill(up.pid, "SIGCONT");
  }
  const back = running(await ensureDashboard());
  assert.deepEqual([back.pid, back.started], [up.pid, false]);
});

test("a pid file that names the wrong process is corrected as soon as the dashboard answers", async () => {
  const up = running(await ensureDashboard());
  writeInstance({ pid: 2 ** 22 + 1, port, startedAt: new Date().toISOString() }); // what a lost race leaves behind: a process that is gone
  const again = running(await ensureDashboard());
  assert.equal(again.pid, up.pid);
  assert.equal(readInstance()?.pid, up.pid);
});

test("a start that fails before the process exists leaves no claim, so the next call starts the dashboard at once", async () => {
  mkdirSync(join(home, "dashboard.log")); // the log cannot be opened: the start fails before any process is spawned
  const failed = await ensureDashboard();
  assert.equal(failed.status, "unavailable");
  assert.equal(existsSync(dashboardPidPath()), false);

  rmSync(join(home, "dashboard.log"), { recursive: true });
  // No claim is left (asserted above), so the next call starts the dashboard; how long the start takes is the machine's.
  const next = running(await ensureDashboard({ startTimeoutMs: 15_000 }));
  assert.equal(next.started, true);
});

test("the dashboard it starts keeps CURSOR_API_KEY: its cloud-agent cancel reaches the Cursor API with the key the SDK finds there", async () => {
  process.env.CURSOR_API_KEY = "test-key-not-a-secret";
  const probe = join(home, "probe-dashboard.mjs");
  const seen = join(home, "key-seen.txt");
  // Records only whether the key arrived, never the key; then stays alive without listening, like the slow dashboard below.
  writeFileSync(probe, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(seen)}, String(process.env.CURSOR_API_KEY === "test-key-not-a-secret"));\nsetInterval(() => {}, 1000);\n`);
  await ensureDashboard({ entry: probe, startTimeoutMs: 1_500 });
  await until("the dashboard process to record its environment", () => existsSync(seen));
  assert.equal(readFileSync(seen, "utf8"), "true");
});

test("a dashboard that is still starting when the wait ends is reported with its link, and is not killed", async () => {
  const slow = join(home, "slow-dashboard.mjs");
  writeFileSync(slow, "setInterval(() => {}, 1000);\n"); // alive, never listens
  const status = await ensureDashboard({ entry: slow, startTimeoutMs: 1_500 });
  assert.equal(status.status, "unavailable");
  const reason = (status as { reason: string }).reason;
  assert.match(reason, new RegExp(`still starting.*http://127\\.0\\.0\\.1:${port}`));
  const pid = readInstance()?.pid;
  assert.ok(pid !== undefined && isAlive(pid), "the process it started is still there, and the pid file names it");
});
