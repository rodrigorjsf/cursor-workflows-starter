// Seam 1 on the shipped workflow: `implement-issue` declares its eight roles, runs with their default models, and
// takes a different model or setting sources for a role from the config files or from WF_MODEL_*. The environment
// (fake SDK, fake gh, temp repo) is in implement-issue.fixture.ts.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { calls } from "@cursor/sdk";
import implementIssue from "../workflows/implement-issue.js";
import { fx, issue, names, run, setup, teardown } from "./implement-issue.fixture.js";
import { globalConfigPath, withEnv, writeGlobalConfig } from "./config-fixtures.js";

beforeEach(setup);
afterEach(() => {
  rmSync(globalConfigPath(), { force: true });
  teardown();
});

const modelOf = (label: string) => calls.find((c) => String(c.name).endsWith(`:${label}`))!.model;
const sourcesOf = (label: string) => calls.find((c) => String(c.name).endsWith(`:${label}`))!.local.settingSources;
const HIGH = [{ id: "reasoning_effort", value: "high" }];

test("implement-issue declares its eight roles, each with its cloud capability", () => {
  assert.deepEqual(
    implementIssue.meta.roles!.map((r) => `${r.name}:${r.cloud}`),
    ["classify:ok", "implement.low:never", "implement.med:never", "implement.high:never", "review:read-only", "fix:never", "design:read-only", "pr-text:read-only"],
  );
});

test("with no config the steps run on the role defaults: models, params and (for read-only roles) no setting sources", async () => {
  issue(["complexity:low"]);
  const r = await run({ openPr: true });
  assert.equal(r.status, "finished", r.error);
  assert.deepEqual(names().slice(0, 2), ["teste-1", "codigo-1"]);
  assert.deepEqual(modelOf("teste-1"), { id: "composer-2.5" });
  assert.deepEqual(modelOf("review:spec:1"), { id: "grok-4.7", params: HIGH });
  assert.deepEqual(modelOf("pr-texto"), { id: "composer-2.5" });
  assert.deepEqual(sourcesOf("review:spec:1"), []);
  assert.deepEqual(sourcesOf("pr-texto"), []);
  assert.deepEqual(sourcesOf("codigo-1"), ["project", "team", "mdm"], "write steps keep the engine default");
});

test("the config swaps the model of a role: global file, WF_MODEL_* by role name and by the old alias, params kept or replaced", async () => {
  issue(["complexity:low"]);
  writeGlobalConfig({ workflows: { "implement-issue": { roles: { review: { model: { params: [{ id: "reasoning_effort", value: "medium" }] }, retries: 0 }, "pr-text": { model: { id: "composer-3" } } } } } });
  const r = await withEnv({ WF_MODEL_LOW: "composer-9" }, () => run({ openPr: true }));
  assert.equal(r.status, "finished", r.error);
  assert.deepEqual(modelOf("teste-1"), { id: "composer-9" }, "WF_MODEL_LOW maps to implement.low");
  assert.deepEqual(modelOf("codigo-1"), { id: "composer-9" });
  assert.deepEqual(modelOf("review:spec:1"), { id: "grok-4.7", params: [{ id: "reasoning_effort", value: "medium" }] }, "the params changed, the id inherited");
  assert.deepEqual(modelOf("pr-texto"), { id: "composer-3" });
});

test("a misspelled role in the repo config is an error before any step; the declared roles are the contract", async () => {
  issue(["complexity:low"]);
  mkdirSync(join(fx.repo, ".agents", "workflows"), { recursive: true });
  writeFileSync(join(fx.repo, ".agents", "workflows", "config.json"), JSON.stringify({ workflows: { "implement-issue": { roles: { "implement.lo": { retries: 0 } } } } }));
  const r = await run({});
  assert.equal(r.status, "failed");
  assert.match(r.error!, /\/workflows\/implement-issue\/roles\/implement\.lo: unknown role \(workflow implement-issue declares: classify, implement\.low, implement\.med, implement\.high, review, fix, design, pr-text\)/);
  assert.equal(calls.length, 0);
});
