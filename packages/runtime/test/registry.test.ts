// Seam 1, the workflow registry in process: `discoverWorkflows` and `loadWorkflows` over a target repo's `.agents/workflows/`.
// A workflow file is code the kit imports and runs without a type check, so what it exports is checked when it loads: a
// module that is not a workflow definition is reported in `broken` (the caller lists it with the reason) and never
// reaches the run. The process seam (the MCP server still serves the good ones) is registry.process.test.ts.
import assert from "node:assert/strict";
import "./isolate-home.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { discoverWorkflows, loadWorkflows } from "../src/runtime/registry.js";

let repo: string;
const previousDir = process.env.WORKFLOWS_DIR;

before(() => {
  delete process.env.WORKFLOWS_DIR; // an override in the developer's shell would add a directory these tests do not own
  repo = mkdtempSync(join(tmpdir(), "wf-registry-"));
  const dir = join(repo, ".agents", "workflows");
  mkdirSync(dir, { recursive: true });
  const module = (file: string, source: string) => writeFileSync(join(dir, file), source);
  module("good.mjs", `export default { meta: { name: "good", description: "fine" }, async run() { return "ok"; } };\n`);
  module("run-not-a-function.mjs", `export default { meta: { name: "no-run", description: "x" }, run: "later" };\n`);
  module("no-run.mjs", `export default { meta: { name: "missing-run", description: "x" } };\n`);
  module("no-name.mjs", `export default { meta: { description: "x" }, async run() {} };\n`);
  module("blank-name.mjs", `export default { meta: { name: "", description: "x" }, async run() {} };\n`);
  module("no-meta.mjs", `export default { async run() {} };\n`);
  module("not-an-object.mjs", `export default "nope";\n`);
  module("helper.mjs", `export const answer = () => 42;\n`); // a module the workflows import: no default export, so not a workflow
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
  if (previousDir !== undefined) process.env.WORKFLOWS_DIR = previousDir;
});

const problemOf = (broken: Array<{ file: string; error: string }>, file: string) => broken.find((b) => b.file.endsWith(file))?.error;

test("a workflow module whose run is not a function lands in broken, with the reason, and is not listed", async () => {
  const { workflows, broken } = await discoverWorkflows(repo);
  assert.match(problemOf(broken, "run-not-a-function.mjs") ?? "", /run must be a function/);
  assert.match(problemOf(broken, "no-run.mjs") ?? "", /run must be a function/);
  assert.ok(!workflows.has("no-run") && !workflows.has("missing-run"), "neither is offered to a caller that would call run()");
});

test("a default export without a name, with a blank name, without meta, or that is not an object lands in broken, with the reason", async () => {
  const { workflows, broken } = await discoverWorkflows(repo);
  assert.match(problemOf(broken, "no-name.mjs") ?? "", /meta\.name must be a non-empty string/);
  assert.match(problemOf(broken, "blank-name.mjs") ?? "", /meta\.name must be a non-empty string/);
  assert.match(problemOf(broken, "no-meta.mjs") ?? "", /meta\.name must be a non-empty string/);
  assert.match(problemOf(broken, "not-an-object.mjs") ?? "", /expected an object, got string/);
  assert.equal(workflows.size, 3, `the good workflow and the kit's two, nothing malformed: ${[...workflows.keys()].join(", ")}`);
});

test("a workflow that is well formed is listed, and a module with no default export is a helper: neither listed nor broken", async () => {
  const { workflows, broken } = await discoverWorkflows(repo);
  assert.equal(workflows.get("good")?.meta.description, "fine");
  assert.equal(broken.some((b) => b.file.endsWith("helper.mjs")), false);
});

test("loadWorkflows, for the callers that must not run with a partial set, throws and names each malformed file with its reason", async () => {
  await assert.rejects(loadWorkflows(repo), (err: Error) => /no-name\.mjs: .*meta\.name must be a non-empty string/.test(err.message) && /run-not-a-function\.mjs: .*run must be a function/.test(err.message));
});
