// Seam: HTTP, with the job as a real process. A start from the dashboard (`POST /api/start`) spawns the runtime's own detached
// job process (`wf run --job`), which runs a real workflow file in a throwaway repo and registers its run in a throwaway
// `WF_HOME`: the tests wait for that run to show on the board and read its event log. Nothing reaches the Cursor API (the
// workflow takes no steps, and the job gets the fake SDK like every TypeScript child process of the tests).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { postStart } from "../app/start-api.js";
import { type DashboardServer, startDashboard } from "../src/server.js";
import { type Reply, type Sandbox, http, sandbox, writeRun } from "./support.js";

let box: Sandbox;
let dash: DashboardServer;
let jobPids: number[];
let previousEnv: Record<string, string | undefined>;

/** The variables the job process inherits from this one: no metrics database, no dashboard auto-start, and the tests' tsconfig, which swaps in the fake SDK. */
const JOB_ENV = { WF_METRICS: "off", WF_DASH_AUTOSTART: "off", TSX_TSCONFIG_PATH: join(import.meta.dirname, "..", "..", "runtime", "tsconfig.test.json") };

beforeEach(async () => {
  box = sandbox();
  previousEnv = Object.fromEntries(Object.keys(JOB_ENV).map((name) => [name, process.env[name]]));
  Object.assign(process.env, JOB_ENV);
  jobPids = [];
  dash = await startDashboard({ port: 0 });
});
afterEach(async () => {
  for (const pid of jobPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* the job ended on its own, which is what the tests wait for */
    }
  }
  await dash.close();
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  box.dispose();
});

const START = "2026-11-12T10:00:00.000Z";
const CAPS = { maxTokens: 50_000, maxCents: 20 };

const ECHO = `export default {
  meta: {
    name: "echo",
    description: "Echoes its args.",
    argsSchema: { type: "object", required: ["issue"], properties: { issue: { type: "integer" } } },
  },
  async run(ctx) { return { status: "done", args: ctx.args }; },
};
`;

/** A repo the runs index knows, with the `echo` workflow. */
function knownRepo(): string {
  const repo = box.repo("repo");
  mkdirSync(join(repo, ".agents", "workflows"), { recursive: true });
  writeFileSync(join(repo, ".agents", "workflows", "echo.mjs"), ECHO);
  writeRun(box.home, repo, { runId: "echo-earlier01", workflow: "echo", startedAt: START, events: [{ type: "run-end", status: "finished" }] });
  return repo;
}

async function start(body: unknown): Promise<Reply> {
  const token = (await http(dash.url, "/api/csrf")).json.csrfToken as string;
  return http(dash.url, "/api/start", { method: "POST", headers: { "x-csrf-token": token }, body });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `read` until it returns something, or fails after `timeoutMs` (a process that has to load TypeScript and the runtime takes seconds on a loaded machine). */
async function until<T>(what: string, read: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  for (const stop = performance.now() + timeoutMs; ; await sleep(100)) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() > stop) throw new Error(`timed out waiting for ${what}`);
  }
}

/** The job's process, found through its record, so a test that fails halfway does not leave it running. */
function trackJob(repo: string, jobId: string): void {
  const { pid } = JSON.parse(readFileSync(join(repo, ".workflows", "jobs", `${jobId}.json`), "utf8")) as { pid: number };
  jobPids.push(pid);
}

/** The `run-start` event of a run, read from its log: what the job's own process resolved. */
function runStartOf(repo: string, runId: string): { config: { limits: Record<string, number | null> } } {
  const lines = readFileSync(join(repo, ".workflows", "runs", runId, "events.jsonl"), "utf8").split("\n").filter(Boolean);
  return JSON.parse(lines.find((line) => (JSON.parse(line) as { type: string }).type === "run-start")!) as { config: { limits: Record<string, number | null> } };
}

/** Waits for the run to appear on the board and to finish, and returns its card and its detail. */
async function runOnTheBoard(runId: string) {
  const card = await until(`run ${runId} on the board`, async () => {
    const boards = (await http(dash.url, "/api/board")).json.boards as Array<{ cards: Array<{ runId: string; status: string }> }>;
    return boards.flatMap((board) => board.cards).find((c) => c.runId === runId);
  });
  const detail = await until(`run ${runId} to finish`, async () => {
    const reply = await http(dash.url, `/api/runs/${runId}`);
    return reply.json?.status === "finished" ? reply.json : undefined;
  });
  return { card, detail };
}

test("a start with a known repository, a listed workflow, valid args and both caps starts a job whose run shows on the board", async () => {
  const repo = knownRepo();
  const reply = await start({ repo, workflow: "echo", args: { issue: 7 }, ...CAPS });
  assert.equal(reply.status, 202, reply.text);
  const { jobId, runId } = reply.json as { jobId: string; runId: string };
  assert.match(runId, /^echo-[0-9a-f]{8}$/);
  assert.deepEqual(reply.json, { jobId, runId, repo, workflow: "echo" });
  trackJob(repo, jobId);

  const { card, detail } = await runOnTheBoard(runId);
  assert.equal(card.runId, runId);
  assert.equal(detail.workflow, "echo");
  assert.equal(detail.repo, repo);
  assert.deepEqual(detail.start, { args: { issue: 7 }, maxTokens: 50_000, maxCents: 20 }, "the job record keeps how it was started, so a resume can repeat it");
  assert.deepEqual(runStartOf(repo, runId).config.limits.maxTokens, 50_000, "the run runs under the caps the start gave");
  assert.deepEqual(runStartOf(repo, runId).config.limits.maxCents, 20);
});

test("the global caps still apply on top of the caps a start gives: the looser one is cut, and the answer says so", async () => {
  const repo = knownRepo();
  writeFileSync(join(box.home, "config.json"), JSON.stringify({ caps: { maxCents: 5 } }));
  const reply = await start({ repo, workflow: "echo", args: { issue: 7 }, ...CAPS });
  assert.equal(reply.status, 202, reply.text);
  const { jobId, runId, violations } = reply.json as { jobId: string; runId: string; violations: Array<{ message: string }> };
  trackJob(repo, jobId);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /maxCents 20 exceeds the global cap 5: the cap applies/);

  await runOnTheBoard(runId);
  assert.equal(runStartOf(repo, runId).config.limits.maxCents, 5, "the job's own run is capped too");
  assert.equal(runStartOf(repo, runId).config.limits.maxTokens, 50_000);
});

test("a repository whose config the runtime cannot use is refused before a job exists, with the file and the field", async () => {
  const repo = knownRepo();
  writeFileSync(join(repo, ".agents", "workflows", "config.json"), JSON.stringify({ limits: { maxTokens: "lots" } }));
  const reply = await start({ repo, workflow: "echo", args: { issue: 7 }, ...CAPS });
  assert.equal(reply.status, 409, reply.text);
  assert.match(reply.json.error, /^invalid configuration:/);
  assert.match(reply.json.error, /config\.json/);
  assert.equal((await http(dash.url, "/api/runs")).json.runs.length, 1, "no job, so no new run");
});

test("the browser's own client starts a run through the same door: its answer carries the run's id, which the Run view opens", async () => {
  const repo = knownRepo();
  const reply = await postStart({ repo, workflow: "echo", args: { issue: 3 }, ...CAPS }, dash.url);
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.equal(reply.status, 202);
  trackJob(repo, reply.body.jobId);
  const { detail } = await runOnTheBoard(reply.body.runId);
  assert.deepEqual(detail.start, { args: { issue: 3 }, maxTokens: 50_000, maxCents: 20 });
});
