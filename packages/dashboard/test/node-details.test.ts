// Seam: what hovering a node says. `describeNode(node, now)` turns a graph node into the rows of its tooltip: model, location,
// attempts, tokens, cost, duration and error kind, written for a person.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeNode, formatCents, formatDuration } from "../run-view/node-details.js";
import { type GraphNode, buildRunGraph } from "../run-view/run-graph.js";
import { execEnd, execStart, runStart, stamp, step, stepEnd, stepStart, T0, type Draft } from "./run-log.js";

const nodeOf = (drafts: Draft[], id: string, settled = false): GraphNode => buildRunGraph(stamp(drafts), { settled }).nodes.find((n) => n.id === id)!;
const rows = (node: GraphNode, now = 0) => Object.fromEntries(describeNode(node, now));

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

test("the start, the forks and the joins have nothing to show", () => {
  const graph = buildRunGraph(stamp([runStart, ...step("s-a", "plan")]));
  assert.deepEqual(describeNode(graph.nodes[0]!, 0), []);
});

test("costs and durations read at a glance", () => {
  assert.deepEqual([0, 0.4, 3, 3.5, 99.9, 100, 1234.5].map(formatCents), ["0¢", "0.4¢", "3¢", "3.5¢", "99.9¢", "$1.00", "$12.35"]);
  assert.deepEqual([0, 7, 999, 1000, 4200, 59999, 60000, 69000, 3600000, 3725000].map(formatDuration), ["0ms", "7ms", "999ms", "1.0s", "4.2s", "59.9s", "1m 0s", "1m 9s", "1h 0m", "1h 2m"]);
});
