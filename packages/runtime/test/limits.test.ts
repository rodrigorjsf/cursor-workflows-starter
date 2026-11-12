// The per-run limits are one table (config/resolve.ts LIMITS). The shipped JSON Schema and the MCP override schema must
// agree with it, so adding a limit in one place and forgetting another fails here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LIMITS, limitOverridesSchema } from "../src/config/index.js";

const schema = JSON.parse(readFileSync(join(import.meta.dirname, "..", "schema", "config.schema.json"), "utf8")) as {
  definitions: Record<string, { properties: Record<string, unknown> }>;
};

test("every limit has its global cap and its workflow preference in the config schema", () => {
  for (const [field, limit] of Object.entries(LIMITS)) {
    assert.ok(schema.definitions.caps!.properties[limit.cap], `caps.${limit.cap} for ${field}`);
    assert.ok(schema.definitions.workflowPrefs!.properties[field], `workflowPrefs.${field}`);
  }
});

test("the MCP override schema offers exactly the limits, with their bounds", () => {
  const props = limitOverridesSchema().properties as Record<string, { type: string; minimum: number }>;
  assert.deepEqual(Object.keys(props).sort(), ["concurrency", "maxCents", "maxTokens", "maxTokensPerStep"]);
  assert.deepEqual(props.concurrency, { ...props.concurrency, type: "integer", minimum: 1 });
  assert.deepEqual(props.maxCents, { ...props.maxCents, type: "number", minimum: 0 });
});
