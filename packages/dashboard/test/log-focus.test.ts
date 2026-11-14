// Seam: `focusOnOpen` and `focusOnClose`, where the keyboard focus goes when a step's log opens and closes. Under 800px the
// log is drawn over the canvas: the node that had the focus, and every Tab stop of the canvas, sit under it. The focus moves
// into the log, and back to the node when the log closes. The tests hand the functions stand-ins for the DOM (this repo has
// no DOM to run them in); the browser check is the repro in the review.
import assert from "node:assert/strict";
import { test } from "node:test";
import { focusOnClose, focusOnOpen } from "../run-view/log-focus.js";

/** A page with a body, the nodes of a canvas by id, and a log panel with its Close button. */
function page(nodeIds: string[]) {
  const doc = {
    activeElement: null as unknown,
    body: { name: "body" } as unknown,
    querySelector: (selector: string) => nodes.find((n) => selector.includes(`data-id="${n.id}"`)) ?? null,
  };
  const focusable = (name: string, id?: string) => {
    const el = {
      name,
      id,
      focus() {
        doc.activeElement = el;
      },
    };
    return el;
  };
  const nodes = nodeIds.map((id) => focusable(`node ${id}`, id));
  const close = focusable("close");
  const panel = { name: "panel" };
  doc.activeElement = doc.body;
  return { doc, nodes, close, panel };
}

test("a log opened over the canvas takes the focus: the node that had it is covered", () => {
  const { doc, nodes, close, panel } = page(["s1"]);
  nodes[0]!.focus();
  focusOnOpen(panel as never, close, () => ({ position: "absolute" }));
  assert.equal(doc.activeElement, close, "the focus is on the log's Close button");
});

test("a log opened beside the canvas leaves the focus where the reader is", () => {
  const { doc, nodes, close, panel } = page(["s1"]);
  nodes[0]!.focus();
  focusOnOpen(panel as never, close, () => ({ position: "static" }));
  assert.equal(doc.activeElement, nodes[0], "the focus stays on the node");
});

test("closing the log gives the focus back to the node whose log it was, when the focus went away with the panel", () => {
  const { doc, nodes } = page(["s1", "s2"]);
  doc.activeElement = doc.body; // the focused Close button was removed with the panel
  focusOnClose(doc as never, "s2");
  assert.equal(doc.activeElement, nodes[1], "the focus is back on s2");
});

test("closing the log by clicking another node keeps the focus on the node clicked", () => {
  const { doc, nodes } = page(["s1", "s2"]);
  nodes[0]!.focus();
  focusOnClose(doc as never, "s2");
  assert.equal(doc.activeElement, nodes[0], "the focus stays on s1");
});

test("a node gone from the canvas leaves the focus alone", () => {
  const { doc } = page(["s1"]);
  focusOnClose(doc as never, "s9");
  assert.equal(doc.activeElement, doc.body);
});
