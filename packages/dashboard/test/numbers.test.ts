// Seam: the pages' sources and their rendered HTML. Every number and date on every page is written by `app/format.ts`, in one
// locale (en-US), so the same quantity reads the same on the Board, in the Runs table, in Metrics and in the Run view, whatever
// the browser's own locale is.
import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { test } from "node:test";
import type { BoardCard } from "../src/board.js";
import { WorkflowBoard } from "../app/BoardView.js";
import { Panels } from "../app/MetricsView.js";
import { RunsTable } from "../app/RunsView.js";
import { PACKAGE, pageSources, render, textOf } from "./render.js";

const FORMAT = join(PACKAGE, "app", "format.ts");

test("numbers and dates are formatted by app/format.ts only: no other file of either page formats one itself", () => {
  const FORMATTING = /\.toLocale\w*String\(|Intl\.(?:NumberFormat|DateTimeFormat|RelativeTimeFormat)|\.toFixed\(|\.toPrecision\(/;
  for (const [path, text] of pageSources(".ts", ".tsx")) {
    if (path === FORMAT) continue;
    const hit = FORMATTING.exec(text);
    assert.equal(hit, null, `${relative(PACKAGE, path)} formats a number itself (${hit?.[0]}): use app/format.ts`);
  }
});

/** A summary as `/api/summary` serves it, with numbers big enough to show a thousands separator and a decimal. */
const SUMMARY = {
  totals: [{ runs: 4, cost_cents: 198, tokens: 453_200, cache_share: 0.652, failed_attempts: 1_250, cached_steps: 0, unreconciled: 0 }],
  daily: [{ day: "2026-11-12", workflow: "ship-feature", cost_cents: 198 }],
  workflows: [{ workflow: "ship-feature", runs: 4, delivered: 2, delivery_rate: 0.5, cost_cents: 198, cost_per_delivery_cents: 99, human_rejected: 0 }],
  contextBuckets: [{ model_key: "composer-2.5", ctx_bucket_k: 25, attempts: 20, cents_per_1k_tokens: 0.437, ok_rate: 1, avg_steps: 1, summaries: 0 }],
  waste: [],
  savings: [],
  models: [{ model_key: "composer-2.5", attempts: 20, ok_rate: 1, cost_cents: 180, cost_per_ok_cents: 9, cache_share: 0.652, avg_steps: 1, avg_reprompts: 0, max_ctx_per_step: 18_400, summaries: 0 }],
};

test("Metrics writes numbers the way every other page does: 453,200 tokens, a share as a percentage, a cost as the Board writes it", () => {
  const page = textOf(render(Panels, { data: SUMMARY, days: "30", onDays: () => undefined }));
  assert.match(page, /453,200/, "a thousands separator is a comma");
  assert.match(page, /18,400/);
  assert.match(page, /1,250/);
  assert.doesNotMatch(page, /\b453\.200\b|\b18\.400\b|\b1\.250\b/, "no pt-BR grouping");
  assert.doesNotMatch(page, /\b0,\d/, "no decimal comma");
  assert.match(page, /65\.2%/, "the cache share is a percentage");
  assert.match(page, /\$1\.98/, "a cost of 198¢ reads as the Board and the Runs table write it");
  assert.doesNotMatch(page, /\b198\b(?!¢)/, "a cost is never a bare number of cents");
});

test("the Runs table and the Board write a cost and a count the same way", () => {
  const run = { runId: "ship-feature-1", workflow: "ship-feature", repo: "/r/web-app", startedAt: "2026-11-12T10:00:00.000Z", finishedAt: "2026-11-12T10:03:05.000Z", status: "finished", spentCents: 1234.5 };
  assert.match(textOf(render(RunsTable, { runs: [run] as never })), /\$12\.35/);
  const card: BoardCard = { runId: "ship-feature-1", workflow: "ship-feature", repo: "/r/web-app", startedAt: run.startedAt, finishedAt: run.finishedAt, status: "finished", column: "done", spentCents: 1234.5 } as never;
  const board = textOf(render(WorkflowBoard, { board: { workflow: "ship-feature", columns: [{ key: "done", title: "Done", kind: "done" }], cards: [card] } as never }));
  assert.match(board, /\$12\.35/);
});

/**
 * A window where the agents' attempts cover 4 runs, and 2 more runs only ran commands (`ctx.exec`): no attempt, still runs.
 * `/api/summary` counts `totals.runs` from every run of the window, as it counts `workflows[].runs`: 6. That the two counts
 * agree is the query's to keep (packages/runtime/test/observability.test.ts); the page shows `totals.runs` as it is served.
 */
const WITH_EXEC_ONLY = {
  ...SUMMARY,
  totals: [{ ...SUMMARY.totals[0], runs: 6 }],
  workflows: [
    { workflow: "ship-feature", runs: 4, delivered: 2, delivery_rate: 0.5, cost_cents: 198, cost_per_delivery_cents: 99, human_rejected: 0 },
    { workflow: "sleeper", runs: 2, delivered: 2, delivery_rate: 1, cost_cents: 0, cost_per_delivery_cents: 0, human_rejected: 0 },
  ],
};

test("the Runs KPI counts what the Runs column under it counts: every run in the window, one that only ran commands included", () => {
  const html = render(Panels, { data: WITH_EXEC_ONLY, width: 600 });
  const kpi = /<div class="kpi"><dt>Runs<\/dt><dd>([^<]*)<\/dd>/.exec(html)?.[1];
  const column = [...html.matchAll(/<td data-label="Runs"[^>]*>([^<]*)<\/td>/g)].reduce((total, m) => total + Number(m[1]!.replace(/,/g, "")), 0);
  assert.equal(column, 6, "the table counts 6 runs");
  assert.equal(kpi, "6", "the KPI labelled Runs shows the same count as the column labelled Runs");
});

test("a window whose only runs ran commands is not empty: its runs are counted", () => {
  const data = { ...WITH_EXEC_ONLY, totals: [{ runs: 2 }], models: [], contextBuckets: [], daily: [], workflows: [WITH_EXEC_ONLY.workflows[1]!] };
  const page = textOf(render(Panels, { data, width: 600 }));
  assert.doesNotMatch(page, /No metrics in this window/);
  assert.match(page, /sleeper/);
});
