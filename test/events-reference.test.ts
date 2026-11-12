// Seam 3, the docs: the events reference page is generated from the event interfaces, and `npm test` fails when the
// committed page drifts from them. Regenerate with `npm run docs:events`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EVENTS_PAGE, EVENTS_SOURCE, generateEventsReference } from "../scripts/events-reference.js";

const source = readFileSync(EVENTS_SOURCE, "utf8");

test("the committed events reference page matches the event type", () => {
  assert.equal(readFileSync(EVENTS_PAGE, "utf8"), generateEventsReference(source), "docs/reference/events.md is out of date: run `npm run docs:events`");
});

test("the page documents every event type, its fields and their comments", () => {
  const page = generateEventsReference(source);
  for (const type of ["log", "phase", "run-start", "run-end", "group-start", "group-end", "step-start", "turn", "step-end", "metric", "warning"]) {
    assert.match(page, new RegExp(`^### \`${type}\``, "m"), `section of ${type}`);
  }
  assert.match(page, /\| `stepId` \| `string` \| sim \|/, "a required field of the step position");
  assert.match(page, /\| `parentId` \| `string \\\| null` \| sim \|/, "a union type keeps its pipe escaped inside the table");
  assert.match(page, /\| `prompt` \| `string` \| não \| Só quando WF_METRICS_STORE_PROMPTS=1\. \|/, "an optional field carries its comment");
  assert.match(page, /### `step-start`[\s\S]*\[`EventBase`\]\(#eventbase\)[\s\S]*\[`StepRef`\]\(#stepref\)/, "a step event says it also has the common and the position fields");
});

test("a change to the event type makes the committed page stale", () => {
  const changed = source.replace('type: "log";', 'type: "log";\n  /** Gravidade. */\n  level?: "info" | "warn";');
  assert.notEqual(changed, source, "the fixture edit applied");
  const page = generateEventsReference(changed);
  assert.match(page, /\| `level` \| `"info" \\\| "warn"` \| não \| Gravidade\. \|/);
  assert.notEqual(page, readFileSync(EVENTS_PAGE, "utf8"), "the committed page no longer matches: the docs check would fail");
});
