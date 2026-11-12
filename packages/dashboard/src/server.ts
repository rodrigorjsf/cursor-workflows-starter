// The dashboard's HTTP server: a read-only JSON API over the runs of every repo and the metrics database, plus the web app
// that draws them (built at start, see app-bundle.ts).
//
// - It listens on 127.0.0.1 only and refuses any `Host` that is not a loopback name (DNS rebinding protection). It sends
//   no CORS headers, so another site's script cannot read it.
// - It reads: the global runs index and each run's event log (`@cursor-workflows/runtime/observe`), and the metrics
//   database, opened read-only the first time it exists. A machine with no history gets empty states, not an error.
// - A run's event log is also served live: `/api/runs/<runId>/events` is a Server-Sent Events stream that replays the log and
//   then follows it as the run appends, and `/api/runs/<runId>/steps/<stepId>/content` is one step's content.
// - The Board is `/api/board`: the runs placed in the columns of their workflow, with the state of the pull requests their cards link to.
import { existsSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { DASHBOARD_APP, DASHBOARD_HOST, HEALTH_PATH, type Db, type RunTail, defaultDbPath, listRuns, openDb, readRun, readStepContent, summary, tailRun } from "@cursor-workflows/runtime/observe";
import { type AppBundle, buildApp } from "./app-bundle.js";
import { buildBoards } from "./board.js";
import { PrStates } from "./pr-state.js";

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
  /** How long the state of an open pull request is kept before `gh` is asked again, in milliseconds (a merged or closed one is kept 120 times as long). Default 30 seconds. */
  prStateCacheMs?: number;
}

const DEFAULT_PR_STATE_CACHE_MS = 30_000;

/** The page the app runs in. Everything it loads is on this server, so the policy allows only this origin and no inline code. */
const PAGE_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The app's page: an empty root, the script and the stylesheet. */
const appPage = (app: AppBundle): string =>
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cursor Workflows</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/assets/app.${app.hash}.css">
</head><body><div id="root"></div>
<script type="module" src="/assets/app.${app.hash}.js"></script>
</body></html>
`;

/** The assets are named after their content: they never change under their name, so a browser may keep them for good. */
const ASSET_HEADERS = { "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" };

function hostAllowed(header: string | undefined): boolean {
  if (!header) return false;
  try {
    return ALLOWED_HOSTS.has(new URL(`http://${header}`).hostname);
  } catch {
    return false;
  }
}

/** Sent with every API answer and stream: a run's state is never cached, and a body is never sniffed into another type. */
const API_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...API_HEADERS });
  res.end(JSON.stringify(body));
}

/** The metrics database, opened read-only the first time it exists: the first run of the kit creates it after the dashboard may already be up. */
class MetricsSource {
  private opening: Promise<Db> | undefined;
  private path: string | undefined;

  /** The database, or undefined while there is none. Requests that arrive while it is being opened share the one connection. */
  async get(): Promise<Db | undefined> {
    const path = defaultDbPath();
    if (!existsSync(path)) return undefined;
    if (this.path !== path) {
      this.close();
      const opening = openDb(path, { readOnly: true });
      this.path = path;
      this.opening = opening;
      opening.catch(() => {
        if (this.opening === opening) this.close(); // a failed open is tried again by the next request
      });
    }
    return this.opening;
  }

  close(): void {
    const opening = this.opening;
    this.opening = undefined;
    this.path = undefined;
    void opening?.then((db) => db.close(), () => undefined);
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

/** How often an open stream looks at its run's log for new lines. The log is a file, possibly on a filesystem that does not report changes. */
const TAIL_POLL_MS = 200;

/** A number from a query parameter, clamped to [min, max]; `fallback` when it is not a number. */
function clamped(raw: string | null, fallback: number, min: number, max: number): number {
  return Math.min(Math.max(Number(raw ?? fallback) || fallback, min), max);
}

/** The id a reader has seen up to, from the `Last-Event-ID` header a reconnecting EventSource sends (it wins) or the `lastEventId` query. Undefined when neither is there; NaN when it is not a whole number of 0 or more. */
function resumeId(req: IncomingMessage, url: URL): number | undefined {
  const raw = req.headers["last-event-id"] ?? url.searchParams.get("lastEventId") ?? undefined;
  if (raw === undefined || Array.isArray(raw)) return undefined;
  return /^\d{1,15}$/.test(raw) ? Number(raw) : Number.NaN;
}

/** Sends the events of `tail` as server-sent events, now and as the run appends them, until the client goes away. */
function stream(req: IncomingMessage, res: ServerResponse, tail: RunTail): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", ...API_HEADERS });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.flushHeaders();
  const pump = () => {
    try {
      const events = tail.poll();
      if (events.length > 0) res.write(events.map(({ id, event }) => `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    } catch {
      res.destroy(); // the log became unreadable: the client reconnects
    }
  };
  pump();
  const timer = setInterval(pump, TAIL_POLL_MS);
  res.once("close", () => clearInterval(timer));
}

export async function startDashboard(options: DashboardOptions): Promise<DashboardServer> {
  const app = await buildApp();
  const page = appPage(app);
  const assets = new Map([
    [`/assets/app.${app.hash}.js`, { type: "text/javascript; charset=utf-8", body: app.js }],
    [`/assets/app.${app.hash}.css`, { type: "text/css; charset=utf-8", body: app.css }],
  ]);
  const metrics = new MetricsSource();
  const prStates = new PrStates(options.prStateCacheMs ?? DEFAULT_PR_STATE_CACHE_MS);

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("host not allowed");
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
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": PAGE_POLICY, "cache-control": "no-cache" });
        res.end(page);
        return;
      case HEALTH_PATH:
        send(res, 200, { app: DASHBOARD_APP, pid: process.pid });
        return;
      case "/api/runs":
        send(res, 200, { runs: listRuns(clamped(url.searchParams.get("limit"), 200, 1, 1000)) });
        return;
      case "/api/board": {
        const runs = listRuns(clamped(url.searchParams.get("limit"), 200, 1, 1000));
        const states = prStates.states(runs.flatMap((run) => run.card?.links.map((link) => link.url) ?? []));
        send(res, 200, { boards: buildBoards(runs, states) });
        return;
      }
      case "/api/summary": {
        const db = await metrics.get();
        send(res, 200, db ? summary(db, clamped(url.searchParams.get("days"), 30, 1, 3650)) : EMPTY_SUMMARY);
        return;
      }
      default: {
        const asset = assets.get(url.pathname);
        if (asset) {
          res.writeHead(200, { "content-type": asset.type, ...ASSET_HEADERS });
          res.end(asset.body);
          return;
        }
        const match = /^\/api\/runs\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
        if (!match) return send(res, 404, { error: "not found" });
        const runId = decodeSegment(match[1]!);
        const rest = match[2];
        if (rest === undefined) {
          const detail = readRun(runId);
          return detail ? send(res, 200, detail) : send(res, 404, { error: "run not found" });
        }
        if (rest === "events") {
          const after = resumeId(req, url);
          if (Number.isNaN(after)) return send(res, 400, { error: "Last-Event-ID must be a whole number: the id of the last event received" });
          const tail = tailRun(runId, { after, content: url.searchParams.get("content") !== "false", stepId: url.searchParams.get("stepId") ?? undefined });
          return tail ? stream(req, res, tail) : send(res, 404, { error: "run not found" });
        }
        const step = /^steps\/([^/]+)\/content$/.exec(rest);
        if (step) {
          const content = readStepContent(runId, decodeSegment(step[1]!));
          return content ? send(res, 200, content) : send(res, 404, { error: "run or step not found" });
        }
        send(res, 404, { error: "not found" });
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
          prStates.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
