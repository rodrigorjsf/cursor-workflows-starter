// The dashboard as a process: where it listens, how to tell that what answers on its port is the dashboard, and how a
// caller (`start_workflow`) makes sure one is running. There is one dashboard per user, for the runs of every repo.
//
// - The port is `WF_DASH_PORT` (default 4317), on 127.0.0.1 only. The link is `http://127.0.0.1:<port>`: a Windows browser
//   reaches a server in WSL2 through the IPv4 loopback, whereas `localhost` resolves to ::1 first there and is refused.
// - `ensureDashboard` probes the port, and starts the dashboard as a detached process when nothing answers. The pid file
//   (`dashboard.pid` in the per-user directory) is created exclusively by the caller that starts the process, so callers
//   that overlap start one process between them; the OS lets only one process bind the port in any case.
// - `dashboard.autoStart: false` in the global config file, or `WF_DASH_AUTOSTART=off`, turns the starting off. A dashboard
//   that is already up is still reported.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { globalConfigPath, loadConfigFile } from "../config/file.js";
import { isAlive } from "./pid.js";
import { userDir } from "./state.js";
import { writeFileAtomic } from "./state-files.js";

/** What `/api/health` answers as `app`: how a caller knows the program on the port is the dashboard and not something else. */
export const DASHBOARD_APP = "cursor-workflows-dashboard";
export const DASHBOARD_HOST = "127.0.0.1";
export const DEFAULT_DASHBOARD_PORT = 4317;
export const HEALTH_PATH = "/api/health";

/** The port the dashboard listens on: `WF_DASH_PORT`, or 4317. Throws on a value that is not a port. */
export function dashboardPort(): number {
  const raw = process.env.WF_DASH_PORT;
  if (raw === undefined || raw === "") return DEFAULT_DASHBOARD_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`WF_DASH_PORT must be a port number from 1 to 65535, not ${JSON.stringify(raw)}`);
  return port;
}

export const dashboardUrl = (port: number): string => `http://${DASHBOARD_HOST}:${port}`;

export const dashboardPidPath = (): string => join(userDir(), "dashboard.pid");
const dashboardLogPath = (): string => join(userDir(), "dashboard.log");

/** Whether starting the dashboard is allowed: `WF_DASH_AUTOSTART=off`, or `dashboard.autoStart: false` in the global config, forbids it. */
export function dashboardAutoStart(): boolean {
  if (/^(off|0|false)$/i.test(process.env.WF_DASH_AUTOSTART ?? "")) return false;
  try {
    return loadConfigFile(globalConfigPath())?.data.dashboard?.autoStart ?? true;
  } catch {
    return true; // an unusable config is reported where it is loaded (start_workflow refuses to start); it does not decide this
  }
}

/** The process that serves the dashboard (or is about to), as the pid file records it. */
export interface DashboardInstance {
  pid: number;
  port: number;
  startedAt: string;
}

export function readInstance(): DashboardInstance | undefined {
  try {
    const instance = JSON.parse(readFileSync(dashboardPidPath(), "utf8")) as Partial<DashboardInstance>;
    return typeof instance.pid === "number" && typeof instance.port === "number" && typeof instance.startedAt === "string" ? (instance as DashboardInstance) : undefined;
  } catch {
    return undefined;
  }
}

export function writeInstance(instance: DashboardInstance): void {
  mkdirSync(userDir(), { recursive: true, mode: 0o700 });
  writeFileAtomic(dashboardPidPath(), JSON.stringify(instance));
}

/** Removes the pid file when it names `pid`: a process never removes the record of another one. */
export function removeInstance(pid: number): void {
  if (readInstance()?.pid === pid) rmSync(dashboardPidPath(), { force: true });
}

/** The dashboard on `port` (its pid), or undefined when nothing answers there or what answers is not the dashboard. */
export async function probeDashboard(port: number, timeoutMs = 1000): Promise<{ pid: number } | undefined> {
  try {
    const res = await fetch(`${dashboardUrl(port)}${HEALTH_PATH}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { app?: unknown; pid?: unknown };
    return body.app === DASHBOARD_APP && typeof body.pid === "number" ? { pid: body.pid } : undefined;
  } catch {
    return undefined;
  }
}

export type DashboardStatus =
  /** The dashboard answers at `url`. `started`: this call started the process that does. */
  | { status: "running"; url: string; pid: number; started: boolean }
  /** Nothing answers and auto-start is off. */
  | { status: "disabled" }
  | { status: "unavailable"; reason: string };

export interface EnsureOptions {
  /** How long to wait for a starting dashboard to answer. Default 15 s. */
  startTimeoutMs?: number;
  /** The dashboard's entry point. Default: `packages/dashboard/src/main.ts` of this install. */
  entry?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Takes the right to start the dashboard: creates the pid file, naming this process until the child's pid replaces it. False when another caller holds it. */
function claimStart(port: number, startTimeoutMs: number): boolean {
  mkdirSync(userDir(), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(dashboardPidPath(), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() } satisfies DashboardInstance), { flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = readInstance();
    if (holder && isAlive(holder.pid) && Date.now() - Date.parse(holder.startedAt) < startTimeoutMs) return false; // someone is starting it right now
    rmSync(dashboardPidPath(), { force: true }); // left by a process that is gone, or that never answered
  }
  return false;
}

/** The new bytes of the dashboard's log since `offset`, trimmed: the reason a dashboard that exited gave. */
function logSince(offset: number): string {
  try {
    return readFileSync(dashboardLogPath()).subarray(offset).toString("utf8").trim().split("\n").slice(-3).join(" | ");
  } catch {
    return "";
  }
}

/**
 * Makes sure the dashboard is running and says where. Never throws: whatever goes wrong comes back as `unavailable` with the
 * reason, because a dashboard that cannot start must not stop a workflow from starting.
 */
export async function ensureDashboard(options: EnsureOptions = {}): Promise<DashboardStatus> {
  const startTimeoutMs = options.startTimeoutMs ?? 15_000;
  try {
    const port = dashboardPort();
    const up = (pid: number, started: boolean): DashboardStatus => ({ status: "running", url: dashboardUrl(port), pid, started });
    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      const found = await probeDashboard(port);
      if (found) return up(found.pid, false);
      if (!dashboardAutoStart()) return { status: "disabled" };
      const entry = options.entry ?? fileURLToPath(new URL("../../../dashboard/src/main.ts", import.meta.url));
      if (!existsSync(entry)) return { status: "unavailable", reason: `the dashboard package is not part of this install (${entry} is missing)` };
      if (claimStart(port, startTimeoutMs)) return await start(port, entry, startTimeoutMs, up);
      // Another caller is starting it: wait for it to answer, or for its claim to go stale.
      if (Date.now() >= deadline) return { status: "unavailable", reason: `a dashboard is starting on port ${port} but did not answer within ${Math.round(startTimeoutMs / 1000)}s` };
      await sleep(100);
    }
  } catch (err) {
    return { status: "unavailable", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Spawns the dashboard detached and waits for it to answer. The caller holds the claim. */
async function start(port: number, entry: string, startTimeoutMs: number, up: (pid: number, started: boolean) => DashboardStatus): Promise<DashboardStatus> {
  const logFile = dashboardLogPath();
  const offset = existsSync(logFile) ? statSync(logFile).size : 0;
  const out = openSync(logFile, "a");
  let exited = false;
  let spawnError: string | undefined;
  let pid: number | undefined;
  try {
    // The Cursor API key is not the dashboard's business: it never reads it, and it outlives the caller.
    const { CURSOR_API_KEY: _key, ...env } = process.env;
    const child = spawn(process.execPath, [...process.execArgv, entry], { detached: true, stdio: ["ignore", out, out], env });
    child.once("exit", () => (exited = true));
    child.once("error", (err) => (spawnError = err.message));
    child.unref();
    pid = child.pid;
    if (pid) writeInstance({ pid, port, startedAt: new Date().toISOString() });
  } finally {
    closeSync(out); // the child holds its own copy
  }
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline && !exited && !spawnError) {
    const found = await probeDashboard(port, 500);
    if (found) return up(found.pid, found.pid === pid);
    await sleep(100);
  }
  // A process that lost the race for the port exits at once, and the winner answers: that is a dashboard running.
  const found = await probeDashboard(port);
  if (found) return up(found.pid, found.pid === pid);
  if (pid) removeInstance(pid);
  const why = spawnError ?? logSince(offset);
  return { status: "unavailable", reason: why || `the dashboard did not answer on port ${port} within ${Math.round(startTimeoutMs / 1000)}s (log: ${logFile})` };
}
