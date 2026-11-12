// WHAT: generates docs/reference/config.md, the config reference page, from the shipped JSON Schema
//       (packages/runtime/schema/config.schema.json): every field with its type and description, plus the schema's examples.
// WHY:  the schema is what validates the config files, so it cannot go stale; a page written by hand drifts. A generated
//       page is checked: `npm test` (test/config-reference.test.ts) fails when it differs from the schema.
// WHEN: after any change to the schema (a field, a description, an example, a new definition).
// HOW:  `npm run docs:config` rewrites the page. `npx tsx scripts/config-reference.ts --check` only compares it and exits 1
//       when it is out of date. A schema definition with no entry in SECTIONS below makes the generator throw: add its
//       section title there.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_SCHEMA = join(ROOT, "packages", "runtime", "schema", "config.schema.json");
export const CONFIG_PAGE = join(ROOT, "docs", "reference", "config.md");
/** The page's label in the book index (docs/README.md); its H1 must equal it. */
const BOOK_LABEL = "6.2 · Referência de configuração";
/** The footer `npm run docs:check` expects: previous and next chapter in index order. Update it when they change. */
const BOOK_FOOTER =
  "[← Anterior: 6.1 · Referência de eventos](events.md) · [Índice](../README.md) · [Próximo: 8.1 · Cursor SDK como motor de workflows determinísticos: relatório de pesquisa →](../research/relatorio-pesquisa.md)";

interface Node {
  type?: string | string[];
  description?: string;
  $ref?: string;
  enum?: unknown[];
  items?: Node;
  properties?: Record<string, Node>;
  required?: string[];
  additionalProperties?: boolean | Node;
  examples?: unknown[];
}
interface Schema extends Node {
  definitions: Record<string, Node>;
}

/** The object definitions that get a section, in reading order, with the title of the section. */
const SECTIONS: Record<string, string> = {
  caps: "Tetos globais (caps)",
  workflowPrefs: "Preferências de um workflow",
  rolePrefs: "Preferências de um papel ou de um glob de label",
  model: "Modelo",
  modelParam: "Parâmetro de modelo",
};
const ROOT_TITLE = "Raiz do arquivo";

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const cell = (text: string) => squash(text).replace(/\|/g, "\\|");
/** GitHub's heading id: lower case, punctuation dropped, spaces to dashes. */
const anchor = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, "").replace(/ /g, "-");

export function generateConfigReference(schemaText: string): string {
  const schema = JSON.parse(schemaText) as Schema;
  const defs = schema.definitions;
  const objectDefs = Object.entries(defs).filter(([, d]) => d.type === "object" && d.properties).map(([name]) => name);
  for (const name of objectDefs) if (!(name in SECTIONS)) throw new Error(`schema definition ${name} has no section: add it to SECTIONS in scripts/config-reference.ts`);
  for (const name of Object.keys(SECTIONS)) if (!objectDefs.includes(name)) throw new Error(`SECTIONS names ${name}, which is not an object definition of the schema`);

  const refName = (node: Node) => node.$ref?.replace("#/definitions/", "");
  const typeText = (node: Node): string => {
    const name = refName(node);
    if (name) return name in SECTIONS ? `[${SECTIONS[name]}](#${anchor(SECTIONS[name]!)})` : typeText(defs[name]!);
    if (node.enum) return node.enum.map((v) => JSON.stringify(v)).join(" | ");
    const types = Array.isArray(node.type) ? node.type : [node.type ?? "any"];
    return types
      .map((t) => {
        if (t === "array") return `array de ${node.items ? typeText(node.items) : "any"}`;
        if (t === "object" && typeof node.additionalProperties === "object") return `objeto: nome → ${typeText(node.additionalProperties)}`;
        return t;
      })
      .join(" | ");
  };
  const descriptionOf = (node: Node) => node.description ?? (refName(node) ? defs[refName(node)!]?.description : undefined) ?? "";
  const table = (owner: Node): string[] => [
    "| Campo | Tipo | Obrigatório | Descrição |",
    "| --- | --- | --- | --- |",
    ...Object.entries(owner.properties ?? {})
      .filter(([field]) => field !== "$comment") // allowed in every object; said once in the intro
      .map(([field, node]) => {
        const type = typeText(node);
        // A type that links to a section stays text, so the link works; a plain type is code.
        return `| \`${field}\` | ${type.includes("](#") ? cell(type) : `\`${cell(type)}\``} | ${owner.required?.includes(field) ? "sim" : "não"} | ${cell(descriptionOf(node))} |`;
      }),
  ];

  const out: string[] = [
    `# ${BOOK_LABEL}`,
    "",
    "<!-- Gerado por scripts/config-reference.ts a partir de packages/runtime/schema/config.schema.json. Não edite à mão: rode `npm run docs:config`. O `npm test` falha se esta página divergir do esquema. -->",
    "",
    "O comportamento do kit se configura em JSON, em dois arquivos que um único esquema valida. A configuração é lida de novo a cada `start_workflow`, `wf run` e resume: uma edição vale no run seguinte, sem reiniciar o servidor MCP.",
    "",
    "## Onde ficam os arquivos",
    "",
    "- **Global**, `~/.cursor-workflows/config.json` (a pasta muda com `WF_HOME`): os tetos rígidos (`caps`) e preferências suas, valem em todos os repositórios.",
    "- **Do repositório**, `.agents/workflows/config.json`: preferências por workflow e por papel, e a faixa `kit`. Vai para o controle de versão, então só pode **apertar** os tetos globais, nunca afrouxar.",
    "- **O esquema** é `packages/runtime/schema/config.schema.json`. Aponte `$schema` para ele e o editor completa e valida. Arquivo inválido, ou com chave desconhecida, derruba o run (e o `start_workflow`) antes de qualquer etapa, com o arquivo e o caminho do campo como ponteiro JSON, por exemplo `/workflows/implement-issue/roles/review/retries`.",
    "- Todo objeto aceita `$comment`, que é ignorado.",
    "",
    "## Precedência",
    "",
    "Cada valor vem da camada mais alta que o define:",
    "",
    "1. os defaults do código: do motor, do workflow (`defaults`, `budget`) e do papel (`meta.roles[].defaults`);",
    "2. o arquivo global;",
    "3. o arquivo do repositório;",
    "4. variáveis de ambiente: `WF_MAX_TOKENS`, `WF_MAX_CENTS` e `WF_MODEL_*` (veja abaixo);",
    "5. flags do CLI (`--max-tokens`, `--max-cents`) e opções de quem embute o motor;",
    "6. os `overrides` que o chat passa ao `start_workflow`: só apertam.",
    "",
    "Os campos do modelo (`id`, `params`, `maxMode`) se combinam um a um: quem troca só o `id` herda os `params` da camada de baixo.",
    "",
    "## Tetos",
    "",
    "Depois das camadas, os tetos do arquivo global limitam o resultado: **números** valem o menor entre o teto e o valor pedido, **listas** valem a interseção. O que a configuração pede acima de um teto é reduzido ao teto e registrado como **violação**, e o teto vale. Isso vale também para as flags. Os defaults do código acima de um teto são reduzidos sem violação.",
    "",
    "- Um `caps` no arquivo do repositório é violação e não tem efeito.",
    "- Um `overrides` do chat que afrouxaria o valor em vigor é violação e não tem efeito; apertar o valor é permitido. O `maxTokensPerStep` do chat vale como teto de todos os papéis e globs de label.",
    "- Um valor que não é um limite válido (um `concurrency` 0, um `maxTokens` fracionário) numa flag, num `overrides` ou numa variável de ambiente é erro, com o nome de onde veio.",
    "- Um modelo fora de `allowedModels` pedido pela configuração não tem efeito. Um modelo padrão do código que a lista recusa vira uma violação da camada `default` no `run-start`, e as etapas desse papel falham até a configuração trocá-lo.",
    "- `settingSources` fora de `allowedSettingSources` são removidos, em todas as etapas.",
    "",
    "As violações aparecem no `run-start` do log, como aviso no andamento do run, na resposta do `start_workflow` e no `wf config show`.",
    "",
    "## `null` e chave ausente",
    "",
    "`null` desliga um limite (num teto: sem teto; numa preferência: sem limite próprio, e os tetos globais seguem valendo). Uma chave ausente herda da camada de baixo. Zero é zero, nunca \"sem valor\".",
    "",
    "## Papéis, globs de label e variáveis",
    "",
    "- Um workflow declara seus **papéis** em `meta.roles`; os nomes são as chaves de `workflows.<nome>.roles` (`wf config show` e `list_workflows` os mostram). Cada papel traz o que a spec de nuvem vai usar: `cloud` é `ok`, `read-only` ou `never`. Um papel que o workflow não declara é erro, na configuração e em `agent({ role })`.",
    "- Por papel se configura o modelo (com `params`), `timeoutMs`, `retries`, `schemaRetries`, `maxTokensPerStep` e `settingSources`. A configuração vale mais que as opções da chamada `agent()`; os defaults do papel valem menos.",
    "- `labels` guarda as mesmas preferências por glob (`*` e `?`) do `label` da etapa, só para etapas **sem** papel. Vale o glob com mais caracteres literais; empate vai para o primeiro.",
    "- `WF_MODEL_<PAPEL>` troca o modelo de um papel: o nome do papel em maiúsculas, com `.` e `-` como `_` (`WF_MODEL_REVIEW`, `WF_MODEL_IMPLEMENT_LOW`), ou um apelido que o workflow declara (`WF_MODEL_LOW`). O valor `id` troca só o ID e mantém os `params`; `id[param=valor,max]` troca também os `params` (`max` liga o max mode; `id[]` limpa os `params`). Variáveis que não casam com um papel do workflow são ignoradas.",
    "- `maxTokensPerStep` entra na configuração efetiva e no `run-start`; quem o aplica durante a etapa é o limite ao vivo por etapa e por run, que é outro ticket da mesma spec.",
    "",
    "## O que cada run grava",
    "",
    "O `run-start` do [log de eventos](events.md#run-start) leva a configuração efetiva (`config`), de onde veio cada valor (`provenance`, por ponteiro JSON em `config`) e as violações (`violations`). `wf config show [workflow]` imprime os três para o repositório atual, com o caminho dos dois arquivos e se foram achados.",
    "",
    `## ${ROOT_TITLE}`,
    "",
    squash(schema.description ?? ""),
    "",
    ...table(schema),
    "",
  ];
  for (const [name, title] of Object.entries(SECTIONS)) {
    const def = defs[name]!;
    out.push(`## ${title}`, "", ...(def.description ? [squash(def.description), ""] : []), ...table(def), "");
  }
  out.push("## Exemplos", "");
  for (const example of schema.examples ?? []) {
    out.push(`**${typeof example === "object" && example !== null && "caps" in example ? "Arquivo global" : "Arquivo do repositório"}**`, "", "```json", JSON.stringify(example, null, 2), "```", "");
  }
  out.push("---", "", BOOK_FOOTER);
  return `${out.join("\n").trimEnd()}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const page = generateConfigReference(readFileSync(CONFIG_SCHEMA, "utf8"));
  if (process.argv.includes("--check")) {
    const current = (() => {
      try {
        return readFileSync(CONFIG_PAGE, "utf8");
      } catch {
        return undefined;
      }
    })();
    if (current === page) process.exit(0);
    process.stderr.write(`${relative(ROOT, CONFIG_PAGE)} is out of date: run \`npm run docs:config\`\n`);
    process.exit(1);
  }
  mkdirSync(dirname(CONFIG_PAGE), { recursive: true });
  writeFileSync(CONFIG_PAGE, page);
  process.stdout.write(`wrote ${relative(ROOT, CONFIG_PAGE)}\n`);
}
