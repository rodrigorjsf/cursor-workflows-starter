// Seam: HTTP. The run Board and what it is made of: the card a workflow sets (`ctx.card`), the phases it declares, and how a
// run's state decides its column. The dashboard server runs in this process on a random loopback port, against a throwaway
// per-user home and throwaway repos holding run directories written the way the runtime writes them; every assertion is on
// a status code or a response body.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
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

const T0 = Date.parse("2026-01-10T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const card = (fields: Record<string, unknown>) => ({ type: "card", ...fields });
const runsById = async () => Object.fromEntries(((await http(dash.url, "/api/runs")).json.runs as any[]).map((r) => [r.runId, r]));

test("a run's card is the latest card its log holds, across every execution of the run", async () => {
  const repo = box.repo("repo");
  writeRun(box.home, repo, {
    runId: "implement-issue-aaaa0001",
    workflow: "implement-issue",
    startedAt: at(0),
    events: [
      card({ title: "#7 Add subtract", badges: ["LOW"] }),
      card({ title: "#7 Add subtract", subtitle: "wf/issue-7", badges: ["LOW", "2 slices"], links: [{ label: "PR #9", url: "https://github.com/o/r/pull/9" }] }),
      { type: "run-end", status: "failed", error: "Cost cap reached" },
      { type: "run-start", workflow: "implement-issue" }, // a resume that sets no card of its own: the run is still the same card
      { type: "phase", title: "Delivery" },
    ],
  });
  writeRun(box.home, repo, { runId: "smoke-bbbb0002", workflow: "smoke", startedAt: at(5), events: [{ type: "phase", title: "Ping" }] });

  const runs = await runsById();
  assert.deepEqual(runs["implement-issue-aaaa0001"].card, {
    title: "#7 Add subtract",
    subtitle: "wf/issue-7",
    links: [{ label: "PR #9", url: "https://github.com/o/r/pull/9" }],
    badges: ["LOW", "2 slices"],
  });
  assert.equal(runs["smoke-bbbb0002"].card, undefined, "a workflow that sets no card has none: the Board falls back to the run id");

  const detail = (await http(dash.url, "/api/runs/implement-issue-aaaa0001")).json;
  assert.equal(detail.card.title, "#7 Add subtract", "the single-run answer carries it too");
});

test("what a log says about a card is not trusted: only http and https links are kept, items of the wrong type are dropped, and a card with no title is no card", async () => {
  const repo = box.repo("repo");
  writeRun(box.home, repo, {
    runId: "smoke-aaaa0001",
    workflow: "smoke",
    startedAt: at(0),
    events: [
      card({ title: "good", badges: ["kept"] }),
      card({
        title: "hostile",
        subtitle: 42,
        links: [
          { label: "script", url: "javascript:alert(1)" },
          { label: "data", url: "data:text/html,<script>1</script>" },
          { label: "not a url", url: "nope" },
          { label: "ftp", url: "ftp://example.com/x" },
          { label: 7, url: "https://example.com/seven" },
          "https://example.com/bare",
          { label: "fine", url: "https://example.com/fine" },
          { label: "plain", url: "http://example.com/plain" },
        ],
        badges: ["ok", 1, null, { label: "obj" }, "also ok"],
      }),
      card({ title: "", badges: ["no title"] }),
      card({ subtitle: "no title either" }),
      card("not an object"),
    ],
  });
  const run = (await runsById())["smoke-aaaa0001"];
  assert.deepEqual(run.card, {
    title: "hostile",
    links: [
      { label: "fine", url: "https://example.com/fine" },
      { label: "plain", url: "http://example.com/plain" },
    ],
    badges: ["ok", "also ok"],
  });
});

test("a card's text is bounded: a log cannot make the Board carry a megabyte of title", async () => {
  const repo = box.repo("repo");
  writeRun(box.home, repo, {
    runId: "smoke-aaaa0001",
    workflow: "smoke",
    startedAt: at(0),
    events: [card({ title: "t".repeat(5000), subtitle: "s".repeat(5000), badges: Array.from({ length: 50 }, (_, i) => `b${i}`.repeat(100)), links: Array.from({ length: 50 }, (_, i) => ({ label: "l".repeat(500), url: `https://example.com/${i}` })) })],
  });
  const c = (await runsById())["smoke-aaaa0001"].card;
  assert.ok(c.title.length <= 200 && c.title.endsWith("…"), `title ${c.title.length}`);
  assert.ok(c.subtitle.length <= 200);
  assert.ok(c.badges.length <= 8 && c.badges.every((b: string) => b.length <= 40));
  assert.ok(c.links.length <= 8 && c.links.every((l: any) => l.label.length <= 80));
});

test("a run lists its phases: the ones its workflow declared in the run-start, then any other it entered; and how a finished run is classed", async () => {
  const repo = box.repo("repo");
  writeRun(box.home, repo, {
    runId: "implement-issue-aaaa0001",
    workflow: "implement-issue",
    startedAt: at(0),
    phases: ["Triage", "Plan", "Implementation"],
    events: [{ type: "phase", title: "Triage" }, { type: "phase", title: "Extra" }, { type: "phase", title: "Implementation" }, { type: "run-end", status: "finished", outcomeStatus: "seams-proposed", result: { status: "seams-proposed" } }],
  });
  writeRun(box.home, repo, { runId: "smoke-bbbb0002", workflow: "smoke", startedAt: at(1), events: [{ type: "phase", title: "Ping" }, { type: "phase", title: "Ping" }] });
  writeRun(box.home, repo, { runId: "smoke-cccc0003", workflow: "smoke", startedAt: at(2), phases: ["Ping"], events: [{ type: "run-end", status: "finished", outcomeStatus: "done", result: { status: "done" } }] });
  writeRun(box.home, repo, { runId: "smoke-dddd0004", workflow: "smoke", startedAt: at(3), events: [{ type: "run-end", status: "finished", outcomeStatus: "baseline-red", result: { status: "baseline-red" } }] });
  writeRun(box.home, repo, { runId: "smoke-eeee0005", workflow: "smoke", startedAt: at(4), events: [{ type: "run-end", status: "failed", error: "boom" }] });

  const runs = await runsById();
  assert.deepEqual(runs["implement-issue-aaaa0001"].phases, ["Triage", "Plan", "Implementation", "Extra"]);
  assert.deepEqual(runs["smoke-bbbb0002"].phases, ["Ping"], "an older log declares none: the phases the run entered");
  assert.deepEqual(runs["smoke-cccc0003"].phases, ["Ping"], "declared but never entered");
  const outcomes = (...ids: string[]) => ids.map((id) => runs[id].outcome);
  assert.deepEqual(
    outcomes("implement-issue-aaaa0001", "smoke-bbbb0002", "smoke-cccc0003", "smoke-dddd0004", "smoke-eeee0005"),
    ["pending", undefined, "delivered", "failed", "error"],
    "the class of the latest execution's ending; none while it runs",
  );
});

// ---- the Board: one per workflow, a column per phase plus the four ends, a card per run ----

const boardOf = async (workflow: string) => ((await http(dash.url, "/api/board")).json.boards as any[]).find((b) => b.workflow === workflow);
const placed = (board: any) => Object.fromEntries(board.cards.map((c: any) => [c.runId, c.column]));
const END_COLUMNS = [
  { key: "awaiting-approval", title: "Awaiting approval", kind: "awaiting-approval" },
  { key: "done", title: "Done", kind: "done" },
  { key: "failed", title: "Failed", kind: "failed" },
  { key: "cancelled", title: "Cancelled", kind: "cancelled" },
];

test("on a machine with no runs the Board is empty, not an error", async () => {
  const reply = await http(dash.url, "/api/board");
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.json, { boards: [] });
});

test("each workflow has its own Board: the workflow's phases in order, then Awaiting approval, Done, Failed and Cancelled", async () => {
  const repo = box.repo("repo");
  writeRun(box.home, repo, { runId: "implement-issue-aaaa0001", workflow: "implement-issue", startedAt: at(0), phases: ["Triage", "Plan", "Implementation", "Review", "Delivery"], events: [{ type: "phase", title: "Triage" }], lockedBy: process.ppid });
  writeRun(box.home, repo, { runId: "smoke-bbbb0002", workflow: "smoke", startedAt: at(1), phases: ["Ping"], events: [{ type: "phase", title: "Ping" }], lockedBy: process.ppid });

  const boards = (await http(dash.url, "/api/board")).json.boards as any[];
  assert.deepEqual(boards.map((b) => b.workflow), ["smoke", "implement-issue"], "the workflow with the newest run first");
  assert.deepEqual(boards[0].columns, [{ key: "phase:Ping", title: "Ping", kind: "phase" }, ...END_COLUMNS]);
  assert.deepEqual(
    boards[1].columns.map((c: any) => c.title),
    ["Triage", "Plan", "Implementation", "Review", "Delivery", "Awaiting approval", "Done", "Failed", "Cancelled"],
  );
});

test("a run sits in the column of its state: its phase while it runs, then Awaiting approval, Done, Failed or Cancelled", async () => {
  const repo = box.repo("repo");
  const smoke = (runId: string, minutes: number, events: any[], more: Record<string, unknown> = {}) => writeRun(box.home, repo, { runId, workflow: "smoke", startedAt: at(minutes), phases: ["Ping", "Pong"], events, ...more });
  smoke("smoke-running0001", 0, [{ type: "phase", title: "Pong" }], { lockedBy: process.ppid });
  smoke("smoke-nophase0002", 1, [], { lockedBy: process.ppid });
  smoke("smoke-delivered03", 2, [{ type: "run-end", status: "finished", outcomeStatus: "done", result: { status: "done" } }]);
  smoke("smoke-pending0004", 3, [{ type: "run-end", status: "finished", outcomeStatus: "seams-proposed", result: { status: "seams-proposed" } }]);
  smoke("smoke-notdone0005", 4, [{ type: "run-end", status: "finished", outcomeStatus: "baseline-red", result: { status: "baseline-red" } }]);
  smoke("smoke-nostatus006", 5, [{ type: "run-end", status: "finished", result: "all good" }]);
  smoke("smoke-errored0007", 6, [{ type: "run-end", status: "failed", error: "Cost cap reached" }]);
  smoke("smoke-cancelled08", 7, [{ type: "run-end", status: "cancelled", error: "cancelled by the user" }]);
  smoke("smoke-died000009", 8, [{ type: "phase", title: "Ping" }]); // no run-end and nobody executing it
  writeRun(box.home, repo, { runId: "smoke-gone000010", workflow: "smoke", startedAt: at(9), withoutLog: true });

  assert.deepEqual(placed(await boardOf("smoke")), {
    "smoke-running0001": "phase:Pong",
    "smoke-nophase0002": "phase:Ping",
    "smoke-delivered03": "done",
    "smoke-pending0004": "awaiting-approval",
    "smoke-notdone0005": "failed",
    "smoke-nostatus006": "done",
    "smoke-errored0007": "failed",
    "smoke-cancelled08": "cancelled",
    "smoke-died000009": "failed",
  });
});

test("the cards of a Board are newest first, and say what the run is: its card, its state and what it has cost", async () => {
  const repo = box.repo("repo");
  writeRun(box.home, repo, {
    runId: "implement-issue-aaaa0001",
    workflow: "implement-issue",
    startedAt: at(0),
    events: [card({ title: "#7 Add subtract", badges: ["LOW"] }), { type: "phase", title: "Review" }, { type: "step-end", attemptId: "a1", stepId: "s-1", parentId: null, groupId: null, stepKey: "k", label: "do", ok: true, cached: false, chargedCents: 3, rawCents: 5 }],
    lockedBy: process.ppid,
  });
  writeRun(box.home, repo, { runId: "implement-issue-bbbb0002", workflow: "implement-issue", startedAt: at(1), events: [{ type: "run-end", status: "cancelled", error: "cancelled by the user" }] });

  const board = await boardOf("implement-issue");
  assert.deepEqual(board.cards.map((c: any) => c.runId), ["implement-issue-bbbb0002", "implement-issue-aaaa0001"]);
  const [cancelled, running] = board.cards;
  assert.deepEqual(
    { ...running, repo: undefined },
    {
      runId: "implement-issue-aaaa0001",
      repo: undefined,
      status: "running",
      column: "phase:Review",
      startedAt: at(0),
      phase: "Review",
      spentCents: 5,
      chargedCents: 3,
      card: { title: "#7 Add subtract", links: [], badges: ["LOW"] },
    },
  );
  assert.equal(running.repo, repo);
  assert.equal(cancelled.card, undefined, "no card of its own: the Board shows the run id");
  assert.equal(cancelled.error, "cancelled by the user");
  assert.equal(cancelled.finishedAt, new Date(T0 + 60_000 + 1000).toISOString());
});

test("a phase a run entered that its workflow did not declare gets a column too, after the declared ones; a workflow with no phases at all has one column, Running", async () => {
  const repo = box.repo("repo");
  writeRun(box.home, repo, { runId: "smoke-aaaa0001", workflow: "smoke", startedAt: at(0), phases: ["Ping"], events: [{ type: "phase", title: "Surprise" }], lockedBy: process.ppid });
  writeRun(box.home, repo, { runId: "bare-bbbb0002", workflow: "bare", startedAt: at(1), events: [{ type: "log", message: "hi" }], lockedBy: process.ppid });
  writeRun(box.home, repo, { runId: "bare-cccc0003", workflow: "bare", startedAt: at(2), events: [{ type: "run-end", status: "finished", outcomeStatus: "done", result: { status: "done" } }] });

  const smoke = await boardOf("smoke");
  assert.deepEqual(smoke.columns.slice(0, -4).map((c: any) => c.title), ["Ping", "Surprise"]);
  assert.equal(placed(smoke)["smoke-aaaa0001"], "phase:Surprise");

  const bare = await boardOf("bare");
  assert.deepEqual(bare.columns, [{ key: "running", title: "Running", kind: "phase" }, ...END_COLUMNS]);
  assert.deepEqual(placed(bare), { "bare-bbbb0002": "running", "bare-cccc0003": "done" });
});

test("the Board follows the log: a run moves to the next column as its events are appended", async () => {
  const repo = box.repo("repo");
  writeRun(box.home, repo, { runId: "smoke-aaaa0001", workflow: "smoke", startedAt: at(0), phases: ["Ping"], events: [], lockedBy: process.ppid });
  assert.equal(placed(await boardOf("smoke"))["smoke-aaaa0001"], "phase:Ping");

  const { appendLog, eventLine } = await import("./support.js");
  appendLog(repo, "smoke-aaaa0001", eventLine("smoke-aaaa0001", at(1), { type: "run-end", status: "finished", outcomeStatus: "done", result: { status: "done" } }) + "\n");
  assert.equal(placed(await boardOf("smoke"))["smoke-aaaa0001"], "done");
});

test("?limit= bounds how many runs the Board reads, newest first", async () => {
  const repo = box.repo("repo");
  for (let i = 0; i < 5; i++) writeRun(box.home, repo, { runId: `smoke-aaaa000${i}`, workflow: "smoke", startedAt: at(i), events: [{ type: "run-end", status: "finished", outcomeStatus: "done", result: { status: "done" } }] });
  const board = ((await http(dash.url, "/api/board?limit=2")).json.boards as any[])[0];
  assert.deepEqual(board.cards.map((c: any) => c.runId), ["smoke-aaaa0004", "smoke-aaaa0003"]);
});

test("a run's log is read again only when it has changed: polling the Board does not re-read every finished run", async () => {
  const repo = box.repo("repo");
  const done = [{ type: "run-end", status: "finished", outcomeStatus: "done", result: { status: "done" } }];
  writeRun(box.home, repo, { runId: "smoke-aaaa0001", workflow: "smoke", startedAt: at(0), phases: ["Ping"], events: [card({ title: "first" }), ...done] });
  const { logPath } = await import("./support.js");
  const log = logPath(repo, "smoke-aaaa0001");
  assert.equal(((await http(dash.url, "/api/board")).json.boards[0].cards[0].card.title), "first");

  // The same bytes' length and the same modification time: as far as the file system says, nothing happened to it.
  const { readFileSync, statSync, utimesSync, writeFileSync } = await import("node:fs");
  const { mtime, size } = statSync(log);
  writeFileSync(log, readFileSync(log, "utf8").replace('"first"', '"FIRST"'));
  utimesSync(log, mtime, mtime);
  assert.equal(statSync(log).size, size);
  assert.equal(((await http(dash.url, "/api/board")).json.boards[0].cards[0].card.title), "first", "served from what was read, not read again");

  // Any change the run makes shows: it appends, and the size and the time move.
  const { appendLog, eventLine } = await import("./support.js");
  appendLog(repo, "smoke-aaaa0001", eventLine("smoke-aaaa0001", at(1), { type: "card", title: "second" }) + "\n");
  assert.equal(((await http(dash.url, "/api/board")).json.boards[0].cards[0].card.title), "second");
});
