// Seam: the process. `scripts/verify/validation-report.ts` is what the validation wizard calls to turn what the user
// observed into `validation-report.json` and the body of the issue to file. It is run the way the wizard runs it, on a
// progress file written by hand; the tests read the files it writes, its stdout and its exit code. The report is meant to
// leave the machine (an issue on a public tracker), so most of what is checked is what must NOT be in it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "verify", "validation-report.ts");
const FAKE_HOME = "/home/tester";

let sandbox: string;
let counter = 0;
before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-validation-report-"));
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

const SCENARIOS = [
  "Doctor is green in the IDE's environment",
  "The MCP server is visible and enabled",
  "A cheap workflow finishes from the chat",
  "implement-issue opens a pull request on the sandbox repo",
  "A run survives restarting Cursor",
  "A run cancels from the chat",
  "The dashboard shows the run live",
];

/** A progress file: the facts, then one title/result/note triple per scenario (`results[i]` is `pass`, `fail` or `skip`). */
function progress(results: string[], notes: string[] = [], facts: Record<string, string> = {}): string {
  const lines = Object.entries({
    CURSOR_VERSION: "3.26.1",
    IDE_TERMINAL: "yes",
    SANDBOX_REPO: "acme-corp/wf-sandbox-77",
    SANDBOX_DIR: `${FAKE_HOME}/tmp/wf-sandbox-77`,
    ...facts,
  }).map(([k, v]) => `${k}=${v}`);
  SCENARIOS.forEach((title, i) => {
    lines.push(`S${i + 1}_TITLE=${title}`, `S${i + 1}_RESULT=${results[i] ?? "pass"}`, `S${i + 1}_NOTE=${notes[i] ?? ""}`);
  });
  return `${lines.join("\n")}\n`;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  report: any;
  body: string;
  dir: string;
}

/** Runs the script on a progress file (and an optional doctor report) and reads back what it wrote. */
function run(progressText: string, { doctor, extra = [] }: { doctor?: unknown; extra?: string[] } = {}): Run {
  const dir = join(sandbox, `run-${++counter}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "progress.env"), progressText);
  const args = ["--progress", join(dir, "progress.env"), "--out-dir", dir, "--kit", ROOT, ...extra];
  if (doctor !== undefined) {
    writeFileSync(join(dir, "doctor.json"), typeof doctor === "string" ? doctor : JSON.stringify(doctor));
    args.push("--doctor", join(dir, "doctor.json"));
  }
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: FAKE_HOME, WF_HOME: `${FAKE_HOME}/.cursor-workflows` },
    encoding: "utf8",
  });
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), "utf8");
    } catch {
      return "";
    }
  };
  const reportText = read("validation-report.json");
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, report: reportText ? JSON.parse(reportText) : undefined, body: read("issue-body.md"), dir };
}

test("the report has one entry per scenario with its result and note, the environment facts and a summary", () => {
  const r = run(progress(["pass", "pass", "pass", "fail", "skip", "pass", "pass"], ["", "five tools listed", "answered pong", "no PR appeared", "", "cancelled in 4 s", "card moved to Done"]));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.report.scenarios.map((s: { id: number; title: string; result: string; note: string }) => [s.id, s.title, s.result, s.note]),
    [
      [1, SCENARIOS[0], "pass", ""],
      [2, SCENARIOS[1], "pass", "five tools listed"],
      [3, SCENARIOS[2], "pass", "answered pong"],
      [4, SCENARIOS[3], "fail", "no PR appeared"],
      [5, SCENARIOS[4], "skipped", ""],
      [6, SCENARIOS[5], "pass", "cancelled in 4 s"],
      [7, SCENARIOS[6], "pass", "card moved to Done"],
    ],
  );
  assert.deepEqual(r.report.summary, { pass: 5, fail: 1, skipped: 1, releaseCriterionMet: false });
  assert.equal(r.report.environment.cursorVersion, "3.26.1");
  assert.equal(r.report.environment.ideTerminal, true);
  assert.equal(r.report.environment.node, process.version);
  assert.equal(r.report.environment.platform, process.platform);
  assert.equal(r.report.kit.version, JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
  assert.match(r.report.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("the release criterion is met only when all seven scenarios pass", () => {
  const r = run(progress([]));
  assert.deepEqual(r.report.summary, { pass: 7, fail: 0, skipped: 0, releaseCriterionMet: true });
  assert.equal(r.stdout.trim(), "Cursor IDE validation: 7 of 7 scenarios passed");
});

test("the release criterion needs all seven scenarios on record: six passes out of six is not it", () => {
  const seventh = (line: string) => !line.startsWith("S7_");
  const r = run(`${progress([]).split("\n").filter(seventh).join("\n")}\n`);
  assert.deepEqual(r.report.summary, { pass: 6, fail: 0, skipped: 0, releaseCriterionMet: false });
});

const EIGHTH = "A read-only step runs on a cloud agent";
/** The optional eighth scenario, as the wizard records it when the person chose to run it. */
const withEighth = (text: string, result: string, note = "") => `${text}S8_TITLE=${EIGHTH}\nS8_RESULT=${result}\nS8_NOTE=${note}\n`;

test("the optional eighth scenario is reported with its result, but the release criterion and the title count the seven", () => {
  for (const [typed, reported] of [["pass", "pass"], ["fail", "fail"], ["skip", "skipped"]] as const) {
    const r = run(withEighth(progress([]), typed, "agent bc-1"));
    assert.deepEqual(r.report.summary, { pass: 7, fail: 0, skipped: 0, releaseCriterionMet: true }, typed);
    assert.equal(r.stdout.trim(), "Cursor IDE validation: 7 of 7 scenarios passed", typed);
    const eighth = r.report.scenarios[7];
    assert.deepEqual([eighth.id, eighth.title, eighth.result, eighth.note, eighth.optional], [8, EIGHTH, reported, "agent bc-1", true], typed);
    assert.equal(r.report.scenarios[0].optional, undefined, "the first seven are required");
    assert.match(r.body, new RegExp(`\\| 8 \\| ${EIGHTH} \\(optional\\) \\| ${reported} \\| agent bc-1 \\|`), typed);
  }
});

test("the eighth scenario passing does not make up for a required one that failed, or is missing", () => {
  const failed = run(withEighth(progress(["pass", "pass", "fail"]), "pass"));
  assert.deepEqual(failed.report.summary, { pass: 6, fail: 1, skipped: 0, releaseCriterionMet: false });
  assert.equal(failed.stdout.trim(), "Cursor IDE validation: 6 of 7 scenarios passed, 1 failed");

  const withoutSeventh = progress([]).split("\n").filter((line) => !line.startsWith("S7_")).join("\n");
  const missing = run(withEighth(`${withoutSeventh}\n`, "pass"));
  assert.deepEqual(missing.report.summary, { pass: 6, fail: 0, skipped: 0, releaseCriterionMet: false });
});

test("stdout is the issue title and says what did not pass", () => {
  const r = run(progress(["pass", "fail", "pass", "pass", "skip", "fail", "pass"]));
  assert.equal(r.stdout.trim(), "Cursor IDE validation: 4 of 7 scenarios passed, 2 failed, 1 not run");
});

test("a scenario with no recorded answer is reported as skipped, not as passed", () => {
  const lines = progress([]).split("\n").filter((l) => !l.startsWith("S4_RESULT") && !l.startsWith("S4_NOTE"));
  const r = run(`${lines.join("\n")}\n`);
  const four = r.report.scenarios[3];
  assert.equal(four.result, "skipped");
  assert.equal(r.report.summary.releaseCriterionMet, false);
});

test("the doctor report is kept as ok plus the id, status and message of each check", () => {
  const doctor = {
    ok: false,
    checks: [
      { id: "node", title: "Node.js", status: "pass", message: "v22.23.4" },
      { id: "gh", title: "GitHub CLI (gh)", status: "fail", message: "not logged in", hint: "run gh auth login" },
    ],
  };
  const r = run(progress([]), { doctor });
  assert.equal(r.report.doctor.ok, false);
  assert.deepEqual(
    r.report.doctor.checks.map((c: { id: string; status: string }) => [c.id, c.status]),
    [["node", "pass"], ["gh", "fail"]],
  );
  assert.equal(r.report.doctor.checks[1].hint, "run gh auth login");
  assert.match(r.body, /gh.*fail/);
});

test("no doctor report, or one that is not JSON, leaves doctor null instead of breaking the report", () => {
  assert.equal(run(progress([])).report.doctor, null);
  assert.equal(run(progress([]), { doctor: "this is not json" }).report.doctor, null);
});

test("local paths, the sandbox repo, the account and the machine never reach the report or the issue body", () => {
  const user = userInfo().username;
  const notes = [
    `ran wf from ${FAKE_HOME}/.local/bin/wf and node at /usr/local/lib/node_modules/x`,
    `PR is https://github.com/acme-corp/wf-sandbox-77/pull/3`,
    `repo acme-corp/wf-sandbox-77 belongs to acme-corp; folder ${FAKE_HOME}/tmp/wf-sandbox-77/src`,
    `mail dev@example.com about it`,
    `windows side C:\\Users\\Alice\\Desktop\\log.txt and /mnt/c/Users/alice/log.txt`,
    `ran as ${user} on ${hostname()}`,
    `the dashboard at http://127.0.0.1:4317/runs/smoke-1 showed the card`, // a local address that is not a place on this machine's disk
  ];
  const doctor = { ok: true, checks: [{ id: "node", title: "Node.js", status: "pass", message: `${FAKE_HOME}/.cursor-workflows/kit/node is v22` }] };
  const r = run(progress([], notes), { doctor });
  const everything = JSON.stringify(r.report) + r.body;

  assert.deepEqual(
    r.report.scenarios.map((s: { note: string }) => s.note),
    [
      "ran wf from ~/.local/bin/wf and node at <path>",
      "PR is https://github.com/<sandbox-repo>/pull/3",
      "repo <sandbox-repo> belongs to <owner>; folder <sandbox-dir>/src",
      "mail <email> about it",
      "windows side <path> and <path>",
      "ran as <user> on <host>",
      "the dashboard at http://127.0.0.1:4317/runs/smoke-1 showed the card",
    ],
  );
  assert.equal(r.report.doctor.checks[0].message, "~/.cursor-workflows/kit/node is v22");
  for (const leak of [FAKE_HOME, "acme-corp", "wf-sandbox-77", "dev@example.com", "Alice", "alice", user, hostname()]) {
    assert.ok(!everything.includes(leak), `"${leak}" leaked: ${everything}`);
  }
});

test("the wizard's own words survive: a scenario title is not anonymized, even when it contains the repository's name", () => {
  const r = run(progress([], ["", "sandbox is where it ran"], { SANDBOX_REPO: "acme-corp/sandbox" }));
  assert.equal(r.report.scenarios[3].title, SCENARIOS[3], "the title mentions the sandbox repo in words");
  assert.equal(r.report.scenarios[1].note, "<sandbox-repo> is where it ran", "what the person wrote is anonymized");
});

test("a name under four characters is left alone: it would eat ordinary words", () => {
  const r = run(progress([], ["", "the abc server answered"], { SANDBOX_REPO: "me/abc" }));
  assert.equal(r.report.scenarios[1].note, "the abc server answered");
});

test("text that is not a path survives: slash commands, one-segment paths, URLs, dates", () => {
  const note = "typed /run-workflow smoke, saw /tmp mentioned, docs at https://cursor.com/docs/mcp, on 11/12/2026, yes/no";
  const r = run(progress([], ["", note]));
  assert.equal(r.report.scenarios[1].note, note);
});

test("credentials pasted into a note are redacted, the Cursor key shape included", () => {
  const notes = [`my key crsr_${"a1B2c3D4".repeat(4)} and token ghp_${"x".repeat(36)} by mistake`];
  const r = run(progress([], notes));
  assert.equal(r.report.scenarios[0].note, "my key [REDACTED] and token [REDACTED] by mistake");
});

test("the issue body is Markdown: a table of the scenarios, the environment and the doctor result; a `|` in a note cannot break the table", () => {
  const r = run(progress(["pass", "fail"], ["", "tools: a | b"]));
  assert.match(r.body, /^## Cursor IDE validation/m);
  assert.match(r.body, /\| 2 \| The MCP server is visible and enabled \| fail \| tools: a \\\| b \|/);
  assert.match(r.body, /Cursor: 3\.26\.1/);
  assert.match(r.body, /Node: v\d+/);
  assert.match(r.body, /scripts\/verify\/validate-cursor-ide\.sh/);
});

test("without --progress the script says so and exits 2", () => {
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), SCRIPT, "--out-dir", sandbox], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--progress/);
});
