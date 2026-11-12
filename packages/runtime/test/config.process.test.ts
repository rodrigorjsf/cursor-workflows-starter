// Seam 2, the process: the `wf` CLI and the MCP server are spawned (against the fake Cursor SDK) in a temporary repo with
// a temporary home. Covers `wf config show`, and `start_workflow`: tighten-only overrides, the config re-read on every
// call, and an unusable config refused up front with the field path.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { WorkflowEvent } from "../src/runtime/events.js";
import { readEventLog, eventLogPath } from "../src/runtime/run-store.js";

const PACKAGE = join(import.meta.dirname, "..");
let sandbox: string;
let home: string;
let repo: string;

const globalConfig = () => join(home, "config.json");
const repoConfig = () => join(repo, ".agents", "workflows", "config.json");
const put = (path: string, content: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
};

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-config-process-"));
  home = join(sandbox, "home");
  repo = join(sandbox, "repo");
  mkdirSync(home);
  // A workflow with two roles that finishes without calling an agent: only the config is under test.
  put(
    join(repo, ".agents", "workflows", "cfgwf.mjs"),
    `export default {
  meta: { name: "cfgwf", description: "config test", roles: [
    { name: "classify", cloud: "ok", defaults: { model: { id: "composer-2.5" } } },
    { name: "review", cloud: "read-only", defaults: { model: { id: "grok-4.7", params: [{ id: "reasoning_effort", value: "high" }] } } },
  ] },
  defaults: { model: { id: "m" } },
  budget: { maxTokens: 3000000 },
  async run() { return "done"; },
};\n`,
  );
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

const childEnv = () => ({ ...getDefaultEnvironment(), WF_HOME: home, TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"), WF_METRICS: "off", WF_CWD: repo });
const tsxArgs = (script: string) => ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", script)];

function wf(...args: string[]) {
  const r = spawnSync(process.execPath, [...tsxArgs("cli.ts"), ...args, "--cwd", repo], { env: childEnv(), encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("wf config show prints each workflow's effective config, the provenance of its values and the violations", () => {
  put(globalConfig(), { caps: { maxTokens: 1_000_000 } });
  put(repoConfig(), { workflows: { cfgwf: { maxTokens: 2_000_000, roles: { review: { retries: 0 } } } } });
  const r = wf("config", "show", "cfgwf");
  assert.equal(r.status, 0, r.stderr);
  const shown = JSON.parse(r.stdout);
  assert.deepEqual(shown.files, { global: { path: globalConfig(), found: true }, repo: { path: repoConfig(), found: true } });
  assert.deepEqual(Object.keys(shown.workflows), ["cfgwf"]);
  const { config, provenance, violations } = shown.workflows.cfgwf;
  assert.equal(config.limits.maxTokens, 1_000_000);
  assert.deepEqual(provenance["/limits/maxTokens"], { layer: "cap", ref: globalConfig() });
  assert.equal(config.roles.review.retries, 0);
  assert.deepEqual(provenance["/roles/review/retries"], { layer: "repo", ref: repoConfig() });
  assert.equal(config.roles.review.model.id, "grok-4.7");
  assert.deepEqual(violations.map((v: { path: string }) => v.path), ["/workflows/cfgwf/maxTokens"]);
});

test("wf config show without a workflow name covers every workflow of the repo, built-ins included; flags are the top layer", () => {
  rmSync(globalConfig(), { force: true });
  rmSync(repoConfig(), { force: true });
  const r = wf("config", "show", "--max-tokens", "123456");
  assert.equal(r.status, 0, r.stderr);
  const shown = JSON.parse(r.stdout);
  assert.ok("cfgwf" in shown.workflows && "implement-issue" in shown.workflows, Object.keys(shown.workflows).join());
  assert.equal(shown.workflows.cfgwf.config.limits.maxTokens, 123456);
  assert.deepEqual(shown.workflows.cfgwf.provenance["/limits/maxTokens"], { layer: "flag", ref: "--max-tokens" });
  assert.deepEqual(shown.files, { global: { path: globalConfig(), found: false }, repo: { path: repoConfig(), found: false } });
});

test("wf config show with an unusable config exits 1 and names the file and the field path; an unknown workflow is named", () => {
  put(repoConfig(), { workflows: { cfgwf: { roles: { review: { retries: -1 } } } } });
  const bad = wf("config", "show", "cfgwf");
  assert.equal(bad.status, 1);
  assert.ok(bad.stderr.includes(repoConfig()), bad.stderr);
  assert.ok(bad.stderr.includes("/workflows/cfgwf/roles/review/retries"), bad.stderr);

  rmSync(repoConfig(), { force: true });
  const unknown = wf("config", "show", "nope");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /workflow desconhecido: nope/);
});

async function withServer<T>(use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "config-process-test", version: "0.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: tsxArgs("mcp-server.ts"), cwd: repo, env: childEnv() }));
    return await use(client);
  } finally {
    await client.close();
  }
}

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: Boolean(r.isError), body: JSON.parse(r.content[0]!.text) as Record<string, any> };
};

/** Starts the workflow, waits for the end, and returns what the run recorded in run-start. */
async function startAndRead(client: Client, args: Record<string, unknown> = {}) {
  const started = await call(client, "start_workflow", { name: "cfgwf", ...args });
  assert.equal(started.isError, false, JSON.stringify(started.body));
  let state = started.body;
  for (let i = 0; i < 30 && state.status !== "finished" && state.status !== "failed"; i++) {
    state = (await call(client, "wait_workflow", { jobId: started.body.jobId, timeoutSec: 5 })).body;
  }
  assert.equal(state.status, "finished", JSON.stringify(state));
  const events: WorkflowEvent[] = readEventLog(eventLogPath(repo, started.body.runId)).events;
  return { started: started.body, start: events.find((e): e is Extract<WorkflowEvent, { type: "run-start" }> => e.type === "run-start")! };
}

test("start_workflow reads the config afresh on every call, without restarting the server", async () => {
  rmSync(globalConfig(), { force: true });
  rmSync(repoConfig(), { force: true });
  await withServer(async (client) => {
    const first = await startAndRead(client);
    assert.equal(first.start.config.limits.maxCents, null);
    put(repoConfig(), { workflows: { cfgwf: { maxCents: 42 } } });
    const second = await startAndRead(client);
    assert.equal(second.start.config.limits.maxCents, 42);
    assert.deepEqual(second.start.provenance["/limits/maxCents"], { layer: "repo", ref: repoConfig() });
  });
});

test("start_workflow takes tighten-only overrides; a looser one is reported in the reply and has no effect", async () => {
  put(globalConfig(), { caps: { maxCents: 500 } });
  put(repoConfig(), { workflows: { cfgwf: { maxCents: 300 } } });
  await withServer(async (client) => {
    const tight = await startAndRead(client, { overrides: { maxTokens: 400_000, maxCents: 100 } });
    assert.equal(tight.start.config.limits.maxTokens, 400_000);
    assert.equal(tight.start.config.limits.maxCents, 100);
    assert.deepEqual(tight.start.provenance["/limits/maxCents"], { layer: "mcp", ref: "start_workflow.overrides" });
    assert.equal(tight.started.violations, undefined, "nothing to report");

    const loose = await startAndRead(client, { overrides: { maxCents: 450, concurrency: 2 } });
    assert.equal(loose.start.config.limits.maxCents, 300, "450 would loosen the repo's 300");
    assert.equal(loose.start.config.limits.concurrency, 2);
    assert.equal(loose.started.violations.length, 1);
    assert.equal(loose.started.violations[0].layer, "mcp");
    assert.equal(loose.started.violations[0].path, "maxCents");
    assert.equal(loose.start.violations.length, 1, "the run records it too");
  });
});

test("start_workflow refuses an unusable config up front, with the file and the field path, and starts no job", async () => {
  put(repoConfig(), { workflows: { cfgwf: { roles: { clasify: {} } } } });
  await withServer(async (client) => {
    const r = await call(client, "start_workflow", { name: "cfgwf" });
    assert.equal(r.isError, true);
    assert.match(r.body.error, /\/workflows\/cfgwf\/roles\/clasify: papel desconhecido/);
    assert.ok(String(r.body.error).includes(repoConfig()));
    assert.equal(r.body.jobId, undefined);
  });
  rmSync(repoConfig(), { force: true });
});

test("list_workflows publishes the roles a workflow declares: the contract of its config keys", async () => {
  await withServer(async (client) => {
    const listed = await client.callTool({ name: "list_workflows", arguments: {} });
    const metas = JSON.parse((listed.content as Array<{ text: string }>)[0]!.text) as Array<{ name: string; roles?: Array<{ name: string; cloud: string }> }>;
    assert.deepEqual(metas.find((m) => m.name === "cfgwf")!.roles!.map((r) => `${r.name}:${r.cloud}`), ["classify:ok", "review:read-only"]);
  });
});

test("wf start refuses an unusable config in the parent, before it spawns anything", () => {
  put(repoConfig(), { workflows: { cfgwf: { concurrency: 0 } } });
  const r = wf("start", "cfgwf");
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("/workflows/cfgwf/concurrency"), r.stderr);
  assert.equal(r.stdout, "", "no job was created");
  rmSync(repoConfig(), { force: true });
});
