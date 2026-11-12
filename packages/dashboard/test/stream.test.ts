// Seam: HTTP and Server-Sent Events. The dashboard server runs in this process on a random loopback port, against a throwaway
// per-user home (`WF_HOME`) and throwaway repos whose run logs the tests write and append to the way the runtime does. Every
// assertion is on a status code, a header, a response body or the frames of a stream.
import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { type DashboardServer, startDashboard } from "../src/server.js";
import { type Frame, type Sandbox, type Stream, appendLog, eventLine, http, logPath, openStream, sandbox, writeRun } from "./support.js";

let box: Sandbox;
let dash: DashboardServer;
let open: Stream[];
beforeEach(async () => {
  box = sandbox();
  dash = await startDashboard({ port: 0 });
  open = [];
});
afterEach(async () => {
  for (const stream of open) stream.close();
  await dash.close();
  box.dispose();
});

const T0 = Date.parse("2026-01-10T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const RUN = "smoke-aaaa0001";

/** A stream of `path` that the test closes at its end. */
async function stream(path: string, opts: Parameters<typeof openStream>[2] = {}): Promise<Stream> {
  const opened = await openStream(dash.url, path, opts);
  open.push(opened);
  return opened;
}

/** The event each frame carries, as `[id, type]`. */
const brief = (frames: Frame[]) => frames.map((f) => [f.id, JSON.parse(f.data).type]);

/** A running run of repo `name` whose log holds a run-start, a phase and a log line (lines 1 to 3). */
function seedRun(name = "repo"): string {
  const repo = box.repo(name);
  writeRun(box.home, repo, { runId: RUN, workflow: "smoke", startedAt: at(0), lockedBy: process.ppid, events: [{ type: "phase", title: "work" }, { type: "log", message: "hello" }] });
  return repo;
}

test("GET /api/runs/:runId/events replays the run's log as server-sent events, one per event, each with its line number as id", async () => {
  seedRun();
  const live = await stream(`/api/runs/${RUN}/events`);
  assert.equal(live.status, 200);
  assert.match(String(live.headers["content-type"]), /^text\/event-stream/);
  assert.equal(live.headers["cache-control"], "no-store");

  const frames = await live.take(3);
  assert.deepEqual(brief(frames), [["1", "run-start"], ["2", "phase"], ["3", "log"]]);
  assert.deepEqual(JSON.parse(frames[2]!.data), { v: 1, ts: at(2), runId: RUN, type: "log", message: "hello" }, "the event as the log has it");
});

test("a run the index does not know has no stream: 404, and the run id is never a path", async () => {
  seedRun();
  for (const id of ["nope", "..%2F..%2Fetc%2Fpasswd", "%00", "%E0%A4%A"]) {
    const reply = await http(dash.url, `/api/runs/${id}/events`);
    assert.equal(reply.status, 404, id);
    assert.deepEqual(Object.keys(reply.json), ["error"]);
  }
});

test("a stream follows the log as events are appended: the replay first, then each new event with the next id", async () => {
  const repo = seedRun();
  const live = await stream(`/api/runs/${RUN}/events`);
  await live.take(3);

  appendLog(repo, RUN, `${eventLine(RUN, at(3), { type: "phase", title: "review" })}\n`);
  assert.deepEqual(brief(await live.take(1)), [["4", "phase"]]);

  appendLog(repo, RUN, `${eventLine(RUN, at(4), { type: "log", message: "one" })}\n${eventLine(RUN, at(5), { type: "log", message: "two" })}\n`);
  assert.deepEqual(brief(await live.take(2)), [["5", "log"], ["6", "log"]]);
  assert.deepEqual(await live.within(150), [], "nothing is sent when nothing is appended");
});

test("a line is sent only when it is complete: half a line written waits for its newline", async () => {
  const repo = seedRun();
  const live = await stream(`/api/runs/${RUN}/events`);
  await live.take(3);

  const line = eventLine(RUN, at(3), { type: "log", message: "split in two writes" });
  appendLog(repo, RUN, line.slice(0, 20));
  assert.deepEqual(await live.within(400), [], "half a line is not an event");
  appendLog(repo, RUN, `${line.slice(20)}\n`);
  const [frame] = await live.take(1);
  assert.equal(frame!.id, "4");
  assert.equal(JSON.parse(frame!.data).message, "split in two writes");
});

test("a line that a crash cut short is skipped once the next append closes it, and still counts in the ids", async () => {
  const repo = seedRun();
  appendLog(repo, RUN, eventLine(RUN, at(3), { type: "log", message: "cut by a crash" }).slice(0, 30)); // line 4, no newline
  const live = await stream(`/api/runs/${RUN}/events`);
  assert.deepEqual(brief(await live.take(3)), [["1", "run-start"], ["2", "phase"], ["3", "log"]]);
  assert.deepEqual(await live.within(200), [], "the torn tail is not sent");

  appendLog(repo, RUN, `\n${eventLine(RUN, at(4), { type: "log", message: "after the crash" })}\n`); // what appendJsonl writes
  const [frame] = await live.take(1);
  assert.equal(frame!.id, "5", "the damaged line was line 4");
  assert.equal(JSON.parse(frame!.data).message, "after the crash");
});

// ---- resuming from an event id ----

test("a stream resumes after the id in Last-Event-ID, which is what a reconnecting EventSource sends", async () => {
  const repo = seedRun();
  const first = await stream(`/api/runs/${RUN}/events`);
  const seen = await first.take(3);
  first.close(); // the connection drops after the client received line 3
  appendLog(repo, RUN, `${eventLine(RUN, at(3), { type: "log", message: "while away" })}\n`);

  const again = await stream(`/api/runs/${RUN}/events`, { headers: { "last-event-id": seen[2]!.id! } });
  const [missed] = await again.take(1);
  assert.equal(missed!.id, "4");
  assert.equal(JSON.parse(missed!.data).message, "while away");
  assert.deepEqual(await again.within(150), [], "what the client already has is not sent again");

  appendLog(repo, RUN, `${eventLine(RUN, at(4), { type: "log", message: "live again" })}\n`);
  assert.deepEqual(brief(await again.take(1)), [["5", "log"]]);
});

test("a stream can also resume from a ?lastEventId= query, and the header wins when both are there", async () => {
  seedRun();
  const byQuery = await stream(`/api/runs/${RUN}/events?lastEventId=1`);
  assert.deepEqual(brief(await byQuery.take(2)), [["2", "phase"], ["3", "log"]]);

  const both = await stream(`/api/runs/${RUN}/events?lastEventId=1`, { headers: { "last-event-id": "2" } });
  assert.deepEqual(brief(await both.take(1)), [["3", "log"]]);
  assert.deepEqual(await both.within(150), []);

  const fromStart = await stream(`/api/runs/${RUN}/events`, { headers: { "last-event-id": "0" } });
  assert.deepEqual(brief(await fromStart.take(3)), [["1", "run-start"], ["2", "phase"], ["3", "log"]]);
});

test("an id past the end of the log sends nothing until the log reaches it", async () => {
  const repo = seedRun();
  const ahead = await stream(`/api/runs/${RUN}/events?lastEventId=4`);
  assert.deepEqual(await ahead.within(300), []);
  appendLog(repo, RUN, [4, 5, 6].map((n) => `${eventLine(RUN, at(n), { type: "log", message: `line ${n}` })}\n`).join(""));
  assert.deepEqual(brief(await ahead.take(2)), [["5", "log"], ["6", "log"]]);
});

test("an id that is not a whole number is a 400, from the header or the query", async () => {
  seedRun();
  for (const reply of [
    await stream(`/api/runs/${RUN}/events`, { headers: { "last-event-id": "abc" } }),
    await stream(`/api/runs/${RUN}/events`, { headers: { "last-event-id": "-1" } }),
    await stream(`/api/runs/${RUN}/events?lastEventId=1.5`),
    await stream(`/api/runs/${RUN}/events?lastEventId=`),
  ]) {
    assert.equal(reply.status, 400);
    assert.match(String(reply.headers["content-type"]), /application\/json/);
    await reply.ended;
  }
});

test("?content=false leaves the content events out of the stream, and the ids keep counting them", async () => {
  const repo = seedRun();
  const content = { type: "content", stepId: "s-1", parentId: null, groupId: null, attemptId: "a1", kind: "prompt", text: "the prompt", chars: 10 };
  // The second content event is an older version's: its keys are in another order, so the cheap check on the start of the line does not see it.
  const oldContent = JSON.stringify({ type: "content", v: 0, stepId: "s-1", kind: "prompt", text: "old prompt" });
  appendLog(repo, RUN, `${eventLine(RUN, at(3), content)}\n${oldContent}\n${eventLine(RUN, at(4), { type: "log", message: "after the content" })}\n`);

  const lean = await stream(`/api/runs/${RUN}/events?content=false`);
  assert.deepEqual(brief(await lean.take(4)), [["1", "run-start"], ["2", "phase"], ["3", "log"], ["6", "log"]]);

  const full = await stream(`/api/runs/${RUN}/events`);
  assert.deepEqual(brief(await full.take(6)).map(([, type]) => type), ["run-start", "phase", "log", "content", "content", "log"]);

  appendLog(repo, RUN, `${eventLine(RUN, at(5), { ...content, text: "more" })}\n${eventLine(RUN, at(6), { type: "log", message: "last" })}\n`);
  assert.deepEqual(brief(await lean.take(1)), [["8", "log"]], "content that arrives live is left out too");
});

// ---- one step's live log ----

test("?stepId= keeps only the events of that step, so a step's live log is its content plus a stream that continues from where the content stopped", async () => {
  seedSteps();
  const repo = box.repo("repo-steps");
  const snapshot = (await http(dash.url, `/api/runs/${RUN}/steps/s-1/content`)).json;

  const live = await stream(`/api/runs/${RUN}/events?stepId=s-1&lastEventId=${snapshot.lastEventId}`);
  assert.deepEqual(await live.within(300), [], "nothing of s-1 happened after the snapshot");

  appendLog(repo, RUN, [
    eventLine(RUN, at(60), content("s-2", "b1", { kind: "agent-message", text: "another step" })),
    eventLine(RUN, at(61), content("s-1", "a2", { kind: "agent-message", text: "s-1 again" })),
    eventLine(RUN, at(62), { type: "step-end", ...ref("s-1"), attemptId: "a2", attempt: 2, stepKey: "k1", label: "review", ok: true, cached: false, chargedCents: 0 }),
    eventLine(RUN, at(63), { type: "log", message: "run level, no step" }),
  ].join("\n") + "\n");
  const frames = await live.take(2);
  assert.deepEqual(frames.map((f) => [f.id, JSON.parse(f.data).type, JSON.parse(f.data).stepId]), [
    [String(snapshot.lastEventId + 2), "content", "s-1"],
    [String(snapshot.lastEventId + 3), "step-end", "s-1"],
  ]);
  assert.deepEqual(await live.within(150), []);

  const command = await stream(`/api/runs/${RUN}/events?stepId=x-1&content=false`);
  assert.deepEqual(brief(await command.take(1)), [["11", "exec-start"]]);
  assert.deepEqual(await command.within(150), [], "its content is left out, as everywhere");
});

// ---- events the dashboard does not know ----

/** Lines of other schema versions and types, written as other versions of the kit might have: no `ts`, no `runId`, `v` 0 or 7, a type nobody defined. */
const FOREIGN = [
  JSON.stringify({ v: 0, type: "log", message: "from before the schema had a version" }),
  JSON.stringify({ type: "step-start", label: "no ids at all", model: "composer-2" }),
  JSON.stringify({ v: 7, ts: at(5), runId: RUN, type: "hologram", shape: { deep: [1, 2, { three: 3 }] } }),
  JSON.stringify({ v: 2, ts: at(6), runId: RUN, type: "step-end", stepId: "s-9", ok: "yes", chargedCents: "1.5", renamed: true }),
  JSON.stringify({ v: 1, ts: at(7), runId: RUN, type: "content", kind: "telepathy", chars: 3, text: "abc" }),
  "this line is not JSON",
  JSON.stringify([1, 2, 3]),
  JSON.stringify({ v: 1, message: "an object without a type" }),
];

test("events of older schema versions and unknown types are streamed as they are, in order, and the blank and damaged lines only use up their ids", async () => {
  const repo = seedRun();
  const lines = [FOREIGN[0]!, "", ...FOREIGN.slice(1)]; // a blank line after the first
  appendLog(repo, RUN, `${lines.join("\n")}\n`);
  const live = await stream(`/api/runs/${RUN}/events`);
  const frames = await live.take(8); // 3 seeded + the five lines that are events
  assert.deepEqual(
    frames.map((f) => f.id),
    ["1", "2", "3", "4", "6", "7", "8", "9"],
  );
  assert.deepEqual(frames.slice(3).map((f) => JSON.parse(f.data)), [0, 1, 2, 3, 4].map((i) => JSON.parse(FOREIGN[i]!)), "untouched: no field added, renamed or dropped");
  assert.deepEqual(await live.within(150), [], "the blank line and the three lines that are not events are not sent");

  appendLog(repo, RUN, `${eventLine(RUN, at(8), { type: "log", message: "still alive" })}\n`);
  assert.deepEqual(brief(await live.take(1)), [["13", "log"]], "the ids counted the blank line and the three lines that were not events");
});

/** Events of the known types with fields missing or of another kind: what a log written by another version of the kit could hold. */
const GUTTED = [
  { v: 0, type: "log" },
  { v: 0, type: "warning", message: 42 },
  { type: "phase" },
  { v: 0, type: "step-start", attempt: "1" },
  { type: "step-end", ok: true, usage: "lots", chargedCents: "1.5" },
  { type: "exec-start" },
  { type: "exec-end", outcome: "exit", durationMs: "slow" },
  { v: 3, type: "turn", usage: null },
  { v: 0, type: "metric" },
  { v: 0, type: "group-start" },
].map((e) => JSON.stringify(e));

test("a log with events of other versions does not break the runs API: the run is listed and its detail is served", async () => {
  const repo = seedRun();
  appendLog(repo, RUN, `${FOREIGN.join("\n")}\n`);
  const list = await http(dash.url, "/api/runs");
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.json.runs.map((r: any) => [r.runId, r.status]), [[RUN, "running"]]);
  const detail = await http(dash.url, `/api/runs/${RUN}`);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.json.status, "running");
});

test("a run whose log the projection cannot digest is listed with the reason, and does not take the other runs down with it", async () => {
  seedRun();
  const other = box.repo("repo-odd");
  writeRun(box.home, other, { runId: "smoke-odd00002", workflow: "smoke", startedAt: at(60), events: GUTTED.map((e) => JSON.parse(e)) });

  const list = await http(dash.url, "/api/runs");
  assert.equal(list.status, 200, list.text);
  const byId = new Map<string, any>(list.json.runs.map((r: any) => [r.runId, r]));
  assert.deepEqual([...byId.keys()].sort(), ["smoke-aaaa0001", "smoke-odd00002"]);
  assert.equal(byId.get(RUN)!.status, "running", "the healthy run is as it was");
  const odd = byId.get("smoke-odd00002")!;
  assert.equal(odd.status, "missing");
  assert.match(odd.error, /could not read .*events\.jsonl/, "it names the log");
  assert.equal((await http(dash.url, "/api/runs/smoke-odd00002")).status, 200);

  const live = await stream("/api/runs/smoke-odd00002/events");
  assert.equal((await live.take(1 + GUTTED.length)).length, 1 + GUTTED.length, "its events still stream: reading the log needs no projection");
});

// ---- the content of one step ----

const ref = (stepId: string) => ({ stepId, parentId: null, groupId: null });
const content = (stepId: string, attemptId: string, fields: Record<string, unknown>) => ({ type: "content", ...ref(stepId), attemptId, chars: String(fields.text ?? "").length, ...fields });

/** A run with an agent step that took two attempts, a command, and a second agent step: the lines after the run-start. */
const STEPS = [
  { type: "step-start", ...ref("s-1"), attemptId: "a1", attempt: 1, label: "review", stepKey: "k1", cached: false, promptHash: "h", promptChars: 12, settingSources: [] },
  content("s-1", "a1", { kind: "prompt", text: "Review the diff." }),
  content("s-2", "b1", { kind: "prompt", text: "Another step's prompt." }),
  content("s-1", "a1", { kind: "agent-message", text: "Looking at the diff." }),
  content("s-1", "a1", { kind: "tool-call", tool: "shell", callId: "c1", text: "git diff --stat" }),
  content("s-1", "a1", { kind: "command-output", tool: "shell", callId: "c1", text: " 2 files changed" }),
  { type: "step-end", ...ref("s-1"), attemptId: "a1", attempt: 1, stepKey: "k1", label: "review", ok: false, cached: false, chargedCents: 0, errorKind: "timeout" },
  content("s-1", "a2", { kind: "prompt", text: "Review the diff." }),
  content("s-1", "a2", { kind: "agent-message", text: "No problems found." }),
  { type: "exec-start", ...ref("x-1"), attemptId: "e1", label: "tests", command: "npm", timeoutMs: 60000 },
  content("x-1", "e1", { kind: "tool-call", tool: "exec", callId: "e1", text: "npm test (cwd /repo)" }),
  content("x-1", "e1", { kind: "command-output", tool: "exec", callId: "e1", stream: "stdout", text: "ok 1\n" }),
  content("x-1", "e1", { kind: "command-output", tool: "exec", callId: "e1", stream: "stderr", text: "warning: slow\n" }),
  { type: "step-start", ...ref("s-3"), attemptId: "c1", attempt: 1, label: "from the journal", stepKey: "k3", cached: "journal", promptHash: "h", promptChars: 0, settingSources: [] },
];

function seedSteps(): void {
  writeRun(box.home, box.repo("repo-steps"), { runId: RUN, workflow: "smoke", startedAt: at(0), events: STEPS });
}

test("GET /api/runs/:runId/steps/:stepId/content returns the content of one step in log order, across its attempts, and nothing of other steps", async () => {
  seedSteps();
  const { status, json } = await http(dash.url, `/api/runs/${RUN}/steps/s-1/content`);
  assert.equal(status, 200);
  assert.deepEqual(
    json.content.map((c: any) => [c.id, c.attemptId, c.kind, c.tool, c.callId, c.text]),
    [
      [3, "a1", "prompt", undefined, undefined, "Review the diff."],
      [5, "a1", "agent-message", undefined, undefined, "Looking at the diff."],
      [6, "a1", "tool-call", "shell", "c1", "git diff --stat"],
      [7, "a1", "command-output", "shell", "c1", " 2 files changed"],
      [9, "a2", "prompt", undefined, undefined, "Review the diff."],
      [10, "a2", "agent-message", undefined, undefined, "No problems found."],
    ],
  );
  assert.equal(json.runId, RUN);
  assert.equal(json.stepId, "s-1");
  assert.equal(json.content[0].chars, 16);
  assert.equal(json.content[0].v, 1, "the event's schema version stays with it");
});

test("the content of a ctx.exec command is its call and its output, each line tagged with its stream", async () => {
  seedSteps();
  const { json } = await http(dash.url, `/api/runs/${RUN}/steps/x-1/content`);
  assert.deepEqual(
    json.content.map((c: any) => [c.kind, c.tool, c.stream, c.text]),
    [
      ["tool-call", "exec", undefined, "npm test (cwd /repo)"],
      ["command-output", "exec", "stdout", "ok 1\n"],
      ["command-output", "exec", "stderr", "warning: slow\n"],
    ],
  );
});

test("the answer says where the log stood, so a stream opened after that id continues without a gap or a repeat", async () => {
  seedSteps();
  const repo = box.repo("repo-steps");
  const { json } = await http(dash.url, `/api/runs/${RUN}/steps/s-1/content`);
  assert.equal(json.lastEventId, 1 + STEPS.length, "the id of the last line of the log");

  const live = await stream(`/api/runs/${RUN}/events`, { headers: { "last-event-id": String(json.lastEventId) } });
  appendLog(repo, RUN, `${eventLine(RUN, at(60), content("s-1", "a2", { kind: "agent-message", text: "one more" }))}\n`);
  const [next] = await live.take(1);
  assert.equal(next!.id, String(json.lastEventId + 1));
  assert.equal(JSON.parse(next!.data).text, "one more");
  assert.equal((await http(dash.url, `/api/runs/${RUN}/steps/s-1/content`)).json.content.at(-1).id, json.lastEventId + 1, "and the next read has it");
});

test("a step that exists but has no content (served from the journal) answers an empty list; a step the run never had is a 404", async () => {
  seedSteps();
  const cached = await http(dash.url, `/api/runs/${RUN}/steps/s-3/content`);
  assert.equal(cached.status, 200);
  assert.deepEqual(cached.json.content, []);

  for (const path of [`/api/runs/${RUN}/steps/s-404/content`, "/api/runs/nope/steps/s-1/content", `/api/runs/${RUN}/steps/%E0%A4%A/content`, `/api/runs/${RUN}/steps//content`]) {
    const reply = await http(dash.url, path);
    assert.equal(reply.status, 404, path);
    assert.deepEqual(Object.keys(reply.json), ["error"]);
  }
  assert.equal((await http(dash.url, `/api/runs/${RUN}/steps/s-1`)).status, 404, "only /content is a route");
  assert.equal((await http(dash.url, `/api/runs/${RUN}/nothing`)).status, 404);
});

test("content the retention pruned keeps its events and their sizes but has no text", async () => {
  const repo = box.repo("repo-pruned");
  const pruned = STEPS.slice(0, 3).map((e) => (e.type === "content" ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== "text")) : e));
  writeRun(box.home, repo, { runId: RUN, workflow: "smoke", startedAt: at(0), events: pruned as typeof STEPS });
  const { json } = await http(dash.url, `/api/runs/${RUN}/steps/s-1/content`);
  assert.equal(json.content.length, 1);
  assert.equal(json.content[0].text, undefined);
  assert.equal(json.content[0].chars, 16);
});

test("what the step content returns is what the log holds: text the runtime already redacted comes back as [REDACTED], not restored", async () => {
  const repo = box.repo("repo-secret");
  writeRun(box.home, repo, { runId: RUN, workflow: "smoke", startedAt: at(0), events: [content("s-1", "a1", { kind: "tool-call", tool: "shell", text: "curl -H 'Authorization: Bearer [REDACTED]' https://api.example" })] });
  const { text } = await http(dash.url, `/api/runs/${RUN}/steps/s-1/content`);
  assert.match(text, /Bearer \[REDACTED\]/);
});

test("step content from events of other versions: unknown kinds and missing fields come back as the log has them", async () => {
  const repo = box.repo("repo-old");
  appendOld(repo);
  const { status, json } = await http(dash.url, `/api/runs/${RUN}/steps/s-1/content`);
  assert.equal(status, 200);
  assert.deepEqual(json.content.map((c: any) => [c.v, c.kind, c.text]), [[0, "prompt", "from v0"], [9, "telepathy", undefined]]);
});

function appendOld(repo: string): void {
  writeRun(box.home, repo, { runId: RUN, workflow: "smoke", startedAt: at(0) });
  appendLog(repo, RUN, [
    JSON.stringify({ v: 0, type: "content", stepId: "s-1", kind: "prompt", text: "from v0" }),
    JSON.stringify({ v: 9, ts: at(3), runId: RUN, type: "content", stepId: "s-1", attemptId: "a1", kind: "telepathy", chars: 3 }),
    "",
  ].join("\n"));
}

// ---- the log is rewritten under an open stream; the dashboard stops ----

test("a stream stays right when the retention pass rewrites the log under it: the same lines, shorter, in a new file", async () => {
  const repo = box.repo("repo-steps");
  writeRun(box.home, repo, { runId: RUN, workflow: "smoke", startedAt: at(0), events: STEPS });
  const live = await stream(`/api/runs/${RUN}/events`);
  await live.take(1 + STEPS.length);

  // What retention does to a run that is not executing: the `text` of every content event goes, every line stays, the file is replaced.
  const file = logPath(repo, RUN);
  const before = readFileSync(file, "utf8");
  const pruned = before.split("\n").map((line) => {
    const event = line ? JSON.parse(line) : undefined;
    if (event?.type !== "content") return line;
    delete event.text;
    return JSON.stringify(event);
  });
  writeFileSync(`${file}.tmp`, pruned.join("\n"));
  renameSync(`${file}.tmp`, file);
  assert.ok(readFileSync(file, "utf8").length < before.length);
  assert.deepEqual(await live.within(400), [], "a rewrite adds no event");

  appendLog(repo, RUN, `${eventLine(RUN, at(70), { type: "log", message: "resumed after the prune" })}\n`);
  const [frame] = await live.take(1);
  assert.equal(frame!.id, String(2 + STEPS.length), "the next line of the same log, not a repeat and not a gap");
  assert.equal(JSON.parse(frame!.data).message, "resumed after the prune");
});

test("closing the dashboard ends the streams open on it, and a stream whose client left stops reading the log", async () => {
  seedRun();
  const second = await startDashboard({ port: 0 });
  const live = await openStream(second.url, `/api/runs/${RUN}/events`);
  await live.take(3);
  const gone = await openStream(second.url, `/api/runs/${RUN}/events`);
  await gone.take(3);
  gone.close();
  await gone.ended;

  await second.close();
  await live.ended; // would never resolve if the server kept the connection
  assert.equal(live.status, 200);
});

test("a HEAD request to a stream gets the headers and no body", async () => {
  seedRun();
  const reply = await http(dash.url, `/api/runs/${RUN}/events`, { method: "HEAD" });
  assert.equal(reply.status, 200);
  assert.match(String(reply.headers["content-type"]), /^text\/event-stream/);
  assert.equal(reply.text, "");
});

test("the streams and the step content sit behind the host check and the read-only gate like every other route", async () => {
  seedSteps();
  const paths = [`/api/runs/${RUN}/events`, `/api/runs/${RUN}/steps/s-1/content`];
  for (const path of paths) {
    for (const host of ["evil.example", `evil.example:${dash.port}`, "127.0.0.1.evil.example", "[::1]"]) {
      const refused = await http(dash.url, path, { host });
      assert.equal(refused.status, 403, `${host} on ${path}`);
      assert.equal(refused.text, "host not allowed");
    }
    for (const method of ["POST", "PUT", "DELETE"]) {
      const reply = await http(dash.url, path, { method });
      assert.equal(reply.status, 405, `${method} ${path}`);
    }
    const allowed = await stream(path); // not `http`: a stream has no end to wait for
    assert.equal(allowed.status, 200, path);
    assert.equal(allowed.headers["access-control-allow-origin"], undefined, "no CORS headers");
  }
  const sneaky = await stream(`/api/runs/${RUN}/events`, { host: "evil.example" });
  assert.equal(sneaky.status, 403);
});
