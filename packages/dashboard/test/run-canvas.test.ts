// Seam: `toFlow`, what the Run view hands React Flow. An edge carries no action: it is drawn, not a Tab stop. React Flow makes
// every edge focusable unless told otherwise, and draws a focused edge like any other, so a keyboard user would pass through
// one invisible stop per edge before reaching the first node.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactElement } from "react";
import "./render.js"; // the classic JSX runtime's global React
import { toFlow } from "../run-view/RunView.js";
import { LaneNode, WorkNode } from "../run-view/nodes.js";
import { buildRunGraph } from "../run-view/run-graph.js";
import { layoutRunGraph } from "../run-view/run-layout.js";
import { render, textOf } from "./render.js";
import { execEnd, execStart, groupEnd, groupStart, phase, runStart, stamp, step } from "./run-log.js";

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
  const { edges } = toFlow(graph, await layoutRunGraph(graph), { now: 0, open: () => {}, focus: () => {}, phases: { onOpen: () => {} } });
  assert.ok(edges.length >= 4, `the run is drawn with its edges (${edges.length})`);
  for (const edge of edges) assert.equal(edge.focusable, false, `edge ${edge.id} is not a Tab stop`);
});

test("a step or command that takes the keyboard focus asks the canvas to bring it into view; a click's focus does not", async () => {
  const graph = buildRunGraph(stamp([runStart, phase("Plan"), ...step("s1", "plan"), ...step("s2", "review", { parentId: "s1" })]), { settled: true });
  const focused: string[] = [];
  const { nodes } = toFlow(graph, await layoutRunGraph(graph), { now: 0, open: () => {}, focus: (id) => focused.push(id), phases: { onOpen: () => {} } });
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

const withLooseCommands = (title: string) => buildRunGraph(stamp([runStart, ...(title === "" ? [] : [phase(title)]), ...step("s1", "plan"), execStart("x-1", "git status", { parentId: "s1" }), execEnd("x-1", "git status")]), { settled: true });

test("a phase with commands outside its steps draws its band and hands the band the size of its workflow entry and a way to open it, even when the phase has no title", async () => {
  for (const title of ["Delivery", ""]) {
    const graph = withLooseCommands(title);
    const opened: number[] = [];
    const { nodes } = toFlow(graph, await layoutRunGraph(graph), { now: 0, open: () => {}, focus: () => {}, phases: { openIndex: 0, onOpen: (lane) => opened.push(lane) } });
    const [band] = nodes.filter((n) => n.type === "lane");
    assert.ok(band, `the band of the phase ${JSON.stringify(title)} is drawn`);
    assert.deepEqual([band.data.title, band.data.commandCount, band.data.open], [title, 1, true]);
    (band.data as { onOpen(): void }).onOpen();
    assert.deepEqual(opened, [0]);
  }
});

test("a phase with commands but no steps still has its band, so that its workflow entry has a header to hang from", async () => {
  const graph = buildRunGraph(stamp([runStart, phase("Triage"), execStart("x-1", "gh issue view"), execEnd("x-1", "gh issue view")]), { settled: true });
  const { nodes } = toFlow(graph, await layoutRunGraph(graph), { now: 0, open: () => {}, focus: () => {}, phases: { onOpen: () => {} } });
  assert.deepEqual(nodes.filter((n) => n.type === "lane").map((n) => [n.data.title, n.data.commandCount, n.data.open]), [["Triage", 1, false]]);
});

test("the band's header holds a button for the workflow entry, named after its phase and its count; with no commands it is only the title", () => {
  const lane = (data: object) => render(LaneNode, { data } as never);
  const withEntry = lane({ title: "Delivery", commandCount: 7, open: false });
  assert.match(withEntry, /<button type="button" class="phase-entry nopan" aria-pressed="false" aria-label="Workflow of Delivery: 7 commands\. Open the list">/);
  assert.equal(textOf(withEntry), "Delivery workflow · 7");
  assert.match(lane({ title: "", commandCount: 2, open: true }), /aria-pressed="true" aria-label="Workflow of the run: 2 commands/);
  assert.doesNotMatch(lane({ title: "Review", commandCount: 0, open: false }), /<button/);
  assert.equal(textOf(lane({ title: "Review", commandCount: 0, open: false })), "Review");
  assert.doesNotMatch(lane({ title: "", commandCount: 0, open: false }), /lane-header/);
});
