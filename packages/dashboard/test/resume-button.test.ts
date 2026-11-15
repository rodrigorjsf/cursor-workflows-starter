// Seam: the Run view's header actions as the browser first paints them (`RunActions`, rendered to static markup with its data handed
// to it), and `resumeResult` (run-view/run-actions.ts), which says what the header shows after a resume. The Resume button is offered
// only for a run that can be resumed: one that stopped (`failed` or `cancelled`) and is not held by a frozen process. No DOM, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RunActions, type RunActionsProps } from "../run-view/RunActions.js";
import { resumeResult } from "../run-view/run-actions.js";
import { render, textOf } from "./render.js";

const noop = () => undefined;
const INFO = { workflow: "echo", repo: "/work/app", start: { args: { issue: 7 }, maxTokens: 50_000, maxCents: 20 } };

const header = (props: Partial<RunActionsProps>) =>
  textOf(render(RunActions, { runId: "echo-aaaa0001", offered: { cancelRun: false, frozen: false, leftCloudAgents: [] }, info: INFO, onChanged: noop, ...props }));

test("a failed or cancelled run offers Resume run, beside the command to copy", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const text = header({ status });
    assert.match(text, /Resume run/, status);
    assert.match(text, /Copy resume command/, status);
  }
});

test("a run that is running, finished or unreadable, or not known yet, offers no Resume", () => {
  for (const status of ["running", "finished", "missing", undefined] as const) assert.doesNotMatch(header({ status }), /Resume run/, String(status));
});

test("a frozen run, failed but still held by its process, offers Cancel run and no Resume: a job over it would find the run already executing", () => {
  const text = header({ status: "failed", offered: { cancelRun: true, frozen: true, leftCloudAgents: [] } });
  assert.match(text, /Cancel run/);
  assert.doesNotMatch(text, /Resume run/);
});

test("a resume that started a job says the page follows the run; one the server refused says why, in a sentence", () => {
  assert.deepEqual(resumeResult({ ok: true, jobId: "5c1f0b2e" }), { step: "started" });
  assert.deepEqual(resumeResult({ ok: false, error: "the run is running; only a failed or cancelled run can be resumed" }), { step: "failed", message: "The run is running; only a failed or cancelled run can be resumed." });
  assert.deepEqual(resumeResult({ ok: false, error: "could not reach the dashboard: fetch failed" }), { step: "failed", message: "Could not reach the dashboard: fetch failed." });
});
