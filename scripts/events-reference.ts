// WHAT: generates docs/reference/events.md, the events reference page, from the event interfaces and their comments
//       in packages/runtime/src/runtime/events.ts.
// WHY:  the event type is the only description of the event log that cannot go stale. A page written by hand drifts;
//       a generated one is checked: `npm test` (test/events-reference.test.ts) fails when it differs from the code.
// WHEN: after any change to packages/runtime/src/runtime/events.ts (a field, a comment, a new event).
// HOW:  `npm run docs:events` rewrites the page. `npx tsx scripts/events-reference.ts --check` only compares it and
//       exits 1 when it is out of date. The source is parsed, not imported: no event code runs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const EVENTS_SOURCE = join(ROOT, "packages", "runtime", "src", "runtime", "events.ts");
export const EVENTS_PAGE = join(ROOT, "docs", "reference", "events.md");
/** The page's label in the book index (docs/README.md); its H1 must equal it. */
const BOOK_LABEL = "6.1 · Referência de eventos";
/** The footer `npm run docs:check` expects: previous and next chapter in index order. Update it when they change. */
const BOOK_FOOTER =
  "[← Anterior: 5.3 · Observabilidade: custo, tokens, contexto e eficiência](../operating/03-observabilidade.md) · [Índice](../README.md) · [Próximo: 8.1 · Cursor SDK como motor de workflows determinísticos: relatório de pesquisa →](../research/relatorio-pesquisa.md)";

interface Field {
  name: string;
  type: string;
  optional: boolean;
  doc: string;
}

interface Declared {
  name: string;
  doc: string;
  /** Names of the interfaces it extends. */
  extendsNames: string[];
  fields: Field[];
  /** The literal of its `type` field: set for events only. */
  eventType?: string;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
/** Table cells: no line breaks, and a pipe would end the cell. */
const cell = (text: string) => squash(text).replace(/\|/g, "\\|");

/** The text of the last `/** ... *\/` comment before the node. */
function docOf(node: ts.Node, source: ts.SourceFile): string {
  const ranges = ts.getLeadingCommentRanges(source.text, node.getFullStart()) ?? [];
  const block = ranges.map((r) => source.text.slice(r.pos, r.end)).filter((c) => c.startsWith("/**")).at(-1);
  if (!block) return "";
  return squash(block.replace(/^\/\*\*|\*\/$/g, "").replace(/^\s*\* ?/gm, " "));
}

export function generateEventsReference(sourceText: string): string {
  const source = ts.createSourceFile("events.ts", sourceText, ts.ScriptTarget.Latest, true);

  const interfaces = new Map<string, Declared>();
  const aliases = new Map<string, { name: string; doc: string; text: string }>();
  const imports = new Map<string, string[]>();
  let eventNames: string[] = [];

  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      imports.set(
        (node.moduleSpecifier as ts.StringLiteral).text,
        node.importClause.namedBindings.elements.map((e) => e.name.text),
      );
    } else if (ts.isInterfaceDeclaration(node)) {
      const fields: Field[] = [];
      let eventType: string | undefined;
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || !member.type) continue;
        const name = member.name.getText(source);
        if (name === "type" && ts.isLiteralTypeNode(member.type) && ts.isStringLiteral(member.type.literal)) {
          eventType = member.type.literal.text;
          continue;
        }
        fields.push({ name, type: squash(member.type.getText(source)), optional: Boolean(member.questionToken), doc: docOf(member, source) });
      }
      interfaces.set(node.name.text, {
        name: node.name.text,
        doc: docOf(node, source),
        extendsNames: (node.heritageClauses ?? []).flatMap((h) => h.types.map((t) => t.expression.getText(source))),
        fields,
        eventType,
      });
    } else if (ts.isTypeAliasDeclaration(node)) {
      if (node.name.text === "WorkflowEvent" && ts.isUnionTypeNode(node.type)) {
        eventNames = node.type.types.map((t) => t.getText(source));
      } else {
        aliases.set(node.name.text, { name: node.name.text, doc: docOf(node, source), text: squash(node.type.getText(source)) });
      }
    }
  }

  const events = eventNames.map((name) => {
    const found = interfaces.get(name);
    if (!found?.eventType) throw new Error(`WorkflowEvent member ${name} is not an interface with a literal \`type\` field`);
    return found;
  });

  /** Interfaces and aliases that event fields mention by name, other than the events and the two shared bases. */
  const bases = new Set(["EventBase", "StepRef"]);
  const auxiliary: Array<Declared | { name: string; doc: string; text: string }> = [];
  const seen = new Set<string>();
  const visit = (typeText: string) => {
    for (const [name] of typeText.matchAll(/\b[A-Z][A-Za-z0-9]*\b/g)) {
      if (seen.has(name) || bases.has(name)) continue;
      const found = interfaces.get(name) ?? aliases.get(name);
      if (!found || (found as Declared).eventType) continue;
      seen.add(name);
      auxiliary.push(found);
      if ("fields" in found) found.fields.forEach((f) => visit(f.type));
      else visit(found.text);
    }
  };
  events.flatMap((e) => e.fields).forEach((f) => visit(f.type));

  const table = (fields: Field[]) => [
    "| Campo | Tipo | Obrigatório | Descrição |",
    "| --- | --- | --- | --- |",
    ...fields.map((f) => `| \`${f.name}\` | \`${cell(f.type)}\` | ${f.optional ? "não" : "sim"} | ${cell(f.doc)} |`),
  ];
  const includes = (d: Declared) => {
    const parents = d.extendsNames.filter((n) => bases.has(n));
    if (!parents.length) return "";
    return `Inclui os campos de ${parents.map((n) => `[\`${n}\`](#${n.toLowerCase()})`).join(" e de ")}.`;
  };

  const out: string[] = [
    `# ${BOOK_LABEL}`,
    "",
    `<!-- Gerado por scripts/events-reference.ts a partir de packages/runtime/src/runtime/events.ts. Não edite à mão: rode \`npm run docs:events\`. O \`npm test\` falha se esta página divergir do código. -->`,
    "",
    "Todo evento de um run é acrescentado ao **log de eventos** do run, `<repo>/.workflows/runs/<runId>/events.jsonl`: um objeto JSON por linha (JSON Lines). O log é a fonte de verdade do run. Um resume acrescenta ao mesmo arquivo, e cada execução abre com o seu `run-start`.",
    "",
    "- Todo evento tem `v`, `ts` e `runId` ([`EventBase`](#eventbase)). As etapas e os grupos dizem onde estão na estrutura do run ([`StepRef`](#stepref)), o bastante para montar o grafo do run só com o log.",
    "- Quem lê ignora uma última linha incompleta (queda no meio de uma gravação) e trata um `type` desconhecido, ou um `v` maior que o seu, como opaco.",
    "- As descrições dos campos vêm dos comentários do tipo, em `packages/runtime/src/runtime/events.ts`.",
    ...[...imports].map(([module, names]) => `- Tipos importados de \`${module}\`: ${names.map((n) => `\`${n}\``).join(", ")}.`),
    "",
  ];
  for (const base of ["EventBase", "StepRef"]) {
    const d = interfaces.get(base);
    if (!d) throw new Error(`events.ts must declare ${base}`);
    out.push(`## ${base}`, "", d.doc, "", ...table(d.fields), "");
  }
  out.push("## Eventos", "");
  for (const e of events) {
    out.push(`### \`${e.eventType}\``, "", e.doc, "");
    const inc = includes(e);
    if (inc) out.push(inc, "");
    if (e.fields.length) out.push(...table(e.fields), "");
  }
  if (auxiliary.length) {
    out.push("## Tipos auxiliares", "");
    for (const a of auxiliary) {
      out.push(`### ${a.name}`, "");
      if (a.doc) out.push(a.doc, "");
      if ("fields" in a) out.push(...table(a.fields), "");
      else out.push("```ts", `type ${a.name} = ${a.text};`, "```", "");
    }
  }
  // The page is chapter 6.1 of the docs book, so it ends with the previous/next footer the docs check demands.
  out.push("---", "", BOOK_FOOTER);
  return `${out.join("\n").trimEnd()}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const page = generateEventsReference(readFileSync(EVENTS_SOURCE, "utf8"));
  if (process.argv.includes("--check")) {
    const current = (() => {
      try {
        return readFileSync(EVENTS_PAGE, "utf8");
      } catch {
        return undefined;
      }
    })();
    if (current === page) process.exit(0);
    process.stderr.write(`${relative(ROOT, EVENTS_PAGE)} is out of date: run \`npm run docs:events\`\n`);
    process.exit(1);
  }
  mkdirSync(dirname(EVENTS_PAGE), { recursive: true });
  writeFileSync(EVENTS_PAGE, page);
  process.stdout.write(`wrote ${relative(ROOT, EVENTS_PAGE)}\n`);
}
