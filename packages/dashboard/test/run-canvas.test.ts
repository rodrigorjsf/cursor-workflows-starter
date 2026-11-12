// Seam: `toFlow`, what the Run view hands React Flow. An edge carries no action: it is drawn, not a Tab stop. React Flow makes
// every edge focusable unless told otherwise, and draws a focused edge like any other, so a keyboard user would pass through
// one invisible stop per edge before reaching the first node.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactElement } from "react";
import "./render.js"; // the classic JSX runtime's global React
import { toFlow } from "../run-view/RunView.js";
import { WorkNode } from "../run-view/nodes.js";
import { buildRunGraph } from "../run-view/run-graph.js";
import { layoutRunGraph } from "../run-view/run-layout.js";
import { groupEnd, groupStart, phase, runStart, stamp, step } from "./run-log.js";

test("no edge of the canvas takes the keyboard focus", async () => {
  const graph = buildRunGraph(
    stamp([
      runStart,
      phase("Plan"),
      ...step("s1", "plan"),
      phase("Build"),
      groupStart("g1", "parallel", 2, "s1"),
      ...step("b1", "implement-ui", { parentId: "g1", groupId: "g1" }),
      ...step("b2", "implement-api", { parentId: "g1", groupId: "g1" }),
      groupEnd("g1"),
      ...step("s2", "review", { parentId: "g1" }),
    ]),
    { settled: true },
  );
  const { edges } = toFlow(graph, await layoutRunGraph(graph), 0, undefined, () => {}, () => {});
  assert.ok(edges.length >= 4, `the run is drawn with its edges (${edges.length})`);
  for (const edge of edges) assert.equal(edge.focusable, false, `edge ${edge.id} is not a Tab stop`);
});

test("a step or command that takes the keyboard focus asks the canvas to bring it into view; a click's focus does not", async () => {
  const graph = buildRunGraph(stamp([runStart, phase("Plan"), ...step("s1", "plan"), ...step("s2", "review", { parentId: "s1" })]), { settled: true });
  const focused: string[] = [];
  const { nodes } = toFlow(graph, await layoutRunGraph(graph), 0, undefined, () => {}, (id) => focused.push(id));
  const work = nodes.filter((n) => n.type === "work");
  assert.equal(work.length, 2);
  type Focusable = ReactElement<{ onFocus?: (event: { currentTarget: { matches(selector: string): boolean } }) => void }>;
  for (const node of work) {
    const element = WorkNode({ data: node.data, selected: false } as never) as Focusable;
    element.props.onFocus?.({ currentTarget: { matches: (selector) => selector !== ":focus-visible" } }); // a click
    element.props.onFocus?.({ currentTarget: { matches: (selector) => selector === ":focus-visible" } }); // Tab
  }
  assert.deepEqual(focused, ["s1", "s2"], "each node asked once, for the keyboard focus");
});
