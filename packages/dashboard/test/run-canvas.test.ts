// Seam: `toFlow`, what the Run view hands React Flow. An edge carries no action: it is drawn, not a Tab stop. React Flow makes
// every edge focusable unless told otherwise, and draws a focused edge like any other, so a keyboard user would pass through
// one invisible stop per edge before reaching the first node.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ReactElement, type ReactNode, isValidElement } from "react";
import { render, textOf } from "./render.js";
import { StepMenu, toFlow } from "../run-view/RunView.js";
import { WorkNode } from "../run-view/nodes.js";
import { buildRunGraph, stepMenu } from "../run-view/run-graph.js";
import { layoutRunGraph } from "../run-view/run-layout.js";
import { groupEnd, groupStart, phase, runStart, sandboxRun, stamp, step } from "./run-log.js";

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

const elementsOf = (node: ReactNode): ReactElement<Record<string, any>>[] => (Array.isArray(node) ? node.flatMap(elementsOf) : isValidElement(node) ? [node as ReactElement<Record<string, any>>, ...elementsOf((node.props as { children?: ReactNode }).children)] : []);

const sandboxMenu = () => stepMenu(buildRunGraph(sandboxRun(), { settled: true }));
const menuProps = (over: Partial<Parameters<typeof StepMenu>[0]> = {}) => ({ phases: sandboxMenu(), open: true, onToggle: () => {}, onPick: () => {}, ...over });

test("the side menu lists every step under its phase, with its state, and each is a button of its own", () => {
  const phases = sandboxMenu();
  const html = render(StepMenu, menuProps());
  const text = textOf(html);

  for (const title of ["Implementation", "Review", "Delivery"]) assert.ok(text.includes(title), `the phase ${title} is a heading`);
  assert.match(text, /suite:red:1 failed/);
  assert.match(text, /code-1 ok/);
  const buttons = elementsOf(StepMenu(menuProps())).filter((e) => e.type === "button" && e.props["aria-pressed"] !== undefined);
  assert.equal(buttons.length, phases.reduce((sum, p) => sum + p.steps.length, 0), "one button per step");
});

test("picking a step in the side menu hands its id over, and the step picked is marked as pressed", () => {
  const picked: string[] = [];
  const phases = sandboxMenu();
  const menu = menuProps({ phases, selectedId: phases[0]!.steps[2]!.id, onPick: (id: string) => picked.push(id) });
  const buttons = elementsOf(StepMenu(menu)).filter((e) => e.type === "button" && e.props["aria-pressed"] !== undefined);
  assert.deepEqual(buttons.flatMap((b, i) => (b.props["aria-pressed"] === true ? [i] : [])), [2], "only the selected step is pressed");

  buttons[1]!.props.onClick();
  buttons[3]!.props.onClick();
  assert.deepEqual(picked, [phases[0]!.steps[1]!.id, phases[0]!.steps[3]!.id]);
});

test("the side menu collapses to its button: closed, no step is listed, and the button says so and opens it again", () => {
  const toggled: boolean[] = [];
  const closed = menuProps({ open: false, onToggle: () => toggled.push(false) });
  const tree = elementsOf(StepMenu(closed));
  const toggle = tree.find((e) => e.type === "button" && e.props["aria-expanded"] !== undefined);

  assert.ok(toggle, "the menu keeps a button that opens it");
  assert.equal(toggle.props["aria-expanded"], false);
  assert.equal(tree.filter((e) => e.type === "button" && e.props["aria-pressed"] !== undefined).length, 0, "no step is listed while it is closed");
  assert.doesNotMatch(textOf(render(StepMenu, closed)), /suite:red:1/);
  toggle.props.onClick();
  assert.equal(toggled.length, 1);
  assert.equal(elementsOf(StepMenu(menuProps())).find((e) => e.type === "button" && e.props["aria-expanded"] !== undefined)!.props["aria-expanded"], true);
});
