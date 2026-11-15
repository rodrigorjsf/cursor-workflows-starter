// Seam: the repository's own files, read as text or through the TypeScript parser, the way a reviewer reads them. Each
// check enforces one mechanical rule that CODING_STANDARDS.md names on an "Enforced by tooling" line, so the file keeps
// only the judgement. A check is a predicate over one file's text: a sample test proves it fires on an offender and stays
// silent on the legitimate case, and a second test runs it over the tree the rule governs. The last check reads
// CODING_STANDARDS.md itself: every exemplar it cites (a file plus a symbol, heading or key) must still resolve.
//
// Code-keyed: the TypeScript checks read the syntax tree, so comments never trip them; the shell, YAML and manifest checks
// read lines. A construct spelled in a way the predicate does not know (an alias of `ctx`, a computed import path) passes.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { parseMarkdown } from "../scripts/lib/markdown.js";

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
/** Every shell script: the maintainer scripts and the git hooks (extensionless, under .githooks/). */
const SHELL = [...files("scripts", /\.sh$/), ...files(".githooks", /^[\w-]+$/)];

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

/** 0 (the file) unless line 1 is `// Seam: <the seam, in words>`. A numbered `// Seam 1, ...` or any other opening is no header. */
const seamless = (_path: string, text: string): number[] => (/^\/\/ Seam: \S/.test(text) ? [] : [0]);

test("the seam header check fires on a numbered seam, a comment of another kind and a file that opens with code, and passes `// Seam: <name>`", () => {
  assert.deepEqual(seamless("a.test.ts", "// Seam 1, the run: the engine.\n"), [0]);
  assert.deepEqual(seamless("a.test.ts", "// Seam:\n"), [0], "a header with no seam named");
  assert.deepEqual(seamless("a.test.ts", "// The engine, offline.\n"), [0]);
  assert.deepEqual(seamless("a.test.ts", '// A comment first\n// Seam: the engine.\nimport "x";\n'), [0], "the header is line 1");
  assert.deepEqual(seamless("a.test.ts", 'import "x";\n'), [0]);
  assert.deepEqual(seamless("a.test.ts", "// Seam: the engine; the event log.\nimport \"x\";\n"), []);
});

test("every test file opens with `// Seam: <the seam, in words>` on line 1; a file that tests several seams names them on one line, `// Seam: a; b`", () => {
  const tests = ALL_CODE.filter((f) => f.endsWith(".test.ts"));
  assert.ok(tests.length >= 140, `found ${tests.length}`);
  assert.deepEqual(scan(tests, seamless), [], "open the file with `// Seam: <the interface the file asserts at, and what is real and what is a stand-in>`");
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

/** The built-ins one could import without a prefix. Node 24 also lists the ones that exist only as `node:<name>` (`node:test`), which are no offence. */
const bareBuiltinNames = (modules: readonly string[]) => new Set(modules.filter((m) => !m.startsWith("_") && !m.startsWith("node:")));
const BUILTINS = bareBuiltinNames(builtinModules);
/** Lines importing a Node built-in by its bare name. */
const barebuiltins = (path: string, text: string) =>
  importsOf(path, text)
    .filter((i) => BUILTINS.has(i.spec) || BUILTINS.has(i.spec.split("/")[0]!) && !i.spec.startsWith("@"))
    .map((i) => i.line);

test("the node: prefix check fires on bare built-in names, dynamic and re-exported too, and passes node: and packages", () => {
  const offender = 'import { readFileSync } from "fs";\nimport { join } from "path";\nexport { x } from "fs/promises";\nconst cp = await import("child_process");\n';
  assert.deepEqual(barebuiltins("a.ts", offender), [1, 2, 3, 4]);
  assert.deepEqual(barebuiltins("a.ts", 'import { readFileSync } from "node:fs";\nimport ts from "typescript";\nimport { x } from "./path.js";\n'), []);
  assert.deepEqual(barebuiltins("a.ts", 'import { test } from "node:test";\nimport { DatabaseSync } from "node:sqlite";\n'), []);
  assert.deepEqual([...bareBuiltinNames(["fs", "node:test", "node:sqlite", "_http_agent"])], ["fs"]);
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
  for (const config of ["tsconfig.json", "packages/dashboard/tsconfig.json", "packages/dashboard/app/tsconfig.json", "packages/dashboard/run-view/tsconfig.json", "test/tsconfig.json", "packages/runtime/test/tsconfig.json", "packages/dashboard/test/tsconfig.json"]) {
    const options = JSON.parse(read(config)).compilerOptions ?? {};
    assert.notEqual(options.verbatimModuleSyntax, false, `${config} turns verbatimModuleSyntax off`);
  }
});

test("`npm run typecheck` checks every test: each directory that holds tests has a tsconfig.json for all its files, and the script runs it", () => {
  const typecheck: string = JSON.parse(read("package.json")).scripts.typecheck;
  const dirs = ["test", ...PACKAGES.map((p) => `${p}/test`)].filter((dir) => existsSync(join(ROOT, dir)) && readdirSync(join(ROOT, dir)).some((f) => f.endsWith(".test.ts")));
  assert.ok(dirs.length >= 3, `test directories found: ${dirs.join(", ")}`);
  for (const dir of dirs) {
    const config = `${dir}/tsconfig.json`;
    assert.ok(existsSync(join(ROOT, config)), `${dir} has no tsconfig.json: its tests are never typechecked`);
    assert.deepEqual(JSON.parse(read(config)).include, ["./**/*.ts"], `${config} includes every file of ${dir}`);
    assert.ok(typecheck.split("&&").some((command) => command.trim() === `tsc --noEmit -p ${dir}`), `npm run typecheck does not run tsc --noEmit -p ${dir}`);
  }
});

/** The `type X = { ... }` the code keeps because only an alias will do: the file, the name, and why an interface does not. */
interface AllowedTypeLiteral {
  file: string;
  name: string;
  why: string;
}

/** Each `type X = { ... }` of a file: an object shape written as an alias of a type literal. A union, an intersection, a mapped or a utility type is no type literal. */
function typeLiteralAliases(path: string, text: string): Array<{ name: string; line: number }> {
  const sf = parse(path, text);
  const found: Array<{ name: string; line: number }> = [];
  walk(sf, (node) => {
    if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) found.push({ name: node.name.text, line: lineOf(sf, node) });
  });
  return found;
}

/** The lines of a file's type-literal aliases that no allowlist entry names. */
const unallowedTypeLiterals = (path: string, text: string, allowed: AllowedTypeLiteral[]): number[] =>
  typeLiteralAliases(path, text)
    .filter((alias) => !allowed.some((a) => a.file === path && a.name === alias.name))
    .map((alias) => alias.line);

test("the object shape check fires on an alias of a type literal, generic or exported or declared inside a function, and passes an interface, the aliases that compute a type and an allowlisted name", () => {
  const offender = "type A = { a: string };\nexport type B<T> = { b: T };\nfunction f() {\n  type C = { c: 1 };\n}\n";
  assert.deepEqual(unallowedTypeLiterals("a.ts", offender, []), [1, 2, 4]);
  const legit = [
    "interface A { a: string }",
    'type Mode = "a" | "b";',
    "type Reply = Ok | Failed;",
    "type Both = A & { extra: string };",
    "type Keys = { [K in keyof A]: boolean };",
    "type Partial2 = Partial<{ a: string }>;",
    "type Fn = (a: string) => void;",
  ].join("\n");
  assert.deepEqual(unallowedTypeLiterals("a.ts", legit, []), []);
  assert.deepEqual(unallowedTypeLiterals("a.ts", offender, [{ file: "a.ts", name: "B", why: "needs the alias" }]), [1, 4]);
  assert.deepEqual(unallowedTypeLiterals("b.ts", offender, [{ file: "a.ts", name: "B", why: "needs the alias" }]), [1, 2, 4], "an entry names its own file only");
});

/** The aliases of a type literal that stay. An interface has no implicit index signature, so it is not assignable to a `Record<string, unknown>`; a type literal is. */
const ALLOWED_TYPE_LITERALS: AllowedTypeLiteral[] = [
  {
    file: "packages/runtime/workflows/implement-issue.ts",
    name: "Settings",
    why: "the workflow's `meta.settings` is a `Record<string, unknown>`, and an interface is not assignable to one",
  },
];

test("an object shape is an interface: `type X = { ... }` is kept out unless the allowlist says why, and every allowlist entry still names an alias", () => {
  assert.deepEqual(
    scan(ALL_CODE, (path, text) => unallowedTypeLiterals(path, text, ALLOWED_TYPE_LITERALS)),
    [],
    "write `interface X { ... }`; keep `type` for unions, intersections, mapped and utility types, or allow the alias here with the reason an interface will not do",
  );
  const stale = ALLOWED_TYPE_LITERALS.filter((a) => !typeLiteralAliases(a.file, read(a.file)).some((alias) => alias.name === a.name));
  assert.deepEqual(stale.map((a) => `${a.file}: ${a.name}`), [], "the alias was removed or became an interface: delete the entry");
});

/** True when a default-exported expression is a workflow definition: `defineWorkflow(...)` or an object with `meta`. */
const isWorkflow = (e: ts.Expression): boolean =>
  (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "defineWorkflow") ||
  (ts.isObjectLiteralExpression(e) && e.properties.some((p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === "meta")) ||
  ((ts.isSatisfiesExpression(e) || ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) && isWorkflow(e.expression));

/** Lines with a default export that is not a workflow definition; for a PascalCase .tsx, 0 when it exports no function, constant or class of its name (an error boundary has to be a class). */
function badExports(path: string, text: string): number[] {
  const sf = parse(path, text);
  const found: number[] = [];
  const exported = new Set<string>();
  for (const s of sf.statements) {
    const modifiers = ts.canHaveModifiers(s) ? ts.getModifiers(s) ?? [] : [];
    const isExport = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isExportAssignment(s) && !s.isExportEquals && !isWorkflow(s.expression)) found.push(lineOf(sf, s));
    if (isExport && modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) found.push(lineOf(sf, s));
    if (isExport && (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) exported.add(s.name.text);
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
  assert.deepEqual(badExports("app/Panel.tsx", "export class Panel extends Component { render() { return null; } }\n"), [], "a class component: an error boundary cannot be a function");
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

// --- Error handling ---------------------------------------------------------------------------------------------------

/**
 * The two files that define `errorText`: the runtime's, and the browser pages' own (a page imports only types from the runtime,
 * so it cannot take the runtime's). Everything else calls one of them.
 */
const ERROR_TEXT_HELPERS = ["packages/runtime/src/runtime/error-text.ts", "packages/dashboard/app/error-text.ts"];

const unparenthesized = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unparenthesized(e.expression) : e);

/** Lines of `x instanceof Error ? x.message : String(...)`, spelled out by hand: the body of `errorText`. The tested value `x` is the one whose message is read. */
function inlineErrorText(path: string, text: string): number[] {
  if (ERROR_TEXT_HELPERS.includes(path)) return [];
  const sf = parse(path, text);
  const found: number[] = [];
  walk(sf, (node) => {
    if (!ts.isConditionalExpression(node)) return;
    const test = unparenthesized(node.condition);
    const message = unparenthesized(node.whenTrue);
    const fallback = unparenthesized(node.whenFalse);
    if (!ts.isBinaryExpression(test) || test.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword) return;
    if (!ts.isIdentifier(test.right) || test.right.text !== "Error") return;
    if (!ts.isPropertyAccessExpression(message) || message.name.text !== "message") return;
    if (!ts.isCallExpression(fallback) || !ts.isIdentifier(fallback.expression) || fallback.expression.text !== "String" || fallback.arguments.length !== 1) return;
    if (message.expression.getText(sf) === test.left.getText(sf)) found.push(lineOf(sf, node));
  });
  return found;
}

test("the errorText check fires on the inline conversion, whatever the value or the layout, and passes errorText, other fallbacks and the helpers' own body", () => {
  const offender = [
    "const a = err instanceof Error ? err.message : String(err);",
    "const b = `x: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`;",
    "const c = (e instanceof Error)",
    "  ? e.message",
    "  : String(e);",
    "const d = err instanceof Error ? err.message : String(other);",
  ].join("\n");
  assert.deepEqual(inlineErrorText("a.ts", offender), [1, 2, 3, 6]);
  const legit = [
    "const a = errorText(err);",
    'const b = err instanceof Error ? err.message : "unknown";',
    "const c = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);",
    "const d = err instanceof Error ? other.message : String(err);",
    "const e = err instanceof TypeError ? err.message : String(err);",
    '// err instanceof Error ? err.message : String(err)',
    'const f = "err instanceof Error ? err.message : String(err)";',
  ].join("\n");
  assert.deepEqual(inlineErrorText("a.ts", legit), []);
  assert.deepEqual(inlineErrorText(ERROR_TEXT_HELPERS[0]!, offender), [], "the helper's own body");
});

test("a caught value becomes text through errorText: no inline `x instanceof Error ? x.message : String(x)` outside the two helpers", () => {
  for (const helper of ERROR_TEXT_HELPERS) assert.match(read(helper), /export const errorText = /, `${helper} defines errorText`);
  assert.deepEqual(scan(ALL_CODE, inlineErrorText), [], "import errorText (packages/runtime/src/runtime/error-text.ts; packages/dashboard/app/error-text.ts in the browser pages) and call errorText(err)");
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

/** Lines of a `registerTool` call whose config has no `inputSchema` that is a strict object: `z.strictObject(...)` or `<schema>.strict()`. */
function lenientToolSchemas(path: string, text: string): number[] {
  const sf = parse(path, text);
  const found: number[] = [];
  const isStrict = (schema: ts.Expression) =>
    ts.isCallExpression(schema) && ts.isPropertyAccessExpression(schema.expression) && ["strictObject", "strict"].includes(schema.expression.name.text);
  walk(sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "registerTool") return;
    const config = node.arguments[1];
    const schema = config && ts.isObjectLiteralExpression(config) ? config.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "inputSchema") : undefined;
    if (!schema || !ts.isPropertyAssignment(schema) || !isStrict(schema.initializer)) found.push(lineOf(sf, node));
  });
  return found;
}

test("the strict tool schema check fires on a missing schema, a raw shape and z.object, and passes z.strictObject and .strict()", () => {
  const offender = [
    'server.registerTool("a", { description: "d" }, async () => text({}));',
    'server.registerTool("b", { inputSchema: { jobId: z.string() } }, async () => text({}));',
    'server.registerTool("c", { inputSchema: z.object({ jobId: z.string() }) }, async () => text({}));',
    "server.registerTool(\"d\", { inputSchema }, async () => text({}));",
  ].join("\n");
  assert.deepEqual(lenientToolSchemas("m.ts", offender), [1, 2, 3, 4]);
  const strict = [
    'server.registerTool("a", { inputSchema: z.strictObject({}) }, async () => text({}));',
    'server.registerTool("b", { description: "d", inputSchema: z.object({ jobId: z.string() }).strict() }, async () => text({}));',
  ].join("\n");
  assert.deepEqual(lenientToolSchemas("m.ts", strict), []);
});

test("every tool of the MCP server has a strict input schema, so that an unknown argument is refused instead of dropped", () => {
  const server = "packages/runtime/src/mcp-server.ts";
  assert.match(read(server), /\.registerTool\(/, "the check reads the file that registers the tools");
  assert.deepEqual(scan([server], lenientToolSchemas), [], "give the tool `inputSchema: z.strictObject({ ... })`: zod 4's z.object strips an unknown key");
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

/** Lines of `new EventSource(...)` in a file that does not import `batcher` from `batch.js`, which is what makes a burst of events one render. */
function unbatchedStreams(path: string, text: string): number[] {
  const sf = parse(path, text);
  const batches = importsOf(path, text).some((i) => /(^|\/)batch\.js$/.test(i.spec) && !i.typeOnly && i.names.includes("batcher"));
  const found: number[] = [];
  if (!batches) {
    walk(sf, (node) => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "EventSource") found.push(lineOf(sf, node));
    });
  }
  return found;
}

test("the SSE check fires on a module that opens an EventSource without importing batcher, and passes one that does and one that opens none", () => {
  const open = "const source = new EventSource(url);\nsource.onmessage = (e) => setState(e.data);\n";
  assert.deepEqual(unbatchedStreams("run-view/a.ts", open), [1]);
  assert.deepEqual(unbatchedStreams("run-view/a.ts", 'import type { batcher } from "./batch.js";\n' + open), [2], "a type-only import loads nothing");
  assert.deepEqual(unbatchedStreams("run-view/a.ts", 'import { BATCH_MS } from "./batch.js";\n' + open), [2], "batch.js, but not batcher");
  assert.deepEqual(unbatchedStreams("run-view/a.ts", 'import { batcher } from "./batch.js";\n' + open), []);
  assert.deepEqual(unbatchedStreams("app/a.ts", 'import { batcher } from "../run-view/batch.js";\n' + open), []);
  assert.deepEqual(unbatchedStreams("run-view/a.ts", "// new EventSource(url) is opened in use-run-events.ts\nlet source: EventSource | undefined;\n"), []);
});

test("every browser module that opens an EventSource applies its messages through batcher, so a burst of events is one render", () => {
  assert.ok(BROWSER_CODE.some((f) => readFileSync(join(ROOT, f), "utf8").includes("new EventSource")), "the check reads the modules that open a stream");
  assert.deepEqual(scan(BROWSER_CODE, unbatchedStreams), [], 'import { batcher } from "./batch.js" (packages/dashboard/run-view/batch.ts) and deliver the stream\'s messages through it');
});

interface CssDeclaration {
  line: number;
  /** The rule the declaration sits in: its selector list, or the prelude of an at-rule that holds declarations. */
  rule: string;
  /** The at-rule preludes around the rule, outermost first: `@media (prefers-reduced-motion: reduce)`. */
  within: string[];
  property: string;
  /** The value, without `!important`. */
  value: string;
}

/** Every declaration of a stylesheet, comments skipped. A `;`, `{` or `}` inside a string or a parenthesis does not split. */
function cssDeclarations(css: string): CssDeclaration[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const found: CssDeclaration[] = [];
  const preludes: string[] = [];
  let buffer = "";
  let bufferLine = 1;
  let line = 1;
  let parens = 0;
  let quote = "";
  const flush = () => {
    const declaration = buffer.trim();
    buffer = "";
    const colon = declaration.indexOf(":");
    if (!declaration || declaration.startsWith("@") || colon < 1) return;
    found.push({
      line: bufferLine,
      rule: preludes.at(-1) ?? "",
      within: preludes.slice(0, -1).filter((p) => p.startsWith("@")),
      property: declaration.slice(0, colon).trim().toLowerCase(),
      value: declaration.slice(colon + 1).replace(/\s*!important\s*$/, "").trim(),
    });
  };
  for (const ch of text) {
    if (ch === "\n") line++;
    if (buffer.trim() === "" && ch.trim() !== "") bufferLine = line;
    if (quote) {
      if (ch === quote) quote = "";
      buffer += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buffer += ch;
    } else if (ch === "(") {
      parens++;
      buffer += ch;
    } else if (ch === ")") {
      parens--;
      buffer += ch;
    } else if (parens === 0 && ch === "{") {
      preludes.push(buffer.trim().replace(/\s+/g, " "));
      buffer = "";
    } else if (parens === 0 && ch === "}") {
      flush();
      preludes.pop();
    } else if (parens === 0 && ch === ";") {
      flush();
    } else {
      buffer += ch;
    }
  }
  return found;
}

test("the stylesheet reader splits declarations at the rule they sit in, through comments, strings, parentheses and nested at-rules", () => {
  const css = [
    "/* a { padding: 99px; } */",
    ".a, .b { padding: 4px 8px; content: \";}\"; margin: calc(1px + var(--x, 2px)) }",
    "@media (max-width: 600px) {",
    "  .c { gap: 0 !important; }",
    "}",
    "@import url(x.css);",
  ].join("\n");
  assert.deepEqual(cssDeclarations(css), [
    { line: 2, rule: ".a, .b", within: [], property: "padding", value: "4px 8px" },
    { line: 2, rule: ".a, .b", within: [], property: "content", value: '";}"' },
    { line: 2, rule: ".a, .b", within: [], property: "margin", value: "calc(1px + var(--x, 2px))" },
    { line: 4, rule: ".c", within: ["@media (max-width: 600px)"], property: "gap", value: "0" },
  ]);
});

// --- Dashboard CSS ---

/** The sizes the stylesheets space, set and round by: padding, margin, gap, font-size and border-radius, longhands included. */
const SIZE_PROPERTY = /^(?:(?:padding|margin)(?:-[a-z-]+)?|(?:row-|column-)?gap|font-size|border(?:-[a-z]+)*-radius)$/;
/** `text` split at the characters `isSeparator` accepts that sit outside parentheses (`calc(1px + 2px)` and `:is(a, b)` stay whole); empty parts are dropped. */
const splitOutsideParens = (text: string, isSeparator: (ch: string) => boolean): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let part = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && isSeparator(ch)) {
      parts.push(part.trim());
      part = "";
    } else part += ch;
  }
  return [...parts, part.trim()].filter(Boolean);
};
/** The parts of a value, split at the spaces outside parentheses. */
const valueParts = (value: string): string[] => splitOutsideParens(value, (ch) => ch.trim() === "");
/** A length that is no token: a number with a unit, other than a 1 or 2px hairline or offset, or a share of the parent or of the viewport (`%`, `vh`, `vw`). Zero has no unit here. */
const offScaleLengths = (text: string): string[] =>
  (text.replace(/var\(--[\w-]+(?:\s*,[^)]*)?\)/g, "").match(/-?\d*\.?\d+[a-z%]+/gi) ?? []).filter((length) => !/^-?[12]px$/.test(length) && !/(%|vh|vw)$/.test(length));

/** Lines of the padding, margin, gap, font-size and border-radius declarations that set a size by hand instead of a token, `0`, a share of the parent or the viewport, or a 1 or 2px hairline. */
function offScaleSizes(_path: string, text: string): number[] {
  const lines = cssDeclarations(text)
    .filter((d) => SIZE_PROPERTY.test(d.property) && valueParts(d.value).some((part) => !part.startsWith("var(") && offScaleLengths(part).length > 0))
    .map((d) => d.line);
  return [...new Set(lines)];
}

test("the size token check fires on a literal size in padding, margin, gap, font-size or border-radius, and passes tokens, zero, hairlines, percentages and other properties", () => {
  const css = [
    ".a { padding: 6px var(--space-2); }", // 1
    ".b { gap: var(--space-1) 10px; }", // 2
    ".c { font-size: 11px; margin-bottom: 0.5rem; }", // 3 (two declarations, one line)
    ".d { border-top-left-radius: 8px; }", // 4
    ".e { padding: 0 var(--space-3) 2px; margin-top: -1px; border-radius: 50%; gap: 0; font-size: var(--text-xs); }",
    ".f { margin: 0 calc(-1 * var(--space-4)); width: 14px; height: 14px; min-height: 32px; border: 2px solid red; }",
    ".g { padding: var(--space-1, 4px); scroll-padding: 0 12px; margin: 15vh auto 0; }",
    "@media (max-width: 600px) { .h { padding: 20px; } }", // 8
  ].join("\n");
  assert.deepEqual(offScaleSizes("a.css", css), [1, 2, 3, 4, 8]);
});

/** The stylesheets of the two dashboard pages. */
const DASHBOARD_CSS = ["packages/dashboard/app", "packages/dashboard/run-view"].flatMap((d) => files(d, /\.css$/));

test("the dashboard stylesheets take every padding, margin, gap, font size and corner radius from the token scales", () => {
  assert.ok(DASHBOARD_CSS.length >= 3, `found ${DASHBOARD_CSS.join(", ")}`);
  assert.deepEqual(scan(DASHBOARD_CSS, offScaleSizes), [], "use --space-1…6, --text-xs…2xl or --radius-* (app/tokens.css); a literal stays only as 0, a percentage or a 1 or 2px hairline");
});

/** The selectors of a rule's list, split at the commas outside parentheses. */
const selectorList = (rule: string): string[] => splitOutsideParens(rule, (ch) => ch === ",");

const REDUCED_MOTION = /^@media\s+\(prefers-reduced-motion:\s*reduce\)$/;
/** `animation` for `animation` and its longhands, `transition` for `transition` and its longhands, otherwise undefined. */
const motionOf = (property: string): "animation" | "transition" | undefined => (/^animation(-|$)/.test(property) ? "animation" : /^transition(-|$)/.test(property) ? "transition" : undefined);

/**
 * Lines of the declarations that set an `animation` or a `transition` for a selector the same file does not set to `none` of
 * that kind under `@media (prefers-reduced-motion: reduce)`. A selector is compared as written, one by one of its list.
 */
function unresetMotion(_path: string, text: string): number[] {
  const declarations = cssDeclarations(text);
  const reset = new Set(
    declarations
      .filter((d) => d.within.some((w) => REDUCED_MOTION.test(w)) && d.value === "none" && motionOf(d.property))
      .flatMap((d) => selectorList(d.rule).map((selector) => `${motionOf(d.property)} ${selector}`)),
  );
  const lines = declarations
    .filter((d) => motionOf(d.property) && d.value !== "none" && !d.within.some((w) => REDUCED_MOTION.test(w) || w.startsWith("@keyframes")))
    .filter((d) => selectorList(d.rule).some((selector) => !reset.has(`${motionOf(d.property)} ${selector}`)))
    .map((d) => d.line);
  return [...new Set(lines)];
}

test("the reduced-motion check fires on an animation or a transition with no reset to none under prefers-reduced-motion in the same file, and passes the pairs", () => {
  const css = [
    ".a { animation: pulse 1s infinite; }", // 1: no reset
    ".b { transition: color 1s; }", // 2: reset is for the animation only
    ".c, .d { animation: spin 1s; }", // 3: .d has no reset
    ".e { transition-property: opacity; }", // 4: no reset
    "@media (prefers-reduced-motion: reduce) { .b { animation: none; } .c { animation: none; } .x { transition: none; } }",
    ".f { animation: pulse 1s; }", // 6: its reset is in a media query of another kind
    "@media (max-width: 600px) { .f { animation: none; } }",
    ".g, .h { animation: pulse 1s; transition: opacity 1s; }",
    "@media (prefers-reduced-motion: reduce) { .g, .h { animation: none; transition: none; } }",
    ".i { animation: none; }",
    "@keyframes pulse { 50% { opacity: 0.5; } }",
  ].join("\n");
  assert.deepEqual(unresetMotion("a.css", css), [1, 2, 3, 4, 6]);
  assert.deepEqual(unresetMotion("a.css", ".a { animation: spin 1s; }\n@media (prefers-reduced-motion: reduce) { .a { animation: none; } }\n"), []);
});

test("every animation and transition of the dashboard stylesheets is reset to none under prefers-reduced-motion, in the file that sets it", () => {
  assert.ok(DASHBOARD_CSS.some((f) => /\banimation:/.test(read(f))), "the check reads a stylesheet that animates");
  assert.deepEqual(scan(DASHBOARD_CSS, unresetMotion), [], "add the selector to the `@media (prefers-reduced-motion: reduce)` block of the same file, set to `animation: none` or `transition: none`");
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

/** The one file of the workflows that may run `git push`: the helpers every other file calls (`push`, `pushOwned`, `deleteOwned`). */
const PUSH_HELPERS = "packages/runtime/workflows/implement-issue/commands.ts";
/** A call whose callee is one of these runs a command: `ctx.exec`, `Commands.exec`, `child_process`'s functions. */
const RUNS_A_COMMAND = /^(exec|execFile|execFileSync|execSync|spawn|spawnSync|runCommand)$/;
/** The `Commands` methods that run any CLI by name, which they take as an argument: `forgeRead("git", cwd, "push")`. */
const RUNS_A_NAMED_CLI = /^forgeRead(With|OrNothing)?$/;
/** Text that is a `git push` command line: `git push`, `git -C dir push`, inside a shell one-liner. */
const GIT_PUSH_LINE = /\bgit\b[^\n]*\bpush\b/;

/**
 * Lines of a workflow file that run `git push` itself instead of calling the helpers of `PUSH_HELPERS`: a call to a `git`, `gitRead` or
 * `gitIs` method with the argument `"push"`, a command call whose command is `git` with `"push"` among its arguments, a call of a
 * `Commands` method that runs a named CLI (`forgeRead`...) with both `"git"` and `"push"`, and a command call with a string that
 * is a `git ... push` command line (`bash -c "git push"`). Read from the syntax tree, so comments and log text
 * never trip it; a subcommand held in a variable passes.
 */
function directGitPush(path: string, text: string): number[] {
  if (posix(path) === PUSH_HELPERS) return [];
  const sf = parse(path, text);
  const found: number[] = [];
  walk(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : undefined;
    if (callee === undefined) return;
    const direct = node.arguments.flatMap((a) => (ts.isStringLiteralLike(a) ? [a.text] : []));
    const listed = node.arguments.flatMap((a) => (ts.isArrayLiteralExpression(a) ? a.elements.flatMap((e) => (ts.isStringLiteralLike(e) ? [e.text] : [])) : []));
    const pushes =
      (/^git(Read|Is)?$/.test(callee) && direct.includes("push")) ||
      (RUNS_A_COMMAND.test(callee) && direct[0] === "git" && listed.includes("push")) ||
      (RUNS_A_NAMED_CLI.test(callee) && direct.includes("git") && direct.includes("push")) ||
      (RUNS_A_COMMAND.test(callee) && [...direct, ...listed].some((s) => GIT_PUSH_LINE.test(s)));
    if (pushes) found.push(lineOf(sf, node));
  });
  return found;
}

test("the git push check fires on a workflow that pushes itself, through ctx.exec, the Commands git methods or a shell line, and passes the helpers, other git commands and text", () => {
  const offender = [
    'await ctx.exec("git", ["push", "origin", "HEAD"]);',
    'await cmd.git(cwd, "-c", "x=y", "push");',
    'await ctx.exec("bash", ["-c", "git push --force"]);',
    'execSync("git -C dir push");',
    'await cmd.gitRead(cwd, "push", "--dry-run");',
    'await cmd.forgeRead("git", cwd, "push", "origin");',
    'await cmd.forgeReadWith("git", cwd, {}, "push");',
  ].join("\n");
  assert.deepEqual(directGitPush("packages/runtime/workflows/x.ts", offender), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(directGitPush(".agents/workflows/mine.ts", 'await ctx.exec("git", ["push"]);\n'), [1]);
  const legit = [
    'await cmd.push(cwd, "-u", "origin", branch);',
    "await cmd.pushOwned(cwd, branch, undefined);",
    "await cmd.deleteOwned(cwd, branch, sha);",
    'await ctx.exec("git", ["config", "push.default", "simple"]);',
    'await cmd.git(cwd, "status");',
    'ctx.log("git push is not run here");',
    'await cmd.forgeRead("gh", cwd, "pr", "view");',
    '// await ctx.exec("git", ["push"]);',
  ].join("\n");
  assert.deepEqual(directGitPush("packages/runtime/workflows/x.ts", legit), []);
  assert.deepEqual(directGitPush(PUSH_HELPERS, offender), [], "the helpers are where it is allowed");
});

test("no workflow runs git push itself: pushing and deleting a remote branch go through the Commands helpers, which touch only the branches the workflow owns", () => {
  const workflows = ["packages/runtime/workflows", ".agents/workflows"].flatMap((d) => files(d, CODE));
  assert.ok(workflows.includes(PUSH_HELPERS), "the helpers are among the files scanned");
  assert.deepEqual(scan(workflows, directGitPush), [], "call Commands.push, pushOwned or deleteOwned (workflows/implement-issue/commands.ts)");
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
  assert.ok(SHELL.length >= 5 && SHELL.includes(".githooks/pre-commit"), `found ${SHELL.join(", ")}`);
  assert.deepEqual(scan(SHELL, lax), [], "open with #!/usr/bin/env bash and set -euo pipefail");
  assert.deepEqual(scan(SHELL, dollarZero), [], 'use "$(dirname "${BASH_SOURCE[0]}")", not $0');
  assert.deepEqual(scan(SHELL, unexplainedDisables), [], "put the reason on the same line: # shellcheck disable=SCnnnn # <why>");
});

/** Lines calling `process.exit(...)`: it ends the process before the stdout and stderr of a piped run are flushed. */
function processExits(path: string, text: string): number[] {
  const sf = parse(path, text);
  const found: number[] = [];
  walk(sf, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "process" && node.expression.name.text === "exit") {
      found.push(lineOf(sf, node));
    }
  });
  return found;
}

test("the process.exit check fires on a call, in a function or at the top level, and passes process.exitCode, a string that holds the call and a comment", () => {
  assert.deepEqual(processExits("s.ts", 'if (bad) process.exit(2);\nfunction f() {\n  process.exit();\n}\n'), [1, 3]);
  assert.deepEqual(processExits("s.ts", 'process.exitCode = 2;\nconst child = "process.exit(1)";\n// process.exit(0) cuts the output\nconst exit = () => 1;\n'), []);
});

test("no maintainer script calls process.exit: it sets process.exitCode and returns, so a piped run keeps its output", () => {
  const scripts = files("scripts", CODE);
  assert.ok(scripts.length >= 20, `found ${scripts.length}`);
  assert.deepEqual(scan(scripts, processExits), [], "return the exit code from `main` and write `if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2))` (scripts/lib/cli.ts)");
});

const LINE_COMMENT = /^\s*(?:\/\/|#)/;

/** The lines of a file as a reader takes them: a line ending in `\` or `\\` (a shell continuation, or one inside a heredoc) and a comment line that leaves a backtick span open both join the next line. Each carries the number of its first physical line. */
function logicalLines(text: string): Array<{ line: number; text: string }> {
  const lines = text.split("\n");
  const found: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const first = i + 1;
    let joined = lines[i]!;
    for (;;) {
      const next = lines[i + 1];
      if (next === undefined) break;
      const backslash = /\\{1,2}\s*$/.test(joined);
      const openSpan = LINE_COMMENT.test(joined) && LINE_COMMENT.test(next) && (joined.match(/`/g)?.length ?? 0) % 2 === 1;
      if (!backslash && !openSpan) break;
      joined = `${joined.replace(/\\{1,2}\s*$/, "").trimEnd()} ${next.replace(openSpan ? /^\s*(?:\/\/|#)\s*/ : /^\s*/, "")}`;
      i++;
    }
    found.push({ line: first, text: joined });
  }
  return found;
}

/**
 * Lines holding a run command that lacks `--max-tokens` or `--max-cents`. `npm run wf -- run <name>` is a command whatever follows it;
 * a bare `wf run <name>` is one only with a `--flag`, which tells it from a mention of the subcommand in prose. The command runs
 * to the next backtick or the end of the joined line.
 */
function uncappedRuns(_path: string, text: string): number[] {
  const isCommand = (npmForm: boolean, tail: string) => (npmForm ? /\S/.test(tail) : / --[a-z]/.test(tail));
  return logicalLines(text)
    .filter(({ text: line }) =>
      [...line.matchAll(/\bwf (-- )?run\b([^`]*)/g)].some(([, npmForm, tail]) => isCommand(npmForm !== undefined, tail!) && !(tail!.includes("--max-tokens") && tail!.includes("--max-cents"))),
    )
    .map(({ line }) => line);
}

test("the caps check fires on a run command without --max-tokens or --max-cents, across a shell continuation or a comment's backtick span, and passes capped commands and prose", () => {
  const sample = [
    "npm run wf -- run verify-cloud --cwd ~/repo --max-tokens 60000", // 1: no cents cap
    "npm run wf -- run verify-cache --cwd ~/repo --args '{}'", // 2: neither
    "// HOW: `WORKFLOWS_DIR=scripts/verify npm run wf -- run", // 3: capped, across two comment lines
    "//   verify-context --cwd <probe-repo> --max-tokens 120000 --max-cents 25`.",
    "// HOW: `npm run wf -- run verify-sandbox --cwd <repo>", // 5: not capped, across two comment lines
    "//   --max-tokens 150000`.",
    "  npm run wf -- run implement-issue --cwd \"$dir\" \\\\", // 7: capped, across a heredoc continuation
    "    --args '{}' --max-tokens 300000 --max-cents 50",
    "  npm run wf -- run implement-issue --cwd \"$dir\" --args '{}' --resume <runId>", // 9: the resume
    "Passed to `wf run` as `--max-tokens` and `--max-cents`; see `wf run implement-issue` and wf run smoke.",
    "npm run wf -- cancel job-1 --cwd ~/repo",
    "npm run wf -- run verify-cloud", // 12: a bare command
    "Run it with `npm run wf -- run` and the caps.",
  ].join("\n");
  assert.deepEqual(uncappedRuns("a.sh", sample), [1, 2, 5, 9, 12]);
});

/** Every place that documents a command: the maintainer scripts (their `HOW:` lines and what they print), the verify README and chapter 9.4. */
const COMMAND_DOCS = [...files("scripts", /\.(ts|sh|md)$/), "docs/contributing/04-scripts-do-mantenedor.md"];

test("every documented command that runs a workflow carries --max-tokens and --max-cents: a copied command without the cents cap spends without limit", () => {
  assert.ok(COMMAND_DOCS.some((f) => /\bwf -- run\b/.test(read(f))), "the check reads a file that documents a run");
  assert.deepEqual(scan(COMMAND_DOCS, uncappedRuns), [], "add `--max-tokens <N> --max-cents <N>`, with the caps the first command of the same script uses");
});

// --- CI ---------------------------------------------------------------------------------------------------------------

/** 0 (the file) without a top-level `permissions: contents: read`, plus the lines that grant a write permission. */
const writableCi = (_path: string, text: string) => [
  ...(/^permissions:[ \t]*\n[ \t]+contents:[ \t]*read[ \t]*$/m.test(text) ? [] : [0]),
  ...text.split("\n").flatMap((l, i) => (/^\s*(permissions:\s*write-all|[\w-]+:\s*write)\s*$/.test(l) ? [i + 1] : [])),
];
/** Lines with a `uses:` that is not a first-party `actions/<name>` action. How it is pinned is test/supply-chain.test.ts. */
const thirdPartyActions = (_path: string, text: string) =>
  text.split("\n").flatMap((l, i) => {
    const uses = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(l);
    return uses && !/^actions\/[\w-]+@/.test(uses[1]!) ? [i + 1] : [];
  });

test("the CI checks fire on a missing or writable permission and on a third-party action, whatever its pin", () => {
  assert.deepEqual(writableCi("ci.yml", "on: push\njobs:\n  t:\n    permissions:\n      pull-requests: write\n"), [0, 5]);
  assert.deepEqual(writableCi("ci.yml", "on: push\npermissions:\n  contents: read\njobs: {}\n"), []);
  const sha = "a".repeat(40);
  assert.deepEqual(thirdPartyActions("ci.yml", `      - uses: someone/action@${sha} # v1\n      - uses: ./local-action\n      - uses: docker://alpine:3\n`), [1, 2, 3]);
  assert.deepEqual(thirdPartyActions("ci.yml", `      - uses: actions/checkout@${sha} # v4.4.0\n      - uses: actions/setup-node@v4\n`), []);
});

test("CI reads the repository only, and uses first-party actions only", () => {
  const workflows = files(".github/workflows", /\.ya?ml$/);
  assert.ok(workflows.length >= 1);
  assert.deepEqual(scan(workflows, writableCi), [], "set top-level permissions: contents: read and grant no write");
  assert.deepEqual(scan(workflows, thirdPartyActions), [], "use first-party actions/<name> only; install any other tool by hand, pinned and checked");
});

// --- The exemplars ----------------------------------------------------------------------------------------------------
//
// An exemplar is cited as a file, plus the symbol, heading or key in it that shows the rule: `path` `anchor`, two code
// spans one space apart. An edit above the exemplar leaves the anchor valid; a line number would not. A file alone (no
// anchor) is cited in a `_See:_` clause when the exemplar is the whole file or its header.

/** A file the standards can cite: a path with one of the extensions the anchor resolver reads. */
const CITABLE = /^[\w./-]+\.(?:ts|tsx|mjs|md|sh|css|json|toml|ya?ml)$/;

interface Citation {
  /** The line of the standards file that cites it. */
  at: number;
  path: string;
  /** The symbol, heading or key; undefined when the citation is the whole file. */
  anchor?: string;
}

/** Every exemplar a standards file cites, plus each legacy `path:line` citation it still holds. */
function citations(md: string): { cited: Citation[]; byLine: string[] } {
  const cited: Citation[] = [];
  const byLine: string[] = [];
  md.split("\n").forEach((l, i) => {
    const at = i + 1;
    const see = l.indexOf("_See:_");
    const spans = [...l.matchAll(/`([^`]+)`/g)].map((m) => ({ text: m[1]!, start: m.index, end: m.index + m[0].length }));
    for (let k = 0; k < spans.length; k++) {
      const span = spans[k]!;
      if (/^[\w./-]+\.\w+:\d+$/.test(span.text)) byLine.push(`:${at} cites ${span.text}`);
      if (!CITABLE.test(span.text)) continue;
      const next = spans[k + 1];
      if (next && next.start === span.end + 1 && !CITABLE.test(next.text)) {
        cited.push({ at, path: span.text, anchor: next.text });
        k++;
      } else if (see >= 0 && span.start > see) {
        cited.push({ at, path: span.text });
      }
    }
  });
  return { cited, byLine };
}

/** The name a TypeScript declaration, member or object key introduces, or undefined for any other node. */
function declaredName(node: ts.Node): string | undefined {
  const named =
    ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) || ts.isVariableDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node) ||
    ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isPropertyAssignment(node);
  const name = named ? node.name : undefined;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
}

/** True when `anchor` names a declaration of the file (`outer.inner` for one declared inside another) or a `test()` title. */
function tsAnchor(sf: ts.SourceFile, anchor: string): boolean {
  let scopes: ts.Node[] = [sf];
  for (const segment of anchor.split(".")) {
    const found: ts.Node[] = [];
    for (const scope of scopes) ts.forEachChild(scope, (child) => walk(child as ts.SourceFile, (n) => void (declaredName(n) === segment && found.push(n))));
    scopes = found;
  }
  if (scopes.length > 0) return true;
  let titled = false;
  walk(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "test") {
      const title = n.arguments[0];
      if (title && ts.isStringLiteralLike(title) && title.text === anchor) titled = true;
    }
  });
  return titled;
}

/** Every key of a parsed JSON value, at any depth. */
const jsonKeys = (value: unknown): string[] =>
  value && typeof value === "object" ? Object.entries(value).flatMap(([k, v]) => [...(Array.isArray(value) ? [] : [k]), ...jsonKeys(v)]) : [];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `anchor` resolves in `path`: a declaration or test title (TypeScript), a heading or a bold lead-in (Markdown),
 * a function (shell), a selector or at-rule prelude (CSS), a key (JSON, TOML, YAML). */
function anchorResolves(path: string, text: string, anchor: string): boolean {
  if (/\.(ts|tsx|mjs)$/.test(path)) return tsAnchor(parse(path, text), anchor);
  if (path.endsWith(".md")) {
    const { headings, lines } = parseMarkdown(text);
    const leadIns = lines.flatMap((l) => /^\s*(?:\d+\.\s+|[-*]\s+)?\*\*([^*]+)\*\*/.exec(l)?.[1] ?? []);
    return [...headings.map((h) => h.text), ...leadIns].includes(anchor);
  }
  if (path.endsWith(".sh")) return new RegExp(`^${escapeRegExp(anchor)}\\(\\)\\s*\\{`, "m").test(text);
  if (path.endsWith(".css")) return text.split("\n").some((l) => l.includes("{") && l.slice(0, l.indexOf("{")).split(",").some((s) => s.trim() === anchor));
  if (path.endsWith(".json")) return jsonKeys(JSON.parse(text)).includes(anchor);
  if (path.endsWith(".toml")) return new RegExp(`^\\s*(${escapeRegExp(anchor)}\\s*=|\\[${escapeRegExp(anchor)}\\])`, "m").test(text);
  return new RegExp(`^\\s*(?:-\\s*)?${escapeRegExp(anchor)}:`, "m").test(text);
}

/** Each citation whose file is gone or whose anchor no longer resolves in it, and each citation by line number. */
function brokenCitations(md: string, readFile: (path: string) => string | undefined): string[] {
  const { cited, byLine } = citations(md);
  return [
    ...byLine.map((c) => `${c}: cite the file and a symbol or heading, not a line`),
    ...cited.flatMap(({ at, path, anchor }) => {
      const text = readFile(path);
      if (text === undefined) return [`:${at} cites ${path}, which does not exist`];
      return anchor === undefined || anchorResolves(path, text, anchor) ? [] : [`:${at} cites ${path} \`${anchor}\`, which ${path} no longer declares`];
    }),
  ];
}

test("the exemplar check fires on a missing file, a dangling anchor and a line number, and resolves every anchor kind", () => {
  const files = new Map([
    ["a.ts", "// header\nexport function outer() {\n  const inner = 1;\n}\ntest(\"it works\", () => {});\n"],
    ["b.md", "# Title\n\n## Section\n\n**Term** (*term*): text.\n"],
    ["c.sh", "#!/usr/bin/env bash\nmain() {\n  :\n}\n"],
    ["d.css", ".a .b, .c { color: red; }\n@media (x) { .d { color: blue; } }\n"],
    ["e.json", '{ "dependencies": { "@x/y": "1.0.0" } }\n'],
    ["f.toml", "[tools]\nnode = \"22\"\n"],
    ["g.yml", "jobs:\n  test:\n    steps:\n      - run: x\n"],
  ]);
  const good = [
    "`a.ts` `outer`", "`a.ts` `outer.inner`", "`a.ts` `it works`", "`b.md` `Section`", "`b.md` `Term`", "`c.sh` `main`",
    "`d.css` `.c`", "`d.css` `@media (x)`", "`e.json` `@x/y`", "`f.toml` `node`", "`f.toml` `tools`", "`g.yml` `test`",
  ];
  const md = `- **Rule.** _See:_ ${good.join(", ")}, \`a.ts\`.\n- **Rule.** _See:_ \`gone.ts\` \`x\`, \`a.ts\` \`inner.outer\`, \`b.md\` \`Nope\`.\n- **Rule.** _See:_ \`a.ts:2\`.\n`;
  assert.equal(citations(md).cited.length, good.length + 4);
  assert.deepEqual(brokenCitations(md, (p) => files.get(p)), [
    ":3 cites a.ts:2: cite the file and a symbol or heading, not a line",
    ":2 cites gone.ts, which does not exist",
    ":2 cites a.ts `inner.outer`, which a.ts no longer declares",
    ":2 cites b.md `Nope`, which b.md no longer declares",
  ]);
});

test("every exemplar CODING_STANDARDS.md cites is a file that exists, with an anchor it still declares", () => {
  const md = read("CODING_STANDARDS.md");
  const { cited } = citations(md);
  assert.ok(cited.length >= 141, `found ${cited.length} citations`);
  const readFile = (path: string) => (existsSync(join(ROOT, path)) ? read(path) : undefined);
  assert.deepEqual(brokenCitations(md, readFile), [], "an exemplar was renamed, moved or deleted: cite a symbol or heading that still shows the rule");
});
