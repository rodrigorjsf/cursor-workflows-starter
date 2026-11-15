// Seam: repo tests. The kit runs its own `implement-issue` on this repository, so the repository config
// (`.agents/workflows/config.json`) is the first example of a target repo that declares where its context files live:
// it must pass the shipped schema, name the glossary that docs/agents/domain.md names, and list only paths that exist.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfigFile, repoConfigPath } from "../packages/runtime/src/config/file.js";
import { ROOT } from "./mcp-support.js";

const GLOSSARY = "docs/vision/03-conceitos.md";

/** The `contextFiles` this repository's config sets for `implement-issue`. */
function contextFiles(): string[] {
  const config = loadConfigFile(repoConfigPath(ROOT)); // throws, naming the field, when the file does not pass the schema
  assert.ok(config, ".agents/workflows/config.json does not exist");
  const listed = config.data.workflows?.["implement-issue"]?.settings?.contextFiles;
  assert.ok(Array.isArray(listed) && listed.every((path) => typeof path === "string"), "contextFiles is a list of paths");
  return listed as string[];
}

test("the repository config names the glossary in docs/vision, which docs/agents/domain.md names as the glossary", () => {
  assert.ok(contextFiles().includes(GLOSSARY), `contextFiles must name ${GLOSSARY}`);
  assert.match(readFileSync(join(ROOT, "docs", "agents", "domain.md"), "utf8"), new RegExp(`\`${GLOSSARY}\`[^\\n]*: the glossary`));
});

test("every path the repository config lists exists, so the agents are not sent to a file that was renamed", () => {
  const listed = contextFiles();
  assert.ok(listed.length > 0);
  for (const path of listed) assert.ok(existsSync(join(ROOT, path)), `${path} is listed in contextFiles and does not exist`);
});
