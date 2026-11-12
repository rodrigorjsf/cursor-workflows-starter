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
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { globalConfigPath, loadConfigFile } from "../config/file.js";
import { fromEnv } from "./job-state.js";
import { commandLineHas, isAlive } from "./pid.js";
import { userDir } from "./state.js";
import { writeFileAtomic } from "./state-files.js";

/** What `/api/health` answers as `app`: how a caller knows the program on the port is the dashboard and not something else. */
export const DASHBOARD_APP = "cursor-workflows-dashboard";
export const DASHBOARD_HOST = "127.0.0.1";
const DEFAULT_DASHBOARD_PORT = 4317;
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

/** The Run view of run `runId` on the dashboard at `baseUrl`: the page `/runs/<runId>` (the dashboard's `app/format.ts` writes the same link as `runHref`). */
export const runPageUrl = (baseUrl: string, runId: string): string => `${baseUrl}/runs/${encodeURIComponent(runId)}`;

export const dashboardPidPath = (): string => join(userDir(), "dashboard.pid");
/** Where the dashboard keeps the bundle of its web app, one folder per content hash (see packages/dashboard/src/web-bundle.ts). */
export const dashboardCacheDir = (): string => join(userDir(), "dashboard-cache");
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
export async function probeDashboard(port: number, timeoutMs = 2000): Promise<{ pid: number } | undefined> {
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
  /** How long to wait for a starting dashboard to answer. Default 10 s. */
  startTimeoutMs?: number;
  /** The dashboard's entry point. Default: `packages/dashboard/src/main.ts` of this install. */
  entry?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when `pid` runs the dashboard's entry point, and not another program that got the number. Where /proc is missing it cannot tell, and says yes. */
function isDashboardProcess(pid: number): boolean {
  return commandLineHas(pid, (arg) => /dashboard[\\/]src[\\/]main\.ts$/.test(arg));
}

/**
 * Takes the right to start the dashboard: creates the pid file, naming this process until the child's pid replaces it. False
 * when another caller holds it: one that is starting the dashboard now (a record younger than `startTimeoutMs`), or the dashboard
 * itself, which a probe may have missed only because it was busy. Anything else is stale and is taken over.
 *
 * Known limit: two callers that find the same stale record at the same instant can both take it over and both start a process.
 * The port lets only one of them listen, and the answering dashboard corrects the pid file (`answering`).
 */
function claimStart(port: number, startTimeoutMs: number): boolean {
  mkdirSync(userDir(), { recursive: true, mode: 0o700 });
  const file = dashboardPidPath();
  const aside = `${file}.${process.pid}.tmp`;
  writeFileSync(aside, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() } satisfies DashboardInstance)); // complete before anyone can see it
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(aside, file); // fails when the file exists
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const holder = readInstance();
      if (holder && isAlive(holder.pid) && (Date.now() - Date.parse(holder.startedAt) < startTimeoutMs || isDashboardProcess(holder.pid))) return false;
      const again = readInstance();
      if (again?.pid !== holder?.pid || again?.startedAt !== holder?.startedAt) continue; // replaced while we looked: look again
      rmSync(file, { force: true }); // left by a process that is gone, or that never became the dashboard
    }
    return false;
  } finally {
    rmSync(aside, { force: true });
  }
}

/** The new bytes of the dashboard's log since `offset`, trimmed: the reason a dashboard that exited gave. */
function logSince(offset: number): string {
  try {
    return readFileSync(dashboardLogPath()).subarray(offset).toString("utf8").trim().split("\n").slice(-3).join(" | ");
  } catch {
    return "";
  }
}

/** The dashboard answers on `port` as process `pid`. The pid file is made to say so: a lost race can leave it naming a process that is gone. */
function answering(port: number, pid: number, started: boolean): DashboardStatus {
  try {
    if (readInstance()?.pid !== pid) writeInstance({ pid, port, startedAt: new Date().toISOString() });
  } catch {
    /* the record is a convenience: the dashboard is up whether or not it can be written */
  }
  return { status: "running", url: dashboardUrl(port), pid, started };
}

/**
 * Makes sure the dashboard is running and says where. Never throws: whatever goes wrong comes back as `unavailable` with the
 * reason, because a dashboard that cannot start must not stop a workflow from starting.
 */
export async function ensureDashboard(options: EnsureOptions = {}): Promise<DashboardStatus> {
  // `WF_DASH_START_TIMEOUT_MS` exists for the tests, which start dashboards on a machine that is running the whole suite at once.
  const startTimeoutMs = options.startTimeoutMs ?? fromEnv("WF_DASH_START_TIMEOUT_MS", 10_000);
  const seconds = Math.max(1, Math.round(startTimeoutMs / 1000));
  try {
    const port = dashboardPort();
    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      const found = await probeDashboard(port);
      if (found) return answering(port, found.pid, false);
      if (!dashboardAutoStart()) return { status: "disabled" };
      // The dashboard package sits next to the runtime in the kit's checkout: the kit is installed whole, and this is a file to run, not a module to import.
      const entry = options.entry ?? fileURLToPath(new URL("../../../dashboard/src/main.ts", import.meta.url));
      if (!existsSync(entry)) return { status: "unavailable", reason: `the dashboard package is not part of this install (${entry} is missing)` };
      if (claimStart(port, startTimeoutMs)) return await start(port, entry, startTimeoutMs);
      // Another caller is starting it, or it is up and busy: wait for it to answer, or for its record to go stale.
      if (Date.now() >= deadline) {
        const holder = readInstance();
        return {
          status: "unavailable",
          reason: holder && isDashboardProcess(holder.pid) ? `the dashboard (pid ${holder.pid}) does not answer on port ${port} within ${seconds}s` : `a dashboard is starting on port ${port} but did not answer within ${seconds}s`,
        };
      }
      await sleep(100);
    }
  } catch (err) {
    return { status: "unavailable", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Spawns the dashboard detached and waits for it to answer. The caller holds the claim; this releases it unless a dashboard is running or still starting. */
async function start(port: number, entry: string, startTimeoutMs: number): Promise<DashboardStatus> {
  const logFile = dashboardLogPath();
  const offset = existsSync(logFile) ? statSync(logFile).size : 0;
  let exited = false;
  let spawnError: string | undefined;
  let pid: number | undefined;
  let keepRecord = false;
  try {
    const out = openSync(logFile, "a");
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
      if (found) {
        keepRecord = true;
        return answering(port, found.pid, found.pid === pid);
      }
      await sleep(100);
    }
    // A process that lost the race for the port exits at once, and the winner answers: that is a dashboard running.
    const found = await probeDashboard(port);
    if (found) {
      keepRecord = true;
      return answering(port, found.pid, found.pid === pid);
    }
    if (pid !== undefined && !exited && !spawnError) {
      keepRecord = true; // alive and not answering yet: the next caller waits for it instead of starting another
      return { status: "unavailable", reason: `the dashboard (pid ${pid}) is still starting; its link works in a moment: ${dashboardUrl(port)}` };
    }
    return { status: "unavailable", reason: spawnError ?? (logSince(offset) || `the dashboard exited without answering on port ${port} (log: ${logFile})`) };
  } finally {
    if (!keepRecord) removeInstance(pid ?? process.pid);
  }
}
