// Seam: the runtime's and the dashboard's own source, read with the TypeScript checker (it needs types: whether a statement's value
// is a promise cannot be told from the text). A promise that nothing awaits, returns, `void`s or catches is lost when it rejects:
// `jobs.ts` logs an `unhandledRejection` and goes on, a workaround for promises inside the Cursor SDK, so a floating promise in the
// kit's own code would fail without a word. CODING_STANDARDS (Concurrency) says to prefix fire-and-forget with `void` and to mark a
// race promise handled with `.catch`; this check enforces it over `packages/*/src` and `packages/*/workflows`. A call of `node:test`
// (`test(...)`) is exempt: the runner awaits it. A sample test proves the check fires on an unawaited promise and stays silent on
// each way of handling one, and a second test runs it over the repository. A promise held in a container (`[p()]`, a map's value)
// is not seen: only the value of an expression statement is.
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "..");

/** Does a value of this type have a callable `then`? A union is a promise when any member is (`Promise<T> | undefined`). */
function isThenable(checker: ts.TypeChecker, type: ts.Type, at: ts.Node): boolean {
  if (type.isUnion()) return type.types.some((member) => isThenable(checker, member, at));
  const then = type.getProperty("then");
  return then !== undefined && checker.getTypeOfSymbolAtLocation(then, at).getCallSignatures().length > 0;
}

/** Is `callee` an identifier imported from `node:test`? */
function isNodeTestCall(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
  const callee = call.expression;
  const symbol = ts.isIdentifier(callee) ? checker.getSymbolAtLocation(callee) : undefined;
  return (symbol?.declarations ?? []).some((d) => ts.isImportSpecifier(d) && ts.isStringLiteral(d.parent.parent.parent.moduleSpecifier) && d.parent.parent.parent.moduleSpecifier.text === "node:test");
}

/** Is the value of `node`, an expression statement's expression, a promise that nothing handles? */
function floats(checker: ts.TypeChecker, node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return floats(checker, node.expression);
  if (ts.isVoidExpression(node) || ts.isAwaitExpression(node)) return false;
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if (kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment) return false; // `this.pending = p()`, `cache ??= p()`: held, and settled where it is read
    if (kind === ts.SyntaxKind.CommaToken || kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken) {
      return floats(checker, node.left) || floats(checker, node.right);
    }
  }
  if (ts.isConditionalExpression(node)) return floats(checker, node.whenTrue) || floats(checker, node.whenFalse);
  if (ts.isCallExpression(node)) {
    if (isNodeTestCall(checker, node)) return false;
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee) && (callee.name.text === "catch" || (callee.name.text === "then" && node.arguments.length >= 2))) return false; // the rejection has a handler
  }
  return isThenable(checker, checker.getTypeAtLocation(node), node);
}

/** The lines of `file` that start an expression statement whose promise floats. */
function floatingPromises(program: ts.Program, file: ts.SourceFile): number[] {
  const checker = program.getTypeChecker();
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isExpressionStatement(node) && floats(checker, node.expression)) lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

/** A program over one in-memory file, placed inside the repository so that `node:test` and the rest of @types/node resolve. */
function programOf(source: string): { program: ts.Program; file: ts.SourceFile } {
  const path = join(ROOT, "test", "floating-promises.fixture.ts");
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true, types: ["node"], skipLibCheck: true };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...rest) => (name === path ? ts.createSourceFile(name, source, languageVersion, true) : getSourceFile(name, languageVersion, ...rest));
  const program = ts.createProgram({ rootNames: [path], options, host });
  const file = program.getSourceFile(path);
  assert.ok(file, "the fixture is part of its program");
  return { program, file };
}

/** A fixture whose offending statements end with `// floats`: the lines the check must name. */
const FIXTURE = `import { test } from "node:test";
declare function save(): Promise<void>;
declare const jobs: Map<string, Promise<number>>;
let pending: Promise<void> | undefined;
export async function handled() {
  await save();
  void save();
  save().catch(() => {});
  save().then(() => {}, () => {});
  const kept = save();
  pending = save();
  pending ??= save();
  test("the runner awaits it", async () => {});
  if (jobs.size > 0) void save();
  jobs.size > 0 && save().catch(() => {});
  await Promise.all([save(), save()]);
  return kept;
}
export async function floating() {
  save(); // floats
  (save()); // floats
  jobs.get("a"); // floats
  jobs.size > 0 && save(); // floats
  jobs.size > 0 ? save() : undefined; // floats
  Promise.resolve().then(() => {}); // floats
  new Promise<void>((resolve) => resolve()); // floats
  (async () => {})(); // floats
}
`;

test("the floating-promise check fires on a promise nothing handles, and stays silent on each way of handling one", () => {
  const { program, file } = programOf(FIXTURE);
  const expected = FIXTURE.split("\n").flatMap((line, i) => (line.endsWith("// floats") ? [i + 1] : []));
  assert.equal(expected.length, 8);
  assert.deepEqual(floatingPromises(program, file), expected);
});

test("no expression statement of the runtime's or the dashboard's own source leaves a promise floating", () => {
  const { config, error } = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile);
  assert.equal(error, undefined);
  const { options, fileNames } = ts.parseJsonConfigFileContent(config, ts.sys, ROOT);
  const program = ts.createProgram({ rootNames: fileNames, options });
  const governed = /\/packages\/[^/]+\/(src|workflows)\//;
  const sources = program.getSourceFiles().filter((f) => !f.isDeclarationFile && governed.test(f.fileName) && !f.fileName.includes("/node_modules/"));
  assert.ok(sources.length >= 80, `found ${sources.length} files`);
  const offences = sources.flatMap((f) => floatingPromises(program, f).map((line) => `${f.fileName.slice(ROOT.length + 1)}:${line}`));
  assert.deepEqual(offences, [], "await it, return it, prefix it with `void` when nothing depends on it, or end it with .catch(...)");
});
