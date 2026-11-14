// The dashboard's HTTP server: a JSON API over the runs of every repo and the metrics database, plus the web app that draws
// them (its two pages, built at start, see web-bundle.ts). It reads, with one action: cancelling a run.
//
// - It listens on 127.0.0.1 only and refuses any `Host` that is not a loopback name (DNS rebinding protection). It sends
//   no CORS headers, so another site's script cannot read it.
// - The one POST is `/api/runs/<runId>/cancel`. It needs the CSRF token (`/api/csrf`, one random value per dashboard process)
//   in the `X-CSRF-Token` header, which only a script that can read an answer of this origin has, and it refuses a request
//   that says it comes from another origin. It ends in `cancelRun`, which is `wf cancel`'s path (`cancelJob`).
// - It reads: the global runs index and each run's event log (`@cursor-workflows/runtime/observe`), and the metrics
//   database, opened read-only the first time it exists. A machine with no history gets empty states, not an error.
// - A run's event log is also served live: `/api/runs/<runId>/events` is a Server-Sent Events stream that replays the log and
//   then follows it as the run appends, and `/api/runs/<runId>/steps/<stepId>/content` is one step's content.
// - The Board is `/api/board`: the runs placed in the columns of their workflow, with the state of the pull requests and merge requests their cards link to.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { DASHBOARD_APP, DASHBOARD_HOST, HEALTH_PATH, type Db, dashboardUrl, type RunTail, cancelRun, defaultDbPath, leftAgentsNote, listRuns, openDb, readRun, readStepContent, summary, tailRun } from "@cursor-workflows/runtime/observe";
import { buildBoards } from "./board.js";
import { PAGE_POLICY, assetPath, pageHtml } from "./pages.js";
import { PrStates } from "./pr-state.js";
import { type PageName, buildWeb } from "./web-bundle.js";

/** Host names a request may carry: the loopback names. Anything else is a page of another site asking the browser to talk to us. */
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** What `/api/summary` answers on a machine with no metrics database yet: every table empty. */
const EMPTY_SUMMARY = { totals: [], workflows: [], models: [], contextBuckets: [], daily: [], waste: [], savings: [], attribution: [] };

export interface DashboardServer {
  /** The server's origin, `http://127.0.0.1:<port>`. */
  url: string;
  port: number;
  /** The content hash of the pages' build it serves (see web-bundle.ts), built or read from the cache before it listened. */
  webHash: string;
  close(): Promise<void>;
}

export interface DashboardOptions {
  /** The port to listen on; 0 picks a free one (tests). */
  port: number;
  /** How long the state of an open pull request or merge request is kept before its forge (`gh`, `glab`) is asked again, in milliseconds (a merged or closed one is kept 120 times as long). Default 30 seconds. */
  prStateCacheMs?: number;
  /** How long a cancel waits for the job to stop before it answers that the job is still stopping, in milliseconds. Default 20 seconds, what `cancel_workflow` waits. */
  cancelTimeoutMs?: number;
}

const DEFAULT_PR_STATE_CACHE_MS = 30_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 20_000;

/** The assets are named after their content: they never change under their name, so a browser may keep them for good. */
const ASSET_HEADERS = { "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" };

/** A page: its HTML names the build's assets, so it is fetched again every time to see a new build. */
function sendPage(req: IncomingMessage, res: ServerResponse, page: PageName, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": PAGE_POLICY[page], "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(req.method === "HEAD" ? undefined : html);
}

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

/** How many runs `/api/runs` and `/api/board` read: the `limit` query, 200 by default, from 1 to 1000. */
const runsLimit = (url: URL): number => clamped(url.searchParams.get("limit"), 200, 1, 1000);

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

/** Whether `candidate` is the CSRF token, compared in constant time. */
function sameToken(candidate: string | string[] | undefined, token: string): boolean {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether a request that carries `Origin` or `Sec-Fetch-Site` comes from a page of this dashboard (a request with neither is a script or a tool, which the token covers). */
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    const { protocol, hostname, port } = new URL(origin);
    return protocol === "http:" && ALLOWED_HOSTS.has(hostname) && port === String(req.socket.localPort);
  } catch {
    return false; // `null`, or not an origin
  }
}

export async function startDashboard(options: DashboardOptions): Promise<DashboardServer> {
  const web = await buildWeb();
  const appPage = pageHtml("app", web.hash, "Cursor Workflows");
  const assets = new Map(
    Object.entries(web.files).map(([file, body]) => [assetPath(file, web.hash), { type: file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", body }]),
  );
  const metrics = new MetricsSource();
  const prStates = new PrStates(options.prStateCacheMs ?? DEFAULT_PR_STATE_CACHE_MS);
  const csrfToken = randomBytes(32).toString("hex");
  const cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;

  /** The cancel action: the token and the origin first, then `cancelRun`, and an answer that says what it did. */
  async function cancel(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    if (!sameOrigin(req) || !sameToken(req.headers["x-csrf-token"], csrfToken)) {
      return send(res, 403, { error: "csrf token missing or wrong" });
    }
    const outcome = await cancelRun(runId, cancelTimeoutMs);
    switch (outcome.kind) {
      case "unknown-run":
        return send(res, 404, { error: "run not found" });
      case "not-running": {
        // No process to signal; the cloud agents a dead process left running were reached through the Cursor API.
        const left = leftAgentsNote({ cancelled: outcome.cancelledAgents, failed: outcome.cloudErrors ?? [] });
        if (left) return send(res, 200, { runId, status: outcome.status, note: `the run is not running (${outcome.status})${left}` });
        return send(res, 409, { error: `the run is not running (${outcome.status}); nothing to cancel` });
      }
      case "no-job":
        return send(res, 409, { error: "the run was not started as a job (wf run in a terminal), so the dashboard cannot stop it: press Ctrl-C in that terminal" });
      case "signalled": {
        const { jobId, runId: id, status, note } = outcome.result;
        return send(res, 200, { jobId, runId: id, status, note });
      }
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("host not allowed");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${DASHBOARD_HOST}`);
    if (req.method === "POST") {
      const target = /^\/api\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
      if (target) return cancel(req, res, decodeSegment(target[1]!));
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      send(res, 405, { error: "method not allowed" });
      return;
    }
    switch (url.pathname) {
      case "/":
        return sendPage(req, res, "app", appPage);
      case HEALTH_PATH:
        send(res, 200, { app: DASHBOARD_APP, pid: process.pid });
        return;
      case "/api/csrf":
        send(res, 200, { csrfToken });
        return;
      case "/api/runs":
        send(res, 200, { runs: listRuns(runsLimit(url)) });
        return;
      case "/api/board": {
        const runs = listRuns(runsLimit(url));
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
          res.end(req.method === "HEAD" ? undefined : asset.body);
          return;
        }
        const page = /^\/runs\/([^/]+)$/.exec(url.pathname);
        if (page) return sendPage(req, res, "run", pageHtml("run", web.hash, `Run ${decodeSegment(page[1]!)} · cursor-workflows`));
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
        if (rest === "cancel") {
          res.setHeader("allow", "POST");
          return send(res, 405, { error: "method not allowed" });
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
    url: dashboardUrl(port),
    port,
    webHash: web.hash,
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
