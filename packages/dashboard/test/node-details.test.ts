// Seam: what hovering a node says. `describeNode(node, now)` turns a graph node into the rows of its tooltip: model, location,
// the cloud agent (a link to it in Cursor), attempts, tokens, cost, duration and error kind, written for a person; and
// `describeFacts`, the part of them that heads a step's log, and `runsInCloud`, what marks a node with the cloud badge.
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCents, formatDuration } from "../app/format.js";
import { cloudAgentUrl, describeFacts, describeNode, runsInCloud } from "../run-view/node-details.js";
import { type GraphNode, buildRunGraph } from "../run-view/run-graph.js";
import { cloudAgent, execEnd, execStart, groupStart, runStart, stamp, step, stepEnd, stepStart, T0, type Draft } from "./run-log.js";

const nodeOf = (drafts: Draft[], id: string, settled = false): GraphNode => buildRunGraph(stamp(drafts), { settled }).nodes.find((n) => n.id === id)!;
const rows = (node: GraphNode, now = 0) => Object.fromEntries(describeNode(node, now).map((row) => [row.name, row.value]));
const rowOf = (node: GraphNode, name: string) => describeNode(node, 0).find((row) => row.name === name);

test("a finished step lists its model, where it ran, attempts, tokens, cost and duration", () => {
  const node = nodeOf(
    [runStart, stepStart("s-a", "plan"), stepEnd("s-a", "plan", {}, { usage: { totalTokens: 12345 }, rawCents: 3.5, chargedCents: 2, durationMs: 69000 })],
    "s-a",
  );
  assert.deepEqual(rows(node), { State: "ok", Model: "composer-2.5", Location: "local", Attempts: "1", Tokens: "12,345", Cost: "3.5¢", Duration: "1m 9s" });
});

test("a failed step adds the kind of its error and the message", () => {
  const node = nodeOf([runStart, stepStart("s-a", "plan"), stepEnd("s-a", "plan", {}, { ok: false, errorKind: "rate-limit", error: "slow down" })], "s-a");
  assert.equal(rows(node).State, "failed");
  assert.equal(rows(node)["Error kind"], "rate-limit");
  assert.equal(rows(node).Error, "slow down");
});

test("a step still going counts the time since it started, and says it is running", () => {
  const node = nodeOf([runStart, stepStart("s-a", "plan")], "s-a");
  const started = T0 + 1000;
  assert.equal(rows(node, started + 4200).Duration, "4.2s");
  assert.equal(rows(node, started + 4200).State, "running");
  assert.equal(rows(node, started - 5000).Duration, "0ms", "a clock behind the log's never gives a negative time");
});

test("a node of a run that stopped says so and stops counting", () => {
  const node = nodeOf([runStart, stepStart("s-a", "plan")], "s-a", true);
  assert.equal(rows(node, T0 + 999999).State, "interrupted");
  assert.equal(rows(node, T0 + 999999).Duration, "0ms");
});

test("a step served from the journal or the memo says where its result came from instead of counting attempts", () => {
  const node = nodeOf([runStart, stepStart("s-a", "plan", {}, { cached: "journal" }), stepEnd("s-a", "plan", {}, { cached: "journal" })], "s-a");
  assert.equal(rows(node).Attempts, "0 (from the journal)");
  assert.equal(rows(node).State, "cached");
});

test("a command lists the program, where it ran, attempts, duration and how it ended; it has no model, tokens or cost", () => {
  const node = nodeOf([runStart, execStart("x-1", "test"), execEnd("x-1", "test", {}, { ok: false, exitCode: 1, durationMs: 2500 })], "x-1");
  assert.deepEqual(rows(node), { State: "failed", Command: "npm", Location: "local", Attempts: "1", Duration: "2.5s", "Error kind": "exit 1" });
});

test("a cloud step says it ran in the cloud and names its agent as a link to it in Cursor, next to its cost", () => {
  const node = nodeOf(
    [
      runStart,
      stepStart("s-a", "review", {}, { location: "cloud" }),
      cloudAgent("s-a", "bc-00000000-0000-0000-0000-000000000001"),
      stepEnd("s-a", "review", {}, { location: "cloud", usage: { totalTokens: 4200 }, rawCents: 12.5, chargedCents: 12.5, durationMs: 31000, costFinal: true }),
    ],
    "s-a",
  );
  assert.deepEqual(rows(node), {
    State: "ok",
    Model: "composer-2.5",
    Location: "cloud",
    "Cloud agent": "bc-00000000-0000-0000-0000-000000000001",
    Attempts: "1",
    Tokens: "4,200",
    Cost: "12.5¢",
    Duration: "31.0s",
  });
  assert.equal(rowOf(node, "Cloud agent")!.href, "https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000001");
  assert.equal(rowOf(node, "Cost")!.href, undefined, "only the agent is a link");
});

test("a cloud step that is still running already shows its agent, and says when its cost is not final yet", () => {
  const going = nodeOf([runStart, stepStart("s-a", "review", {}, { location: "cloud" }), cloudAgent("s-a", "bc-1")], "s-a");
  assert.equal(rows(going).State, "running");
  assert.equal(rowOf(going, "Cloud agent")!.value, "bc-1");

  const ended = nodeOf([runStart, stepStart("s-a", "review", {}, { location: "cloud" }), cloudAgent("s-a", "bc-1"), stepEnd("s-a", "review", {}, { location: "cloud", costFinal: false, rawCents: 0, chargedCents: 0 })], "s-a");
  assert.equal(rows(ended).Cost, "0¢ (not final)", "the cloud has not settled the cost: the number is not the final one");
});

test("a local step has no cloud agent row; a cloud step whose log has no agent id has none either", () => {
  const local = nodeOf([runStart, stepStart("s-a", "plan", {}, { location: "local" }), stepEnd("s-a", "plan", {}, { location: "local", agentId: "agent-3" })], "s-a");
  assert.equal(rowOf(local, "Cloud agent"), undefined);
  const noAgent = nodeOf([runStart, stepStart("s-b", "plan", {}, { location: "cloud" })], "s-b");
  assert.deepEqual([rows(noAgent).Location, rowOf(noAgent, "Cloud agent")], ["cloud", undefined]);
});

test("the link to a cloud agent is made only for an id shaped like Cursor's, so that a log cannot send the reader anywhere else", () => {
  assert.equal(cloudAgentUrl("bc-9f2a"), "https://cursor.com/agents/bc-9f2a");
  for (const odd of ["agent-3", "bc-", "bc-a/../../x", "bc-a?x=1", "bc-a#b", "https://evil.example/bc-1", "javascript:alert(1)", " bc-1", "BC-1", ""]) assert.equal(cloudAgentUrl(odd), undefined, JSON.stringify(odd));
  const node = nodeOf([runStart, stepStart("s-a", "review", {}, { location: "cloud" }), cloudAgent("s-a", "bc-a/../../x")], "s-a");
  assert.deepEqual([rowOf(node, "Cloud agent")!.value, rowOf(node, "Cloud agent")!.href], ["bc-a/../../x", undefined], "shown as text, not linked");
});

test("the facts above a step's log are the short list; a cloud step adds where it ran, its agent as a link and its cost", () => {
  const names = (node: GraphNode) => describeFacts(node, 0).map((row) => row.name);
  const local = nodeOf([runStart, ...step("s-a", "plan")], "s-a");
  assert.deepEqual(names(local), ["State", "Model", "Attempts", "Duration"]);

  const cloud = nodeOf([runStart, stepStart("s-b", "review", {}, { location: "cloud" }), cloudAgent("s-b", "bc-7"), stepEnd("s-b", "review", {}, { location: "cloud", rawCents: 4, chargedCents: 4 })], "s-b");
  assert.deepEqual(names(cloud), ["State", "Model", "Location", "Cloud agent", "Attempts", "Cost", "Duration"]);
  assert.equal(describeFacts(cloud, 0).find((row) => row.name === "Cloud agent")!.href, "https://cursor.com/agents/bc-7");
  assert.equal(describeFacts(cloud, 0).find((row) => row.name === "Cost")!.value, "4¢");

  const command = nodeOf([runStart, execStart("x-1", "test"), execEnd("x-1", "test")], "x-1");
  assert.deepEqual(names(command), ["State", "Command", "Attempts", "Duration"]);
});

test("only a step that ran in the cloud is marked as one: not a local step, not a command, not the start or a fork", () => {
  const graph = buildRunGraph(stamp([runStart, stepStart("s-a", "remote", {}, { location: "cloud" }), stepStart("s-b", "here", {}, { location: "local" }), stepStart("s-c", "older log"), execStart("x-1", "test"), groupStart("g1", "parallel", 1, null)]));
  const marked = graph.nodes.filter(runsInCloud).map((node) => node.id);
  assert.deepEqual(marked, ["s-a"]);
});

test("the start, the forks and the joins have nothing to show", () => {
  const graph = buildRunGraph(stamp([runStart, ...step("s-a", "plan")]));
  assert.deepEqual(describeNode(graph.nodes[0]!, 0), []);
});

test("costs and durations read at a glance", () => {
  assert.deepEqual([0, 0.4, 3, 3.5, 99.9, 100, 1234.5].map(formatCents), ["0¢", "0.4¢", "3¢", "3.5¢", "99.9¢", "$1.00", "$12.35"]);
  assert.deepEqual([0, 7, 999, 1000, 4200, 59999, 60000, 69000, 3600000, 3725000].map(formatDuration), ["0ms", "7ms", "999ms", "1.0s", "4.2s", "59.9s", "1m 0s", "1m 9s", "1h 0m", "1h 2m"]);
});
