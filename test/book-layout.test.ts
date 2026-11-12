// Seam: the docs book as shipped. These tests read docs/ the way a reader or an agent would find it: the index, where
// each chapter lives, the contributor section, the Claude Code rule that points at the diagram conventions, and the
// diagram sources themselves. (The mechanical consistency of links, anchors, footers and the index is docs-check.test.ts.)
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { test } from "node:test";
import { markdownFiles, parseMarkdown } from "../scripts/lib/markdown.js";

const ROOT = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** The chapters the index lists, by part number, as `docs/...` paths. */
function indexParts(): Map<number, string[]> {
  const parts = new Map<number, string[]>();
  let current: string[] | undefined;
  for (const line of read("docs/README.md").split("\n")) {
    const part = /^### Parte (\d+) · /.exec(line);
    if (part) parts.set(Number(part[1]), (current = []));
    else if (/^##? /.test(line)) current = undefined;
    const entry = /^- \[[^\]]+\]\(([^)#]+)/.exec(line);
    if (current && entry) current.push(posix.join("docs", entry[1]!));
  }
  return parts;
}

test("the index has the nine parts, in order", () => {
  const titles = [...read("docs/README.md").matchAll(/^### Parte (\d+) · (.+)$/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(titles, [
    "1 Visão",
    "2 Uso",
    "3 Internos",
    "4 Escrevendo workflows",
    "5 Operação",
    "6 Referência",
    "7 Decisões (ADRs)",
    "8 Pesquisa",
    "9 Contribuindo",
  ]);
});

test("the nine original chapters and the research reports live in their parts, and no flat chapter is left", () => {
  const parts = indexParts();
  assert.deepEqual(parts.get(2), ["docs/usage/01-instalacao.md", "docs/usage/02-configuracao-inicial.md", "docs/usage/03-invocacao-no-cursor-ide.md"]);
  assert.deepEqual(parts.get(3), ["docs/internals/01-arquitetura.md"]);
  assert.deepEqual(parts.get(4), ["docs/authoring/01-escrevendo-workflows.md", "docs/authoring/02-convertendo-skills-e-subagents.md"]);
  assert.deepEqual(parts.get(5), ["docs/operating/01-governanca-e-custos.md", "docs/operating/02-custos-e-cache.md", "docs/operating/03-observabilidade.md"]);
  assert.deepEqual(parts.get(8), ["docs/research/relatorio-pesquisa.md", "docs/research/verificacoes-locais.md"]);

  const flat = readdirSync(join(ROOT, "docs")).filter((name) => /^\d\d-.*\.md$/.test(name));
  assert.deepEqual(flat, [], "chapters live in the folder of their part");
});

test("the index gives an entry point for each profile: user, workflow author and maintainer", () => {
  const index = read("docs/README.md");
  const start = index.slice(index.indexOf("## Por onde começar"), index.indexOf("## Partes e capítulos"));
  for (const profile of ["Usuário", "Autor de workflows", "Mantenedor"]) {
    const row = start.split("\n").find((line) => line.startsWith("|") && line.includes(`**${profile}`));
    assert.ok(row, `no "${profile}" row under "Por onde começar"`);
    assert.ok((row.match(/\]\(/g) ?? []).length >= 2, `the "${profile}" row should link to the chapters to start with`);
  }
});

// Moving a chapter must not cost it content. These are the numbers of dated-evidence markers each chapter had before it
// moved; a chapter may gain more, but never lose one.
const EVIDENCE_FLOOR: Array<[file: string, docCitations: number]> = [
  ["docs/usage/01-instalacao.md", 10],
  ["docs/usage/02-configuracao-inicial.md", 14],
  ["docs/usage/03-invocacao-no-cursor-ide.md", 30],
  ["docs/internals/01-arquitetura.md", 16],
  ["docs/authoring/02-convertendo-skills-e-subagents.md", 5],
  ["docs/operating/01-governanca-e-custos.md", 24],
  ["docs/operating/02-custos-e-cache.md", 19],
  ["docs/operating/03-observabilidade.md", 17],
  ["docs/research/relatorio-pesquisa.md", 81],
  ["docs/research/verificacoes-locais.md", 26],
];

test("moved chapters keep their [DOC] citations", () => {
  for (const [file, floor] of EVIDENCE_FLOOR) {
    const citations = (read(file).match(/\[\[?DOC\]\]?/g) ?? []).length;
    assert.ok(citations >= floor, `${file} has ${citations} [DOC] citations, it had ${floor}`);
  }
});

test("moved chapters name the workspace layout, not the old one", () => {
  for (const file of ["docs/research/relatorio-pesquisa.md", "docs/research/verificacoes-locais.md"]) {
    const text = read(file);
    assert.doesNotMatch(text, /`(?:src\/(?:runtime|observability|mcp-server|console-to-stderr)|test\/implement-issue)/, `${file} still names a path from before the workspace move`);
  }
});

test("the contributor section documents the book, the diagrams and the maintainer scripts", () => {
  const book = read("docs/contributing/02-convencoes-do-livro.md");
  assert.match(book, /rodapé/i);
  assert.match(book, /docs\/README\.md/);

  const diagrams = read("docs/contributing/03-diagramas.md");
  assert.match(diagrams, /classDef/);
  assert.match(diagrams, /stateDiagram-v2/);
  assert.match(diagrams, /sem animação/i);

  assert.match(read("docs/contributing/04-scripts-do-mantenedor.md"), /^\| Script \| O que faz \| Quando usar \| Como \|$/m);
});

test("a path-scoped Claude Code rule points *.md files at the diagram conventions", () => {
  const rule = read(".claude/rules/diagrams.md");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(rule);
  assert.ok(frontmatter, "the rule needs YAML frontmatter with `paths`");
  assert.match(frontmatter[1]!, /^paths:\s*\n(\s+- .*\n)*\s+- "\*\*\/\*\.md"/m, "the rule must apply to **/*.md");
  assert.match(rule.slice(frontmatter[0].length), /\]\(\.\.\/\.\.\/docs\/contributing\/03-diagramas\.md\)/, "the rule must link the diagram conventions chapter");
  assert.ok(existsSync(join(ROOT, "docs/contributing/03-diagramas.md")));
});

test("the diagrams in the repo follow the diagram conventions", () => {
  let blocks = 0;
  for (const file of markdownFiles(ROOT)) {
    for (const block of parseMarkdown(read(file)).mermaid) {
      blocks++;
      const where = `${file}:${block.line}`;
      assert.doesNotMatch(block.source, /\banimat(e|ion)\b/, `${where}: no animation on GitHub-rendered pages`);
      assert.doesNotMatch(block.source, /^\s*stateDiagram\s*$/m, `${where}: use stateDiagram-v2 for state machines`);
      assert.doesNotMatch(block.source, /%%\{\s*init/, `${where}: do not pin a theme: GitHub picks it`);
      for (const classDef of block.source.matchAll(/^\s*classDef\s+\S+\s+(\S+)/gm)) {
        for (const property of ["fill", "stroke", "color"]) {
          assert.match(classDef[1]!, new RegExp(`(^|,)${property}:`), `${where}: classDef must set ${property} so the node reads in light and dark themes`);
        }
      }
    }
  }
  assert.ok(blocks >= 5, `expected the book's diagrams, found ${blocks}`);
});

test("a chapter outside the conventions draws the job lifecycle as a state machine, with the statuses the runtime reports", () => {
  const statuses = ["running", "finished", "failed", "cancelled"]; // RunStatus plus `running`, as wait_workflow returns them
  const machines = markdownFiles(ROOT)
    .filter((file) => file.startsWith("docs/") && !file.startsWith("docs/contributing/"))
    .flatMap((file) => parseMarkdown(read(file)).mermaid.map((block) => block.source))
    .filter((source) => /^\s*stateDiagram-v2\b/.test(source));
  assert.ok(
    machines.some((source) => statuses.every((s) => new RegExp(`\\b${s}\\b`).test(source))),
    "no stateDiagram-v2 in the book shows running, finished, failed and cancelled",
  );
});
