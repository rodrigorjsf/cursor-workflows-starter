// Seam: the files the runtime reads back as JSON, in process: what comes out of a text that is not JSON, or is JSON of
// another shape than the one the runtime writes. A state file (job record, run lock, dashboard pid file, memo entry,
// workflow progress) and a repo's `.mcp.json` are data at rest that a crash, an older kit or another tool may have left in
// any shape, and the runtime decides from them whether a process is alive, what a resume repeats and which server starts.
// Each one is checked when it is read: a reader that treats an unreadable file as absent says undefined, one that cannot go
// on throws an error that names the file and the field. Never a TypeError further on. The answers of the forge CLIs have
// their own file, forge-answers.test.ts.
import assert from "node:assert/strict";
import "./isolate-home.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { z } from "zod";
import { readMcpLaunches } from "../src/mcp-launch.js";
import { dashboardPidPath, readInstance } from "../src/runtime/dashboard-instance.js";
import { jobsDir, readJobRecord, readJobStart } from "../src/runtime/job-state.js";
import { MemoStore } from "../src/runtime/memo.js";
import { checkShape, isRecord, parseJson, tryParseJson } from "../src/runtime/parse-json.js";
import { LOCK_FILE, runDirPath, runLockHolder } from "../src/runtime/run-store.js";
import { userDir } from "../src/runtime/state.js";
import { Commands, type Exec } from "../workflows/implement-issue/commands.js";
import { ProgressStore, runnerConfigChanged } from "../workflows/implement-issue/tdd.js";

let dir: string;
let sequence = 0;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-parse-json-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** A repository folder of its own. */
const repoFolder = (): string => {
  const repo = join(dir, `repo-${++sequence}`);
  mkdirSync(repo);
  return repo;
};
const put = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

// --- The helper ---------------------------------------------------------------------------------------------------------

const ISSUE = z.looseObject({ number: z.number(), labels: z.array(z.looseObject({ name: z.string() })) });

test("a text of the right shape parses to its value, with the keys the schema does not name kept as they were", () => {
  const value = parseJson('{"number":7,"labels":[{"name":"bug","color":"red"}],"added":"later"}', ISSUE, "gh issue view 7");
  assert.deepEqual(value, { number: 7, labels: [{ name: "bug", color: "red" }], added: "later" });
});

test("a text that is not JSON is an error that starts with where it came from", () => {
  assert.throws(() => parseJson("HTTP 502 Bad Gateway", ISSUE, "gh issue view 7"), /^Error: gh issue view 7: not valid JSON \(/);
  assert.throws(() => parseJson("", ISSUE, "gh issue view 7"), /^Error: gh issue view 7: not valid JSON \(/);
});

test("a JSON of another shape is an error that names where it came from and each field that is wrong", () => {
  assert.throws(() => parseJson('{"number":"7","labels":[{"name":1}]}', ISSUE, "gh issue view 7"), (err: Error) => {
    assert.match(err.message, /^gh issue view 7: /);
    assert.match(err.message, /number: .*expected number, received string/);
    assert.match(err.message, /labels\.0\.name: .*expected string, received number/);
    return true;
  });
  assert.throws(() => parseJson("null", ISSUE, "x"), /^Error: x: \(root\): .*expected object, received null/);
});

test("checkShape checks a value that is already parsed, and tryParseJson answers undefined where parseJson throws", () => {
  assert.deepEqual(checkShape({ number: 1, labels: [] }, ISSUE, "x"), { number: 1, labels: [] });
  assert.throws(() => checkShape({ number: 1 }, ISSUE, "x"), /^Error: x: labels: /);
  assert.equal(tryParseJson("not json", ISSUE), undefined);
  assert.equal(tryParseJson('{"number":1}', ISSUE), undefined);
  assert.deepEqual(tryParseJson('{"number":1,"labels":[]}', ISSUE), { number: 1, labels: [] });
});

test("isRecord says yes to a plain object only: not null, not an array, not a string", () => {
  assert.deepEqual([{}, { a: 1 }, null, [], "s", 3, undefined].map(isRecord), [true, true, false, false, false, false, false]);
});

// --- The job record -----------------------------------------------------------------------------------------------------

const GOOD_JOB = { jobId: "good", runId: "run-good", pid: 4242, heartbeat: "2026-01-10T10:00:00.000Z" };
const jobFile = (repo: string, jobId: string) => join(jobsDir(repo), `${jobId}.json`);

test("a job record with a field of another type, a missing field, or no object at all is not a record the runtime wrote", () => {
  const repo = repoFolder();
  const records: Record<string, unknown> = {
    pidIsText: { ...GOOD_JOB, jobId: "pidIsText", pid: "4242" },
    noHeartbeat: { jobId: "noHeartbeat", runId: "run-x", pid: 1 },
    runIdIsNumber: { ...GOOD_JOB, jobId: "runIdIsNumber", runId: 7 },
    badStart: { ...GOOD_JOB, jobId: "badStart", start: { args: {}, maxCents: "ten" } },
    startIsText: { ...GOOD_JOB, jobId: "startIsText", start: "later" },
  };
  for (const [id, record] of Object.entries(records)) put(jobFile(repo, id), JSON.stringify(record));
  put(jobFile(repo, "isNull"), "null");
  put(jobFile(repo, "isList"), "[]");
  put(jobFile(repo, "isText"), "this is not json");
  for (const id of [...Object.keys(records), "isNull", "isList", "isText"]) {
    assert.equal(readJobRecord(repo, id), undefined, id);
    assert.equal(readJobStart(repo, id), undefined, id);
  }
});

test("a job record of the shape the runtime writes is read whole, with the fields an older or a newer kit adds", () => {
  const repo = repoFolder();
  const start = { args: { issue: 3 }, maxCents: 10, maxTokens: 5000, overrides: { maxCents: null, concurrency: 2 } };
  put(jobFile(repo, "good"), JSON.stringify({ ...GOOD_JOB, refused: "nope", killedByCancel: "2026-01-10T10:05:00.000Z", start, addedLater: true }));
  assert.deepEqual(readJobRecord(repo, "good"), { ...GOOD_JOB, refused: "nope", killedByCancel: "2026-01-10T10:05:00.000Z", start, addedLater: true });
  assert.deepEqual(readJobStart(repo, "good"), start);
  put(jobFile(repo, "plain"), JSON.stringify(GOOD_JOB));
  assert.equal(readJobStart(repo, "plain"), undefined, "a record with no `start` is an older kit's");
});

// --- The run lock -------------------------------------------------------------------------------------------------------

const lockFile = (repo: string, runId: string) => join(runDirPath(repo, runId), LOCK_FILE);

test("a run lock whose fields are not the ones the runtime writes names no holder, and one that is whole names the live process", () => {
  const repo = repoFolder();
  const live = process.ppid; // another process that is alive: the one that started this test
  const whole = { pid: live, token: "6f1c", startedAt: "2026-01-10T10:00:00.000Z" };
  const locks: Record<string, string> = {
    "pid-text": JSON.stringify({ ...whole, pid: String(live) }),
    "token-number": JSON.stringify({ ...whole, token: 7 }),
    "no-start": JSON.stringify({ pid: live, token: "6f1c" }),
    "null": "null",
    "list": "[]",
    "torn": '{"pid":',
  };
  for (const [runId, text] of Object.entries(locks)) {
    put(lockFile(repo, runId), text);
    assert.equal(runLockHolder(repo, runId), undefined, runId);
  }
  put(lockFile(repo, "whole"), JSON.stringify(whole));
  assert.equal(runLockHolder(repo, "whole"), live);
});

// --- The dashboard's pid file -------------------------------------------------------------------------------------------

test("a dashboard pid file with a field of another type, or no object, names no instance, and a whole one names it", () => {
  mkdirSync(userDir(), { recursive: true });
  const whole = { pid: 4242, port: 4317, startedAt: "2026-01-10T10:00:00.000Z" };
  for (const text of [JSON.stringify({ ...whole, pid: "4242" }), JSON.stringify({ ...whole, port: "4317" }), JSON.stringify({ pid: 1, port: 2 }), "null", "[]", "not json"]) {
    writeFileSync(dashboardPidPath(), text);
    assert.equal(readInstance(), undefined, text);
  }
  writeFileSync(dashboardPidPath(), JSON.stringify(whole));
  assert.deepEqual(readInstance(), whole);
  rmSync(dashboardPidPath(), { force: true });
});

// --- The memo entry -----------------------------------------------------------------------------------------------------

test("a memo entry that is not JSON, or is not an object, is an error that names the file; one that holds no result is a miss", () => {
  const cwd = repoFolder();
  const memo = new MemoStore(cwd);
  memo.set("kept", { answer: 42 });
  const file = (key: string) => join(cwd, ".workflows", "memo", `${key}.json`);
  put(file("torn"), '{"result":');
  put(file("null"), "null");
  put(file("empty"), "{}");
  assert.throws(() => memo.get("torn"), (err: Error) => err.message.startsWith(`${file("torn")}: not valid JSON (`));
  assert.throws(() => memo.get("null"), (err: Error) => err.message.startsWith(`${file("null")}: (root): `));
  assert.equal(memo.get("empty"), undefined);
  assert.deepEqual(memo.get("kept"), { answer: 42 });
  assert.equal(memo.get("absent"), undefined);
});

// --- The workflow progress ----------------------------------------------------------------------------------------------

const progressFile = (cwd: string, runId: string) => join(cwd, ".workflows", "runs", runId, "tdd-progress.json");

test("a progress file that is not JSON, or has no slices, or has a slice that is not one, is an error that names the file and the field, when the store opens", () => {
  const cwd = repoFolder();
  put(progressFile(cwd, "torn"), '{"slices": [');
  put(progressFile(cwd, "no-slices"), "{}");
  put(progressFile(cwd, "slice-key"), JSON.stringify({ slices: [{ behavior: "b", seam: "s", done: false }] }));
  put(progressFile(cwd, "crashes"), JSON.stringify({ slices: [], crashes: { "code-1": "twice" } }));
  assert.throws(() => new ProgressStore(cwd, "torn"), (err: Error) => err.message.startsWith(`${progressFile(cwd, "torn")}: not valid JSON (`));
  assert.throws(() => new ProgressStore(cwd, "no-slices"), (err: Error) => err.message.startsWith(`${progressFile(cwd, "no-slices")}: `) && /slices: /.test(err.message));
  assert.throws(() => new ProgressStore(cwd, "slice-key"), /slices\.0\.key: /);
  assert.throws(() => new ProgressStore(cwd, "crashes"), /crashes\.code-1: /);
});

test("a progress file of the shape the workflow writes is read whole, with a field a newer kit adds", () => {
  const cwd = repoFolder();
  const record = {
    branch: "wf/issue-7-a",
    forge: "gitlab",
    writeSeq: 3,
    crashes: { "code-1": 1 },
    inFlight: { id: "code-1", before: "abc123", interrupted: true, execution: 2 },
    slices: [{ key: "1:abc", behavior: "adds", seam: "math", done: true, testHash: null, fixRound: 1 }],
    addedLater: { a: 1 },
  };
  put(progressFile(cwd, "whole"), JSON.stringify(record));
  const store = new ProgressStore(cwd, "whole");
  assert.deepEqual(store.data, record);
  assert.equal(store.existed, true);
  assert.deepEqual(new ProgressStore(cwd, "absent").data, { slices: [] });
});

// --- A package.json read from a git tree ---------------------------------------------------------------------------------

test("a package.json that is not an object is one that did not change what runs, not a TypeError", async () => {
  const limits = { localMs: 1000, networkMs: 1000 };
  const printing = (stdout: string): Exec => async (_command, _args, opts) => {
    writeFileSync(opts?.env?.WF_STDOUT ?? "", stdout); // Commands.read sends a command's stdout to the file named in WF_STDOUT
    return { ok: true, exitCode: 0, timedOut: false, tail: "" };
  };
  for (const text of ["null", "[]", '"scripts"', "42"]) {
    assert.equal(await runnerConfigChanged(new Commands(printing(text), limits), "/x", "tree-a", "tree-b"), false, text);
  }
});

// --- The MCP config of a repo -------------------------------------------------------------------------------------------

test("a .mcp.json that is not an object, or whose workflows server is not one, is reported as having no workflows server, not as invalid JSON", () => {
  for (const [text, expected] of [["null", /has no "workflows" server in mcpServers/], ['{"mcpServers":null}', /has no "workflows" server/], ['{"mcpServers":{"workflows":"stdio"}}', /has no "workflows" server/], ["{", /invalid JSON/]] as const) {
    const cwd = repoFolder();
    put(join(cwd, ".mcp.json"), text);
    const { launches, problems } = readMcpLaunches(cwd);
    assert.deepEqual(launches, [], text);
    assert.equal(problems.length, 1, `${text}: ${problems.join(" | ")}`);
    assert.match(problems[0] ?? "", expected, text);
  }
});

test("a .mcp.json with a workflows server gives the launch, with an env that is not an object left out", () => {
  const cwd = repoFolder();
  put(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { workflows: { command: "node", args: ["server.js", 3], env: { A: "1", B: 2 } } } }));
  const { launches, problems } = readMcpLaunches(cwd);
  assert.deepEqual(problems, []);
  assert.deepEqual(launches.map(({ command, args, env }) => ({ command, args, env })), [{ command: "node", args: ["server.js", "3"], env: { A: "1", B: "2" } }]);
  const other = repoFolder();
  put(join(other, ".mcp.json"), JSON.stringify({ mcpServers: { workflows: { command: "node", env: 5 } } }));
  assert.deepEqual(readMcpLaunches(other).launches.map(({ env }) => env), [{}]);
});
