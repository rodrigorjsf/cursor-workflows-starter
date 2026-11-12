// Seam: the dashboard's stylesheets, read as text. A node raised on hover or focus is drawn over its neighbours, so that its
// tooltip is not covered. A lane is a node too, the band behind its phase's steps: raising one covers every step in it. With
// the pointer resting on an empty part of a lane, its steps vanish, and so does a step Tab just panned into view.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PACKAGE } from "./render.js";

/** Every rule of every stylesheet of the pages: one entry per selector of a selector list, with its declarations. */
function rules(): Array<{ file: string; selector: string; decls: string }> {
  const out: Array<{ file: string; selector: string; decls: string }> = [];
  for (const dir of ["app", "run-view"]) {
    for (const name of readdirSync(join(PACKAGE, dir)).filter((n) => n.endsWith(".css"))) {
      const css = readFileSync(join(PACKAGE, dir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      // A rule's prelude is what follows the last `{`, `}` or `;` before its block: an `@media (...) {` before it is not part of it.
      for (const m of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
        for (const selector of m[1]!.split(",")) out.push({ file: `${dir}/${name}`, selector: selector.trim(), decls: m[2]! });
      }
    }
  }
  return out;
}

const raising = (r: { selector: string; decls: string }) => /:hover|:focus/.test(r.selector) && /z-index\s*:/.test(r.decls);

test("no rule raises a lane, or any node whatever its type, on hover or focus: a lane would cover its own steps", () => {
  for (const r of rules().filter(raising)) {
    assert.doesNotMatch(r.selector, /\.react-flow__node(?![-\w])/, `${r.file}: '${r.selector}' raises every node, lanes included`);
    assert.doesNotMatch(r.selector, /\.react-flow__node-lane\b|\.lane\b/, `${r.file}: '${r.selector}' raises a lane`);
  }
});

test("a step or command raised on hover and on keyboard focus, so its tooltip is drawn over its neighbours", () => {
  const work = rules().filter((r) => raising(r) && /\.react-flow__node-work\b/.test(r.selector));
  assert.ok(work.some((r) => /:hover/.test(r.selector)), "a hovered work node is raised");
  assert.ok(work.some((r) => /:focus-within/.test(r.selector)), "a work node holding the focus is raised (its tooltip shows on focus too)");
  for (const r of work) assert.match(r.decls, /!important/, "over the z-index React Flow writes on the node's own style");
});
