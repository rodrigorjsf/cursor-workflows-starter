// Contract: the run graph is built from what the engine really writes. The other tests of the graph use events written by
// hand; this one runs a workflow with the real engine (and the fake Cursor SDK that the dashboard's tests run with, see
// `package.json`), reads the event log it left, and checks that the structure the engine gives the step, parent and group ids
// is the structure the graph derives: a parallel group, a pipeline, a command, a nested group, a step after a group, and a
// run that is resumed. A change to how the engine numbers its ids or groups fails here, not in someone's browser.
//
// The same goes for a step that ran in the cloud (the fake SDK has a cloud mode and the test a temporary bare remote): the
// node says it was a cloud one, names its agent, and the step's log has what the agent said, read through the dashboard's API.
//
// The one place the dashboard's tests reach into the runtime's sources: the engine is the thing under test.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { calls, resetCloud, script } from "../../runtime/test/fake-sdk.js";
import { runWorkflow } from "../../runtime/src/runtime/engine.js";
import { EVENT_SCHEMA_VERSION } from "../../runtime/src/runtime/events.js";
import { defineWorkflow } from "../../runtime/src/runtime/workflow.js";
import { repoWithRemote } from "../../runtime/test/cloud-fixtures.js";
import { clearConfig, configWorkflow, writeGlobalConfig } from "../../runtime/test/config-fixtures.js";
import { describeNode } from "../run-view/node-details.js";
import { EMPTY_ARGS_HASH, argsHashOf } from "../run-view/resume-command.js";
import { type GraphNode, KNOWN_EVENT_VERSION, type RunEvent, buildRunGraph, joinIdOf } from "../run-view/run-graph.js";
import { type ContentItem, buildStepLog } from "../run-view/step-log.js";
import { type DashboardServer, startDashboard } from "../src/server.js";
import { http, type Sandbox, logPath, sandbox } from "./support.js";

let box: Sandbox;
let dash: DashboardServer | undefined;
let cloudRepo: string | undefined;
beforeEach(() => {
  box = sandbox();
});
afterEach(async () => {
  await dash?.close();
  dash = undefined;
  if (cloudRepo !== undefined) clearConfig(cloudRepo);
  cloudRepo = undefined;
  box.dispose();
  script.length = 0;
  calls.length = 0;
  resetCloud();
});

const NODE: [string, string[]] = [process.execPath, ["-e", "0"]];

/** One of each shape: steps in a row, a parallel group whose branches differ, a nested pipeline, then a step after it all. */
const workflow = defineWorkflow<unknown, string>({
  meta: { name: "contract", description: "contract", phases: [{ title: "Plan" }, { title: "Build" }] },
  defaults: { model: { id: "m" } },
  async run(ctx) {
    ctx.phase("Plan");
    await ctx.agent("plan", { label: "plan" });
    ctx.phase("Build");
    await ctx.parallel([
      async () => {
        await ctx.agent("left 1", { label: "left-1" });
        await ctx.agent("left 2", { label: "left-2" });
      },
      async () => {
        await ctx.exec(...NODE, { label: "right-cmd" });
      },
      async () => {
        await ctx.pipeline(["x", "y"], (item) => ctx.exec(...NODE, { label: `stage-1:${item}` }), (_prev, item) => ctx.exec(...NODE, { label: `stage-2:${item}` }));
      },
    ]);
    await ctx.agent("merge", { label: "merge" });
    return "ok";
  },
});

function eventsOf(repo: string, runId: string): RunEvent[] {
  return readFileSync(logPath(repo, runId), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as RunEvent);
}
const byLabel = (nodes: GraphNode[], label: string) => nodes.find((n) => n.label === label)!;

test("the graph of a real run: every step and command is a node, the groups fork and join, and what follows a group continues from its join", async () => {
  const repo = box.repo("repo");
  const result = await runWorkflow(workflow, {}, { cwd: repo });
  assert.equal(result.status, "finished", result.error);

  const graph = buildRunGraph(eventsOf(repo, result.runId));
  const id = (label: string) => byLabel(graph.nodes, label).id;
  const arrow = (from: string, to: string) => graph.edges.some((e) => e.source === from && e.target === to);

  assert.equal(graph.nodes.filter((n) => n.kind === "step").length, 4, "plan, left-1, left-2, merge");
  assert.equal(graph.nodes.filter((n) => n.kind === "command").length, 5, "right-cmd and two stages of two items");
  assert.deepEqual(graph.nodes.filter((n) => n.kind === "fork").map((n) => n.label), ["parallel ×3", "pipeline ×2"]);
  assert.ok(graph.nodes.every((n) => n.state === "ok"), "a finished run has no node going or failed");
  assert.equal(graph.run.status, "finished");

  const [outer, inner] = graph.nodes.filter((n) => n.kind === "fork").map((n) => n.id);
  assert.ok(arrow("start", id("plan")) && arrow(id("plan"), outer!), "the group continues from the step before it");
  for (const first of ["left-1", "right-cmd"]) assert.ok(arrow(outer!, id(first)), `the parallel group fans out to ${first}`);
  assert.ok(arrow(outer!, inner!), "a group that opens a branch is a node of the group around it");
  assert.ok(arrow(id("left-1"), id("left-2")), "a branch is a chain");
  for (const item of ["x", "y"]) {
    assert.ok(arrow(inner!, id(`stage-1:${item}`)), `the pipeline fans out to the first stage of ${item}`);
    assert.ok(arrow(id(`stage-1:${item}`), id(`stage-2:${item}`)), `the stages of ${item} are chained`);
    assert.ok(arrow(id(`stage-2:${item}`), joinIdOf(inner!)), `the last stage of ${item} joins`);
  }
  for (const tail of [id("left-2"), id("right-cmd"), joinIdOf(inner!)]) assert.ok(arrow(tail, joinIdOf(outer!)), `${tail} joins the parallel group`);
  assert.ok(arrow(joinIdOf(outer!), id("merge")), "the step after the group continues from its join");
  assert.deepEqual(graph.lanes.map((l) => l.title), ["Plan", "Build"]);
  assert.equal(byLabel(graph.nodes, "merge").lane, 1);
});

test("the hash the engine writes for empty args is the one the resume command recognises, and any other args are not mistaken for it", async () => {
  const repo = box.repo("repo");
  const empty = await runWorkflow(workflow, {}, { cwd: repo });
  assert.equal(argsHashOf(eventsOf(repo, empty.runId)), EMPTY_ARGS_HASH, "if the engine changes how it hashes args, the resume command must stop claiming that the args are known");
  const other = await runWorkflow(workflow, { issue: 1 }, { cwd: repo });
  assert.notEqual(argsHashOf(eventsOf(repo, other.runId)), EMPTY_ARGS_HASH);
});

test("a resumed run keeps its nodes: the steps served from the journal show as cached and nothing is drawn twice", async () => {
  const repo = box.repo("repo");
  const first = await runWorkflow(workflow, {}, { cwd: repo });
  const resumed = await runWorkflow(workflow, {}, { cwd: repo, runId: first.runId });
  assert.equal(resumed.status, "finished", resumed.error);

  const once = buildRunGraph(eventsOf(repo, first.runId).slice(0, eventsOf(repo, first.runId).findIndex((e, i) => i > 0 && e.type === "run-start")));
  const both = buildRunGraph(eventsOf(repo, first.runId));
  assert.deepEqual(both.nodes.map((n) => n.id), once.nodes.map((n) => n.id), "the second execution adds no node");
  assert.equal(both.run.executions, 2);
  assert.deepEqual(byLabel(both.nodes, "plan").detail.cached, "journal");
  assert.equal(byLabel(both.nodes, "plan").state, "cached");
  assert.equal(byLabel(both.nodes, "plan").detail.attempts, 1, "the attempt of the first execution still counts");
});

test("the Run view knows the event schema version the engine writes: a version bump makes this fail until the reader learns it", () => {
  assert.equal(KNOWN_EVENT_VERSION, EVENT_SCHEMA_VERSION);
});

// ── a step in the cloud ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A repository with a bare `origin`, and a config that allows the cloud and sends the `review` role there. */
function cloudSetup(): string {
  const repo = box.repo("cloud-repo");
  cloudRepo = repo;
  repoWithRemote(repo, box.repo("origin.git"));
  writeGlobalConfig({ caps: { allowedLocations: ["local", "cloud"] }, workflows: { cfg: { roles: { review: { location: "cloud" } } } } });
  return repo;
}

const READ = ["read", "grep"] as const;
const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 20 };
/** What the agent streams: a message, then the end of its turn. */
const says = (text: string) => [{ type: "text-delta", text }, { type: "step-completed", stepId: 1 }, { type: "turn-ended", usage }];

/** One read-only step on the `review` role (the config above sends it to the cloud), then one on `classify`, which stays local. */
const cloudWorkflow = configWorkflow(async (ctx) => {
  await ctx.agent("look at the change", { role: "review", label: "look", tools: [...READ] });
  await ctx.agent("sort it", { role: "classify", label: "sort" });
  return "ok";
});

const rowsOf = (node: GraphNode) => Object.fromEntries(describeNode(node, 0).map((row) => [row.name, row]));

test("the graph of a real run with a cloud step: that step is a cloud one, names the agent the SDK created with a link to it in Cursor, and carries its cost; the local step beside it is not marked", async () => {
  script.push(() => ({ result: "all good", deltas: says("Looking at the change.") }), () => ({ result: "ok" }));
  const repo = cloudSetup();
  const result = await runWorkflow(cloudWorkflow, {}, { cwd: repo });
  assert.equal(result.status, "finished", result.error);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].cloud && !calls[1].cloud, "the review step was created as a cloud agent, the classify step as a local one");

  const graph = buildRunGraph(eventsOf(repo, result.runId));
  const cloud = byLabel(graph.nodes, "look");
  assert.equal(cloud.state, "ok");
  assert.deepEqual([cloud.detail.location, cloud.detail.cloudAgentId], ["cloud", "bc-1"]);
  const rows = rowsOf(cloud);
  assert.deepEqual([rows.Location!.value, rows["Cloud agent"]!.value, rows["Cloud agent"]!.href], ["cloud", "bc-1", "https://cursor.com/agents/bc-1"]);
  assert.deepEqual([rows.Tokens!.value, rows.Cost!.value], ["110", "9¢"], "what the cloud usage API reported, as the cap counts it");

  const local = byLabel(graph.nodes, "sort");
  assert.equal(local.detail.location, "local");
  assert.equal("cloudAgentId" in local.detail, false);
  assert.equal(rowsOf(local)["Cloud agent"], undefined);
});

test("a cloud step shows its agent while it still runs: the id is in the log before the step ends", async () => {
  const repo = cloudSetup();
  let atSend: RunEvent[] = [];
  script.push(() => {
    atSend = eventsOf(repo, "running-1"); // the agent has its message now; the step has not ended
    return { result: "done" };
  });
  const wf = configWorkflow((ctx) => ctx.agent("look", { role: "review", label: "look", tools: [...READ] }));
  const result = await runWorkflow(wf, {}, { cwd: repo, runId: "running-1" });
  assert.equal(result.status, "finished", result.error);

  const node = byLabel(buildRunGraph(atSend).nodes, "look");
  assert.equal(node.state, "running");
  assert.deepEqual([node.detail.location, node.detail.cloudAgentId], ["cloud", "bc-1"]);
});

test("the step log of a cloud step shows what the cloud agent said, read through the dashboard's API", async () => {
  script.push(() => ({ result: "all good", deltas: says("Looking at the change.") }), () => ({ result: "ok" }));
  const repo = cloudSetup();
  const result = await runWorkflow(cloudWorkflow, {}, { cwd: repo });
  assert.equal(result.status, "finished", result.error);
  const cloud = byLabel(buildRunGraph(eventsOf(repo, result.runId)).nodes, "look");

  dash = await startDashboard({ port: 0 });
  const reply = await http(dash.url, `/api/runs/${encodeURIComponent(result.runId)}/steps/${encodeURIComponent(cloud.id)}/content`);
  assert.equal(reply.status, 200);
  const log = buildStepLog((reply.json as { content: ContentItem[] }).content);

  assert.equal(log.attempts.length, 1);
  const entries = log.attempts[0]!.entries;
  assert.deepEqual(entries.map((e) => e.kind), ["prompt", "message"]);
  const message = entries[1]!;
  assert.equal(message.kind === "message" && message.text, "Looking at the change.");
});
