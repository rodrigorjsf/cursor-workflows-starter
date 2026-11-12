// The runtime's messages are English: what it prints, returns or throws reaches agents (the MCP tools, the `wf` CLI, `wf doctor`,
// `wf init`, `wf upgrade`), and agent-facing text is English. Scans every string literal and template text in
// packages/runtime/src with the TypeScript parser, so comments, which keep the file's own language, are not read.
//
// Wording-keyed: the check knows Portuguese by its accented letters and a list of common words, not by understanding the text.
// A Portuguese message written without any of them passes.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const SRC = join(import.meta.dirname, "..", "src");
const PORTUGUESE = /[ãõçáéíóúâêôà]|\b(não|para|uma|que|dos|das|são|também|você|com o|de um|de|da|em|ou|sem|nenhuma?|chave|desconhecid[oa]s?|encontrad[oa]s?|arquivo|pasta|rode|banco)\b/i;
/** Not messages: the metrics database's DDL, whose SQL comments keep the file's language, and the pricing rows it seeds. */
const DATA = ["CREATE VIEW", "CREATE TABLE", "cursor.com/docs/models-and-pricing"];

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.(ts|mjs)$/.test(e.name) ? [join(dir, e.name)] : []));

/** Every piece of literal text in `file`: string literals and the fixed parts of template literals. */
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

test("no string in the runtime's source is Portuguese: every message that can reach an agent is English", () => {
  const offenders = sources(SRC).flatMap((file) =>
    literals(file)
      .filter(({ text }) => PORTUGUESE.test(text) && !DATA.some((d) => text.includes(d)))
      .map(({ line, text }) => `${relative(SRC, file)}:${line}: ${text.slice(0, 100)}`),
  );
  assert.deepEqual(offenders, []);
});
