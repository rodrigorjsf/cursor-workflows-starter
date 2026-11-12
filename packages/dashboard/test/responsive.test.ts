// Seam: the rendered HTML of the app's views, and the Run view's stylesheet. What keeps a page readable on a 360px phone:
// charts drawn at the width they are shown (so their labels keep their size), tables whose rows stack into labelled cells, a
// failed run's reason written on the page (a tooltip is out of reach of touch and keyboard), and a step's log that opens over
// the canvas instead of squeezing it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ContextLines, DailyBars, Panels } from "../app/MetricsView.js";
import { RunsTable } from "../app/RunsView.js";
import { PACKAGE, render, textOf } from "./render.js";

/** The smallest text a chart may draw, in CSS pixels. */
const MIN_TEXT_PX = 11;

function assertDrawnAtWidth(html: string, width: number, what: string): void {
  const svg = /<svg\b[^>]*>/.exec(html)?.[0];
  assert.ok(svg, `${what} draws an SVG`);
  const viewBox = /viewBox="0 0 ([\d.]+) [\d.]+"/.exec(svg)?.[1];
  assert.equal(Number(viewBox), width, `${what}: one SVG unit is one CSS pixel at ${width}px wide`);
  for (const text of html.matchAll(/<text\b[^>]*>/g)) {
    const size = Number(/font-size="([\d.]+)"/.exec(text[0])?.[1]);
    assert.ok(size >= MIN_TEXT_PX, `${what}: a label is drawn at ${size}px (${text[0]}), under ${MIN_TEXT_PX}px`);
  }
}

test("a chart is drawn at the width it is shown, so its labels keep their size on a phone", () => {
  for (const width of [300, 640]) {
    const bars = render(DailyBars, { days: ["2026-11-11", "2026-11-12"], series: [{ day: "2026-11-12", workflow: "ship-feature", cost_cents: 198 }], width } as Parameters<typeof DailyBars>[0]);
    assertDrawnAtWidth(bars, width, "the daily spend chart");
    const lines = render(ContextLines, { rows: [{ ctx_bucket_k: 25, attempts: 20, cents_per_1k_tokens: 0.437, ok_rate: 1, avg_steps: 1, summaries: 0 }], width } as Parameters<typeof ContextLines>[0]);
    assertDrawnAtWidth(lines, width, "the context band chart");
  }
});

test("a context band chart with one band still shows the success rate: a lone point is drawn as a mark, not as an empty path", () => {
  const html = render(ContextLines, { rows: [{ ctx_bucket_k: 25, attempts: 20, cents_per_1k_tokens: 0.437, ok_rate: 1, avg_steps: 1, summaries: 0 }], width: 400 } as Parameters<typeof ContextLines>[0]);
  assert.ok((html.match(/<circle\b/g) ?? []).length >= 2, "a mark for the cost and one for the success rate");
});

/** Every `<td>` of `html` names its column, which a narrow screen shows beside the value when the rows stack. */
function assertCellsLabelled(html: string, what: string): void {
  const cells = [...html.matchAll(/<td\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(cells.length > 0, `${what} has cells`);
  for (const cell of cells) assert.match(cell, /\bdata-label="[^"]+"/, `${what}: a cell does not say its column: ${cell}`);
}

const RUNS = [
  { runId: "ship-feature-1", workflow: "ship-feature", repo: "/r/web-app", startedAt: "2026-11-12T10:00:00.000Z", status: "failed", phase: "Build", error: "tests failed: 1 of 42 specs failed (exit 1)", spentCents: 45 },
  { runId: "ship-feature-2", workflow: "ship-feature", repo: "/r/web-app", startedAt: "2026-11-12T09:00:00.000Z", finishedAt: "2026-11-12T09:01:00.000Z", status: "finished", spentCents: 54 },
];

test("tables stack into labelled rows on a narrow screen: every cell of the Runs table and of Metrics names its column", () => {
  assertCellsLabelled(render(RunsTable, { runs: RUNS as never }), "the Runs table");
  const summary = {
    totals: [{ runs: 2, cost_cents: 99 }],
    workflows: [{ workflow: "ship-feature", runs: 2, delivered: 1, delivery_rate: 0.5, cost_cents: 99, cost_per_delivery_cents: 99, human_rejected: 0 }],
    models: [{ model_key: "composer-2.5", attempts: 3, ok_rate: 1, cost_cents: 99, cost_per_ok_cents: 33, cache_share: 0.5, avg_steps: 1, avg_reprompts: 0, max_ctx_per_step: 100, summaries: 0 }],
  };
  assertCellsLabelled(render(Panels, { data: summary, days: "30", onDays: () => undefined }), "Metrics");
});

test("a failed run's reason is written in the Runs table, not only in a tooltip", () => {
  assert.match(textOf(render(RunsTable, { runs: RUNS as never })), /tests failed: 1 of 42 specs failed/);
});

/** The rules inside each `@media (max-width: …)` block of a stylesheet, by the width. */
function narrowRules(css: string): Array<{ width: number; body: string }> {
  const out: Array<{ width: number; body: string }> = [];
  for (const m of css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)\s*\{/g)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    for (; i < css.length && depth > 0; i++) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
    out.push({ width: Number(m[1]), body: css.slice(start, i - 1) });
  }
  return out;
}

test("on a narrow screen a step's log opens over the canvas, not beside it: the canvas keeps the whole workspace", () => {
  const css = readFileSync(join(PACKAGE, "run-view", "run-view.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const panelRules = narrowRules(css).flatMap(({ width, body }) => [...body.matchAll(/([^{}]*\.step-panel[^{}]*)\{([^}]*)\}/g)].map((r) => ({ width, selector: r[1]!.trim(), decls: r[2]! })));
  const overlay = panelRules.find((r) => /^\.step-panel$/.test(r.selector) && /position:\s*(absolute|fixed)/.test(r.decls) && r.width >= 600);
  assert.ok(overlay, "under 600px or more, .step-panel is positioned over the canvas");
  assert.match(overlay.decls, /inset:\s*0/, "and covers it whole");
  assert.doesNotMatch(css, /\.step-panel\s*\{[^}]*flex:\s*0 0 \d+%/, "the log never takes a share of the canvas's height");
});

test("while the log covers the canvas, the canvas is hidden, so its nodes and zoom buttons leave the Tab order", () => {
  const css = readFileSync(join(PACKAGE, "run-view", "run-view.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = narrowRules(css).flatMap(({ width, body }) => [...body.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((r) => ({ width, selector: r[1]!.trim(), decls: r[2]! })));
  const overlay = rules.find((r) => r.selector === ".step-panel" && /position:\s*(absolute|fixed)/.test(r.decls));
  assert.ok(overlay, "the log is drawn over the canvas on a narrow screen");
  const hidden = rules.find((r) => r.width === overlay.width && /:has\(\s*\.step-panel\s*\)/.test(r.selector) && /\.canvas$/.test(r.selector) && /visibility:\s*hidden/.test(r.decls));
  assert.ok(hidden, `under ${overlay.width}px, a workspace with the log open hides its canvas (visibility: hidden)`);
  // React Flow writes `visibility: visible` on each node's own style, which a hidden parent does not override.
  const nodes = rules.find((r) => r.width === overlay.width && /:has\(\s*\.step-panel\s*\)/.test(r.selector) && /\.react-flow__node\b/.test(r.selector) && /visibility:\s*hidden\s*!important/.test(r.decls));
  assert.ok(nodes, `under ${overlay.width}px, the canvas's nodes are hidden too, over React Flow's inline style (!important)`);
});
