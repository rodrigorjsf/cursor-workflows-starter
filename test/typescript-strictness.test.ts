// Seam: the repository's TypeScript configuration and sources, read the way `tsc` and a reviewer read them. Each check
// enforces one rule that CODING_STANDARDS.md names under TypeScript: the compiler flags that catch a mistake before a
// run stay on in every tsc project, and the two places the types give no protection (a `JSON.parse` result cast to a
// shape, and an `any` at the workflow-module boundary) stay closed. A check is a predicate: a sample test proves it
// fires on an offender and stays silent on the legitimate case, and a second test runs it over the tree the rule
// governs. A construct spelled in a way the predicate does not know (an aliased `JSON`) passes.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "..");
const posix = (rel: string) => rel.split(sep).join("/");

/** Files under `dir` (relative to the root) whose name matches `name`, skipping dependencies and dot-folders (test temp dirs). */
function files(dir: string, name: RegExp): string[] {
  if (!existsSync(join(ROOT, dir))) return [];
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = posix(join(dir, e.name));
    if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : files(rel, name);
    return name.test(e.name) ? [rel] : [];
  });
}

// --- Compiler flags -----------------------------------------------------------------------------------------------------

/** The flags every tsc project of the repo keeps on. `moduleDetection` is checked apart: its value is an enum. */
const REQUIRED_FLAGS = [
  "strict",
  "verbatimModuleSyntax",
  "noUncheckedIndexedAccess",
  "noImplicitOverride",
  "noFallthroughCasesInSwitch",
  "noImplicitReturns",
  "noUnusedLocals",
  "noUnusedParameters",
  "isolatedModules",
  "noUncheckedSideEffectImports",
] as const;

/** The compiler options a tsconfig resolves to once its `extends` chain is applied, as `tsc -p` sees them. */
function resolvedOptions(tsconfig: string): ts.CompilerOptions {
  const path = join(ROOT, tsconfig);
  const { config, error } = ts.readConfigFile(path, ts.sys.readFile);
  assert.equal(error, undefined, `${tsconfig} does not parse`);
  return ts.parseJsonConfigFileContent(config, ts.sys, dirname(path)).options;
}

/** The required flags a project's resolved options leave off (or turn off), by name. */
function flagsOff(options: ts.CompilerOptions): string[] {
  const off: string[] = REQUIRED_FLAGS.filter((flag) => options[flag] !== true);
  if (options.moduleDetection !== ts.ModuleDetectionKind.Force) off.push("moduleDetection");
  return off;
}

test("the flag check names every required flag a project leaves off, and passes one that sets them all", () => {
  const all: ts.CompilerOptions = { ...Object.fromEntries(REQUIRED_FLAGS.map((flag) => [flag, true])), moduleDetection: ts.ModuleDetectionKind.Force };
  assert.deepEqual(flagsOff(all), []);
  assert.deepEqual(flagsOff({ ...all, noUncheckedIndexedAccess: false }), ["noUncheckedIndexedAccess"]);
  assert.deepEqual(flagsOff({ ...all, moduleDetection: ts.ModuleDetectionKind.Auto }), ["moduleDetection"]);
  assert.deepEqual(flagsOff({}).length, REQUIRED_FLAGS.length + 1);
});

test("every tsc project of the repo resolves with the strictness flags on, so none opts out of what `packages/runtime/tsconfig.json` sets", () => {
  const projects = files(".", /^tsconfig(\.[\w-]+)?\.json$/).filter((p) => !p.endsWith("tsconfig.test.json")); // tsconfig.test.json is for tsx, never for tsc
  assert.ok(projects.length >= 8, `found ${projects.join(", ")}`);
  const off = projects.flatMap((project) => flagsOff(resolvedOptions(project)).map((flag) => `${project}: ${flag}`));
  assert.deepEqual(off, [], "turn the flag on in packages/runtime/tsconfig.json (every project extends it) and fix the sites it reports");
});

// --- The workflow-module boundary ---------------------------------------------------------------------------------------

const parse = (path: string, text: string) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const lineOf = (sf: ts.SourceFile, node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** Visits every node of `sf`. */
function walk(sf: ts.SourceFile, visit: (node: ts.Node) => void) {
  const go = (node: ts.Node) => {
    visit(node);
    ts.forEachChild(node, go);
  };
  go(sf);
}

/** The lines where a file writes the `any` type: a workflow module the registry loads is typed `WorkflowDefinition`, and checked at load. */
function anyTypes(path: string, text: string): number[] {
  const sf = parse(path, text);
  const lines: number[] = [];
  walk(sf, (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) lines.push(lineOf(sf, node));
  });
  return lines;
}

test("the any check fires on an any type and stays silent on the word in text and on unknown", () => {
  assert.deepEqual(anyTypes("a.ts", "const m = new Map<string, WorkflowDefinition<any, any>>();\n"), [1, 1]);
  assert.deepEqual(anyTypes("a.ts", "const m = (await import(x)) as { default?: any };\n"), [1]);
  assert.deepEqual(anyTypes("a.ts", '// any workflow\nconst note = "any";\nconst m: Map<string, WorkflowDefinition<unknown, unknown>> = new Map();\n'), []);
});

test("the registry and the source fingerprints, which hold every loaded workflow, type none of it any", () => {
  const boundary = ["packages/runtime/src/runtime/registry.ts", "packages/runtime/src/runtime/workflow-source.ts"];
  const offences = boundary.flatMap((path) => anyTypes(path, readFileSync(join(ROOT, path), "utf8")).map((line) => `${path}:${line}`));
  assert.deepEqual(offences, [], "type the workflow as WorkflowDefinition (unknown args and result) and check what a module exports at load");
});
