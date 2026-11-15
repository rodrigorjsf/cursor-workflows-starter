// Seam: the Run view's seams panel as the browser first paints it (`SeamsPanel` and its replacement box, rendered to static markup with
// their data handed to them), and the pure modules behind it: `seams-form.ts` (the proposal the API offers, narrowed; the textarea's lines
// into a list of seams; the inline error of an empty list) and `resumeResult` (what the panel says after a decision, as the header does after a resume). The panel's
// requests are tested over HTTP in seams.process.test.ts. No DOM, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ReplaceBox, SeamsPanel, type SeamsPanelProps } from "../run-view/SeamsPanel.js";
import { approveSeams, replaceSeams, resumeResult } from "../run-view/run-actions.js";
import { isSeamsProposal, replacementOf, seamsFromText } from "../run-view/seams-form.js";
import { render, textOf } from "./render.js";

const noop = () => undefined;
const PROPOSAL = {
  stop: "seams-proposed" as const,
  seams: [{ name: "math.subtract", interface: "subtract(a, b): number", why: "the behaviour the issue asks for" }],
  slices: [{ behavior: "subtract returns the difference", seam: "math.subtract", testIdea: "subtract(5, 3) is 2" }],
  testCommand: "node --test",
  digest: "0123456789abcdef",
};

const panel = (props: Partial<SeamsPanelProps> = {}) => render(SeamsPanel, { runId: "implement-issue-aaaa0001", proposal: PROPOSAL, status: "finished", onChanged: noop, ...props });

test("a run at its seams proposal shows the seams, the slices and the test command, with Approve and Replace seams and no reject", () => {
  const html = panel();
  const text = textOf(html);
  assert.match(text, /math\.subtract/);
  assert.match(text, /subtract\(a, b\): number/);
  assert.match(text, /the behaviour the issue asks for/);
  assert.match(text, /subtract returns the difference/);
  assert.match(text, /node --test/);
  assert.match(text, /Approve/);
  assert.match(text, /Replace seams/);
  assert.doesNotMatch(text, /Reject/);
  assert.match(html, /role="region"|<section/);
});

test("a proposal at the planner's test command says that nothing ran and shows the command, which is what Approve lets the run execute", () => {
  const text = textOf(panel({ proposal: { ...PROPOSAL, stop: "test-command-proposed", testCommand: "touch PWNED" } }));
  assert.match(text, /Test command proposed/);
  assert.match(text, /nothing has run/i);
  assert.match(text, /touch PWNED/);
});

test("text of the proposal is shown as text: markup in a seam or in the command is escaped", () => {
  const html = panel({ proposal: { ...PROPOSAL, seams: [{ name: "<img src=x onerror=alert(1)>", interface: "<b>i</b>", why: "<script>w</script>" }], testCommand: "echo '<u>x</u>'" } });
  assert.doesNotMatch(html, /<img|<script|<b>|<u>/);
  assert.match(textOf(html), /<img src=x onerror=alert\(1\)>/);
});

test("a command of several lines keeps its lines: a person who approves it reads the script that runs", () => {
  const html = panel({ proposal: { ...PROPOSAL, testCommand: "npm test\ntouch PWNED" } });
  assert.match(html, /<pre[^>]*>[\s\S]*npm test\ntouch PWNED[\s\S]*<\/pre>/);
});

test("the replacement box says one seam per line, and shows its inline error as an alert", () => {
  const withError = render(ReplaceBox, { text: "", error: "List at least one seam, one per line.", sending: false, onText: noop, onSend: noop, onCancel: noop });
  assert.match(textOf(withError), /one per line/i);
  assert.match(withError, /<textarea/);
  assert.match(withError, /role="alert"[^>]*>List at least one seam, one per line\./);
  const clean = render(ReplaceBox, { text: "math.negate(a)", sending: false, onText: noop, onSend: noop, onCancel: noop });
  assert.doesNotMatch(clean, /role="alert"/);
  assert.match(clean, /math\.negate\(a\)/);
});

test("the textarea's lines become the seams: one each, trimmed, blank lines and either line ending dropped", () => {
  assert.deepEqual(seamsFromText("math.negate(a)\r\n\n  math.abs(a)  \n   \n"), ["math.negate(a)", "math.abs(a)"]);
  assert.deepEqual(seamsFromText(""), []);
  assert.deepEqual(seamsFromText(" \n\t\n"), []);
});

test("an empty replacement is refused with an inline error, and a list is passed on", () => {
  assert.deepEqual(replacementOf(""), { ok: false, error: "List at least one seam, one per line." });
  assert.deepEqual(replacementOf("  \n \n"), { ok: false, error: "List at least one seam, one per line." });
  assert.deepEqual(replacementOf("a\nb"), { ok: true, seams: ["a", "b"] });
});

test("only an object of the proposal's shape is a proposal: the page narrows what the API answered", () => {
  assert.equal(isSeamsProposal(PROPOSAL), true);
  assert.equal(isSeamsProposal({ ...PROPOSAL, stop: "done" }), false);
  assert.equal(isSeamsProposal({ ...PROPOSAL, digest: 7 }), false);
  assert.equal(isSeamsProposal({ ...PROPOSAL, seams: [{ name: "a" }] }), false);
  assert.equal(isSeamsProposal({ ...PROPOSAL, slices: "none" }), false);
  assert.equal(isSeamsProposal(null), false);
  assert.equal(isSeamsProposal(undefined), false);
  assert.equal(isSeamsProposal("seams-proposed"), false);
});

test("a decision that started a job says the page follows the run; one the server refused says why, in a sentence", () => {
  assert.deepEqual(resumeResult({ ok: true, jobId: "5c1f0b2e" }), { step: "started" });
  assert.deepEqual(resumeResult({ ok: false, error: "the proposal changed since this page showed it; reload the page and read the new one before approving" }), {
    step: "failed",
    message: "The proposal changed since this page showed it; reload the page and read the new one before approving.",
  });
});

test("the page's calls report a dashboard that does not answer as data, and never throw", async () => {
  // no server answers on port 1
  const approved = await approveSeams("implement-issue-aaaa0001", "0123456789abcdef", "http://127.0.0.1:1");
  const replaced = await replaceSeams("implement-issue-aaaa0001", ["a"], "http://127.0.0.1:1");
  for (const outcome of [approved, replaced]) {
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.error, /^could not reach the dashboard/);
  }
});
