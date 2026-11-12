// Seam 1, the run: `runWorkflow` with the fake Cursor SDK against a temp repo and a throwaway home. The two config
// files are written to disk; the assertions are on the run outcome, the agent calls the SDK received and the replayed
// event log (the `run-start` event carries the effective config, its provenance and the violations).
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { calls, costConfig, script, stats } from "@cursor/sdk";
import { runWorkflow } from "../src/runtime/engine.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { clearConfig, configWorkflow, globalConfigPath, repoConfigPath, runStartOf, withEnv, writeGlobalConfig, writeRepoConfig } from "./config-fixtures.js";

const cwd = join(import.meta.dirname, ".tmp", `config-${process.pid}`);
afterEach(() => {
  clearConfig(cwd);
  rmSync(cwd, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined });
});

const clearRepo = () => rmSync(join(cwd, ".agents"), { recursive: true, force: true });
const logOf = (runId: string) => readEventLog(eventLogPath(cwd, runId)).events;

test("a config file that does not validate fails the run before any step, naming the file and the field path", async () => {
  writeGlobalConfig({ workflows: { cfg: { roles: { classify: { retries: "two" } } } } });
  const r = await runWorkflow(configWorkflow(), {}, { cwd });
  assert.equal(r.status, "failed");
  assert.ok(r.error!.includes(globalConfigPath()), r.error);
  assert.match(r.error!, /\/workflows\/cfg\/roles\/classify\/retries/);
  assert.equal(calls.length, 0, "no agent was created");
});

test("the repo file is validated too: an unknown key and a bad value name their paths; unparseable JSON names the file", async () => {
  writeRepoConfig(cwd, { workflows: { cfg: { maxTokns: 1, roles: { review: { timeoutMs: 0 } } } } });
  const bad = await runWorkflow(configWorkflow(), {}, { cwd });
  assert.equal(bad.status, "failed");
  assert.ok(bad.error!.includes(repoConfigPath(cwd)), bad.error);
  assert.match(bad.error!, /\/workflows\/cfg\/maxTokns/, "an unknown key is named");
  assert.match(bad.error!, /\/workflows\/cfg\/roles\/review\/timeoutMs/, "a bad value is named");

  writeRepoConfig(cwd, "{ not json");
  const torn = await runWorkflow(configWorkflow(), {}, { cwd });
  assert.equal(torn.status, "failed");
  assert.ok(torn.error!.includes(repoConfigPath(cwd)), torn.error);
});

test("without config files the run starts with the code defaults, recorded in run-start with their provenance", async () => {
  const r = await runWorkflow(configWorkflow(), {}, { cwd });
  assert.equal(r.status, "finished", r.error);
  const start = runStartOf(logOf(r.runId));
  assert.equal(start.config.workflow, "cfg");
  assert.deepEqual(start.config.limits, { maxTokens: 3_000_000, maxTokensPerStep: null, maxCents: null, concurrency: 4 });
  assert.deepEqual(start.config.roles.classify, { model: { id: "composer-2.5" }, timeoutMs: 1_800_000, retries: 1, schemaRetries: 2 });
  assert.deepEqual(start.provenance["/limits/maxTokens"], { layer: "default" });
  assert.deepEqual(start.provenance["/roles/classify/model/id"], { layer: "default" });
  assert.deepEqual(start.violations, []);
  assert.equal(calls[0].model.id, "composer-2.5", "the role's default model reached the SDK");
});

/** Runs the workflow without agent steps and returns what run-start recorded. */
async function startOf(options: Parameters<typeof runWorkflow>[2] extends infer O ? Partial<O> : never = {}) {
  const r = await runWorkflow(configWorkflow(async () => "done"), {}, { cwd, ...options });
  assert.equal(r.status, "finished", r.error);
  return runStartOf(logOf(r.runId));
}

test("precedence: code defaults < global < repo < env < flag, each value recorded with the layer that decided it", async () => {
  const maxTokens = async (options = {}) => {
    const start = await startOf(options);
    return [start.config.limits.maxTokens, start.provenance["/limits/maxTokens"]] as const;
  };
  assert.deepEqual(await maxTokens(), [3_000_000, { layer: "default" }]);

  writeGlobalConfig({ workflows: { cfg: { maxTokens: 2_500_000 } } });
  assert.deepEqual(await maxTokens(), [2_500_000, { layer: "global", ref: globalConfigPath() }]);

  writeRepoConfig(cwd, { workflows: { cfg: { maxTokens: 2_000_000 } } });
  assert.deepEqual(await maxTokens(), [2_000_000, { layer: "repo", ref: repoConfigPath(cwd) }]);

  await withEnv({ WF_MAX_TOKENS: "1500000" }, async () => assert.deepEqual(await maxTokens(), [1_500_000, { layer: "env", ref: "WF_MAX_TOKENS" }]));

  await withEnv({ WF_MAX_TOKENS: "1500000" }, async () =>
    assert.deepEqual(await maxTokens({ maxTokens: 1_000_000 }), [1_000_000, { layer: "flag", ref: "--max-tokens" }]),
  );
});

test("role settings layer field by field; a model's id and params inherit separately", async () => {
  writeGlobalConfig({ workflows: { cfg: { roles: { review: { timeoutMs: 600_000, retries: 3, model: { params: [{ id: "reasoning_effort", value: "medium" }] } } } } } });
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { review: { retries: 0, model: { id: "grok-5" } } } } } });
  const start = await startOf();
  assert.deepEqual(start.config.roles.review, {
    model: { id: "grok-5", params: [{ id: "reasoning_effort", value: "medium" }] },
    timeoutMs: 600_000,
    retries: 0,
    schemaRetries: 2,
    settingSources: [],
  });
  assert.deepEqual(start.provenance["/roles/review/model/id"], { layer: "repo", ref: repoConfigPath(cwd) });
  assert.deepEqual(start.provenance["/roles/review/model/params"], { layer: "global", ref: globalConfigPath() });
  assert.deepEqual(start.provenance["/roles/review/timeoutMs"], { layer: "global", ref: globalConfigPath() });
  assert.deepEqual(start.provenance["/roles/review/retries"], { layer: "repo", ref: repoConfigPath(cwd) });
  assert.deepEqual(start.provenance["/roles/review/schemaRetries"], { layer: "default" });
});

test("a step takes its role's model and setting sources from the config, and the config beats the call's own options", async () => {
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { model: { id: "composer-3" }, settingSources: ["project"] } } } } });
  const wf = configWorkflow((ctx) => ctx.agent("p", { role: "classify", label: "c", model: { id: "from-the-call" }, settingSources: ["team"] }));
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.status, "finished", r.error);
  assert.deepEqual(calls[0].model, { id: "composer-3" });
  assert.deepEqual(calls[0].local.settingSources, ["project"]);
  const start = logOf(r.runId).find((e) => e.type === "step-start");
  assert.ok(start && start.type === "step-start");
  assert.equal(start.role, "classify");
  assert.equal(start.model, "composer-3");
});

test("a role's defaults sit under the call's options: the call wins over the role default, the config wins over both", async () => {
  const wf = configWorkflow((ctx) => ctx.agent("p", { role: "classify", label: "c", model: { id: "from-the-call" } }));
  await runWorkflow(wf, {}, { cwd });
  assert.equal(calls[0].model.id, "from-the-call");
  calls.length = 0;
  await withEnv({ WF_MODEL_CLASSIFY: "from-env" }, () => runWorkflow(wf, {}, { cwd }));
  assert.equal(calls[0].model.id, "from-env");
});

// The 10 s bound turns a regression (the role timeout ignored: the default is 30 minutes) into a failure, not a hang.
test("retries, schema retries and timeout per role change how the step runs", { timeout: 10_000 }, async () => {
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { retries: 2, timeoutMs: 40 } } } } });
  script.push(() => ({ hang: true }), () => ({ hang: true }), () => ({ hang: true }));
  const r = await runWorkflow(configWorkflow(), {}, { cwd });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /failed after 3 attempt\(s\): timeout after 40 ms/);
  assert.equal(calls.length, 3);

  calls.length = 0;
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { retries: 0, schemaRetries: 0 } } } } });
  const schema = { type: "object", properties: { x: { type: "number" } } };
  const wf = configWorkflow((ctx) => ctx.agent("p", { role: "classify", label: "c", schema }));
  const bad = await runWorkflow(wf, {}, { cwd });
  assert.equal(bad.status, "failed");
  assert.match(bad.error!, /failed after 1 attempt/);
  assert.equal(stats.disposed, 4, "no schema re-prompt and no second attempt");
});

test("WF_MODEL_* env vars set a role's model: the role name, an alias, params in brackets, and a bare id keeps the params", async () => {
  const roleModels = async (env: Record<string, string>) => {
    const start = await withEnv(env, () => startOf());
    return { start, models: start.config.roles };
  };
  let { start, models } = await roleModels({ WF_MODEL_REVIEW: "grok-5" });
  assert.deepEqual(models.review!.model, { id: "grok-5", params: [{ id: "reasoning_effort", value: "high" }] }, "bare id: params stay");
  assert.deepEqual(start.provenance["/roles/review/model/id"], { layer: "env", ref: "WF_MODEL_REVIEW" });
  assert.deepEqual(start.provenance["/roles/review/model/params"], { layer: "default" });

  ({ models } = await roleModels({ WF_MODEL_REVIEW: "grok-5[reasoning_effort=low,max]" }));
  assert.deepEqual(models.review!.model, { id: "grok-5", params: [{ id: "reasoning_effort", value: "low" }], maxMode: true });

  ({ models } = await roleModels({ WF_MODEL_REVIEW: "grok-5[]" }));
  assert.deepEqual(models.review!.model, { id: "grok-5", params: [] }, "empty brackets clear the params");

  ({ models, start } = await roleModels({ WF_MODEL_LOW: "composer-9", WF_MODEL_IMPLEMENT_LOW: "ignored-after-the-name" }));
  assert.equal(models["implement.low"]!.model!.id, "ignored-after-the-name", "the role name wins over its alias");
  ({ models, start } = await roleModels({ WF_MODEL_LOW: "composer-9" }));
  assert.equal(models["implement.low"]!.model!.id, "composer-9", "the legacy alias still works");
  assert.deepEqual(start.provenance["/roles/implement.low/model/id"], { layer: "env", ref: "WF_MODEL_LOW" });

  const wf = configWorkflow((ctx) => ctx.agent("p", { role: "review", label: "r" }));
  await withEnv({ WF_MODEL_REVIEW: "grok-5" }, () => runWorkflow(wf, {}, { cwd }));
  assert.deepEqual(calls.at(-1).model, { id: "grok-5", params: [{ id: "reasoning_effort", value: "high" }] }, "the SDK gets the id and the kept params");

  const bad = await withEnv({ WF_MODEL_REVIEW: "grok[5" }, () => runWorkflow(configWorkflow(), {}, { cwd }));
  assert.equal(bad.status, "failed");
  assert.match(bad.error!, /WF_MODEL_REVIEW/);
  const badNumber = await withEnv({ WF_MAX_TOKENS: "lots" }, () => runWorkflow(configWorkflow(), {}, { cwd }));
  assert.match(badNumber.error!, /WF_MAX_TOKENS/);
});

test("an unknown role in a config file is an error naming the path; so is an unknown role in a step", async () => {
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { clasify: { retries: 1 } } } } });
  const r = await runWorkflow(configWorkflow(), {}, { cwd });
  assert.equal(r.status, "failed");
  assert.ok(r.error!.includes(repoConfigPath(cwd)));
  assert.match(r.error!, /\/workflows\/cfg\/roles\/clasify: unknown role \(workflow cfg declares: classify, review, implement\.low\)/);
  assert.equal(calls.length, 0);

  clearConfig(cwd);
  const wf = configWorkflow((ctx) => ctx.agent("p", { role: "nope", label: "n" }));
  const step = await runWorkflow(wf, {}, { cwd });
  assert.equal(step.status, "failed");
  assert.match(step.error!, /unknown role "nope"/);
  assert.equal(calls.length, 0, "the step fails before an agent exists, and is not retried");
});

test("label globs are the fallback for steps without a role; the glob with the most literal characters wins; a role beats labels", async () => {
  writeRepoConfig(cwd, {
    workflows: { cfg: { labels: { "desenhar:*": { model: { id: "label-wide" } }, "desenhar:a*": { model: { id: "label-narrow" }, retries: 0 }, "*": { settingSources: [] } }, roles: { classify: { model: { id: "from-role" } } } } },
  });
  const wf = configWorkflow(async (ctx) => {
    await ctx.agent("1", { label: "desenhar:alpha" });
    await ctx.agent("2", { label: "desenhar:beta" });
    await ctx.agent("3", { label: "other" });
    await ctx.agent("4", { label: "desenhar:alpha-again", role: "classify" });
  });
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.status, "finished", r.error);
  assert.deepEqual(
    calls.map((c) => c.model.id),
    ["label-narrow", "label-wide", "fallback-model", "from-role"],
  );
  assert.deepEqual(calls[2].local.settingSources, [], "the catch-all glob applies to the step no other glob matches");
  assert.deepEqual(calls[3].local.settingSources, ["project", "team", "mdm"], "a step with a role ignores the label globs");
  const start = runStartOf(logOf(r.runId));
  assert.deepEqual(Object.keys(start.config.labels).sort(), ["*", "desenhar:*", "desenhar:a*"]);
  assert.deepEqual(start.provenance["/labels/desenhar:a*/retries"], { layer: "repo", ref: repoConfigPath(cwd) });
});

test("the global caps clamp the result: numbers take the minimum, and a repo preference above a cap is a violation with no effect", async () => {
  writeGlobalConfig({ caps: { maxTokens: 1_000_000, maxTokensPerStep: 200_000, maxCents: 100 } });
  writeRepoConfig(cwd, { workflows: { cfg: { maxTokens: 5_000_000, maxCents: 50, roles: { review: { maxTokensPerStep: 900_000 } } } } });
  const r = await runWorkflow(configWorkflow(async () => "done"), {}, { cwd });
  assert.equal(r.status, "finished", r.error);
  const events = logOf(r.runId);
  const start = runStartOf(events);

  assert.equal(start.config.limits.maxTokens, 1_000_000, "above the cap: the cap");
  assert.deepEqual(start.provenance["/limits/maxTokens"], { layer: "cap", ref: globalConfigPath() });
  assert.equal(start.config.limits.maxCents, 50, "below the cap: the preference");
  assert.deepEqual(start.provenance["/limits/maxCents"], { layer: "repo", ref: repoConfigPath(cwd) });
  assert.equal(start.config.limits.maxTokensPerStep, 200_000, "the code default (no cap) is clamped silently");
  assert.equal(start.config.roles.review!.maxTokensPerStep, 200_000);
  assert.deepEqual(start.config.caps, {
    maxTokens: 1_000_000,
    maxTokensPerStep: 200_000,
    maxCents: 100,
    allowedModels: null,
    allowedSettingSources: null,
    allowedLocations: null,
    maxConcurrency: null,
    requireSandbox: null,
  });

  assert.deepEqual(
    start.violations.map(({ layer, ref, path, requested, applied }) => ({ layer, ref, path, requested, applied })),
    [
      { layer: "repo", ref: repoConfigPath(cwd), path: "/workflows/cfg/maxTokens", requested: 5_000_000, applied: 1_000_000 },
      { layer: "repo", ref: repoConfigPath(cwd), path: "/workflows/cfg/roles/review/maxTokensPerStep", requested: 900_000, applied: 200_000 },
    ],
  );
  const warnings = events.filter((e) => e.type === "warning").map((e) => (e as { message: string }).message);
  assert.ok(warnings.some((w) => w.startsWith("config:") && w.includes("/workflows/cfg/maxTokens")), `violations also show up as warnings: ${warnings}`);
});

test("a cap enforces on a run: the budget that stops the run is the clamped one", async () => {
  writeGlobalConfig({ caps: { maxTokens: 200 } });
  writeRepoConfig(cwd, { workflows: { cfg: { maxTokens: 1_000_000 } } });
  const wf = configWorkflow(async (ctx) => {
    await ctx.agent("1", { label: "one" }); // 110 tokens per step in the fake SDK
    await ctx.agent("2", { label: "two" });
    await ctx.agent("3", { label: "three" });
  });
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /Token cap reached: 220 of 200/);
  assert.equal(calls.length, 2);
});

test("a repo file cannot set caps: they are reported as a violation and ignored", async () => {
  writeGlobalConfig({ caps: { maxTokens: 1_000_000 } });
  writeRepoConfig(cwd, { caps: { maxTokens: 10_000_000, allowedSettingSources: ["all"] } });
  const start = await startOf();
  assert.equal(start.config.caps.maxTokens, 1_000_000);
  assert.equal(start.config.caps.allowedSettingSources, null);
  assert.equal(start.violations.length, 1);
  assert.equal(start.violations[0]!.layer, "repo");
  assert.equal(start.violations[0]!.path, "/caps");
});

test("the dashboard switch is valid in the global file; in a repo file it is a violation with no effect", async () => {
  writeGlobalConfig({ dashboard: { autoStart: false } });
  assert.deepEqual((await startOf()).violations, []);

  clearConfig(cwd);
  writeRepoConfig(cwd, { dashboard: { autoStart: false } });
  const start = await startOf();
  assert.equal(start.violations.length, 1);
  assert.equal(start.violations[0]!.layer, "repo");
  assert.equal(start.violations[0]!.path, "/dashboard");
  assert.match(start.violations[0]!.message, /dashboard.*global file/);

  writeGlobalConfig({ dashboard: { autoStart: "no" } });
  const bad = await runWorkflow(configWorkflow(), {}, { cwd });
  assert.equal(bad.status, "failed");
  assert.match(bad.error!, /\/dashboard\/autoStart/, "a value that is not a boolean names its path");
});

test("explicit null disables a cap or a preference; an absent key inherits", async () => {
  writeGlobalConfig({ caps: { maxTokens: null } });
  writeRepoConfig(cwd, { workflows: { cfg: { maxTokens: 9_000_000, maxCents: null, maxTokensPerStep: 100_000, roles: { classify: { maxTokensPerStep: null } } } } });
  let start = await startOf();
  assert.equal(start.config.limits.maxTokens, 9_000_000, "a null cap is no cap: nothing clamps, nothing is a violation");
  assert.equal(start.config.limits.maxCents, null, "null in a preference: no limit");
  assert.deepEqual(start.provenance["/limits/maxCents"], { layer: "repo", ref: repoConfigPath(cwd) });
  assert.equal(start.config.limits.maxTokensPerStep, 100_000);
  assert.equal(start.config.roles.classify!.maxTokensPerStep, null, "a role's explicit null turns off the workflow's per-step cap for that role");
  assert.equal("maxTokensPerStep" in start.config.roles.review!, false, "a role that says nothing inherits the workflow's");
  assert.deepEqual(start.violations, []);

  writeGlobalConfig({ caps: { maxTokens: 1_000_000, maxCents: 100 } });
  start = await startOf();
  assert.equal(start.config.limits.maxCents, 100, "a null preference does not remove a finite cap: the cap applies");
  assert.deepEqual(start.violations.map((v) => v.path), ["/workflows/cfg/maxTokens", "/workflows/cfg/maxCents"], "asking for no limit under a cap is a violation");
  assert.equal(start.config.limits.maxTokens, 1_000_000);
});

test("a global concurrency cap bounds parallel agents whatever the preference asks", async () => {
  writeGlobalConfig({ caps: { maxConcurrency: 1 } });
  writeRepoConfig(cwd, { workflows: { cfg: { concurrency: 6 } } });
  const wf = configWorkflow((ctx) => ctx.parallel(Array.from({ length: 6 }, (_, i) => () => ctx.agent(`p${i}`, { label: `p${i}` }))));
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.status, "finished", r.error);
  assert.equal(stats.maxActive, 1);
  assert.equal(runStartOf(logOf(r.runId)).config.limits.concurrency, 1);
  assert.equal(runStartOf(logOf(r.runId)).violations[0]!.path, "/workflows/cfg/concurrency");
});

test("allowedSettingSources: lists intersect, a role asking for 'all' is reduced and reported, the run default is clamped too", async () => {
  writeGlobalConfig({ caps: { allowedSettingSources: ["project", "user", "team", "mdm", "plugins"] } });
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { settingSources: ["project", "all"] } } } } });
  const wf = configWorkflow(async (ctx) => {
    await ctx.agent("1", { label: "c", role: "classify" });
    await ctx.agent("2", { label: "no-role" });
  });
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.status, "finished", r.error);
  assert.deepEqual(calls[0].local.settingSources, ["project"]);
  assert.deepEqual(calls[1].local.settingSources, ["project", "team", "mdm"], "inside the cap: untouched");
  const start = runStartOf(logOf(r.runId));
  assert.deepEqual(start.config.roles.classify!.settingSources, ["project"]);
  assert.equal(start.violations.length, 1);
  assert.equal(start.violations[0]!.path, "/workflows/cfg/roles/classify/settingSources");
  assert.deepEqual(start.violations[0]!.applied, ["project"]);

  // The caps clamp code too: a narrow cap narrows a step that asks for more in its own options.
  calls.length = 0;
  writeGlobalConfig({ caps: { allowedSettingSources: ["project"] } });
  clearRepo();
  await runWorkflow(wf, {}, { cwd });
  assert.deepEqual(calls.map((c) => c.local.settingSources), [["project"], ["project"]]);
});

test("allowedModels: a model the config asks for outside the list is a violation with no effect; a step whose model is outside the list fails", async () => {
  writeGlobalConfig({ caps: { allowedModels: ["composer-*", "grok-4.7"] } });
  writeRepoConfig(cwd, { workflows: { cfg: { roles: { classify: { model: { id: "gpt-9", params: [{ id: "x", value: "y" }] } } } } } });
  const wf = configWorkflow(async (ctx) => {
    await ctx.agent("1", { label: "c", role: "classify" });
    await ctx.agent("2", { label: "r", role: "review" });
  });
  const ok = await runWorkflow(wf, {}, { cwd });
  assert.equal(ok.status, "finished", ok.error);
  assert.deepEqual(calls[0].model, { id: "composer-2.5" }, "the refused model and its params have no effect: the default stands");
  const start = runStartOf(logOf(ok.runId));
  assert.equal(start.violations.length, 1);
  assert.equal(start.violations[0]!.path, "/workflows/cfg/roles/classify/model/id");
  assert.deepEqual(start.config.roles.classify!.model, { id: "composer-2.5" });

  calls.length = 0;
  writeGlobalConfig({ caps: { allowedModels: ["composer-*"] } });
  clearRepo();
  const refused = await runWorkflow(wf, {}, { cwd });
  assert.equal(refused.status, "failed");
  assert.match(refused.error!, /step "r": model grok-4\.7 is not in the global allowedModels cap \(composer-\*\)/);
  assert.equal(calls.length, 1, "the step with the allowed model ran, the other never created an agent");
});

test("allowedLocations without 'local' keeps every step from running", async () => {
  writeGlobalConfig({ caps: { allowedLocations: ["cloud"] } });
  const r = await runWorkflow(configWorkflow(), {}, { cwd });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /allowedLocations/);
  assert.equal(calls.length, 0);
});

test("requireSandbox in the global caps sandboxes every step, even one whose code turns the sandbox off", async () => {
  const wf = configWorkflow(async (ctx) => {
    await ctx.agent("p", { role: "classify", label: "off", sandbox: false });
    return ctx.agent("p", { role: "classify", label: "unset" });
  });
  writeGlobalConfig({ caps: { requireSandbox: true } });
  const locked = await runWorkflow(wf, {}, { cwd });
  assert.equal(locked.status, "finished", locked.error);
  assert.deepEqual(calls.map((c) => c.local?.sandboxOptions), [{ enabled: true }, { enabled: true }]);

  calls.length = 0;
  writeGlobalConfig({ caps: {} });
  writeRepoConfig(cwd, { caps: { requireSandbox: false } });
  const free = await runWorkflow(wf, {}, { cwd });
  assert.equal(free.status, "finished", free.error);
  assert.deepEqual(calls.map((c) => c.local?.sandboxOptions), [undefined, undefined], "without the cap the code decides; a repo file cannot set caps");
});

test("tighten-only overrides (the chat): a lower limit applies, a looser one is a violation with no effect", async () => {
  writeGlobalConfig({ caps: { maxCents: 400 } });
  writeRepoConfig(cwd, { workflows: { cfg: { maxTokens: 1_000_000, maxCents: 300 } } });
  const start = await startOf({ mcpOverrides: { maxTokens: 400_000, maxCents: 350, maxTokensPerStep: 50_000, concurrency: 8 } });
  assert.equal(start.config.limits.maxTokens, 400_000);
  assert.deepEqual(start.provenance["/limits/maxTokens"], { layer: "mcp", ref: "start_workflow.overrides" });
  assert.equal(start.config.limits.maxCents, 300, "350 would loosen the repo's 300");
  assert.equal(start.config.limits.maxTokensPerStep, 50_000, "from no limit to a limit is tightening");
  assert.equal(start.config.limits.concurrency, 4, "8 would loosen the default 4");
  assert.deepEqual(
    start.violations.map(({ layer, path, requested, applied }) => ({ layer, path, requested, applied })),
    [
      { layer: "mcp", path: "maxCents", requested: 350, applied: 300 },
      { layer: "mcp", path: "concurrency", requested: 8, applied: 4 },
    ],
  );

  const disable = await startOf({ mcpOverrides: { maxTokens: null } });
  assert.equal(disable.config.limits.maxTokens, 1_000_000, "null from the chat is the loosest override");
  assert.equal(disable.violations[0]!.layer, "mcp");
});

test("a flag may loosen the repo (it is the user's own command) but never the global cap", async () => {
  writeGlobalConfig({ caps: { maxTokens: 800_000 } });
  writeRepoConfig(cwd, { workflows: { cfg: { maxTokens: 500_000 } } });
  const start = await startOf({ maxTokens: 700_000 });
  assert.equal(start.config.limits.maxTokens, 700_000);
  assert.deepEqual(start.violations, []);
  const over = await startOf({ maxTokens: 900_000 });
  assert.equal(over.config.limits.maxTokens, 800_000);
  assert.equal(over.violations[0]!.layer, "flag");
  assert.equal(over.violations[0]!.ref, "--max-tokens");
});

test("the config is read again on every run start, a resume included", async () => {
  const first = await startOf();
  assert.equal(first.config.limits.maxCents, null);
  writeRepoConfig(cwd, { workflows: { cfg: { maxCents: 77 } } });
  const second = await startOf();
  assert.equal(second.config.limits.maxCents, 77);

  const r = await runWorkflow(configWorkflow(async () => "done"), {}, { cwd });
  writeRepoConfig(cwd, { workflows: { cfg: { maxCents: 33 } } });
  await runWorkflow(configWorkflow(async () => "done"), {}, { cwd, runId: r.runId });
  const starts = logOf(r.runId).filter((e) => e.type === "run-start");
  assert.deepEqual(starts.map((e) => (e as typeof first).config.limits.maxCents), [77, 33], "each execution of one run records the config it read");
});

test("a label glob may contain slashes (file paths in labels): it matches, and its provenance pointer is escaped once", async () => {
  writeRepoConfig(cwd, { workflows: { cfg: { labels: { "process:src/*": { retries: 0, model: { id: "path-model" } } } } } });
  const wf = configWorkflow(async (ctx) => {
    await ctx.agent("1", { label: "process:src/a.ts" });
    await ctx.agent("2", { label: "process:docs/a.md" });
  });
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.status, "finished", r.error);
  assert.deepEqual(
    calls.map((c) => c.model.id),
    ["path-model", "fallback-model"],
  );
  const start = runStartOf(logOf(r.runId));
  assert.deepEqual(Object.keys(start.config.labels), ["process:src/*"]);
  assert.deepEqual(start.provenance["/labels/process:src~1*/retries"], { layer: "repo", ref: repoConfigPath(cwd) });
});

test("a chat override of the per-step cap is a ceiling for every step, role and label caps included", async () => {
  writeRepoConfig(cwd, {
    workflows: { cfg: { maxTokensPerStep: 300_000, roles: { review: { maxTokensPerStep: 500_000 }, classify: { maxTokensPerStep: null }, "implement.low": { maxTokensPerStep: 50_000 } }, labels: { "x*": { maxTokensPerStep: 400_000 } } } },
  });
  const start = await startOf({ mcpOverrides: { maxTokensPerStep: 100_000 } });
  assert.equal(start.config.limits.maxTokensPerStep, 100_000);
  assert.equal(start.config.roles.review!.maxTokensPerStep, 100_000, "a role cap above the ceiling is brought down");
  assert.equal(start.config.roles.classify!.maxTokensPerStep, 100_000, "so is a role that turned the cap off");
  assert.equal(start.config.roles["implement.low"]!.maxTokensPerStep, 50_000, "a role cap already below the ceiling stands");
  assert.equal(start.config.labels["x*"]!.maxTokensPerStep, 100_000);
  assert.deepEqual(start.provenance["/roles/review/maxTokensPerStep"], { layer: "mcp", ref: "start_workflow.overrides" });
  assert.deepEqual(start.provenance["/roles/implement.low/maxTokensPerStep"], { layer: "repo", ref: repoConfigPath(cwd) });
});

test("a limit that is not a valid number is an error naming where it came from: flags, chat overrides and env alike", async () => {
  const refused = async (options: Parameters<typeof runWorkflow>[2] extends infer O ? Partial<O> : never, env: Record<string, string> = {}) => {
    const r = await withEnv(env, () => runWorkflow(configWorkflow(async () => "done"), {}, { cwd, ...options }));
    assert.equal(r.status, "failed");
    return r.error!;
  };
  assert.match(await refused({ maxTokens: 1.5 }), /--max-tokens.*integer/);
  assert.match(await refused({ maxCents: -1 }), /--max-cents/);
  assert.match(await refused({ concurrency: 0 }), /RunOptions\.concurrency.*greater than or equal to 1/);
  assert.match(await refused({ mcpOverrides: { concurrency: 0 } }), /start_workflow\.overrides.*concurrency/);
  assert.match(await refused({ mcpOverrides: { maxTokens: 2.5 } }), /start_workflow\.overrides.*maxTokens/);
  assert.match(await refused({}, { WF_MAX_TOKENS: "1.5" }), /WF_MAX_TOKENS/);
  assert.equal(calls.length, 0);
});

test("a code-default model that a cap refuses shows up as a violation of the default, before any step runs", async () => {
  writeGlobalConfig({ caps: { allowedModels: ["composer-*"] } });
  const start = await startOf();
  assert.deepEqual(
    start.violations.map(({ layer, path, requested }) => ({ layer, path, requested })),
    [{ layer: "default", path: "/roles/review/model/id", requested: "grok-4.7" }],
  );
  assert.match(start.violations[0]!.message, /review/);
});

// ── Workflow settings: the workflow declares them, the config files tune them ───────────

/** Like `configWorkflow`, plus two settings with code defaults. */
const settingsWorkflow = (run: Parameters<typeof configWorkflow>[0]) => {
  const base = configWorkflow(run);
  return { ...base, meta: { ...base.meta, settings: { batchSize: 10, mode: "fast", maxTokens: 7 } } };
};

test("a workflow's settings: the code default, then the global file, then the repo file; the workflow reads the result, and the run-start records it with its origin", async () => {
  let seen: Readonly<Record<string, unknown>> | undefined;
  const wf = settingsWorkflow(async (ctx) => {
    seen = ctx.settings;
    return "done";
  });
  const start = async () => {
    const r = await runWorkflow(wf, {}, { cwd });
    assert.equal(r.status, "finished", r.error);
    return runStartOf(logOf(r.runId));
  };

  let at = await start();
  assert.deepEqual(at.config.settings, { batchSize: 10, mode: "fast", maxTokens: 7 });
  assert.deepEqual(seen, { batchSize: 10, mode: "fast", maxTokens: 7 });
  assert.deepEqual(at.provenance["/settings/batchSize"], { layer: "default" });

  writeGlobalConfig({ workflows: { cfg: { settings: { batchSize: 20, mode: "slow" } } } });
  writeRepoConfig(cwd, { workflows: { cfg: { settings: { batchSize: 30 } } } });
  at = await start();
  assert.deepEqual(seen, { batchSize: 30, mode: "slow", maxTokens: 7 }, "the repo beats the global file, which beats the code, setting by setting");
  assert.deepEqual(at.provenance["/settings/batchSize"], { layer: "repo", ref: repoConfigPath(cwd) });
  assert.deepEqual(at.provenance["/settings/mode"], { layer: "global", ref: globalConfigPath() });
  assert.deepEqual(at.provenance["/settings/maxTokens"], { layer: "default" });
});

test("a setting named like a limit is a setting: no cap clamps it and no chat override touches it", async () => {
  writeGlobalConfig({ caps: { maxTokens: 1000, maxTokensPerStep: 1000 } });
  writeRepoConfig(cwd, { workflows: { cfg: { settings: { maxTokens: 5_000_000, maxTokensPerStep: 5_000_000 } } } });
  const wf = { ...settingsWorkflow(async () => "done") };
  wf.meta = { ...wf.meta, settings: { maxTokens: 7, maxTokensPerStep: 7 } };
  const r = await runWorkflow(wf, {}, { cwd, mcpOverrides: { maxTokensPerStep: 100 } });
  assert.equal(r.status, "finished", r.error);
  const start = runStartOf(logOf(r.runId));
  assert.deepEqual(start.config.settings, { maxTokens: 5_000_000, maxTokensPerStep: 5_000_000 });
  assert.equal(start.config.limits.maxTokens, 1000, "the real limit is still clamped by the cap");
  assert.deepEqual(start.violations.map((v) => v.path), [], "and the setting is no violation");
});

test("a setting the workflow does not declare is an error naming its path, like an unknown role; a workflow that declares none says so", async () => {
  writeRepoConfig(cwd, { workflows: { cfg: { settings: { batchsize: 5 } } } });
  const typo = await runWorkflow(settingsWorkflow(async () => "done"), {}, { cwd });
  assert.equal(typo.status, "failed");
  assert.ok(typo.error!.includes(repoConfigPath(cwd)), typo.error);
  assert.match(typo.error!, /\/workflows\/cfg\/settings\/batchsize: unknown setting \(workflow cfg declares: batchSize, mode, maxTokens\)/);

  const none = await runWorkflow(configWorkflow(async () => "done"), {}, { cwd });
  assert.equal(none.status, "failed");
  assert.match(none.error!, /\/workflows\/cfg\/settings\/batchsize: unknown setting \(workflow cfg declares no settings\)/);
  assert.equal(calls.length, 0);
});
