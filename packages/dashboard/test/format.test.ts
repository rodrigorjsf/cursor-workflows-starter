// Seam: the formatting of costs and durations, which the Board, the Runs table (`app/`) and the Run view (`run-view/`) all
// show. One module writes them, so the same run's cost reads the same on every page.
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCents, formatDuration, runDuration } from "../app/format.js";

test("a cost and a duration read the same on the Board, in the Runs table and in the Run view", () => {
  assert.deepEqual([0.4, 12.34, 1234.5].map(formatCents), ["0.4¢", "12.34¢", "$12.35"]);
  assert.equal(runDuration("2026-11-12T10:00:00.000Z", "2026-11-12T10:03:05.000Z"), "3m 5s");
});
