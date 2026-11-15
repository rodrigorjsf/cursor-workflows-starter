// Seam: the run's step stores. `runWorkflow` with the fake Cursor SDK runs a step whose result holds a credential; the
// journal (`journal.jsonl`) and the memo cache (`.workflows/memo/`) are read back from disk, and the run is resumed from them.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { calls, script } from "./fake-sdk.js";
import { runWorkflow } from "../src/runtime/engine.js";
import { defineWorkflow } from "../src/runtime/workflow.js";

const cwd = join(import.meta.dirname, ".tmp", `step-store-redaction-${process.pid}`);
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
});

/** Every file under `dir`, with its text. */
function filesUnder(dir: string): Array<[string, string]> {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [[path, readFileSync(path, "utf8")] as [string, string]];
  });
}

test("a step result that holds a credential is stored redacted in the journal and the memo, and a resume replays it", async () => {
  mkdirSync(cwd, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(cwd, "a.txt"), "1");
  git("add", ".");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");

  const key = "crsr_" + "x".repeat(24);
  const prompts: string[] = [];
  const answer = (result: string) => (_o: unknown, msg: string) => (prompts.push(msg), { status: "finished", result });
  script.push(answer(`the key is ${key}`), answer("done"));
  const wf = defineWorkflow({
    meta: { name: "store-redaction", description: "store-redaction" },
    defaults: { model: { id: "m" } },
    async run(ctx) {
      const read = await ctx.agent<string>("read the key", { tools: ["read"], memo: true });
      const used = await ctx.agent<string>(`use this: ${read}`, { label: "use" });
      return { read, used };
    },
  });

  const first = await runWorkflow(wf, {}, { cwd });
  assert.equal(first.status, "finished", first.error);
  // The run sees the value it stores: what a resume will replay, so the later prompts and their journal keys match.
  assert.deepEqual(first.result, { read: "the key is [REDACTED]", used: "done" });
  assert.ok(!prompts.some((p) => p.includes(key)), "the credential must not flow into a later prompt");
  const stored = filesUnder(join(cwd, ".workflows"));
  assert.ok(stored.some(([path]) => path.endsWith("journal.jsonl")));
  assert.ok(stored.some(([path]) => path.includes(`${join(".workflows", "memo")}`)), "the read-only step was memoized");
  for (const [path, text] of stored) assert.ok(!text.includes(key), `${path} holds the credential`);

  const created = calls.length;
  const resumed = await runWorkflow(wf, {}, { cwd, runId: first.runId });
  assert.equal(resumed.status, "finished", resumed.error);
  assert.equal(calls.length, created, "both steps come from the journal: no agent is created again");
  assert.deepEqual(resumed.result, first.result);
});

test("the key `wf login` saved is redacted from the event log, the journal and the memo even when no key was passed to the run and CURSOR_API_KEY is unset", async () => {
  // The SDK reads the saved login itself, so the engine never sees the key in its options or its environment: it reads the file the SDK reads.
  // A key of no known shape, so that nothing but knowing the key can hide it.
  const saved = `saved-login-${"x".repeat(24)}`;
  const home = mkdtempSync(join(tmpdir(), "wf-saved-key-home-"));
  mkdirSync(join(home, ".cursor", "sdk"), { recursive: true });
  writeFileSync(join(home, ".cursor", "sdk", "auth.json"), JSON.stringify({ apiKey: saved }));
  const before = { HOME: process.env.HOME, CURSOR_API_KEY: process.env.CURSOR_API_KEY };
  process.env.HOME = home;
  delete process.env.CURSOR_API_KEY;
  try {
    mkdirSync(cwd, { recursive: true });
    script.push(() => ({ status: "finished", result: `the saved key is ${saved}` }));
    const wf = defineWorkflow({
      meta: { name: "saved-key", description: "saved-key" },
      defaults: { model: { id: "m" } },
      async run(ctx) {
        return ctx.agent<string>("echo the key", { tools: ["read"], memo: true });
      },
    });
    const r = await runWorkflow(wf, {}, { cwd });
    assert.equal(r.status, "finished", r.error);
    assert.equal(r.result, "the saved key is [REDACTED]");
    const stored = filesUnder(join(cwd, ".workflows"));
    for (const name of ["events.jsonl", "journal.jsonl"]) assert.ok(stored.some(([path]) => path.endsWith(name)), `${name} was written`);
    assert.ok(stored.some(([path]) => path.includes(join(".workflows", "memo"))), "the memo was written");
    for (const [path, text] of stored) assert.ok(!text.includes(saved), `${path} holds the saved key`);
    assert.ok(stored.some(([, text]) => text.includes("[REDACTED]")), "what was hidden is marked");
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("a step result keeps the redact-only shapes (a URL password, Bearer, JWT): the workflow may run them; the event log still hides them", async () => {
  mkdirSync(cwd, { recursive: true });
  const command = "DATABASE_URL=postgres://u:pw1234567890@localhost/db npm test";
  const header = "Authorization: Bearer abcdefghijklmnop1234";
  const jwt = "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJlMTIz";
  const key = "crsr_" + "y".repeat(24);
  script.push(() => ({ status: "finished", result: `${command} | ${header} | ${jwt} | ${key}` }));
  const wf = defineWorkflow({
    meta: { name: "store-redact-only", description: "store-redact-only" },
    defaults: { model: { id: "m" } },
    async run(ctx) {
      return ctx.agent<string>("plan the test command", { tools: ["read"] });
    },
  });
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.status, "finished", r.error);
  assert.equal(r.result, `${command} | ${header} | ${jwt} | [REDACTED]`, "only the blocking formats are redacted from the result");
  const events = readFileSync(join(cwd, ".workflows", "runs", r.runId, "events.jsonl"), "utf8");
  assert.ok(events.includes("postgres://u:[REDACTED]@localhost/db"), "the step's answer is in the event log, redacted");
  for (const shown of ["pw1234567890", "abcdefghijklmnop1234", jwt, key]) assert.ok(!events.includes(shown), `the event log holds ${shown}`);
});
