// Seam: `argsSkeleton`, the pure function that turns a workflow's `argsSchema` into the text its args box starts with
// (src/start.ts). No server, no files: a schema in, an object out. The HTTP side of the same listing is start.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { argsSkeleton } from "../src/start.js";

test("a required field gets a blank of its type, and a field that is not required is left out", () => {
  const schema = {
    type: "object",
    required: ["title", "issue", "dryRun", "labels", "options"],
    properties: {
      title: { type: "string" },
      issue: { type: "integer" },
      ratio: { type: "number" },
      dryRun: { type: "boolean" },
      labels: { type: "array", items: { type: "string" } },
      options: { type: "object" },
      note: { type: "string" },
    },
  };
  assert.deepEqual(argsSkeleton(schema), { title: "", issue: 0, dryRun: false, labels: [], options: {} });
});

test("a schema's own default, constant or first enum value wins over the blank, and a nested object lists its required fields", () => {
  const schema = {
    required: ["mode", "kind", "pr", "limits"],
    properties: {
      mode: { type: "string", enum: ["fast", "slow"] },
      kind: { const: "review" },
      pr: { type: "boolean", default: true },
      limits: { type: "object", required: ["depth"], properties: { depth: { type: "integer" }, width: { type: "integer" } } },
    },
  };
  assert.deepEqual(argsSkeleton(schema), { mode: "fast", kind: "review", pr: true, limits: { depth: 0 } });
});

test("a blank is one the schema turns down, so a field left unfilled fails the check instead of starting a run on a made-up value", () => {
  assert.deepEqual(argsSkeleton({ required: ["issue"], properties: { issue: { type: "integer", minimum: 1 } } }), { issue: 0 });
});

test("a type that allows null takes the blank of its other type, and a field the skeleton cannot guess is null", () => {
  const schema = { required: ["maybe", "free", "missing"], properties: { maybe: { type: ["null", "string"] }, free: {} } };
  assert.deepEqual(argsSkeleton(schema), { maybe: "", free: null, missing: null });
});

test("a workflow with no schema, or one that declares no fields, starts from an empty object", () => {
  for (const schema of [undefined, null, "text", [], {}, { type: "object" }, { properties: {} }, { required: "issue", properties: [] }]) {
    assert.deepEqual(argsSkeleton(schema), {}, JSON.stringify(schema));
  }
});
