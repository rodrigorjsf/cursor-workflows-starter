// Seam: the address of the Run view page. `runIdOf(pathname)` is how the page learns which run it shows from `/runs/<runId>`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runIdOf } from "../src/ui/location.js";

test("the run id is the second segment of /runs/<runId>, percent-decoded", () => {
  assert.equal(runIdOf("/runs/smoke-47b80529"), "smoke-47b80529");
  assert.equal(runIdOf("/runs/a%20b%2Fc"), "a b/c");
  assert.equal(runIdOf("/runs/live-demo-0001/"), "live-demo-0001");
});

test("an address that names no run, or is not valid percent-encoding, names no run id: the page says the run was not found instead of failing", () => {
  for (const pathname of ["/runs/", "/runs", "/", "", "/runs/%E0%A4%A", "/runs/%"]) assert.equal(runIdOf(pathname), "", JSON.stringify(pathname));
});
