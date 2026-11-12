// Shared by the dashboard's tests: a throwaway per-user home, throwaway repos with run directories written the way the
// runtime writes them, and an HTTP client that can send any Host header.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Sandbox {
  /** `WF_HOME`: where the global runs index and the metrics database live. */
  home: string;
  /** Makes a repo directory under the sandbox and returns its absolute path. */
  repo(name: string): string;
  dispose(): void;
}

/** Points `WF_HOME` (and nothing else) at a fresh directory for the length of the test. */
export function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "wf-dash-"));
  const home = join(root, "home");
  mkdirSync(home);
  const previous = { home: process.env.WF_HOME, db: process.env.WF_METRICS_DB };
  process.env.WF_HOME = home;
  delete process.env.WF_METRICS_DB;
  return {
    home,
    repo(name) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    dispose() {
      if (previous.home === undefined) delete process.env.WF_HOME;
      else process.env.WF_HOME = previous.home;
      if (previous.db !== undefined) process.env.WF_METRICS_DB = previous.db;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface FixtureRun {
  runId: string;
  workflow: string;
  startedAt: string;
  /** Events after the `run-start` (which the helper writes): each is `{type, ...fields}`; `ts`, `runId` and `v` are filled in. */
  events?: Array<{ type: string } & Record<string, unknown>>;
  /** Write the run's lock as held by this pid: a process is executing the run. */
  lockedBy?: number;
  /** Register the run in the global index but leave its directory out. */
  withoutLog?: boolean;
}

/** Registers a run in the global index and writes its event log under `<repo>/.workflows/runs/<runId>/`. */
export function writeRun(home: string, repo: string, run: FixtureRun): void {
  const at = (n: number) => new Date(Date.parse(run.startedAt) + n * 1000).toISOString();
  writeFileSync(join(home, "runs.jsonl"), `${JSON.stringify({ v: 1, runId: run.runId, repo, workflow: run.workflow, startedAt: run.startedAt })}\n`, { flag: "a" });
  if (run.withoutLog) return;
  const dir = join(repo, ".workflows", "runs", run.runId);
  mkdirSync(dir, { recursive: true });
  const events = [{ type: "run-start", workflow: run.workflow }, ...(run.events ?? [])];
  writeFileSync(join(dir, "events.jsonl"), events.map((e, i) => JSON.stringify({ v: 1, ts: at(i), runId: run.runId, ...e })).join("\n") + "\n");
  if (run.lockedBy !== undefined) writeFileSync(join(dir, "run.lock"), JSON.stringify({ pid: run.lockedBy, token: "fixture", startedAt: run.startedAt, runId: run.runId }));
}

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  /** The body parsed as JSON; undefined when it is not JSON. */
  json: any;
}

/** One request to `url` (the server's origin); `host` replaces the Host header, `method` the verb. */
export function http(url: string, path: string, opts: { host?: string; method?: string } = {}): Promise<Reply> {
  const target = new URL(path, url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: opts.method ?? "GET", headers: opts.host === undefined ? {} : { host: opts.host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.once("error", reject);
    req.end();
  });
}
