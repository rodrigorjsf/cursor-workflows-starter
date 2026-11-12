// The dashboard's HTTP server: a read-only JSON API over the runs of every repo and the metrics database, plus the page.
//
// - It listens on 127.0.0.1 only and refuses any `Host` that is not a loopback name (DNS rebinding protection). It sends
//   no CORS headers, so another site's script cannot read it.
// - It reads: the global runs index and each run's event log (`@cursor-workflows/runtime/observe`), and the metrics
//   database, opened read-only the first time it exists. A machine with no history gets empty states, not an error.
import { existsSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { DASHBOARD_APP, DASHBOARD_HOST, HEALTH_PATH, type Db, defaultDbPath, listRuns, openDb, readRun, summary } from "@cursor-workflows/runtime/observe";
import { METRICS_PAGE } from "./metrics-page.js";

/** Host names a request may carry: the loopback names. Anything else is a page of another site asking the browser to talk to us. */
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** What `/api/summary` answers on a machine with no metrics database yet: every table empty. */
const EMPTY_SUMMARY = { totals: [], workflows: [], models: [], contextBuckets: [], daily: [], waste: [], savings: [], attribution: [] };

export interface DashboardServer {
  /** The server's origin, `http://127.0.0.1:<port>`. */
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface DashboardOptions {
  /** The port to listen on; 0 picks a free one (tests). */
  port: number;
}

function hostAllowed(header: string | undefined): boolean {
  if (!header) return false;
  try {
    return ALLOWED_HOSTS.has(new URL(`http://${header}`).hostname);
  } catch {
    return false;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

/** The metrics database, opened read-only the first time it exists: the first run of the kit creates it after the dashboard may already be up. */
class MetricsSource {
  private db: Db | undefined;
  private opened: string | undefined;

  async get(): Promise<Db | undefined> {
    const path = defaultDbPath();
    if (!existsSync(path)) return undefined;
    if (this.db && this.opened === path) return this.db;
    this.close();
    this.db = await openDb(path, { readOnly: true });
    this.opened = path;
    return this.db;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
    this.opened = undefined;
  }
}

/** A path segment, percent-decoded; one that is not valid percent-encoding names nothing. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

/** A number from a query parameter, clamped to [min, max]; `fallback` when it is not a number. */
function clamped(raw: string | null, fallback: number, min: number, max: number): number {
  return Math.min(Math.max(Number(raw ?? fallback) || fallback, min), max);
}

export async function startDashboard(options: DashboardOptions): Promise<DashboardServer> {
  const metrics = new MetricsSource();

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("host não permitido");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      send(res, 405, { error: "method not allowed" });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${DASHBOARD_HOST}`);
    switch (url.pathname) {
      case "/":
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        });
        res.end(METRICS_PAGE);
        return;
      case HEALTH_PATH:
        send(res, 200, { app: DASHBOARD_APP, pid: process.pid });
        return;
      case "/api/runs":
        send(res, 200, { runs: listRuns(clamped(url.searchParams.get("limit"), 200, 1, 1000)) });
        return;
      case "/api/summary": {
        const db = await metrics.get();
        send(res, 200, db ? summary(db, clamped(url.searchParams.get("days"), 30, 1, 3650)) : EMPTY_SUMMARY);
        return;
      }
      default: {
        const run = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
        const detail = run && readRun(decodeSegment(run[1]!));
        if (detail) send(res, 200, detail);
        else send(res, 404, { error: run ? "run not found" : "not found" });
      }
    }
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) res.destroy();
      else send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, DASHBOARD_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://${DASHBOARD_HOST}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          metrics.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
