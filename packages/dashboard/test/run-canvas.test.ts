// Seam: `toFlow`, what the Run view hands React Flow. An edge carries no action: it is drawn, not a Tab stop. React Flow makes
// every edge focusable unless told otherwise, and draws a focused edge like any other, so a keyboard user would pass through
// one invisible stop per edge before reaching the first node.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ReactElement, type ReactNode, isValidElement } from "react";
import "./render.js"; // the classic JSX runtime's global React
import { StepMenu, toFlow } from "../run-view/RunView.js";
import { LaneNode, WorkNode } from "../run-view/nodes.js";
import { buildRunGraph, stepMenu } from "../run-view/run-graph.js";
import { layoutRunGraph } from "../run-view/run-layout.js";
import { render, textOf } from "./render.js";
import { execEnd, execStart, groupEnd, groupStart, phase, runStart, sandboxRun, stamp, step } from "./run-log.js";

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

type Focusable = ReactElement<{ className?: string; children?: ReactNode; onFocus?: (event: { currentTarget: { matches(selector: string): boolean } }) => void }>;
const findByClass = (node: ReactNode, className: string): Focusable | undefined => {
  if (Array.isArray(node)) return node.map((child) => findByClass(child, className)).find(Boolean);
  if (!isValidElement(node)) return undefined;
  const element = node as Focusable;
  return element.props.className?.split(" ").includes(className) ? element : findByClass(element.props.children, className);
};

test("a phase's workflow entry that takes the keyboard focus asks the canvas to bring its band's header into view; a click's focus does not", async () => {
  const graph = withLooseCommands("Delivery");
  const focused: number[] = [];
  const { nodes } = toFlow(graph, await layoutRunGraph(graph), { now: 0, open: () => {}, focus: () => {}, phases: { onOpen: () => {}, onFocus: (lane) => focused.push(lane) } });
  const [band] = nodes.filter((n) => n.type === "lane");
  const entry = findByClass(LaneNode({ data: band!.data } as never), "phase-entry");
  assert.ok(entry, "the band draws its workflow entry");
  entry.props.onFocus?.({ currentTarget: { matches: (selector) => selector !== ":focus-visible" } });
  entry.props.onFocus?.({ currentTarget: { matches: (selector) => selector === ":focus-visible" } });
  assert.deepEqual(focused, [0]);
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

type Props = Record<string, unknown>;
const elementsOf = (node: ReactNode): ReactElement<Props>[] => (Array.isArray(node) ? node.flatMap(elementsOf) : isValidElement<Props>(node) ? [node, ...elementsOf(node.props.children as ReactNode)] : []);
const stepButtons = (tree: ReactElement<Props>[]) => tree.filter((e) => e.type === "button" && e.props["aria-pressed"] !== undefined);
const toggleOf = (tree: ReactElement<Props>[]) => tree.find((e) => e.type === "button" && e.props["aria-expanded"] !== undefined);
const click = (button: ReactElement<Props> | undefined) => (button!.props.onClick as () => void)();

const treeOf = (props: Parameters<typeof StepMenu>[0]): ReactElement<Props>[] => {
  let tree: ReactElement<Props>[] = [];
  render(() => {
    tree = elementsOf(StepMenu(props));
    return null;
  }, {});
  return tree;
};

const sandboxMenu = () => stepMenu(buildRunGraph(sandboxRun(), { settled: true }));
const menuProps = (over: Partial<Parameters<typeof StepMenu>[0]> = {}) => ({ phases: sandboxMenu(), open: true, onToggle: () => {}, onPick: () => {}, onOverlay: () => {}, ...over });

test("the side menu lists every step under its phase, with its state, and each is a button of its own", () => {
  const phases = sandboxMenu();
  const text = textOf(render(StepMenu, menuProps()));

  for (const title of ["Implementation", "Review", "Delivery"]) assert.ok(text.includes(title), `the phase ${title} is a heading`);
  assert.match(text, /suite:red:1 failed/);
  assert.match(text, /code-1 ok/);
  assert.equal(stepButtons(treeOf(menuProps())).length, phases.reduce((sum, p) => sum + p.steps.length, 0), "one button per step");
});

test("picking a step in the side menu hands its id over, and the step picked is marked as pressed", () => {
  const picked: string[] = [];
  const phases = sandboxMenu();
  const buttons = stepButtons(treeOf(menuProps({ phases, selectedId: phases[0]!.steps[2]!.id, onPick: (id: string) => picked.push(id) })));
  assert.deepEqual(buttons.flatMap((b, i) => (b.props["aria-pressed"] === true ? [i] : [])), [2], "only the selected step is pressed");

  click(buttons[1]);
  click(buttons[3]);
  assert.deepEqual(picked, [phases[0]!.steps[1]!.id, phases[0]!.steps[3]!.id]);
});

test("the side menu collapses to its button: closed, no step is listed, and the button says so and opens it again", () => {
  const toggled: boolean[] = [];
  const closed = menuProps({ open: false, onToggle: () => toggled.push(false) });
  const tree = treeOf(closed);
  const toggle = toggleOf(tree);

  assert.ok(toggle, "the menu keeps a button that opens it");
  assert.equal(toggle.props["aria-expanded"], false);
  assert.equal(stepButtons(tree).length, 0, "no step is listed while it is closed");
  assert.doesNotMatch(textOf(render(StepMenu, closed)), /suite:red:1/);
  click(toggle);
  assert.equal(toggled.length, 1);
  assert.equal(toggleOf(treeOf(menuProps()))!.props["aria-expanded"], true);
});
