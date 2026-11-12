// Seam: `cancelResult`, what the Run view's header says after a cancel. A cancel that finds nothing left to stop (the run ended,
// or its cloud agents were already cancelled) is a done outcome, said neutrally; only a cancel that could not be carried out is
// a failure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelResult } from "../run-view/run-actions.js";

test("a cancel the server answers with 'nothing to cancel' reads as done, not as a failure", () => {
  for (const cloudOnly of [true, false]) {
    for (const status of ["failed", "finished"]) {
      const result = cancelResult({ ok: false, error: `the run is not running (${status}); nothing to cancel` }, cloudOnly);
      assert.equal(result.step, "done", `${cloudOnly ? "cloud agents" : "run"}, ${status}`);
      assert.equal(result.message, `The run is not running (${status}); nothing to cancel.`);
    }
  }
});

test("a cancel that could not be carried out stays a failure", () => {
  assert.equal(cancelResult({ ok: false, error: "the run was not started as a job: stop it with Ctrl-C in its terminal" }, false).step, "failed");
  assert.equal(cancelResult({ ok: false, error: "could not reach the dashboard: fetch failed" }, true).step, "failed");
  assert.equal(cancelResult({ ok: true, status: "failed", note: "the run is not running (failed); could not reach cloud agent bc-1" }, true).step, "failed");
});

test("cancelling a frozen run says what the kill did, and keeps the button when something is left to cancel", () => {
  const killed = "process 4242 had no heartbeat and was killed (SIGKILL) without undoing the step in progress; the run stays resumable";
  assert.deepEqual(cancelResult({ ok: true, status: "failed", note: killed }, false), { step: "done", message: `${killed.charAt(0).toUpperCase()}${killed.slice(1)}.` }, "the kill is over: not 'Cancelling'");
  const withAgents = `${killed}; cancelled the cloud agent it left running: bc-1`;
  assert.equal(cancelResult({ ok: true, status: "failed", note: withAgents }, false).step, "done");
  assert.match(cancelResult({ ok: true, status: "failed", note: withAgents }, false).message, /bc-1\.$/);
  const unreached = `${killed}; could not reach cloud agent bc-1 (fetch failed): resume the run and cancel it`;
  assert.equal(cancelResult({ ok: true, status: "failed", note: unreached }, false).step, "failed", "an agent left spending");
  const notGone = `${killed}; process 4242 has not exited yet, so the cloud agents its run left running were not cancelled: cancel this job again once it is gone`;
  assert.equal(cancelResult({ ok: true, status: "failed", note: notGone }, false).step, "failed", "the user has to cancel again");
});

test("a run still stopping after SIGTERM says it is cancelling", () => {
  assert.deepEqual(cancelResult({ ok: true, status: "running", note: "SIGTERM sent to process 7, which is still stopping; check with wait_workflow" }, false), {
    step: "done",
    message: "Cancelling: SIGTERM sent to process 7, which is still stopping; check with wait_workflow",
  });
});

test("a cancel that worked says what it did", () => {
  assert.deepEqual(cancelResult({ ok: true, status: "cancelled", note: "" }, false), { step: "done", message: "Cancelled." });
  assert.deepEqual(cancelResult({ ok: true, status: "failed", note: "the run is not running (failed); cancelled cloud agent bc-1" }, true), { step: "done", message: "Cancelled cloud agent bc-1." });
});
