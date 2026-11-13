// Seam: the engine's retry policy, driven by the SDK error's `isRetryable` flag. `runWorkflow` runs one local step with
// retries against the fake Cursor SDK, whose `Agent.create` throws the error under test; `classifyError` is called directly.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { AuthenticationError, ConfigurationError, CursorAgentError, calls, costConfig } from "@cursor/sdk";
import { classifyError } from "../src/runtime/backend.js";
import { runWorkflow } from "../src/runtime/engine.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { defineWorkflow } from "../src/runtime/workflow.js";

const cwd = join(import.meta.dirname, ".tmp", `sdk-retry-${process.pid}`);
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  calls.length = 0;
  costConfig.createError = undefined;
});

const step = defineWorkflow({ meta: { name: "retry", description: "retry" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent("p", { label: "work", retries: 2 }) });

test("classifyError marks a configuration or authentication error the SDK says is not retryable", () => {
  assert.equal(classifyError(new ConfigurationError("[invalid_model] Bad model name")).reason, "not-retryable");
  assert.equal(classifyError(new AuthenticationError("Invalid API key")).reason, "not-retryable");
  assert.equal(classifyError(new ConfigurationError("odd", { isRetryable: true })).reason, "other", "the flag wins over the class");
  assert.equal(classifyError(new CursorAgentError("unknown")).reason, "other", "an unclassified SDK error keeps its retries");
});

for (const [name, error] of [
  ["a configuration error (bad model id)", () => new ConfigurationError("[invalid_model] Bad model name")],
  ["an authentication error (invalid key)", () => new AuthenticationError("Invalid API key")],
] as const) {
  test(`${name} fails the step at once, whatever retries it has left`, async () => {
    costConfig.createError = error;
    const r = await runWorkflow(step, {}, { cwd });
    assert.equal(r.status, "failed");
    assert.equal(calls.length, 1, "retries: 2, but trying again cannot help");
    assert.match(r.error!, /failed after 1 attempt\(s\)/);
    const ends = readEventLog(eventLogPath(cwd, r.runId)).events.filter((e) => e.type === "step-end");
    assert.equal(ends.length, 1);
  });
}

test("an SDK error that is retryable still uses the step's retries", async () => {
  costConfig.createError = () => new CursorAgentError("service unavailable", { isRetryable: true });
  const r = await runWorkflow(step, {}, { cwd });
  assert.equal(r.status, "failed");
  assert.equal(calls.length, 3);
});
