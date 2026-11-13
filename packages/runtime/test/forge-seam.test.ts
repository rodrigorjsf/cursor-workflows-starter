// Seam: the source of `implement-issue` and `wf gc`, read as text with the TypeScript parser (nothing runs). The forge module
// is the one place that names a forge's CLI (ADR-0009), so no string literal anywhere else in them says `gh` or `glab`. What the
// forge CLI is asked is asserted by the behaviour tests of the workflow, of gc and of the doctor, against the fake `gh` and `glab`
// on the PATH.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const RUNTIME = join(import.meta.dirname, "..");
const FORGE = join(RUNTIME, "workflows", "implement-issue", "forge.ts");
const HELPERS = join(RUNTIME, "workflows", "implement-issue");
/** `implement-issue` (the workflow and its helpers, `wf gc` among them), the CLI that starts `wf gc` and `wf doctor`: none of them speaks to a forge itself. */
const FORGE_CLIENTS = [
  join(RUNTIME, "workflows", "implement-issue.ts"),
  join(RUNTIME, "src", "cli.ts"),
  join(RUNTIME, "src", "doctor.ts"),
  ...readdirSync(HELPERS).flatMap((name) => (name.endsWith(".ts") && join(HELPERS, name) !== FORGE ? [join(HELPERS, name)] : [])),
];

/** Every piece of literal text in `file`: string literals and the fixed parts of template literals. Comments are not read. */
function literals(file: string): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const NAMES_GH = /\bgh\b/;
const NAMES_GLAB = /\bglab\b/;
const NAMES_A_FORGE_CLI = /\b(gh|glab)\b/;

test("only the forge module names the gh and glab CLIs: implement-issue, wf gc, wf doctor and the CLI that starts them call the forge instead", () => {
  const named = literals(FORGE);
  assert.ok(
    named.some(({ text }) => NAMES_GH.test(text)) && named.some(({ text }) => NAMES_GLAB.test(text)),
    "the forge module is where `gh` and `glab` are named: the scan below would pass for the wrong reason without it",
  );
  const offenders = FORGE_CLIENTS.flatMap((file) =>
    literals(file)
      .filter(({ text }) => NAMES_A_FORGE_CLI.test(text))
      .map(({ line, text }) => `${relative(RUNTIME, file)}:${line}: ${text.slice(0, 80)}`),
  );
  assert.deepEqual(offenders, [], "route the call through the forge in workflows/implement-issue/forge.ts");
});
