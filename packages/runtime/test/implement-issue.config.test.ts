// Seam 1 on the shipped workflow: `implement-issue` declares its eight roles, runs with their default models, and
// takes a different model or setting sources for a role from the config files or from WF_MODEL_*. Its limits (slice caps,
// extra slices, fix rounds, red/green attempts, diff size, label-to-tier map, crash limit) are settings of the workflow
// that the same files tune. The environment (fake SDK, fake gh, temp repo) is in implement-issue.fixture.ts.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { calls } from "@cursor/sdk";
import { CONFIG_SCHEMA_PATH, validateConfigData } from "../src/config/file.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import implementIssue from "../workflows/implement-issue.js";
import { ALL_CODE, ALL_TEST, CLEAN_REVIEW, PLAN, SUB_CODE, fx, gh, issue, names, run, setup, submit, teardown, write } from "./implement-issue.fixture.js";
import { globalConfigPath, runStartOf, withEnv, writeGlobalConfig, writeRepoConfig } from "./config-fixtures.js";

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

// ── The workflow's settings ──────────────────────────────────────────────────────────────

const res = (r: { result?: unknown }) => r.result as any;
/** The repo file tunes `implement-issue`'s settings. */
const settings = (value: Record<string, unknown>) => writeRepoConfig(fx.repo, { workflows: { "implement-issue": { settings: value } } });
const slice = (n: number) => ({ behavior: `comportamento ${n}`, seam: "math.subtract", testIdea: `ideia ${n}` });
const WRONG_CODE = SUB_CODE.replace("a - b", "a + b");

test("implement-issue declares its ten settings with the code defaults; each is in the config schema, and the defaults pass it", () => {
  assert.deepEqual(implementIssue.meta.settings, {
    sliceCaps: { LOW: 1, MED: 3, HIGH: 5 },
    extraSlices: 2,
    fixRounds: 2,
    redGreenAttempts: 2,
    maxDiffChars: 40_000,
    labelTiers: { "complexity:low": "LOW", "good first issue": "LOW", "complexity:medium": "MED", "complexity:high": "HIGH", security: "HIGH" },
    maxStepCrashes: 2,
    gcFailedAfterDays: 14,
    testTimeoutSec: 600,
    networkTimeoutSec: 120,
  });
  assert.deepEqual(validateConfigData({ workflows: { "implement-issue": { settings: implementIssue.meta.settings } } }), []);
  const schema = JSON.parse(readFileSync(CONFIG_SCHEMA_PATH, "utf8")) as { definitions: { workflowSettings: { properties: Record<string, unknown> } } };
  for (const name of Object.keys(implementIssue.meta.settings!)) assert.ok(schema.definitions.workflowSettings.properties[name], `${name} is documented in the schema (and so in the config reference)`);
});

test("the run-start records the settings the run took and where each came from", async () => {
  issue(["complexity:medium"]);
  settings({ fixRounds: 1 });
  const r = await run({});
  assert.equal(r.status, "finished", r.error);
  const start = runStartOf(readEventLog(eventLogPath(fx.repo, r.runId)).events);
  assert.equal(start.config.settings.fixRounds, 1);
  assert.deepEqual((start.config.settings.sliceCaps as any).MED, 3);
  assert.equal(start.provenance["/settings/fixRounds"]?.layer, "repo");
  assert.equal(start.provenance["/settings/sliceCaps"]?.layer, "default");
});

test("a setting that is out of range, misspelled or of the wrong shape fails the run before any step, naming the field", async () => {
  issue(["complexity:low"]);
  const fails = async (value: Record<string, unknown>, path: RegExp) => {
    settings(value);
    const r = await run({});
    assert.equal(r.status, "failed", JSON.stringify(value));
    assert.match(r.error!, path);
  };
  await fails({ fixRounds: -1 }, /\/workflows\/implement-issue\/settings\/fixRounds/);
  await fails({ redGreenAttempts: 0 }, /\/workflows\/implement-issue\/settings\/redGreenAttempts/);
  await fails({ sliceCaps: { LOW: 1, MED: 2 } }, /\/workflows\/implement-issue\/settings\/sliceCaps/);
  await fails({ labelTiers: { urgent: "EXTREME" } }, /\/workflows\/implement-issue\/settings\/labelTiers\/urgent/);
  await fails({ fixRound: 1 }, /\/workflows\/implement-issue\/settings\/fixRound: unknown setting \(workflow implement-issue declares: sliceCaps, extraSlices, fixRounds/);
  assert.equal(calls.length, 0);
});

test("labelTiers is the label-to-tier map: the file's labels count (any case), the default ones no longer do", async () => {
  issue(["Priority-One"]);
  settings({ labelTiers: { "priority-one": "MED" } });
  const labelled = await run({});
  assert.equal(res(labelled).tier, "MED");
  assert.deepEqual(names(), ["planejar"], "the label decided: no classifier");

  calls.length = 0;
  issue(["complexity:high"]);
  fx.handlers.classificar = (o) => submit(o, { tier: "MED", reason: "typical" });
  const unmapped = await run({});
  assert.equal(res(unmapped).tier, "MED");
  assert.ok(names().includes("classificar"), "complexity:high is not in this map: the classifier ran");
});

test("sliceCaps sets how many slices each tier builds: the planner is told, the comment defers the rest, and only that many run", async () => {
  issue(["complexity:medium"]);
  settings({ sliceCaps: { LOW: 1, MED: 1, HIGH: 5 } });
  let planPrompt = "";
  fx.handlers.planejar = (o, msg) => {
    planPrompt = msg;
    submit(o, { ...PLAN, slices: [PLAN.slices[0], slice(2)] });
  };
  const first = await run({});
  assert.equal(res(first).status, "seams-proposed");
  assert.match(planPrompt, /up to 1 slices/);
  assert.match(gh().comments[0]!, /2\. comportamento 2 .*\(deferred/);
  assert.match(gh().comments[0]!, /tier MED slice cap \(1 slices\)/);

  const second = await run({ approveSeams: true }, first.runId);
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));
  assert.equal(res(second).deferred.length, 1);
  assert.ok(!names().some((n) => n.endsWith("-2")), `slice 2 was not built: ${names()}`);
});

test("extraSlices caps the slices a review can open", async () => {
  issue(["complexity:low"]);
  settings({ extraSlices: 1 });
  let specRound = 0;
  const missing = (behavior: string) => ({ quote: "devolve a - b", note: `falta ${behavior}`, kind: "missing", behavior, seam: "math.subtract" });
  fx.handlers["review:spec"] = (o) => submit(o, ++specRound === 1 ? { findings: [missing("subtractAll"), missing("subtractMany")], worst: "falta" } : CLEAN_REVIEW);
  fx.handlers["teste-extra-1"] = (o) => {
    write(o, "test/all.test.js", ALL_TEST);
    submit(o, { testFile: "test/all.test.js", testName: "subtractAll" });
  };
  fx.handlers["codigo-extra-1"] = (o) => {
    write(o, "src/math.js", ALL_CODE);
    submit(o, { summary: "subtractAll", filesChanged: ["src/math.js"] });
  };
  const r = await run({});
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
  assert.ok(names().includes("teste-extra-1"));
  assert.ok(!names().includes("teste-extra-2"), "the second finding waits: one extra slice only");
});

test("fixRounds is how many times a slice whose suite fails after green is fixed before the run stops", async () => {
  issue(["complexity:low"]);
  settings({ fixRounds: 1 });
  fx.handlers["codigo-1"] = (o) => {
    write(o, "src/math.js", WRONG_CODE);
    submit(o, { summary: "wrong", filesChanged: ["src/math.js"] });
  };
  fx.handlers["corrigir-1-1"] = fx.handlers["codigo-1"]!;
  const r = await run({});
  assert.equal(res(r).status, "tests-failed", JSON.stringify(res(r)));
  assert.deepEqual(names().filter((n) => n.startsWith("corrigir")), ["corrigir-1-1"], "one round, no second");
});

test("redGreenAttempts is how many tries the green step gets before a TDD violation stops the run", async () => {
  issue(["complexity:low"]);
  settings({ redGreenAttempts: 3 });
  fx.handlers["codigo-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE);
    write(o, "test/sub.test.js", "// teste apagado para passar\n");
    submit(o, { summary: "x", filesChanged: [] });
  };
  const r = await run({});
  assert.equal(res(r).status, "tdd-violation");
  assert.equal(names().filter((n) => n.startsWith("codigo-1")).length, 3);
});

test("redGreenAttempts also bounds the red step: one attempt, and a test that already passes is test-not-red at once", async () => {
  issue(["complexity:low"]);
  settings({ redGreenAttempts: 1 });
  fx.handlers["teste-1"] = (o) => {
    write(o, "test/add2.test.js", 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/math.js";\n\ntest("add de novo", () => {\n  assert.equal(add(1, 1), 2);\n});\n');
    submit(o, { testFile: "test/add2.test.js", testName: "add de novo" });
  };
  const r = await run({});
  assert.equal(res(r).status, "test-not-red");
  assert.equal(names().filter((n) => n.startsWith("teste-1")).length, 1);
});

test("maxDiffChars cuts the diff the reviewers and the PR text get", async () => {
  issue(["complexity:low"]);
  settings({ maxDiffChars: 60 });
  let prompt = "";
  fx.handlers["review:spec"] = (o, msg) => {
    prompt = msg;
    submit(o, CLEAN_REVIEW);
  };
  const r = await run({});
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
  assert.match(prompt, /\(diff truncated: read the files for the rest\)/);
  const shown = prompt.slice(prompt.lastIndexOf("```diff\n") + 8, prompt.lastIndexOf("\n```"));
  assert.equal(shown.length, 60);
});
