// Seam: the process. `scripts/verify/validate-cursor-ide.sh` is run with scripted answers on its stdin, the way a person
// answers it. Everything outside it is a stand-in on the PATH: a `gh` and a `wf` that log their calls and answer from
// files, and a `wslview` that logs the URL it is asked to open. The wizard's own collaborators are real: the sandbox
// repo script it reuses (`setup-sandbox-repo.sh`), git, and the report builder. The tests read the files the wizard
// writes, what it prints and the calls the stand-ins logged; none of them looks inside the script.
//
// The prompts, in the order the wizard asks them, are written once, in `answers()`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const WIZARD = join(ROOT, "scripts", "verify", "validate-cursor-ide.sh");
const REPO = "acme-corp/wf-sandbox-77";
const KIT_REPO = "kit-owner/kit-repo";

let sandbox: string;
let counter = 0;
before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-wizard-"));
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

/** An executable `name` in `dir`. */
function bin(dir: string, name: string, script: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, name), 0o755);
}

const GH = `printf '%s\\n' "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "auth status") exit "\${FAKE_GH_AUTH_EXIT:-0}" ;;
  "issue create")
    n=$(cat "$FAKE_DIR/issues" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$FAKE_DIR/issues"
    prev=""; repo=""
    for a in "$@"; do
      [ "$prev" = "-R" ] && repo="$a"
      [ "$prev" = "--body-file" ] && cp "$a" "$FAKE_DIR/body-$n.md"
      prev="$a"
    done
    echo "https://github.com/$repo/issues/$n" ;;
esac
exit 0`;

const WF = `printf '%s\\n' "wf $*" >> "$FAKE_LOG"
case "$1" in
  doctor)
    json=no; for a in "$@"; do [ "$a" = "--json" ] && json=yes; done
    if [ "$json" = yes ]; then cat "$FAKE_DIR/doctor.json"; else echo "[ok] Node.js: v22"; fi
    exit "\${FAKE_DOCTOR_EXIT:-0}" ;;
  init) echo "diff --git a/x b/x"; echo "wf init: 5 arquivo(s) alterado(s)" >&2 ;;
  status) printf '{"jobId":"%s","status":"running"}\\n' "$2" ;;
esac
exit 0`;

const DOCTOR_OK = { ok: true, checks: [{ id: "node", title: "Node.js", status: "pass", message: "v22.23.4" }] };
const DOCTOR_FAILING = {
  ok: false,
  checks: [
    { id: "node", title: "Node.js", status: "pass", message: "v22.23.4" },
    { id: "gh", title: "GitHub CLI (gh)", status: "fail", message: "not logged in", hint: "run gh auth login" },
  ],
};

/** One machine: a home, the stand-ins on a PATH, and the log they write. Every test builds its own. */
function machine(options: { withWf?: boolean; doctor?: unknown } = {}) {
  const dir = join(sandbox, `machine-${++counter}`);
  const home = join(dir, "home");
  const fakes = join(dir, "fakes");
  const state = join(dir, "state");
  mkdirSync(home, { recursive: true });
  mkdirSync(state);
  writeFileSync(join(state, "doctor.json"), JSON.stringify(options.doctor ?? DOCTOR_OK));
  bin(fakes, "gh", GH);
  if (options.withWf !== false) bin(fakes, "wf", WF);
  bin(fakes, "wslview", `printf '%s\\n' "open $*" >> "$FAKE_LOG"`);
  const log = join(state, "calls.log");
  writeFileSync(log, "");
  const reportDir = join(home, ".cursor-workflows", "validation");
  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    PATH: [fakes, dirname(process.execPath), "/usr/bin", "/bin"].join(":"), // the node running the tests first: /usr/bin may hold an older one
    HOME: home,
    WF_HOME: join(home, ".cursor-workflows"),
    WF_KIT_REPO: KIT_REPO,
    FAKE_LOG: log,
    FAKE_DIR: state,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...extra,
  });
  return {
    home,
    state,
    reportDir,
    sandboxDir: join(home, "tmp", "wf-sandbox-77"),
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    report: () => JSON.parse(readFileSync(join(reportDir, "validation-report.json"), "utf8")),
    run(lines: string[], extra: Record<string, string> = {}) {
      const r = spawnSync("bash", [WIZARD], { input: `${lines.join("\n")}\n`, env: env(extra), encoding: "utf8", timeout: 90_000 });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
    },
  };
}

/**
 * What a person types, in the order the wizard asks. Scenario 1 is read from `wf doctor`, not asked. A scenario that an
 * earlier run recorded is asked as one "keep it?" (`keep`).
 */
const start = (ide: "yes" | "no", version = "3.26.1") => ["", version, ide]; // "ready?", the Cursor version, "inside Cursor?"
const newSandbox = (repo = REPO) => [repo, "y", ""]; // the repo name, "create it?", "folder opened in Cursor"
const doctorRead = [""]; // "go on" after the doctor report
const asked = (result: string, note = "") => ["", result, note]; // "done it", the result, the note
const keep = [""];
const startsFive = (job: string) => [job]; // the jobId; inside the IDE the wizard ends here, the person quits Cursor
const fiveOutsideIde = (job: string, result: string, note = "") => [job, "", result, note]; // jobId, "Cursor is back", result, note
const fiveResumed = (result: string, note = "") => [result, note];
const fileIssue = (yn: "y" | "n") => [yn];

const NOTES = ["five tools listed", "answered pong", "PR opened", "still running after the restart", "cancelled in 4 s"];
/** A whole run outside the IDE's terminal, scenarios 2 to 6 answered; `results` default to pass. */
const wholeRunOutside = (results: string[] = [], notes: string[] = NOTES, answer: "y" | "n" = "n") => [
  ...start("no"),
  ...newSandbox(),
  ...doctorRead,
  ...asked(results[0] ?? "pass", notes[0]),
  ...asked(results[1] ?? "pass", notes[1]),
  ...asked(results[2] ?? "pass", notes[2]),
  ...fiveOutsideIde("ab12cd34", results[3] ?? "pass", notes[3]),
  ...asked(results[4] ?? "pass", notes[4]),
  ...fileIssue(answer),
];
/** The first run inside the IDE's terminal: scenarios 2 to 4, then the start of 5, where the wizard ends. */
const firstRunInside = [...start("yes"), ...newSandbox(), ...doctorRead, ...asked("pass", NOTES[0]), ...asked("pass", NOTES[1]), ...asked("pass", NOTES[2]), ...startsFive("ab12cd34")];
/** The run after Cursor came back: the earlier answers kept, scenario 5 and 6 answered. */
const secondRunInside = (answer: "y" | "n") => [...start("yes"), ...doctorRead, ...keep, ...keep, ...keep, ...fiveResumed("pass", "finished after the restart"), ...asked("pass", NOTES[4]), ...fileIssue(answer)];

test("outside the IDE's terminal: scenario 1 is not run, the others are recorded as answered, nothing is filed on a 'no'", () => {
  const m = machine();
  const r = m.run(wholeRunOutside(["pass", "pass", "fail", "pass", "p"], ["five tools listed", "answered pong", "no PR appeared", "still running", "cancelled"]));
  assert.equal(r.status, 0, r.out);

  const report = m.report();
  assert.deepEqual(
    report.scenarios.map((s: { id: number; result: string }) => [s.id, s.result]),
    [[1, "skipped"], [2, "pass"], [3, "pass"], [4, "fail"], [5, "pass"], [6, "pass"]],
  );
  assert.match(report.scenarios[0].note, /outside/i, "scenario 1 says why it was not run");
  assert.equal(report.scenarios[3].note, "no PR appeared");
  assert.deepEqual(report.summary, { pass: 4, fail: 1, skipped: 1, releaseCriterionMet: false });
  assert.equal(report.environment.ideTerminal, false);
  assert.equal(report.environment.cursorVersion, "3.26.1");
  assert.equal(report.doctor.ok, true);

  assert.ok(!m.calls().some((c) => c.startsWith(`gh issue create -R ${KIT_REPO}`)), "a 'no' files nothing");
  assert.ok(readdirSync(m.reportDir).some((f) => /^progress-.*\.env$/.test(f)) && !existsSync(join(m.reportDir, "progress.env")), "the answers are archived, so the next validation starts clean");
});

test("it reuses the sandbox repo script, creates the repo private with three issues, sets it up for the kit and runs doctor on it", () => {
  const m = machine();
  m.run(wholeRunOutside());

  const calls = m.calls();
  assert.ok(calls.some((c) => c.startsWith(`gh repo create ${REPO} --private`)), calls.join("\n"));
  assert.equal(calls.filter((c) => c.startsWith(`gh issue create -R ${REPO}`) && c.includes("complexity:low")).length, 3, "issue 1 from the script, 2 and 3 from the wizard");
  assert.ok(existsSync(join(m.sandboxDir, "src", "math.js")), "the sandbox project is the script's");
  assert.ok(calls.includes(`wf init --cwd ${m.sandboxDir}`), calls.join("\n"));
  assert.ok(calls.includes(`wf doctor --cwd ${m.sandboxDir}`) && calls.includes(`wf doctor --json --cwd ${m.sandboxDir}`), "doctor runs for the person to read and for the report");
});

test("it tells the person exactly what to type in the chat for each scenario, and opens the pull request list", () => {
  const m = machine();
  const r = m.run(wholeRunOutside());

  for (const typed of ["/run-workflow smoke", "/run-workflow implement-issue 1", "/run-workflow implement-issue 2", "/run-workflow implement-issue 3"]) {
    assert.ok(r.stdout.includes(typed), `the wizard never says to type ${typed}`);
  }
  assert.match(r.stdout, /openPr: true/, "scenario 4 must ask for the PR: implement-issue opens none by default");
  assert.match(r.stdout, /list_workflows[\s\S]*cancel_workflow/, "scenario 2 names the five tools");
  assert.ok(m.calls().includes(`open https://github.com/${REPO}/pulls`), "the PR page is opened for the person");
});

test("inside the IDE's terminal: the run stops at scenario 5 (quitting Cursor ends the wizard), and a second run resumes with the earlier answers kept", () => {
  const m = machine();
  const first = m.run(firstRunInside);
  assert.equal(first.status, 0, first.out);
  assert.ok(!existsSync(join(m.reportDir, "validation-report.json")), "no report before the last scenario");
  assert.match(first.stdout, /quit Cursor/i);
  assert.ok(first.stdout.includes("validate-cursor-ide.sh"), "it says how to start the wizard again");
  assert.match(readFileSync(join(m.reportDir, "progress.env"), "utf8"), /^S5_JOB=ab12cd34$/m);

  const second = m.run(secondRunInside("n"));
  assert.equal(second.status, 0, second.out);
  assert.equal(m.calls().filter((c) => c.startsWith("gh repo create")).length, 1, "the sandbox is not created twice");
  assert.ok(m.calls().includes(`wf status ab12cd34 --cwd ${m.sandboxDir}`), "scenario 5 shows the state of the job the person noted");

  const report = m.report();
  assert.deepEqual(report.summary, { pass: 6, fail: 0, skipped: 0, releaseCriterionMet: true });
  assert.equal(report.scenarios[0].result, "pass", "doctor exit 0 inside the IDE's terminal is a pass for scenario 1");
  assert.equal(report.scenarios[1].note, "five tools listed", "kept from the first run");
  assert.equal(report.scenarios[4].note, "finished after the restart");
});

test("a failing doctor is scenario 1 failed, with the failing check in the report", () => {
  const m = machine({ doctor: DOCTOR_FAILING });
  m.run(firstRunInside);
  const second = m.run(secondRunInside("n"), { FAKE_DOCTOR_EXIT: "1" });
  assert.equal(second.status, 0, second.out);

  const report = m.report();
  assert.equal(report.scenarios[0].result, "fail");
  assert.equal(report.doctor.ok, false);
  assert.deepEqual(report.doctor.checks.filter((c: { status: string }) => c.status === "fail").map((c: { id: string }) => c.id), ["gh"]);
  assert.equal(report.summary.releaseCriterionMet, false);
});

test("nothing is filed before the person has seen the issue body and said yes; the filed body is the one shown", () => {
  const m = machine();
  m.run(firstRunInside);
  const second = m.run(secondRunInside("y"));
  assert.equal(second.status, 0, second.out);

  const body = readFileSync(join(m.reportDir, "issue-body.md"), "utf8");
  const shownAt = second.stdout.lastIndexOf("## Cursor IDE validation");
  const askedAt = second.stdout.lastIndexOf(`File this as an issue on ${KIT_REPO}`);
  assert.ok(shownAt !== -1 && askedAt > shownAt, "the body is printed before the question");
  assert.ok(second.stdout.includes("| 2 | The MCP") || second.stdout.includes("| 2 | the MCP"), "the scenario table is on screen");

  const filed = m.calls().filter((c) => c.startsWith(`gh issue create -R ${KIT_REPO}`));
  assert.equal(filed.length, 1, m.calls().join("\n"));
  assert.match(filed[0]!, /--title Cursor IDE validation: 6 of 6 scenarios passed/);
  assert.equal(readFileSync(join(m.state, "body-4.md"), "utf8"), body, "gh got the body file that was shown");
  assert.match(second.stdout, new RegExp(`https://github.com/${KIT_REPO}/issues/4`), "the person gets the issue's address");
});

test("the report and the issue body carry no local path, repository name or account", () => {
  const m = machine();
  m.run(wholeRunOutside([], [`checked ${m.sandboxDir}/src`, `PR at https://github.com/${REPO}/pull/1`, "ok", "ok", "ok"]));

  const everything = readFileSync(join(m.reportDir, "validation-report.json"), "utf8") + readFileSync(join(m.reportDir, "issue-body.md"), "utf8");
  for (const leak of [m.home, "acme-corp", "wf-sandbox-77"]) assert.ok(!everything.includes(leak), `"${leak}" leaked`);
  assert.match(everything, /<sandbox-dir>\/src/);
  assert.match(everything, /github\.com\/<sandbox-repo>\/pull\/1/);
});

test("a result is pass, fail or skip: anything else is asked again, and five wrong answers stop the wizard", () => {
  const retry = machine();
  const lines = wholeRunOutside();
  const at = lines.indexOf("pass"); // scenario 2's result
  const ok = retry.run([...lines.slice(0, at), "maybe", ...lines.slice(at)]);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /Not understood/);
  assert.equal(retry.report().scenarios[1].result, "pass");

  const stuck = machine();
  const bad = stuck.run([...start("no"), ...newSandbox(), ...doctorRead, "", "x", "x", "x", "x", "x"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /No valid answer to "Result: pass, fail or skip\?"/);
});

test("the person can decline to create the sandbox repo: nothing is created and the wizard ends cleanly", () => {
  const m = machine();
  const r = m.run([...start("no"), REPO, "n"]);
  assert.equal(r.status, 0, r.out);
  assert.ok(!m.calls().some((c) => c.startsWith("gh repo create")));
  assert.ok(!existsSync(m.sandboxDir));
});

test("without wf on the PATH, or with gh logged out, it stops at once and says what to do", () => {
  const noWf = machine({ withWf: false });
  const a = noWf.run([]);
  assert.equal(a.status, 1);
  assert.match(a.stderr, /wf is not on the PATH/);
  assert.ok(!existsSync(noWf.reportDir), "nothing is written");
  assert.deepEqual(noWf.calls(), []);

  const loggedOut = machine();
  const b = loggedOut.run([], { FAKE_GH_AUTH_EXIT: "1" });
  assert.equal(b.status, 1);
  assert.match(b.stderr, /gh auth login/);
  assert.ok(!loggedOut.calls().some((c) => c.startsWith("gh repo create")));
});
