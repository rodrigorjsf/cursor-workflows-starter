// Seam: what a real-GitLab proof run concludes. `problems` and `renderEvidence` (scripts/lib/gitlab-proofs.ts) are called with the results
// of a run as plain data, the tables of phrases and payloads the run posts are read against the real `sanitizeModelText`, and the two
// helpers of the prover that need no GitLab (`stagesOf`, `publishable`) are imported from scripts/verify/prove-gitlab.ts: nothing is
// stubbed. What GitLab does with them is the run's own job (scripts/verify/gitlab-e2e.sh, opt-in, with Docker), so here the results are
// written down: this file pins what a result has to say for a proof to count, not what GitLab does.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeModelText } from "../packages/runtime/workflows/implement-issue/pr-body.js";
import { publishable, stagesOf } from "../scripts/verify/prove-gitlab.js";
import {
  CLOSING_FORMS,
  CONTROL_CASE,
  CONTROL_CLOSING_FORM,
  QUICK_ACTION_CASES,
  SIGIL_TEXT,
  SURFACES,
  problems,
  renderEvidence,
  type ProofReport,
} from "../scripts/lib/gitlab-proofs.js";

const TARGET = { number: 7, project: "owner/proof", issueUrl: "http://gitlab.example.com/owner/proof/-/issues/7" };
const body = (pieces: string[]) => pieces.map((piece) => sanitizeModelText(piece, "gitlab")).join("\n\n");

/** A run in which every proof held: each phrase closed raw and not sanitized, each command ran raw and not sanitized, `implement-issue` finished and its merge closed the issue. */
function passingReport(): ProofReport {
  return {
    versions: { glab: "1.130.0", gitlab: "19.5.5", image: "gitlab/gitlab-ce:19.5.5-ce.0" },
    closing: CLOSING_FORMS.map((form) => ({ form: form.name, raw: { closed: true, seconds: 3 }, sanitized: { closed: false } })),
    quickActions: QUICK_ACTION_CASES.flatMap((c) => SURFACES.map((surface) => ({ case: c.name, surface, raw: c.guard === "neutralizes", sanitized: false }))),
    sigils: { raw: { links: 3, crossReferenced: true }, sanitized: { links: 0, crossReferenced: false } },
    workflow: {
      status: "done",
      runId: "implement-issue-0123abcd",
      mrUrl: "http://gitlab.example.com/owner/proof/-/merge_requests/1",
      mrState: "opened",
      closesIssueLine: true,
      merged: true,
      issueClosed: true,
      secondsToClose: 4,
      tokens: 340_000,
      caps: { maxTokens: 600_000, maxCents: 100 },
    },
  };
}

// ── the phrases and the payloads the run posts ───────────────────────────────────────────────────────────────────

test("the phrases cover every word of GitLab's default closing pattern, and the control is the line the workflow writes itself", () => {
  const names = CLOSING_FORMS.map((form) => form.name);
  for (const word of ["Close", "Closes", "Closed", "Closing", "Fix", "Fixes", "Fixed", "Fixing", "Resolve", "Resolves", "Resolved", "Resolving", "Implement", "Implements", "Implemented", "Implementing"]) {
    assert.ok(names.includes(`${word} #N`), `a phrase with ${word}`);
  }
  assert.ok(names.includes(CONTROL_CLOSING_FORM));
  assert.equal(CLOSING_FORMS.find((form) => form.name === CONTROL_CLOSING_FORM)!.text(TARGET), "Closes #7", "what buildPrBody writes");
  assert.equal(new Set(names).size, names.length, "one row per phrase");
});

test("a phrase names the issue it is given, by number, by project path or by URL", () => {
  assert.equal(CLOSING_FORMS.find((f) => f.name === "Implements #N")!.text(TARGET), "Implements #7");
  assert.equal(CLOSING_FORMS.find((f) => f.name === "Resolves group/project#N")!.text(TARGET), "Resolves owner/proof#7");
  assert.equal(CLOSING_FORMS.find((f) => f.name === "Closes <issue URL>")!.text(TARGET), `Closes ${TARGET.issueUrl}`);
  for (const form of CLOSING_FORMS) assert.match(form.text(TARGET), /7/, form.name);
});

test("the sanitizer changes every phrase, so the run never compares a text with itself", () => {
  for (const form of CLOSING_FORMS) {
    const text = form.text(TARGET);
    assert.notEqual(sanitizeModelText(text, "gitlab"), text, form.name);
  }
});

test("the guard does to each payload what the table says: it neutralizes the command, or leaves a fence GitLab reads as code alone", () => {
  for (const c of QUICK_ACTION_CASES) {
    const raw = c.pieces.join("\n\n");
    const sanitized = body(c.pieces);
    // A fence at the end of the text gets a line break after it, so the text around the piece cannot join it: the only change.
    if (c.guard === "leaves-as-code") assert.equal(sanitized.trimEnd(), raw, c.name);
    else assert.notEqual(sanitized, raw, c.name);
  }
});

test("the payloads include the control, a bare /close, and the shapes the ticket lists", () => {
  const names = QUICK_ACTION_CASES.map((c) => c.name);
  assert.ok(names.includes(CONTROL_CASE));
  for (const shape of [/capitals/, /tab/, /carriage return/, /CRLF/, /three backticks/, /tildes/, /four backticks/, /<div>/, />>>/, /\$\$/, /never closed/]) {
    assert.ok(names.some((name) => shape.test(name)), `a payload for ${shape}`);
  }
  assert.ok(QUICK_ACTION_CASES.every((c) => /\/close/i.test(c.pieces.join("\n"))), "every payload has a /close in it");
  assert.ok(SIGIL_TEXT.includes("!1") && SIGIL_TEXT.includes("~bug") && SIGIL_TEXT.includes("%v1"));
});

// ── what makes a proof count ─────────────────────────────────────────────────────────────────────────────────────

test("a run in which every proof held has no problem", () => {
  assert.deepEqual(problems(passingReport()), []);
});

test("a phrase that still closes its issue after the sanitizer is a problem that names the phrase", () => {
  const report = passingReport();
  report.closing!.find((r) => r.form === "Implements #N")!.sanitized = { closed: true, seconds: 5 };
  assert.deepEqual(problems(report), [`"Implements #N" closes its issue on merge after sanitizeModelText: the sanitizer has to cover it`]);
});

test("a phrase that closes nothing, even raw, is no problem: GitLab simply does not know it", () => {
  const report = passingReport();
  report.closing!.find((r) => r.form === "Implementing #N")!.raw = { closed: false };
  assert.deepEqual(problems(report), []);
});

test("when the control phrase did not close its issue, no phrase was shown not to close", () => {
  const report = passingReport();
  report.closing!.find((r) => r.form === CONTROL_CLOSING_FORM)!.raw = { closed: false };
  assert.match(problems(report).join("\n"), /the control proved nothing: "Closes #N" did not close its issue on merge/);
  assert.match(problems({ ...passingReport(), closing: [] }).join("\n"), /the control proved nothing/, "no result at all is no proof either");
});

test("a payload that runs after the guard is a problem that names the payload and where it ran", () => {
  const report = passingReport();
  report.quickActions!.find((r) => r.case === "/close inside a fence of tildes" && r.surface === "merge request description")!.sanitized = true;
  assert.deepEqual(problems(report), [`"/close inside a fence of tildes" ran as a command in a merge request description after sanitizeModelText: the guard has to cover it`]);
});

test("a bare /close that does nothing on a surface, even raw, means nothing was shown there", () => {
  for (const surface of SURFACES) {
    const report = passingReport();
    report.quickActions!.find((r) => r.case === CONTROL_CASE && r.surface === surface)!.raw = false;
    assert.match(problems(report).join("\n"), new RegExp(`a bare /close did not run in a ${surface}`));
  }
});

test("a payload that does nothing raw is no problem, and neither is a fence GitLab already reads as code", () => {
  const report = passingReport();
  for (const r of report.quickActions!) if (r.case !== CONTROL_CASE) r.raw = false;
  assert.deepEqual(problems(report), []);
});

test("references that stay linked behind the zero-width space, or leave a note on !1, are problems; so is a control that linked nothing", () => {
  const linked = passingReport();
  linked.sigils!.sanitized = { links: 2, crossReferenced: false };
  assert.match(problems(linked).join("\n"), /still linked 2 reference\(s\)/);

  const noted = passingReport();
  noted.sigils!.sanitized = { links: 0, crossReferenced: true };
  assert.match(problems(noted).join("\n"), /cross-reference note on !1/);

  const vacuous = passingReport();
  vacuous.sigils!.raw = { links: 0, crossReferenced: true };
  assert.match(problems(vacuous).join("\n"), /the control proved nothing: GitLab linked none of !1, ~bug and %v1/);

  const silent = passingReport();
  silent.sigils!.raw = { links: 3, crossReferenced: false };
  assert.match(problems(silent).join("\n"), /the control proved nothing: GitLab wrote no cross-reference note on !1 for the unsanitized text/);
});

test("implement-issue has to end done, with an open merge request that says Closes #N, that merges, and whose merge closes the issue", () => {
  const cases: Array<[string, (w: NonNullable<ProofReport["workflow"]>) => void, RegExp]> = [
    ["a run that stops", (w) => Object.assign(w, { status: "tdd-violation", reason: "the red step changed the code" }), /ended "tdd-violation": the red step changed the code, not "done"/],
    ["a run that opens nothing", (w) => Object.assign(w, { mrUrl: undefined }), /opened no merge request/],
    ["a merge request that is not open", (w) => Object.assign(w, { mrState: "closed" }), /is "closed", not "opened"/],
    ["a description without the closing line", (w) => Object.assign(w, { closesIssueLine: false }), /no `Closes #N` line/],
    ["a merge request that cannot merge", (w) => Object.assign(w, { merged: false }), /could not be merged/],
    ["a merge that leaves the issue open", (w) => Object.assign(w, { issueClosed: false }), /did not close its issue/],
  ];
  for (const [name, mutate, expected] of cases) {
    const report = passingReport();
    mutate(report.workflow!);
    assert.match(problems(report).join("\n"), expected, name);
  }
});

test("a stage that did not run is a problem, so a half run never reads as a pass", () => {
  assert.equal(problems({ versions: passingReport().versions }).length, 4);
  for (const stage of ["closing", "quickActions", "sigils", "workflow"] as const) {
    const report = passingReport();
    delete report[stage];
    assert.equal(problems(report).length, 1, stage);
  }
});

test("only the stages a run was asked for have to show their proof: a run of some stages reads as a pass when those held", () => {
  const report = { versions: passingReport().versions, closing: passingReport().closing };
  assert.deepEqual(problems(report, ["closing"]), []);
  assert.equal(problems(report, ["closing", "workflow"]).length, 1);
  assert.match(renderEvidence(report, ["closing"]), /Every proof held\.$/m);
  const failing = passingReport();
  failing.closing!.find((r) => r.form === "Fixes #N")!.sanitized = { closed: true };
  assert.equal(problems(failing, ["closing"]).length, 1);
});

// ── the evidence ─────────────────────────────────────────────────────────────────────────────────────────────────

test("the evidence answers the Implement question, naming how many forms closed the issue and how many still close it after the sanitizer", () => {
  const text = renderEvidence(passingReport());
  assert.match(text, /Does GitLab's default closing pattern match `Implement\(s\|ed\|ing\) #N`\? \*\*Yes\*\*: 4 of 4 forms closed the issue/);
  assert.match(text, /After `sanitizeModelText`, 0 of them still close it/);
  assert.match(text, /^\| `Implements #N` \| yes \(3 s\) \| no \|$/m);
  assert.match(text, /^Run with glab 1\.130\.0 against GitLab CE 19\.5\.5 \(`gitlab\/gitlab-ce:19\.5\.5-ce\.0`\)/);
  assert.match(text, /Every proof held\.$/m);

  const none = passingReport();
  for (const r of none.closing!.filter((r) => /^Implement/.test(r.form))) r.raw = { closed: false };
  assert.match(renderEvidence(none), /\*\*No\*\*: 0 of 4 forms closed the issue/);
});

test("the evidence has a row for every payload on every surface, the references, and the run of implement-issue with its caps", () => {
  const text = renderEvidence(passingReport());
  for (const c of QUICK_ACTION_CASES) for (const surface of SURFACES) assert.ok(text.includes(`| ${c.name} | ${surface} |`), `${c.name} on a ${surface}`);
  assert.match(text, /cross-reference note on `!1`/);
  assert.match(text, /\| Run status \| `done` \|/);
  assert.match(text, /\| The issue closed after the merge \| yes \(4 s\) \|/);
  assert.match(text, /\| Tokens \| 340000, under `--max-tokens 600000 --max-cents 100` \|/);
});

test("the evidence of a run with problems lists them, and a pipe in a payload name does not break its table row", () => {
  const report = passingReport();
  report.closing!.find((r) => r.form === "Closed #N")!.sanitized = { closed: true, seconds: 2 };
  report.quickActions!.push({ case: "a | b", surface: "issue note", raw: true, sanitized: false });
  const text = renderEvidence(report);
  assert.match(text, /^Problems:\n- "Closed #N" closes its issue on merge after sanitizeModelText/m);
  assert.ok(text.includes("| a \\| b | issue note |"));
  assert.ok(!text.includes("Every proof held."));
});

test("a stage that did not run leaves its section out of the evidence, and the problems say why", () => {
  const text = renderEvidence({ versions: passingReport().versions, closing: passingReport().closing });
  assert.ok(!text.includes("### Quick actions"));
  assert.match(text, /- the quick actions were not checked/);
  assert.match(text, /- implement-issue was not run/);
});

// ── what the prover does around them ─────────────────────────────────────────────────────────────────────────────

test("the stages a maintainer names run in the order they have, and an unknown name is refused naming the ones there are", () => {
  assert.deepEqual(stagesOf(undefined), ["closing", "quick-actions", "references", "workflow"]);
  assert.deepEqual(stagesOf(""), ["closing", "quick-actions", "references", "workflow"]);
  assert.deepEqual(stagesOf("references, closing"), ["closing", "references"], "the free stages first, whatever the order it was typed in");
  assert.throws(() => stagesOf("closing,flow"), /GITLAB_E2E_STAGES names flow: the stages are closing, quick-actions, references, workflow/);
});

test("the evidence that goes in a pull request has the token, the root password, the local host and the machine's paths replaced", () => {
  const secrets = { token: "glpat-s3cr3t-token-value", password: "hunter2-root-password", scratch: "/tmp/wf-gitlab-e2e-AbC123", home: "/home/maintainer" };
  const text = `MR http://localhost:8929/owner/proof/-/merge_requests/2 run in ${secrets.scratch}/proof by ${secrets.home}`;
  assert.equal(publishable(text, secrets), "MR http://gitlab.example.com/owner/proof/-/merge_requests/2 run in /tmp/scratch/proof by /home/user");
  assert.equal(publishable(renderEvidence(passingReport()), secrets).includes("localhost"), false);
});

test("a credential of a shape the scrubber was not told about is redacted too, by the runtime's own list of shapes", () => {
  const secrets = { token: "glpat-s3cr3t-token-value", password: "hunter2-root-password", scratch: "/tmp/wf-gitlab-e2e-AbC123", home: "/home/maintainer" };
  assert.equal(publishable("a token of another shape: glpat-0123456789abcdefghij", secrets).includes("glpat-0123456789abcdefghij"), false, "the runtime's redactor knows its shape");
});
