// Seam: HTTP. The dashboard server runs in this process on a random loopback port, against a throwaway per-user home
// (`WF_HOME`) and throwaway repos holding run directories written the way the runtime writes them. Every assertion is on a
// status code, a header or a response body.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { openDb } from "@cursor-workflows/runtime/observe";
import { type DashboardServer, startDashboard } from "../src/server.js";
import { type Sandbox, http, sandbox, writeRun } from "./support.js";

let box: Sandbox;
let dash: DashboardServer;
beforeEach(async () => {
  box = sandbox();
  dash = await startDashboard({ port: 0 });
});
afterEach(async () => {
  await dash.close();
  box.dispose();
});

test("on a machine with no history the API answers with empty states: no runs index, no metrics database", async () => {
  const runs = await http(dash.url, "/api/runs");
  assert.equal(runs.status, 200);
  assert.deepEqual(runs.json, { runs: [] });

  const summary = await http(dash.url, "/api/summary");
  assert.equal(summary.status, 200);
  assert.deepEqual(Object.keys(summary.json).sort(), ["attribution", "contextBuckets", "daily", "models", "savings", "totals", "waste", "workflows"]);
  for (const rows of Object.values(summary.json)) assert.deepEqual(rows, []);

  const page = await http(dash.url, "/");
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-type"]), /text\/html/);
});

test("it binds the IPv4 loopback only, so the link http://127.0.0.1:<port> is the one that works from a Windows browser", async () => {
  assert.match(dash.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const { createConnection } = await import("node:net");
  const reachable = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port: dash.port }, () => (socket.destroy(), resolve(true)));
      socket.once("error", () => resolve(false));
    });
  assert.equal(await reachable("127.0.0.1"), true);
  assert.equal(await reachable("::1"), false, "the server must not listen on the IPv6 loopback");
});

test("the host check lets the loopback names through and refuses any other Host, whatever the path", async () => {
  for (const host of ["127.0.0.1", `127.0.0.1:${dash.port}`, "localhost", `localhost:${dash.port}`]) {
    assert.equal((await http(dash.url, "/api/runs", { host })).status, 200, host);
  }
  for (const host of ["evil.example", `evil.example:${dash.port}`, "127.0.0.1.evil.example", "localhost.evil.example:80", "[::1]", "0.0.0.0"]) {
    for (const path of ["/", "/api/runs", "/api/summary", "/api/health"]) {
      const reply = await http(dash.url, path, { host });
      assert.equal(reply.status, 403, `Host ${JSON.stringify(host)} on ${path}`);
      assert.equal(reply.text, "host not allowed");
    }
  }
});

test("it is read-only and sends no CORS headers", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const reply = await http(dash.url, "/api/runs", { method });
    assert.equal(reply.status, 405, method);
    assert.equal(reply.headers["allow"], "GET, HEAD");
  }
  for (const path of ["/", "/api/runs", "/api/summary", "/nope"]) {
    const reply = await http(dash.url, path);
    assert.equal(reply.headers["access-control-allow-origin"], undefined, path);
  }
  assert.equal((await http(dash.url, "/nope")).status, 404);
});

test("a request with no Host header at all is refused too", async () => {
  const { createConnection } = await import("node:net");
  const answer = await new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: dash.port }, () => socket.write("GET /api/runs HTTP/1.0\r\n\r\n"));
    let received = "";
    socket.on("data", (c) => (received += c));
    socket.once("close", () => resolve(received));
    socket.once("error", reject);
  });
  assert.match(answer, /^HTTP\/1\.1 403 /);
});

// ---- the runs index and the projection of each run ----

const T0 = Date.parse("2026-01-10T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const USAGE = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 20, totalTokens: 110 };
const stepEnd = { type: "step-end", attemptId: "a1", stepId: "s-1", parentId: null, groupId: null, stepKey: "k1", label: "do", ok: true, cached: false, chargedCents: 3, rawCents: 5, usage: USAGE };

/** Four runs in two repos: finished, running (a live process holds its lock), cancelled, and interrupted (no run-end, nobody executing). */
function seedRuns(): { a: string; b: string } {
  const a = box.repo("repo-a");
  const b = box.repo("repo-b");
  writeRun(box.home, a, {
    runId: "smoke-aaaa0001",
    workflow: "smoke",
    startedAt: at(0),
    events: [{ type: "phase", title: "work" }, { type: "log", message: "hello" }, stepEnd, { type: "run-end", status: "finished", result: { status: "done" } }],
  });
  writeRun(box.home, b, { runId: "implement-issue-bbbb0002", workflow: "implement-issue", startedAt: at(10), events: [{ type: "phase", title: "implement" }], lockedBy: process.ppid });
  writeRun(box.home, a, { runId: "smoke-cccc0003", workflow: "smoke", startedAt: at(20), events: [{ type: "run-end", status: "cancelled", error: "cancelled by the user" }] });
  writeRun(box.home, b, { runId: "implement-issue-dddd0004", workflow: "implement-issue", startedAt: at(30), events: [{ type: "phase", title: "triage" }] });
  return { a, b };
}

test("GET /api/runs lists the runs of every repo from the global runs index, newest first, each with its status read from its event log", async () => {
  const { a, b } = seedRuns();
  const { status, json } = await http(dash.url, "/api/runs");
  assert.equal(status, 200);
  assert.deepEqual(
    json.runs.map((r: any) => [r.runId, r.repo, r.workflow, r.status, r.phase, r.startedAt]),
    [
      ["implement-issue-dddd0004", b, "implement-issue", "failed", "triage", at(30)],
      ["smoke-cccc0003", a, "smoke", "cancelled", undefined, at(20)],
      ["implement-issue-bbbb0002", b, "implement-issue", "running", "implement", at(10)],
      ["smoke-aaaa0001", a, "smoke", "finished", "work", at(0)],
    ],
  );
  const [interrupted, cancelled, running, finished] = json.runs;
  assert.match(interrupted.error, /ended without finishing.*resumeRunId="implement-issue-dddd0004"/, "a run nobody executes and that never ended is failed, with how to resume it");
  assert.equal(cancelled.error, "cancelled by the user");
  assert.equal(running.finishedAt, undefined);
  assert.equal(finished.finishedAt, new Date(T0 + 4000).toISOString(), "the run-end's timestamp (the fixture spaces a run's events one second apart)");
  assert.deepEqual([finished.spentCents, finished.chargedCents, finished.spentTokens], [5, 3, 110], "spend replayed from the log");
});

test("GET /api/runs/:runId serves the projection of one run: progress lines, result and token usage", async () => {
  seedRuns();
  const { status, json } = await http(dash.url, "/api/runs/smoke-aaaa0001");
  assert.equal(status, 200);
  assert.equal(json.runId, "smoke-aaaa0001");
  assert.equal(json.status, "finished");
  assert.deepEqual(json.result, { status: "done" });
  assert.deepEqual(json.recent, ["== work", "hello", "✓ do 5¢ cache-read 60"]);
  assert.deepEqual(json.usage, { ...USAGE, cacheHitRatio: 0.6 });

  const running = await http(dash.url, "/api/runs/implement-issue-bbbb0002");
  assert.equal(running.json.status, "running");
  assert.deepEqual(running.json.recent, ["== implement"]);
});

test("a run that was resumed is one run: the first start, the latest execution's state, the spend of all of them", async () => {
  const repo = box.repo("repo-resumed");
  writeRun(box.home, repo, {
    runId: "smoke-eeee0005",
    workflow: "smoke",
    startedAt: at(0),
    events: [
      { type: "run-end", status: "failed", error: "Cost cap reached" },
      { type: "run-start", workflow: "smoke" },
      { type: "phase", title: "second try" },
      { ...stepEnd, attemptId: "a2", rawCents: 7, chargedCents: 7 },
      { type: "run-end", status: "finished", result: "ok" },
    ],
  });
  const run = (await http(dash.url, "/api/runs/smoke-eeee0005")).json;
  assert.equal(run.executions, 2);
  assert.equal(run.startedAt, at(0));
  assert.equal(run.status, "finished");
  assert.equal(run.error, undefined, "the failure belongs to the earlier execution");
  assert.equal(run.phase, "second try");
  assert.equal(run.spentCents, 7);
});

test("a run the index does not know is a 404, and the run id is never a path", async () => {
  seedRuns();
  for (const id of ["nope", "..%2F..%2Fetc%2Fpasswd", "%00", "%E0%A4%A", "smoke-aaaa0001%2F..", ""]) {
    const reply = await http(dash.url, `/api/runs/${id}`);
    assert.equal(reply.status, 404, id);
    assert.deepEqual(Object.keys(reply.json), ["error"]);
  }
});

test("a run whose log is gone is listed as missing, and reading runs never creates a directory in a repo", async () => {
  const gone = box.repo("repo-gone");
  writeRun(box.home, gone, { runId: "smoke-ffff0006", workflow: "smoke", startedAt: at(0), withoutLog: true });
  const runs = (await http(dash.url, "/api/runs")).json.runs;
  assert.deepEqual(runs.map((r: any) => [r.runId, r.status, r.executions]), [["smoke-ffff0006", "missing", 0]]);
  assert.match(runs[0].error, /no run-start in .*events\.jsonl/);
  assert.equal((await http(dash.url, "/api/runs/smoke-ffff0006")).json.status, "missing");
  assert.equal(existsSync(join(gone, ".workflows")), false, "the dashboard only reads");
});

test("?limit= caps how many runs are read, newest first", async () => {
  seedRuns();
  const two = (await http(dash.url, "/api/runs?limit=2")).json.runs;
  assert.deepEqual(two.map((r: any) => r.runId), ["implement-issue-dddd0004", "smoke-cccc0003"]);
  assert.equal((await http(dash.url, "/api/runs?limit=junk")).json.runs.length, 4, "a limit that is not a number is the default");
});

test("GET /api/summary starts answering from the metrics database as soon as the first run creates it, without a restart", async () => {
  const before = (await http(dash.url, "/api/summary")).json;
  assert.deepEqual(before.totals, []);

  const db = await openDb(join(box.home, "metrics.db")); // what the first run does
  try {
    const after = await http(dash.url, "/api/summary?days=7");
    assert.equal(after.status, 200);
    assert.deepEqual(Object.keys(after.json).sort(), Object.keys(before).sort(), "the empty state has the shape of a real summary");
    assert.equal(after.json.totals.length, 1, "an empty database still has its totals row");
    assert.equal(after.json.totals[0].runs, 0);
  } finally {
    db.close();
  }
});

test("requests that arrive together as the metrics database first appears share one connection to it", async (t) => {
  if (!existsSync("/proc/self/fd")) return t.skip("counts open file descriptors through /proc");
  const path = join(box.home, "metrics.db");
  const db = await openDb(path);
  try {
    const replies = await Promise.all(Array.from({ length: 12 }, () => http(dash.url, "/api/summary")));
    assert.deepEqual(replies.map((r) => r.status), Array(12).fill(200));
    const open = readdirSync("/proc/self/fd").filter((fd) => {
      try {
        return readlinkSync(join("/proc/self/fd", fd)) === path;
      } catch {
        return false;
      }
    });
    assert.equal(open.length, 2, "one connection of this test, one of the dashboard: a handle opened and dropped would show up here");
  } finally {
    db.close();
  }
});

test("serving the dashboard never loads the Cursor SDK: a process that stays up for days does not carry hundreds of megabytes it never uses", async () => {
  await http(dash.url, "/api/summary");
  await http(dash.url, "/api/runs");
  assert.equal((globalThis as { __fakeSdkLoaded?: boolean }).__fakeSdkLoaded, undefined, "something the dashboard imports pulls in @cursor/sdk");
});
