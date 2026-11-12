// Seam: the workflow files the repo ships. A workflow runs every command it needs through `ctx.exec`: a synchronous
// process call (`execFileSync`, `execSync`, `spawnSync`) freezes the whole process while it runs, so a cancel signal
// waits behind it, no timeout can kill it, and its output is invisible to the run's log. This lint reads the files the way
// an author wrote them (as TypeScript, comments and strings ignored) and fails on such a call.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "..");

const SYNC_PROCESS_CALLS = new Set(["execSync", "execFileSync", "spawnSync"]);

/** The synchronous process calls in `source`: the line of each identifier named like one (an import, a call, a property, a destructured name). */
function syncProcessCalls(source: string): Array<{ line: number; name: string }> {
  const file = ts.createSourceFile("workflow.ts", source, ts.ScriptTarget.Latest, true);
  const found: Array<{ line: number; name: string }> = [];
  const note = (node: ts.Node, name: string) => found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, name });
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && SYNC_PROCESS_CALLS.has(node.text)) note(node, node.text);
    // cp["execSync"](...): the name is a string here
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && SYNC_PROCESS_CALLS.has(node.argumentExpression.text)) note(node, node.argumentExpression.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The files that are workflows, as posix paths from the repo root: the kit's built-in ones, the repo's own, and the verification workflows. */
function workflowFiles(): string[] {
  const walk = (dir: string, keep: (name: string) => boolean): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
      const path = posix.join(dir, e.name);
      return e.isDirectory() ? walk(path, keep) : keep(e.name) ? [path] : [];
    });
  const code = (name: string) => /\.(ts|mjs|js)$/.test(name);
  return [
    ...walk("packages/runtime/workflows", code),
    ...walk(".agents/workflows", code),
    ...walk("scripts/verify", (name) => /^verify-.*\.ts$/.test(name)),
  ];
}

test("the lint sees a synchronous process call however it is imported, and ignores prose and the asynchronous API", () => {
  const flagged = [
    `import { execFileSync } from "node:child_process";\nexecFileSync("git", ["status"]);`,
    `import { execSync as run } from "child_process";\nrun("ls");`,
    `import * as cp from "node:child_process";\ncp.spawnSync("ls");`,
    `const { spawnSync } = require("node:child_process");`,
    `const cp = require("node:child_process");\ncp["execSync"]("ls");`,
  ];
  for (const source of flagged) assert.ok(syncProcessCalls(source).length > 0, `not flagged: ${source}`);

  const fine = [
    `// execFileSync would block the process\n/* spawnSync too */`,
    `const warning = "do not call execSync here";`,
    `import { execFile, spawn } from "node:child_process";\nspawn("ls");`,
    `await ctx.exec("git", ["status"], { label: "status" });`,
  ];
  for (const source of fine) assert.deepEqual(syncProcessCalls(source), [], `flagged: ${source}`);

  assert.deepEqual(syncProcessCalls(`\n\nexecSync("ls");`), [{ line: 3, name: "execSync" }]);
});

test("workflow files make no synchronous process calls: commands go through ctx.exec", () => {
  const files = workflowFiles();
  assert.ok(files.includes("packages/runtime/workflows/smoke.ts"), `found ${files.join(", ")}`);
  const offending = files.filter((file) => syncProcessCalls(readFileSync(join(ROOT, file), "utf8")).length > 0).sort();
  assert.deepEqual(
    offending,
    [],
    `${offending.join(", ")} call a synchronous process API (execFileSync, execSync, spawnSync): run the command with ctx.exec instead (skills/cursor-workflow-authoring/references/runtime-api.md)`,
  );
});
