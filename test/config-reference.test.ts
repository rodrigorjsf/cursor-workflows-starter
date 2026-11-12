// Seam 3, the docs: the config reference page (chapter 6.2) is generated from the shipped JSON Schema, and `npm test`
// fails when the committed page drifts from it. Regenerate with `npm run docs:config`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONFIG_PAGE, CONFIG_SCHEMA, generateConfigReference } from "../scripts/config-reference.js";

const schemaText = readFileSync(CONFIG_SCHEMA, "utf8");

test("the committed config reference page matches the JSON Schema", () => {
  assert.equal(readFileSync(CONFIG_PAGE, "utf8"), generateConfigReference(schemaText), "docs/reference/config.md is out of date: run `npm run docs:config`");
});

test("the page documents every field of the schema with its type and description, and the shipped examples", () => {
  const page = generateConfigReference(schemaText);
  const schema = JSON.parse(schemaText) as { properties: Record<string, unknown>; definitions: Record<string, { properties?: Record<string, { description?: string }> }> };
  for (const field of Object.keys(schema.properties)) if (field !== "$comment") assert.match(page, new RegExp(`\\| \`${field.replace("$", "\\$")}\` \\|`), `root field ${field}`);
  for (const [name, def] of Object.entries(schema.definitions)) {
    for (const [field, node] of Object.entries(def.properties ?? {})) {
      if (field === "$comment") continue;
      assert.match(page, new RegExp(`\\| \`${field}\` \\|`), `${name}.${field} has a row`);
      if (node.description) assert.ok(page.includes(node.description.replace(/\|/g, "\\|")), `${name}.${field}: its description is on the page`);
    }
  }
  assert.match(page, /\| `maxTokens` \| `integer \\\| null` \| não \|/, "a nullable type is spelled out, its pipe escaped");
  assert.match(page, /\| `allowedLocations` \| `array de "local" \\\| "cloud" \\\| null` \| não \|/);
  assert.match(page, /"maxConcurrency": 4/, "the shipped global example is on the page");
  assert.match(page, /"implement\.low": \{\s+"retries": 0\s+\}/, "the shipped repo example is on the page");
});

test("a field added to the schema makes the committed page stale; a definition without a section title is refused", () => {
  const changed = schemaText.replace('"maxConcurrency": {', '"maxSteps": { "type": "integer", "description": "Passos por run." },\n        "maxConcurrency": {');
  assert.notEqual(changed, schemaText, "the fixture edit applied");
  const page = generateConfigReference(changed);
  assert.match(page, /\| `maxSteps` \| `integer` \| não \| Passos por run\. \|/);
  assert.notEqual(page, readFileSync(CONFIG_PAGE, "utf8"), "the committed page no longer matches: the docs check would fail");

  const extra = schemaText.replace('"definitions": {', '"definitions": {\n    "newThing": { "type": "object", "properties": { "x": { "type": "string" } } },');
  assert.throws(() => generateConfigReference(extra), /newThing/);
});
