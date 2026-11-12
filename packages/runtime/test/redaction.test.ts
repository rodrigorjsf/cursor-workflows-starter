// Seam 1, the run: known secret formats, and the values of environment variables named like secrets, are redacted before
// anything is written to the run's event log, and before any listener sees an event. Runs `runWorkflow` with the fake
// Cursor SDK and reads the log back.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { calls, costConfig, script, stats } from "@cursor/sdk";
import { runWorkflow } from "../src/runtime/engine.js";
import type { ContentEvent, WorkflowEvent } from "../src/runtime/events.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { defineWorkflow } from "../src/runtime/workflow.js";

const cwd = join(import.meta.dirname, ".tmp", `redaction-${process.pid}`); // one directory per test process
const touchedEnv: string[] = [];
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  for (const name of touchedEnv.splice(0)) delete process.env[name];
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined });
});
const setEnv = (name: string, value: string) => {
  process.env[name] = value;
  touchedEnv.push(name);
};

const USAGE = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 20 };
const logText = (runId: string) => readFileSync(eventLogPath(cwd, runId), "utf8");
const contentOf = (events: WorkflowEvent[]) => events.filter((e): e is ContentEvent => e.type === "content");

/** One step whose prompt is `prompt` and whose agent says `said` and runs `command`, printing `output`. */
async function runStep(prompt: string, said = "", command = "true", output = "", opts: { apiKey?: string } = {}) {
  script.push(() => ({
    status: "finished",
    result: "ok",
    deltas: [
      { type: "text-delta", text: said },
      { type: "tool-call-started", callId: "c1", modelCallId: "m1", toolCall: { type: "shell", args: { command } } },
      { type: "tool-call-completed", callId: "c1", modelCallId: "m1", toolCall: { type: "shell", args: { command }, result: { status: "success", value: { exitCode: 0, signal: "", stdout: output, stderr: "", executionTime: 1 } } } },
      { type: "turn-ended", usage: USAGE },
    ],
  }));
  const wf = defineWorkflow({ meta: { name: "redact", description: "redact" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent(prompt, { label: "work" }) });
  const seen: WorkflowEvent[] = [];
  const r = await runWorkflow(wf, {}, { cwd, onEvent: (e) => seen.push(e), ...opts });
  assert.equal(r.status, "finished", r.error);
  return { runId: r.runId, seen };
}

/** One credential per known format, built from parts so this file holds no literal that a secret scanner would flag. */
const FORMATS: Record<string, string> = {
  "GitHub token": ["ghp", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join(""),
  "GitHub fine-grained token": ["github", "_pat_", "11ABCDEFG0abcdefghijkl_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join(""),
  "AWS access key id": ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
  "Cursor API key": ["crsr", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"].join(""),
  "OpenAI-style key": ["sk", "-", "proj-abcdefghijklmnopqrstuvwxyz0123456789"].join(""),
  "Anthropic-style key": ["sk", "-ant-", "api03-abcdefghijklmnopqrstuvwxyz0123456789"].join(""),
  "Slack token": ["xoxb", "-", "123456789012-abcdefghijklmnop"].join(""),
  "Google API key": ["AIza", "SyA1234567890abcdefghijklmnopqrstuv"].join(""),
  "npm token": ["npm", "_", "abcdefghijklmnopqrstuvwxyz0123456789"].join(""),
  "Stripe key": ["sk", "_live_", "abcdefghijklmnopqrstuvwx"].join(""),
  JWT: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "abcdefghij1234567890"].join("."),
  "private key block": ["-----BEGIN ", "RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabc\ndefghijkl\n-----END ", "RSA PRIVATE KEY-----"].join(""),
};

for (const [name, secret] of Object.entries(FORMATS)) {
  test(`redaction: a ${name} is replaced in the prompt, the agent message, the tool call and the command output`, async () => {
    const { runId } = await runStep(`use ${secret} now`, `I saw ${secret}`, `curl -H "x: ${secret}"`, `leaked ${secret}\n`);
    const log = logText(runId);
    assert.ok(!log.includes(secret), `${name} must not reach the log`);
    const content = contentOf(readEventLog(eventLogPath(cwd, runId)).events);
    assert.deepEqual(
      content.map((c) => c.kind),
      ["prompt", "tool-call", "command-output", "agent-message"],
    );
    for (const c of content) assert.match(c.text!, /\[REDACTED\]/, `${c.kind} keeps a marker where the secret was`);
  });
}

test("redaction: a bearer token keeps the word Bearer, and the text around a secret is untouched", async () => {
  const { runId } = await runStep("send Authorization: Bearer abcdefghijklmnopqrstuvwx0123456789 please");
  const [prompt] = contentOf(readEventLog(eventLogPath(cwd, runId)).events);
  assert.equal(prompt!.text, "send Authorization: Bearer [REDACTED] please");
});

test("redaction: the value of an environment variable named like a secret is replaced, whatever its format", async () => {
  setEnv("DEPLOY_API_KEY", "plain-value-without-a-known-format");
  setEnv("db_password", "p@ss.w0rd+with$regex(chars)");
  setEnv("SERVICE_SECRET", "line one\nline two of the secret");
  setEnv("AUTH_TOKEN", "tok-1234567890");
  const { runId, seen } = await runStep(
    "key plain-value-without-a-known-format and p@ss.w0rd+with$regex(chars) and line one\nline two of the secret",
    "token tok-1234567890",
  );
  const log = logText(runId);
  for (const secret of ["plain-value-without-a-known-format", "p@ss.w0rd+with$regex(chars)", "line two of the secret", "tok-1234567890"]) {
    assert.ok(!log.includes(secret), `${secret} must not reach the log`);
    assert.ok(!JSON.stringify(seen).includes(secret), `${secret} must not reach a listener`);
  }
  const [prompt] = contentOf(readEventLog(eventLogPath(cwd, runId)).events);
  assert.equal(prompt!.text, "key [REDACTED] and [REDACTED] and [REDACTED]");
});

test("redaction: only variables named like a secret, and only values long enough not to be ordinary words", async () => {
  setEnv("PLAIN_SETTING", "ordinary-value-12345");
  setEnv("SHORT_TOKEN", "abc");
  setEnv("KEYBOARD_LAYOUT", "us");
  const { runId } = await runStep("ordinary-value-12345 abc us");
  const [prompt] = contentOf(readEventLog(eventLogPath(cwd, runId)).events);
  assert.equal(prompt!.text, "ordinary-value-12345 abc us");
});

test("redaction: the API key passed to the run is redacted even when no environment variable holds it", async () => {
  const { runId } = await runStep("the key is my-explicit-run-key-0001", "", "true", "", { apiKey: "my-explicit-run-key-0001" });
  assert.ok(!logText(runId).includes("my-explicit-run-key-0001"));
});

test("redaction: every string of every event is redacted, not only step content", async () => {
  setEnv("LEAK_TOKEN", "log-and-result-secret-77");
  const wf = defineWorkflow({
    meta: { name: "everything", description: "everything" },
    async run(ctx) {
      ctx.log("saw log-and-result-secret-77");
      ctx.metric("note", "metric log-and-result-secret-77");
      return { nested: ["log-and-result-secret-77"] };
    },
  });
  const seen: WorkflowEvent[] = [];
  const r = await runWorkflow(wf, {}, { cwd, onEvent: (e) => seen.push(e) });
  assert.ok(!logText(r.runId).includes("log-and-result-secret-77"));
  assert.ok(!JSON.stringify(seen).includes("log-and-result-secret-77"), "listeners receive the redacted events");
  const end = readEventLog(eventLogPath(cwd, r.runId)).events.find((e) => e.type === "run-end");
  assert.ok(end?.type === "run-end");
  assert.deepEqual(end.result, { nested: ["[REDACTED]"] });
});

test("redaction happens before the content is cut: a secret on the cut boundary does not leave a prefix behind", async () => {
  const secret = FORMATS["GitHub token"]!;
  const { runId } = await runStep(`${"x".repeat(32_760)}${secret}`);
  const [prompt] = contentOf(readEventLog(eventLogPath(cwd, runId)).events);
  assert.ok(!prompt!.text!.includes("ghp"), "no part of the token survives");
  assert.equal(prompt!.chars, 32_760 + "[REDACTED]".length);
});
