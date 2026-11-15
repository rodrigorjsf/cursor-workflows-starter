// Seam: the engine, run with the fake Cursor SDK in a temporary repository. The SDK sends the API key to the address in
// CURSOR_BACKEND_URL (and CURSOR_WEBSITE_URL for login) with no check of its own, so a run whose environment names an address that is
// not an https URL on cursor.sh or cursor.com is refused before any agent exists: the fake SDK sees no `Agent.create`, and nothing is
// written to the run's directory. Environment variables are process-wide: this file's tests run one after another.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { calls, script } from "./fake-sdk.js";
import { runWorkflow } from "../src/runtime/engine.js";
import { runDirIn } from "../src/runtime/run-store.js";
import { defineWorkflow } from "../src/runtime/workflow.js";
import { clearConfig } from "./config-fixtures.js";

const VARIABLES = ["CURSOR_BACKEND_URL", "CURSOR_WEBSITE_URL"] as const;
let cwd = "";
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "wf-endpoints-"));
});
afterEach(() => {
  for (const name of VARIABLES) delete process.env[name];
  clearConfig(cwd);
  rmSync(cwd, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
});

const oneStep = defineWorkflow({ meta: { name: "one-step", description: "one step" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent("hello", { label: "hello" }) });
const noAgent = defineWorkflow({ meta: { name: "no-agent", description: "no agent" }, run: async (ctx) => ctx.log("ran") });

test("a CURSOR_BACKEND_URL that is not an https URL on cursor.sh or cursor.com refuses the run before any agent is created, and writes nothing", async () => {
  script.push(() => ({ result: "ok" }));
  for (const value of ["http://api.cursor.sh", "https://evil.example"]) {
    process.env.CURSOR_BACKEND_URL = value;
    const r = await runWorkflow(oneStep, {}, { cwd, runId: "bad-endpoint" });
    assert.equal(r.status, "failed", value);
    assert.equal(r.refused, true, "refused, like invalid args: the run never started");
    assert.match(r.error!, /CURSOR_BACKEND_URL is https?:\/\/[a-z.]+, which is not an https URL on cursor\.sh or cursor\.com/);
    assert.equal(calls.length, 0, `${value}: Agent.create was called`);
    assert.equal(existsSync(runDirIn(cwd, "bad-endpoint")), false, "a refused run leaves no run directory");
  }
});

test("a CURSOR_WEBSITE_URL that is not a Cursor address refuses the run the same way", async () => {
  script.push(() => ({ result: "ok" }));
  process.env.CURSOR_WEBSITE_URL = "https://evil.example/login";
  const r = await runWorkflow(oneStep, {}, { cwd });
  assert.equal(r.refused, true);
  assert.match(r.error!, /CURSOR_WEBSITE_URL is https:\/\/evil\.example,/);
  assert.equal(calls.length, 0);
});

test("a Cursor address, or neither variable, lets the run go: the check keeps no run away from the real endpoint", async () => {
  script.push(() => ({ result: "ok" }), () => ({ result: "ok" }));
  const unset = await runWorkflow(oneStep, {}, { cwd });
  assert.equal(unset.status, "finished", unset.error);
  process.env.CURSOR_BACKEND_URL = "https://api2.cursor.sh";
  process.env.CURSOR_WEBSITE_URL = "https://cursor.com";
  const set = await runWorkflow(oneStep, {}, { cwd });
  assert.equal(set.status, "finished", set.error);
  assert.equal(calls.length, 2);
});

test("a workflow that creates no agent is refused too: the check is the run's, whether or not a step would reach the SDK", async () => {
  process.env.CURSOR_BACKEND_URL = "https://evil.example";
  const r = await runWorkflow(noAgent, {}, { cwd });
  assert.equal(r.refused, true);
});
