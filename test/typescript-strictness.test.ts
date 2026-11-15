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

// --- JSON trust boundaries ----------------------------------------------------------------------------------------------

/** The code that ships or runs for the maintainer: JSON read here comes from a file or a process the code does not control. */
const JSON_SCOPE = ["packages/runtime/src", "packages/runtime/workflows", "packages/dashboard/src", "scripts", ".agents/workflows"].flatMap((d) => files(d, /\.(ts|mts)$/));

/** A `JSON.parse` result given a shape without a check. `call` is the text of the argument, which names what is read. */
interface JsonCast {
  line: number;
  call: string;
}

/** The `JSON.parse(...)` call that `node` is, looking through parentheses. */
function jsonParseCall(node: ts.Expression): ts.CallExpression | undefined {
  let inner = node;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  const callee = ts.isCallExpression(inner) ? inner.expression : undefined;
  const isParse = callee !== undefined && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "JSON" && callee.name.text === "parse";
  return isParse ? (inner as ts.CallExpression) : undefined;
}

/** Every `JSON.parse(text) as T`, `<T>JSON.parse(text)` and `const x: T = JSON.parse(text)`. A result typed `unknown` is the check that comes next, so it is no cast. */
function jsonCasts(path: string, text: string): JsonCast[] {
  const sf = parse(path, text);
  const found: JsonCast[] = [];
  const add = (node: ts.Node, shape: ts.TypeNode, parsed: ts.CallExpression | undefined) => {
    if (parsed && shape.kind !== ts.SyntaxKind.UnknownKeyword) found.push({ line: lineOf(sf, node), call: parsed.arguments.map((a) => a.getText(sf)).join(", ").replace(/\s+/g, " ") });
  };
  walk(sf, (node) => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) add(node, node.type, jsonParseCall(node.expression));
    else if (ts.isVariableDeclaration(node) && node.type && node.initializer) add(node, node.type, jsonParseCall(node.initializer));
  });
  return found;
}

test("the JSON cast check fires on a result cast, asserted or declared with a shape, and stays silent on unknown, on a guard and on other casts", () => {
  assert.deepEqual(jsonCasts("a.ts", "const x = JSON.parse(text) as Job;\n"), [{ line: 1, call: "text" }]);
  assert.deepEqual(jsonCasts("a.ts", "const v = (JSON.parse(readFileSync(path, 'utf8')) as { version?: string }).version;\n"), [{ line: 1, call: "readFileSync(path, 'utf8')" }]);
  assert.deepEqual(jsonCasts("a.ts", "const x = <Job>JSON.parse(text);\n"), [{ line: 1, call: "text" }]);
  assert.deepEqual(jsonCasts("a.ts", "const x: Job = JSON.parse(text);\n"), [{ line: 1, call: "text" }]);
  assert.deepEqual(jsonCasts("a.ts", "const x = (JSON.parse(\n  text,\n)) as Job;\n"), [{ line: 1, call: "text" }]);
  const checked = "const x: unknown = JSON.parse(text);\nconst y = JSON.parse(text) as unknown;\nconst z = other(text) as Job;\nlet w;\nw = JSON.parse(text);\nconst v = isRecord(x) ? x : {};\n";
  assert.deepEqual(jsonCasts("a.ts", checked), []);
});

/**
 * The casts that stay: a manifest or schema the kit ships beside the code that reads it, and the recordings a maintainer script wrote
 * itself. Keyed by file and by the argument of the call, so a line that moves does not break it. Everything else a `JSON.parse` brings
 * in (a state file, a forge answer, a config of the target repo, a process's output) is checked with `parse-json.ts`.
 */
const ALLOWED_JSON_CASTS: Array<{ file: string; call: string; why: string }> = [
  { file: "packages/runtime/src/kit-version.ts", call: 'readFileSync(PACKAGE_JSON, "utf8")', why: "the kit's own package.json, shipped with the code that reads it" },
  { file: "packages/dashboard/src/web-bundle.ts", call: 'readFileSync(packageJson(pkg), "utf8")', why: "the manifest of a package the dashboard bundles: it keys the bundle cache by version" },
  { file: "scripts/verify/validation-report.ts", call: 'readFileSync(join(kitDir, "package.json"), "utf8")', why: "the package.json of the kit the report is about, read for its version" },
  { file: "scripts/config-reference.ts", call: "schemaText", why: "the kit's own shipped config schema" },
  { file: "scripts/verify/record-gh-fixtures.ts", call: 'readFileSync(join(calls, name), "utf8")', why: "a recording this script wrote" },
  { file: "scripts/verify/record-glab-fixtures.ts", call: 'readFileSync(join(this.recordDir, calls[0]!), "utf8")', why: "a recording this script wrote" },
  { file: "scripts/verify/record-release-fixtures.ts", call: "createRedactor({ env: {} }).text(text)", why: "the recording the script has just built and scrubbed, parsed back to its own type" },
];

test("no shipped code casts a JSON.parse result to a shape outside the allowlist, and every allowlist entry still names a cast", () => {
  assert.ok(JSON_SCOPE.length >= 90, `found ${JSON_SCOPE.length} files`);
  const found = JSON_SCOPE.flatMap((path) => jsonCasts(path, readFileSync(join(ROOT, path), "utf8")).map((cast) => ({ path, ...cast })));
  const allowed = (cast: { path: string; call: string }) => ALLOWED_JSON_CASTS.some((a) => a.file === cast.path && a.call === cast.call);
  assert.deepEqual(
    found.filter((cast) => !allowed(cast)).map((cast) => `${cast.path}:${cast.line}: JSON.parse(${cast.call}) is cast`),
    [],
    "check the value instead (packages/runtime/src/runtime/parse-json.ts: parseJson with a zod schema, or isRecord and typeof), or allow it here with the reason it is trusted",
  );
  const stale = ALLOWED_JSON_CASTS.filter((a) => !found.some((cast) => cast.path === a.file && cast.call === a.call));
  assert.deepEqual(stale.map((a) => `${a.file}: ${a.call}`), [], "the cast was removed or its argument changed: delete the entry");
});
