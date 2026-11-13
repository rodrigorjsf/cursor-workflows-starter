// Seam: the repository's own files, read as text or through the TypeScript parser, the way a reviewer reads them. Each
// check enforces one mechanical rule that CODING_STANDARDS.md names on an "Enforced by tooling" line, so the file keeps
// only the judgement. A check is a predicate over one file's text: a sample test proves it fires on an offender and stays
// silent on the legitimate case, and a second test runs it over the tree the rule governs. The last check reads
// CODING_STANDARDS.md itself: every exemplar `path:line` it cites must still exist.
//
// Code-keyed: the TypeScript checks read the syntax tree, so comments never trip them; the shell, YAML and manifest checks
// read lines. A construct spelled in a way the predicate does not know (an alias of `ctx`, a computed import path) passes.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const posix = (rel: string) => rel.split(sep).join("/");

/** Files under `dir` (relative to the root) whose name matches `ext`, skipping dependencies and dot-folders (test temp dirs). */
function files(dir: string, ext: RegExp): string[] {
  if (!existsSync(join(ROOT, dir))) return [];
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = posix(join(dir, e.name));
    if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : files(rel, ext);
    return ext.test(e.name) ? [rel] : [];
  });
}

const CODE = /\.(ts|tsx|mjs)$/;
const PACKAGES = readdirSync(join(ROOT, "packages")).map((p) => `packages/${p}`);
/** Every TypeScript and module source the repo ships or runs: packages, maintainer scripts, root tests, repo workflows. */
const ALL_CODE = [...PACKAGES, "scripts", "test", ".agents/workflows"].flatMap((d) => files(d, CODE));
const TEST_DIRS = ["test", ...PACKAGES.map((p) => `${p}/test`)];
const TEST_CODE = TEST_DIRS.flatMap((d) => files(d, /\.ts$/));
/** Code that runs in the runtime or the dashboard processes: not tests, not maintainer scripts. */
const PRODUCT_CODE = ["packages/runtime/src", "packages/runtime/workflows", "packages/dashboard/src", ".agents/workflows"].flatMap((d) => files(d, CODE));
/** Code bundled for the browser. */
const BROWSER_CODE = ["packages/dashboard/app", "packages/dashboard/run-view"].flatMap((d) => files(d, /\.tsx?$/));
const SHELL = files("scripts", /\.sh$/);

const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const lineOf = (sf: ts.SourceFile, node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** Visits every node of `sf`. */
function walk(sf: ts.SourceFile, visit: (node: ts.Node) => void) {
  const go = (node: ts.Node) => {
    visit(node);
    ts.forEachChild(node, go);
  };
  go(sf);
}

interface Import {
  spec: string;
  line: number;
  /** True when the import brings in types only, so nothing of the module loads at run time. */
  typeOnly: boolean;
  /** The imported names (the original name for `{ a as b }`). */
  names: string[];
}

/** Every module a file imports: static imports, `export ... from`, dynamic `import()` and `import("x").T` types. */
function importsOf(path: string, text: string): Import[] {
  const sf = parse(path, text);
  const found: Import[] = [];
  walk(sf, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined;
      const typeOnly = !!clause && (clause.phaseModifier === ts.SyntaxKind.TypeKeyword || (!clause.name && !!named && named.length > 0 && named.every((e) => e.isTypeOnly)));
      const names = named ? named.map((e) => (e.propertyName ?? e.name).text) : [];
      found.push({ spec: node.moduleSpecifier.text, line: lineOf(sf, node), typeOnly, names });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ spec: node.moduleSpecifier.text, line: lineOf(sf, node), typeOnly: node.isTypeOnly, names: [] });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      found.push({ spec: node.arguments[0].text, line: lineOf(sf, node), typeOnly: false, names: [] });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.push({ spec: node.argument.literal.text, line: lineOf(sf, node), typeOnly: true, names: [] });
    }
  });
  return found;
}

/** Every piece of literal text in a file: string literals, the fixed parts of template literals, and JSX text. */
function literalsOf(path: string, text: string): Array<{ line: number; text: string }> {
  const sf = parse(path, text);
  const found: Array<{ line: number; text: string }> = [];
  walk(sf, (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      found.push({ line: lineOf(sf, node), text: node.text });
    }
  });
  return found;
}

/** Runs `check` over every file and returns `path:line` for each offence, or `path` for a file-level one. */
function scan(paths: string[], check: (path: string, text: string) => number[]): string[] {
  return paths.flatMap((path) => check(path, read(path)).map((line) => (line > 0 ? `${path}:${line}` : path)));
}

// --- Code documentation ---------------------------------------------------------------------------------------------

/** 0 (the file) when the first line after an optional shebang is not a comment. */
const headerless = (_path: string, text: string): number[] => {
  const lines = text.split("\n");
  const first = lines[0]?.startsWith("#!") ? lines[1] : lines[0];
  return /^\s*(\/\/|\/\*)/.test(first ?? "") ? [] : [0];
};

test("the header check fires on a file that opens with code and passes one that opens with a comment, after a shebang too", () => {
  assert.deepEqual(headerless("a.ts", 'import x from "y";\n// late comment\n'), [0]);
  assert.deepEqual(headerless("a.ts", "\n// a blank first line is no header\n"), [0]);
  assert.deepEqual(headerless("a.ts", "// What this module is for.\nexport const x = 1;\n"), []);
  assert.deepEqual(headerless("a.ts", "#!/usr/bin/env node\n/** What this script is for. */\n"), []);
});

test("every source file opens with a header comment: its first line, after a shebang, is a comment", () => {
  const sources = ["packages", "scripts", "test"].flatMap((d) => files(d, CODE));
  assert.ok(sources.length >= 200, `found ${sources.length}`);
  assert.deepEqual(scan(sources, headerless), [], "open the file with a comment that says what the module is for and why");
});

// --- Testing ----------------------------------------------------------------------------------------------------------

const calls = (path: string, text: string, name: string) => {
  let found = false;
  walk(parse(path, text), (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found = true;
  });
  return found;
};

/**
 * For a file that calls `runWorkflow(`: 0 (the file) unless the file or a local module it imports (recursively) isolates the
 * home: imports `./isolate-home.js` or sets `WF_HOME`. The throwaway home holds the runs index and the metrics database, so
 * that is what keeps a test off the developer's. `WF_METRICS = "off"` is not required: the tests of the metrics need them on.
 * `load` reads a local import.
 */
function unisolated(path: string, text: string, load: (from: string, spec: string) => { path: string; text: string } | undefined): number[] {
  if (!calls(path, text, "runWorkflow")) return [];
  const seen = new Set<string>();
  let home = false;
  const visit = (p: string, t: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    if (/process\.env\.WF_HOME\s*=[^=]/.test(t)) home = true;
    for (const i of importsOf(p, t)) {
      if (!i.spec.startsWith("./")) continue;
      if (i.spec === "./isolate-home.js") home = true;
      const next = load(p, i.spec);
      if (next) visit(next.path, next.text);
    }
  };
  visit(path, text);
  return home ? [] : [0];
}

/** Reads a local `./x.js` import as the `x.ts` beside the importer. */
const loadLocal = (from: string, spec: string) => {
  const path = posix(join(dirname(from), spec.replace(/\.js$/, ".ts")));
  return existsSync(join(ROOT, path)) ? { path, text: read(path) } : undefined;
};

test("the isolation check fires on a workflow test with no throwaway home, metrics off or not, and follows a fixture's imports", () => {
  const fixture = { path: "t/fixture.ts", text: 'process.env.WF_METRICS = "off";\nimport "./isolate-home.js";\n' };
  const load = (_from: string, spec: string) => (spec === "./fixture.js" ? fixture : undefined);
  const run = 'import { runWorkflow } from "../src/runtime/engine.js";\nawait runWorkflow(def, {}, { cwd });\n';
  assert.deepEqual(unisolated("t/a.test.ts", run, load), [0]);
  assert.deepEqual(unisolated("t/a.test.ts", 'process.env.WF_METRICS = "off";\n' + run, load), [0]);
  assert.deepEqual(unisolated("t/a.test.ts", 'import "./isolate-home.js";\n' + run, load), []);
  assert.deepEqual(unisolated("t/a.test.ts", 'process.env.WF_HOME = mkdtempSync(prefix);\n' + run, load), []);
  assert.deepEqual(unisolated("t/a.test.ts", 'import { setup } from "./fixture.js";\n' + run, load), []);
  assert.deepEqual(unisolated("t/b.test.ts", 'import { x } from "./helper.js";\n', load), [], "a file that runs no workflow");
});

test("every test that runs a workflow isolates the home, itself or through a fixture, so it never writes the developer's runs index or metrics", () => {
  const offenders = scan(
    TEST_CODE.filter((f) => f.endsWith(".test.ts")),
    (path, text) => unisolated(path, text, loadLocal),
  );
  assert.deepEqual(offenders, [], 'import "./isolate-home.js" before the modules under test, or import a fixture that does');
});

/** Lines importing jsdom or a wrapper of it. */
const jsdomImports = (path: string, text: string) => importsOf(path, text).filter((i) => /^(jsdom|global-jsdom|jsdom-global)(\/|$)/.test(i.spec)).map((i) => i.line);
/** The jsdom packages a manifest declares, in any dependency group. */
const jsdomDependencies = (manifest: Record<string, Record<string, string> | unknown>) =>
  ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap((group) =>
    Object.keys((manifest[group] as Record<string, string> | undefined) ?? {}).filter((name) => /jsdom/.test(name)),
  );

test("the jsdom check fires on an import and on a declared dependency, and passes static markup rendering", () => {
  assert.deepEqual(jsdomImports("a.test.ts", 'import { JSDOM } from "jsdom";\nimport "global-jsdom/register";\n'), [1, 2]);
  assert.deepEqual(jsdomImports("a.test.ts", 'import { renderToStaticMarkup } from "react-dom/server";\n'), []);
  assert.deepEqual(jsdomDependencies({ devDependencies: { jsdom: "^25.0.0" } }), ["jsdom"]);
  assert.deepEqual(jsdomDependencies({ dependencies: { react: "^19.0.0" } }), []);
});

test("no test environment uses jsdom: dashboard components are tested as static markup", () => {
  const manifests = ["package.json", ...PACKAGES.map((p) => `${p}/package.json`)];
  for (const m of manifests) assert.deepEqual(jsdomDependencies(JSON.parse(read(m))), [], `${m} declares jsdom`);
  assert.deepEqual(scan(ALL_CODE, jsdomImports), []);
});

/** Lines importing `describe`/`it`/`suite`/`mock` from node:test, or the loose `node:assert`. */
const nestedOrLoose = (path: string, text: string) =>
  importsOf(path, text)
    .filter((i) => (i.spec === "node:test" && i.names.some((n) => ["describe", "it", "suite", "mock"].includes(n))) || i.spec === "node:assert" || i.spec === "assert")
    .map((i) => i.line);

test("the flat-test check fires on describe, it, mock and loose assert, and passes test with strict assert", () => {
  const offender = 'import { describe, it } from "node:test";\nimport { mock } from "node:test";\nimport assert from "node:assert";\n';
  assert.deepEqual(nestedOrLoose("a.test.ts", offender), [1, 2, 3]);
  assert.deepEqual(nestedOrLoose("a.test.ts", 'import assert from "node:assert/strict";\nimport { afterEach, test } from "node:test";\n'), []);
});

test("every test is a flat test() with strict asserts: no describe, it or mock from node:test, no loose node:assert", () => {
  assert.deepEqual(scan(TEST_CODE, nestedOrLoose), [], 'use top-level test() and import assert from "node:assert/strict"');
});

const WALL_CLOCK_MARKER = /\/\/\s*wall-clock-ok:\s*\S.{4,}/;

/** True for `Date.now()`. */
const isDateNow = (node: ts.Node): boolean =>
  ts.isCallExpression(node) &&
  node.arguments.length === 0 &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === "Date" &&
  node.expression.name.text === "now";

/** True when `node` is, through arithmetic and parentheses only, an argument of `new Date(...)`: a timestamp being built. */
function buildsTimestamp(node: ts.Node): boolean {
  let at = node;
  while (at.parent && (ts.isBinaryExpression(at.parent) || ts.isParenthesizedExpression(at.parent))) at = at.parent;
  return !!at.parent && ts.isNewExpression(at.parent) && ts.isIdentifier(at.parent.expression) && at.parent.expression.text === "Date";
}

/**
 * Lines with a `Date.now()` that is not building a timestamp (`new Date(Date.now() - ms)`) and has no `// wall-clock-ok: <reason>`
 * on its line. Wording-keyed: a clock read spelled any other way (`new Date().getTime()`, an alias of `Date`) gets through.
 */
function wallClockMeasures(path: string, text: string): number[] {
  const sf = parse(path, text);
  const lines = text.split("\n");
  const found: number[] = [];
  walk(sf, (node) => {
    if (!isDateNow(node) || buildsTimestamp(node)) return;
    const line = lineOf(sf, node);
    if (!WALL_CLOCK_MARKER.test(lines[line - 1] ?? "")) found.push(line);
  });
  return found;
}

test("the elapsed-time check fires on Date.now() used to time something or to set a deadline, and passes performance.now(), a built timestamp and a marked line", () => {
  const sample = [
    "const startedAt = Date.now();", // 1: a start mark
    "assert.ok(Date.now() - startedAt < 2000);", // 2: an elapsed bound
    "for (const stop = Date.now() + 5000; Date.now() < stop; ) await sleep(10);", // 3: a deadline, twice
    "const t0 = performance.now();", // fine: monotonic
    "assert.ok(performance.now() - t0 < 2000);", // fine
    "const old = new Date(Date.now() - 5 * 60_000).toISOString();", // fine: a timestamp in the past
    "const when = new Date((Date.now() - ms));", // fine: parenthesised
    "const before = Date.now(); // wall-clock-ok: compared with a timestamp the run wrote", // fine: marked
    "const after = Date.now(); // wall-clock-ok:", // 9: a marker with no reason
  ].join("\n");
  assert.deepEqual(wallClockMeasures("a.test.ts", sample), [1, 2, 3, 3, 9]);
});

test("no test times anything with Date.now(): a wall clock that jumps (a WSL2 resync) fails a bound that held; use performance.now(), or mark a timestamp with `// wall-clock-ok: <reason>`", () => {
  assert.ok(TEST_CODE.length >= 100, `found ${TEST_CODE.length}`);
  assert.deepEqual(
    scan(TEST_CODE, wallClockMeasures),
    [],
    "time a bound or a deadline with performance.now() (monotonic); Date.now() is for building a timestamp (`new Date(Date.now() - ms)`), or for one a test compares with, or hands to, the code under test: end its line with `// wall-clock-ok: <reason>`",
  );
});

// --- TypeScript -------------------------------------------------------------------------------------------------------

const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith("_")));
/** Lines importing a Node built-in by its bare name. */
const barebuiltins = (path: string, text: string) =>
  importsOf(path, text)
    .filter((i) => BUILTINS.has(i.spec) || BUILTINS.has(i.spec.split("/")[0]!) && !i.spec.startsWith("@"))
    .map((i) => i.line);

test("the node: prefix check fires on bare built-in names, dynamic and re-exported too, and passes node: and packages", () => {
  const offender = 'import { readFileSync } from "fs";\nimport { join } from "path";\nexport { x } from "fs/promises";\nconst cp = await import("child_process");\n';
  assert.deepEqual(barebuiltins("a.ts", offender), [1, 2, 3, 4]);
  assert.deepEqual(barebuiltins("a.ts", 'import { readFileSync } from "node:fs";\nimport ts from "typescript";\nimport { x } from "./path.js";\n'), []);
});

test("every Node built-in is imported with the node: prefix", () => {
  assert.deepEqual(scan(ALL_CODE, barebuiltins), [], 'write "node:fs", never "fs"');
});

/** Lines of an import whose every name carries an inline `type`: under verbatimModuleSyntax it still loads the module. */
function inlineTypeOnly(path: string, text: string): number[] {
  const sf = parse(path, text);
  return sf.statements.flatMap((s) => {
    const clause = ts.isImportDeclaration(s) ? s.importClause : undefined;
    if (!clause || clause.phaseModifier === ts.SyntaxKind.TypeKeyword || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return [];
    const names = clause.namedBindings.elements;
    return names.length > 0 && names.every((e) => e.isTypeOnly) ? [lineOf(sf, s)] : [];
  });
}

test("the type import check fires on an import of types only through inline modifiers, and passes import type and mixed imports", () => {
  assert.deepEqual(inlineTypeOnly("a.ts", 'import { type A, type B } from "./a.js";\n'), [1]);
  assert.deepEqual(inlineTypeOnly("a.ts", 'import type { A, B } from "./a.js";\nimport { type C, d } from "./c.js";\n'), []);
});

test("an import of types only is written `import type`, so it never loads the module", () => {
  assert.deepEqual(scan(ALL_CODE, inlineTypeOnly), [], "write import type { ... } when every name is a type");
});

/** The tsconfig every typecheck extends. */
const TSCONFIG = "packages/runtime/tsconfig.json";

test("the shared tsconfig keeps verbatimModuleSyntax on, so tsc rejects a type imported without `type`", () => {
  // tsc proves the flag: with it on, `import { WorkflowEvent } from ".../events.js"` used only as a type fails with TS1484.
  assert.equal(JSON.parse(read(TSCONFIG)).compilerOptions.verbatimModuleSyntax, true);
  for (const config of ["tsconfig.json", "packages/dashboard/tsconfig.json", "packages/dashboard/app/tsconfig.json", "packages/dashboard/run-view/tsconfig.json"]) {
    const options = JSON.parse(read(config)).compilerOptions ?? {};
    assert.notEqual(options.verbatimModuleSyntax, false, `${config} turns verbatimModuleSyntax off`);
  }
});

/** True when a default-exported expression is a workflow definition: `defineWorkflow(...)` or an object with `meta`. */
const isWorkflow = (e: ts.Expression): boolean =>
  (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "defineWorkflow") ||
  (ts.isObjectLiteralExpression(e) && e.properties.some((p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === "meta")) ||
  ((ts.isSatisfiesExpression(e) || ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) && isWorkflow(e.expression));

/** Lines with a default export that is not a workflow definition; for a PascalCase .tsx, 0 when it exports no function of its name. */
function badExports(path: string, text: string): number[] {
  const sf = parse(path, text);
  const found: number[] = [];
  const exported = new Set<string>();
  for (const s of sf.statements) {
    const modifiers = ts.canHaveModifiers(s) ? ts.getModifiers(s) ?? [] : [];
    const isExport = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isExportAssignment(s) && !s.isExportEquals && !isWorkflow(s.expression)) found.push(lineOf(sf, s));
    if (isExport && modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) found.push(lineOf(sf, s));
    if (isExport && ts.isFunctionDeclaration(s) && s.name) exported.add(s.name.text);
    if (isExport && ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) exported.add(d.name.text);
  }
  const name = basename(path).replace(/\.tsx$/, "");
  if (path.endsWith(".tsx") && /^[A-Z]/.test(name) && !exported.has(name)) found.push(0);
  return found;
}

test("the export check fires on a default export that is not a workflow and on a component file not named after its component", () => {
  assert.deepEqual(badExports("a.ts", "export default function helper() {}\nconst x = 1;\nexport default x;\n"), [1, 3]);
  assert.deepEqual(badExports("app/Panel.tsx", "export function Other() { return null; }\n"), [0]);
  assert.deepEqual(badExports("w.ts", 'export default defineWorkflow({ meta: { name: "w" } });\n'), []);
  assert.deepEqual(badExports("w.ts", 'export default { meta: { name: "fixture" }, async run() {} };\n'), []);
  assert.deepEqual(badExports("app/Panel.tsx", "export function Panel() { return null; }\nexport function Row() { return null; }\n"), []);
});

test("exports are named: the one default export is a workflow definition, and a PascalCase component file exports its component", () => {
  assert.deepEqual(scan(ALL_CODE, badExports), [], "use a named export; only a workflow module default-exports its defineWorkflow(...)");
});

// --- Architecture -----------------------------------------------------------------------------------------------------

const BACKENDS = ["packages/runtime/src/runtime/backend.ts", "packages/runtime/src/runtime/backend-cloud.ts"];
/** Besides the backends, the files that may load the SDK as a value: the CLI and the doctor (`Cursor.auth`, `Cursor.models`). */
const SDK_VALUE_IMPORTERS = [...BACKENDS, "packages/runtime/src/cli.ts", "packages/runtime/src/doctor.ts"];

/** Lines calling `Agent.create`/`Agent.resume`, or importing `@cursor/sdk` as a value at load time, outside the files allowed to. */
function sdkOutsideBackends(path: string, text: string): number[] {
  const sf = parse(path, text);
  const found: number[] = [];
  if (!BACKENDS.includes(path)) {
    walk(sf, (node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Agent" && ["create", "resume"].includes(node.name.text)) {
        found.push(lineOf(sf, node));
      }
    });
  }
  if (!SDK_VALUE_IMPORTERS.includes(path)) {
    // A lazy `await import("@cursor/sdk")` (Agent.getUsage, Agent.listRuns) is allowed: only a static value import is flagged.
    for (const s of sf.statements) {
      if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === "@cursor/sdk") {
        const i = importsOf(path, s.getText(sf))[0]!;
        if (!i.typeOnly) found.push(lineOf(sf, s));
      }
    }
  }
  return found.sort((a, b) => a - b);
}

test("the SDK check fires on Agent.create or a value import outside the backends, and passes a type import or a lazy import", () => {
  const offender = 'import { Agent } from "@cursor/sdk";\nconst a = await Agent.create({});\nawait Agent.resume(id);\n';
  assert.deepEqual(sdkOutsideBackends("packages/runtime/src/runtime/engine.ts", offender), [1, 2, 3]);
  assert.deepEqual(sdkOutsideBackends("packages/runtime/src/runtime/backend.ts", 'import { Agent } from "@cursor/sdk";\nAgent.create({});\n'), []);
  const legit = 'import type { ModelSelection } from "@cursor/sdk";\nconst { Agent } = await import("@cursor/sdk");\nawait Agent.getUsage();\n';
  assert.deepEqual(sdkOutsideBackends("packages/runtime/src/observability/queries.ts", legit), []);
});

test("only the AgentBackend adapters create or resume an agent, and only they, the CLI and the doctor load the SDK as a value", () => {
  assert.deepEqual(scan(PRODUCT_CODE, sdkOutsideBackends), [], "reach an agent through AgentBackend.run; elsewhere import SDK types with `import type`");
});

// --- Cursor SDK and agent backends ------------------------------------------------------------------------------------

const exactVersion = (range: string) => /^\d+\.\d+\.\d+$/.test(range);

test("the pin check accepts only an exact version", () => {
  assert.equal(exactVersion("1.3.1"), true);
  for (const loose of ["^1.3.1", "~1.3.1", ">=1.3.1", "1.x", "*", "latest"]) assert.equal(exactVersion(loose), false, loose);
});

test("@cursor/sdk is pinned to an exact version, so the hand-written fake SDK never drifts from it silently", () => {
  const range = JSON.parse(read("packages/runtime/package.json")).dependencies["@cursor/sdk"];
  assert.ok(exactVersion(range), `@cursor/sdk is "${range}": pin it to an exact version, with no caret`);
});

// --- Persistence ------------------------------------------------------------------------------------------------------

const OBSERVABILITY = "packages/runtime/src/observability/";
const SQL = /^\s*(SELECT\s|INSERT\s+INTO\s|UPDATE\s+\w+\s+SET\s|DELETE\s+FROM\s|CREATE\s+(TABLE|VIEW|INDEX|TRIGGER)\s|DROP\s+(TABLE|VIEW|INDEX|TRIGGER)\s|ALTER\s+TABLE\s|PRAGMA\s)|^(BEGIN( IMMEDIATE)?|COMMIT|ROLLBACK);?$/;

/** Lines with SQL text, or (in product code) a `node:sqlite` import, outside the observability folder. */
function sqlOutsideObservability(path: string, text: string, product = true): number[] {
  if (path.startsWith(OBSERVABILITY)) return [];
  const sql = literalsOf(path, text).filter((l) => SQL.test(l.text)).map((l) => l.line);
  const sqlite = product ? importsOf(path, text).filter((i) => i.spec === "node:sqlite").map((i) => i.line) : [];
  return [...new Set([...sql, ...sqlite])].sort((a, b) => a - b);
}

test("the SQL check fires on a query or a node:sqlite import outside src/observability, and passes it inside and a command named exec", () => {
  const offender = 'const { DatabaseSync } = await import("node:sqlite");\ndb.prepare("SELECT id FROM runs WHERE id = ?");\ndb.exec(`BEGIN IMMEDIATE`);\n';
  assert.deepEqual(sqlOutsideObservability("packages/runtime/src/runtime/engine.ts", offender), [1, 2, 3]);
  assert.deepEqual(sqlOutsideObservability(`${OBSERVABILITY}queries.ts`, offender), []);
  assert.deepEqual(sqlOutsideObservability("packages/runtime/workflows/a.ts", 'await ctx.exec("git", ["status"]);\nconst s = "Select a model";\n'), []);
});

test("all SQL lives in packages/runtime/src/observability, and only that folder loads node:sqlite", () => {
  const offenders = [
    ...scan(PRODUCT_CODE, (p, t) => sqlOutsideObservability(p, t)),
    // Maintainer scripts may probe for node:sqlite (dash-fixtures checks the Node version), but write no SQL.
    ...scan(files("scripts", CODE), (p, t) => sqlOutsideObservability(p, t, false)),
  ];
  assert.deepEqual(offenders, [], "put the query in src/observability (schema.ts, recorder.ts or queries.ts)");
});

// --- MCP server and CLI -----------------------------------------------------------------------------------------------

/** Lines of an object literal with an `error` key that is not the argument of `fail(...)`. */
function errorOutsideFail(path: string, text: string): number[] {
  const sf = parse(path, text);
  const found: number[] = [];
  walk(sf, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return;
    if (!node.properties.some((p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === "error")) return;
    const parent = node.parent;
    const viaFail = ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === "fail";
    if (!viaFail) found.push(lineOf(sf, node));
  });
  return found;
}

test("the MCP failure check fires on an { error } answered through text() or returned bare, and passes fail({ error })", () => {
  assert.deepEqual(errorOutsideFail("m.ts", 'return text({ error: "job not found" });\nreturn { error };\n'), [1, 2]);
  assert.deepEqual(errorOutsideFail("m.ts", 'return fail({ error: "job not found" });\nreturn text({ jobId });\n'), []);
});

test("every MCP tool failure goes through fail(), which flags it isError", () => {
  assert.deepEqual(scan(["packages/runtime/src/mcp-server.ts"], errorOutsideFail), [], "return fail({ error: \"<sentence>\" })");
});

// --- Dashboard (React) and Dashboard CSS ------------------------------------------------------------------------------

const URL_HELPERS = ["packages/dashboard/app/format.ts", "packages/dashboard/run-view/location.ts"];
/** Lines writing a per-run path (`/runs/` or `/api/runs/`) by hand, outside the two helpers that build it. */
const handWrittenRunUrls = (path: string, text: string) =>
  URL_HELPERS.includes(path) ? [] : literalsOf(path, text).filter((l) => /\/runs\//.test(l.text)).map((l) => l.line);

test("the run URL check fires on a hand-written /runs/ or /api/runs/ path and passes the helpers and the list endpoint", () => {
  const offender = "const href = `/runs/${id}`;\nfetch(`/api/runs/${encodeURIComponent(id)}/events`);\n";
  assert.deepEqual(handWrittenRunUrls("packages/dashboard/app/RunsView.tsx", offender), [1, 2]);
  assert.deepEqual(handWrittenRunUrls("packages/dashboard/app/format.ts", offender), []);
  assert.deepEqual(handWrittenRunUrls("packages/dashboard/app/RunsView.tsx", 'usePoll("/api/runs");\nconst href = runHref(id);\n'), []);
});

test("browser code builds per-run URLs only through runHref and runApiPath", () => {
  assert.deepEqual(scan(BROWSER_CODE, handWrittenRunUrls), [], "use runHref(runId) (app/format.ts) or runApiPath(runId) (run-view/location.ts)");
});

/** Lines whose literal text or JSX text holds an en dash, the wrong glyph for a missing value. */
const enDashes = (path: string, text: string) => literalsOf(path, text).filter((l) => l.text.includes("\u2013")).map((l) => l.line);

test("the missing-value check fires on an en dash in a string or in JSX text, and passes the em dash", () => {
  assert.deepEqual(enDashes("a.tsx", 'const none = "\u2013";\nconst el = <span className="none">\u2013</span>;\n'), [1, 2]);
  assert.deepEqual(enDashes("a.tsx", 'const el = <span className="none">\u2014</span>;\n// 1\u20132px in a comment\n'), []);
});

test("browser code writes a missing value as an em dash, never an en dash", () => {
  assert.deepEqual(scan(BROWSER_CODE, enDashes), [], 'write "\u2014" (em dash) in a span with class "none"');
});

/** Lines with a JSX `style` attribute. */
function inlineStyles(path: string, text: string): number[] {
  const sf = parse(path, text);
  const found: number[] = [];
  walk(sf, (node) => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "style") found.push(lineOf(sf, node));
  });
  return found;
}

test("the inline style check fires on a style attribute and passes a class name", () => {
  assert.deepEqual(inlineStyles("a.tsx", "const el = <div style={{ width: 10 }} />;\n"), [1]);
  assert.deepEqual(inlineStyles("a.tsx", 'const el = <div className="pill" />;\n'), []);
});

test("the app page has no style= attribute: its CSP has no style-src-attr", () => {
  assert.deepEqual(scan(files("packages/dashboard/app", /\.tsx$/), inlineStyles), [], "style the element with a class in styles.css");
});

// --- Security ---------------------------------------------------------------------------------------------------------

const HTML_SINKS = new Set(["innerHTML", "outerHTML", "insertAdjacentHTML", "dangerouslySetInnerHTML"]);
/** Lines that use an HTML sink: assigning or reading innerHTML, insertAdjacentHTML, or React's dangerouslySetInnerHTML. */
function htmlSinks(path: string, text: string): number[] {
  const sf = parse(path, text);
  const found: number[] = [];
  walk(sf, (node) => {
    if (ts.isIdentifier(node) && HTML_SINKS.has(node.text)) found.push(lineOf(sf, node));
  });
  return [...new Set(found)];
}

test("the HTML sink check fires on innerHTML and dangerouslySetInnerHTML, and passes text nodes and comments", () => {
  assert.deepEqual(htmlSinks("a.tsx", "el.innerHTML = text;\nconst x = <div dangerouslySetInnerHTML={{ __html: text }} />;\n"), [1, 2]);
  assert.deepEqual(htmlSinks("a.tsx", "// never innerHTML here\nconst x = <pre>{text}</pre>;\nel.textContent = text;\n"), []);
});

test("the dashboard renders log and agent content as text: no innerHTML or dangerouslySetInnerHTML", () => {
  const dashboard = ["packages/dashboard/src", "packages/dashboard/app", "packages/dashboard/run-view"].flatMap((d) => files(d, /\.tsx?$/));
  assert.deepEqual(scan(dashboard, htmlSinks), [], "render the text as a React text node; escape it in server-built HTML");
});

// --- Workflow authoring -----------------------------------------------------------------------------------------------

const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
/** Lines of a `ctx.metric(...)` whose literal name is not snake_case (for a template, each fixed part is lowercase). */
function nonSnakeMetrics(path: string, text: string): number[] {
  const sf = parse(path, text);
  const found: number[] = [];
  walk(sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    if (node.expression.name.text !== "metric" || !ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== "ctx") return;
    const name = node.arguments[0];
    if (!name) return;
    const ok = ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)
      ? SNAKE.test(name.text)
      : ts.isTemplateExpression(name)
        ? /^[a-z][a-z0-9_]*$/.test(name.head.text) && name.templateSpans.every((s) => /^[a-z0-9_]*$/.test(s.literal.text))
        : true;
    if (!ok) found.push(lineOf(sf, node));
  });
  return found;
}

test("the metric name check fires on camelCase and kebab-case names and passes snake_case, templates included", () => {
  assert.deepEqual(nonSnakeMetrics("w.ts", 'ctx.metric("slicesPlanned", 1);\nctx.metric("slices-done", 1);\nctx.metric(`Review_${a}`, 1);\n'), [1, 2, 3]);
  assert.deepEqual(nonSnakeMetrics("w.ts", 'ctx.metric("slices_planned", 1);\nctx.metric(`review_${a}_findings`, 1);\nctx.log("camelCase");\n'), []);
});

test("every ctx.metric name in a workflow is snake_case", () => {
  const workflows = ["packages/runtime/workflows", ".agents/workflows", "scripts"].flatMap((d) => files(d, CODE));
  assert.deepEqual(scan(workflows, nonSnakeMetrics), [], "name the metric in snake_case, e.g. slices_planned");
});

// --- Maintainer scripts and Bash --------------------------------------------------------------------------------------

/** 0 (the file) when a shell script does not open with the env bash shebang or never sets -euo pipefail. */
const lax = (_path: string, text: string) => {
  const lines = text.split("\n");
  return lines[0] === "#!/usr/bin/env bash" && lines.some((l) => /^\s*set -euo pipefail\s*$/.test(l)) ? [] : [0];
};
/** Lines locating the script through `$0` instead of BASH_SOURCE. */
const dollarZero = (_path: string, text: string) =>
  text.split("\n").flatMap((l, i) => (/\b(dirname|realpath|readlink(\s+-f)?)\s+"?\$(\{0\}|0\b)/.test(l) ? [i + 1] : []));
/** Lines with a shellcheck disable directive that gives no reason after it. */
const unexplainedDisables = (_path: string, text: string) =>
  text.split("\n").flatMap((l, i) => (/#\s*shellcheck\s+disable=/.test(l) && !/#\s*shellcheck\s+disable=[\w,]+\s+#\s*\S.{4,}/.test(l) ? [i + 1] : []));

test("the shell checks fire on a lax script, on $0 and on a bare shellcheck disable, and pass the strict forms", () => {
  assert.deepEqual(lax("a.sh", "#!/bin/sh\nset -e\n"), [0]);
  assert.deepEqual(lax("a.sh", "#!/usr/bin/env bash\nmain() {\n  set -euo pipefail\n}\nmain \"$@\"\n"), []);
  assert.deepEqual(dollarZero("a.sh", 'cd "$(dirname "$0")/.."\nkit="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"\necho "usage: $0 <repo>"\n'), [1]);
  assert.deepEqual(unexplainedDisables("a.sh", "# shellcheck disable=SC2016\n# shellcheck disable=SC2016 # backticks are Markdown\n"), [1]);
});

test("every shell script starts strict, locates itself through BASH_SOURCE, and explains each shellcheck disable", () => {
  assert.ok(SHELL.length >= 5, `found ${SHELL.join(", ")}`);
  assert.deepEqual(scan(SHELL, lax), [], "open with #!/usr/bin/env bash and set -euo pipefail");
  assert.deepEqual(scan(SHELL, dollarZero), [], 'use "$(dirname "${BASH_SOURCE[0]}")", not $0');
  assert.deepEqual(scan(SHELL, unexplainedDisables), [], "put the reason on the same line: # shellcheck disable=SCnnnn # <why>");
});

// --- CI ---------------------------------------------------------------------------------------------------------------

/** 0 (the file) without a top-level `permissions: contents: read`, plus the lines that grant a write permission. */
const writableCi = (_path: string, text: string) => [
  ...(/^permissions:[ \t]*\n[ \t]+contents:[ \t]*read[ \t]*$/m.test(text) ? [] : [0]),
  ...text.split("\n").flatMap((l, i) => (/^\s*(permissions:\s*write-all|[\w-]+:\s*write)\s*$/.test(l) ? [i + 1] : [])),
];
/** Lines with a `uses:` that is not a first-party action pinned by major tag. */
const unpinnedActions = (_path: string, text: string) =>
  text.split("\n").flatMap((l, i) => {
    const uses = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(l);
    return uses && !/^actions\/[\w-]+@v\d+$/.test(uses[1]!) ? [i + 1] : [];
  });

test("the CI checks fire on a missing or writable permission and on a third-party or branch-pinned action", () => {
  assert.deepEqual(writableCi("ci.yml", "on: push\njobs:\n  t:\n    permissions:\n      pull-requests: write\n"), [0, 5]);
  assert.deepEqual(writableCi("ci.yml", "on: push\npermissions:\n  contents: read\njobs: {}\n"), []);
  assert.deepEqual(unpinnedActions("ci.yml", "      - uses: someone/action@v1\n      - uses: actions/checkout@main\n"), [1, 2]);
  assert.deepEqual(unpinnedActions("ci.yml", "      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n"), []);
});

test("CI reads the repository only, and uses first-party actions by major tag", () => {
  const workflows = files(".github/workflows", /\.ya?ml$/);
  assert.ok(workflows.length >= 1);
  assert.deepEqual(scan(workflows, writableCi), [], "set top-level permissions: contents: read and grant no write");
  assert.deepEqual(scan(workflows, unpinnedActions), [], "use actions/<name>@vN");
});

// --- The exemplars ----------------------------------------------------------------------------------------------------

/** Every `path:line` cited in code spans of a standards file, with the line of the file that cites it. */
const citations = (md: string) =>
  md.split("\n").flatMap((l, i) => [...l.matchAll(/`([\w./-]+\.[\w]+):(\d+)`/g)].map((m) => ({ at: i + 1, path: m[1]!, line: Number(m[2]) })));

/** Each citation whose file is gone, or whose cited line is past the end or blank. */
function brokenCitations(md: string, readFile: (path: string) => string | undefined): string[] {
  return citations(md).flatMap(({ at, path, line }) => {
    const text = readFile(path);
    if (text === undefined) return [`:${at} cites ${path}:${line}, and ${path} does not exist`];
    const cited = text.split("\n")[line - 1];
    return cited === undefined || cited.trim() === "" ? [`:${at} cites ${path}:${line}, which is ${cited === undefined ? "past the end" : "blank"}`] : [];
  });
}

test("the exemplar check fires on a missing file, a line past the end and a blank line, and passes a line with content", () => {
  const files = new Map([["a.ts", "// header\n\nexport const x = 1;\n"]]);
  const md = "- **Rule.** _See:_ `gone.ts:3`.\n- **Rule.** _See:_ `a.ts:9`, `a.ts:2`.\n- **Rule.** _See:_ `a.ts:3`.\n";
  assert.deepEqual(brokenCitations(md, (p) => files.get(p)), [
    ":1 cites gone.ts:3, and gone.ts does not exist",
    ":2 cites a.ts:9, which is past the end",
    ":2 cites a.ts:2, which is blank",
  ]);
});

test("every exemplar path:line that CODING_STANDARDS.md cites exists and is not blank", () => {
  const md = read("CODING_STANDARDS.md");
  assert.ok(citations(md).length >= 100, `found ${citations(md).length} citations`);
  const readFile = (path: string) => (existsSync(join(ROOT, path)) ? read(path) : undefined);
  assert.deepEqual(brokenCitations(md, readFile), [], "a refactor moved or deleted an exemplar: cite a line that still shows the rule");
});

