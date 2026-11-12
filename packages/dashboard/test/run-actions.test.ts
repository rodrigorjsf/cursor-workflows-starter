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

test("a cancel that worked says what it did", () => {
  assert.deepEqual(cancelResult({ ok: true, status: "cancelled", note: "" }, false), { step: "done", message: "Cancelled." });
  assert.deepEqual(cancelResult({ ok: true, status: "failed", note: "the run is not running (failed); cancelled cloud agent bc-1" }, true), { step: "done", message: "Cancelled cloud agent bc-1." });
});
