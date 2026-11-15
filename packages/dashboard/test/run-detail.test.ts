// Seam: `parseRunDetail`, how the Run view reads `GET /api/runs/<runId>`. The answer is untrusted JSON: a body without a known
// status is no detail at all, and a field of the wrong type is left out rather than passed on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRunDetail } from "../run-view/run-detail.js";

test("a run's detail keeps its status, error, workflow, repo and start", () => {
  const detail = parseRunDetail({ status: "failed", error: "boom", workflow: "implement-issue", repo: "/r", start: { args: { issue: 3 } } });
  assert.deepEqual(detail, { status: "failed", error: "boom", workflow: "implement-issue", repo: "/r", start: { args: { issue: 3 } }, seamsProposal: undefined });
});

test("a body whose status is not one the API gives is no detail", () => {
  assert.equal(parseRunDetail({ status: "exploded" }), undefined);
  assert.equal(parseRunDetail({ workflow: "w", repo: "/r" }), undefined);
  assert.equal(parseRunDetail(["running"]), undefined);
  assert.equal(parseRunDetail(null), undefined);
});

test("fields of the wrong type are left out", () => {
  const detail = parseRunDetail({ status: "running", error: 7, workflow: 1, repo: ["/r"], start: "x", seamsProposal: { stop: "nope" } });
  assert.deepEqual(detail, { status: "running", error: undefined, workflow: undefined, repo: undefined, start: undefined, seamsProposal: undefined });
});

test("a start whose limits are not numbers is left out", () => {
  assert.equal(parseRunDetail({ status: "finished", start: { args: {}, maxCents: "5" } })?.start, undefined);
  assert.equal(parseRunDetail({ status: "finished", start: { args: {}, overrides: [] } })?.start, undefined);
  assert.deepEqual(parseRunDetail({ status: "finished", start: { args: {}, maxCents: 5, overrides: { model: "m" } } })?.start, { args: {}, maxCents: 5, overrides: { model: "m" } });
});
