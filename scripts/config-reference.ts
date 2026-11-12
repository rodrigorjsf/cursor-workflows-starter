// WHAT: generates docs/reference/config.md, the config reference page, from the shipped JSON Schema
//       (packages/runtime/schema/config.schema.json): every field with its type and description, plus the schema's examples.
// WHY:  the schema is what validates the config files, so it cannot go stale; a page written by hand drifts. A generated
//       page is checked: `npm test` (test/config-reference.test.ts) fails when it differs from the schema.
// WHEN: after any change to the schema (a field, a description, an example, a new definition).
// HOW:  `npm run docs:config` rewrites the page. `npx tsx scripts/config-reference.ts --check` only compares it and exits 1
//       when it is out of date. A schema definition with no entry in SECTIONS below makes the generator throw: add its
//       section title there. The page's number and footer come from the book index (docs/README.md), so adding a
//       chapter next to it needs no edit here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bookPlace } from "./check-docs.js";
import { isEntryPoint, writeGeneratedPage } from "./lib/cli.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_SCHEMA = join(ROOT, "packages", "runtime", "schema", "config.schema.json");
export const CONFIG_PAGE = join(ROOT, "docs", "reference", "config.md");
/** The page's path from the repo root, as the book index (docs/README.md) lists it. */
const BOOK_PAGE = "docs/reference/config.md";

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
  cloudPrefs: "Etapas na nuvem",
  dashboardPrefs: "O dashboard",
  workflowPrefs: "Preferências de um workflow",
  workflowSettings: "Ajustes de um workflow",
  sliceCaps: "Teto de fatias por tier",
  rolePrefs: "Preferências de um papel ou de um glob de label",
  model: "Modelo",
  modelParam: "Parâmetro de modelo",
};
const ROOT_TITLE = "Raiz do arquivo";

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const cell = (text: string) => squash(text).replace(/\|/g, "\\|");
/** GitHub's heading id: lower case, punctuation dropped, spaces to dashes. */
const anchor = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, "").replace(/ /g, "-");

export function generateConfigReference(schemaText: string, root = ROOT): string {
  const place = bookPlace(root, BOOK_PAGE);
  if (!place) throw new Error(`${BOOK_PAGE} is not listed in the book index (docs/README.md): list it before generating the page`);
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
    `# ${place.label}`,
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
    "- Um `dashboard` no arquivo do repositório é violação e não tem efeito: o dashboard é um só por usuário, para os runs de todos os repositórios.",
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
    "- Um workflow declara seus **papéis** em `meta.roles`; os nomes são as chaves de `workflows.<nome>.roles` (`wf config show` e `list_workflows` os mostram). Cada papel declara a capacidade de nuvem em `cloud`: `ok`, `read-only` ou `never` (veja \"Etapas na nuvem\" abaixo). Um papel que o workflow não declara é erro, na configuração e em `agent({ role })`.",
    "- Por papel se configura o modelo (com `params`), `timeoutMs`, `retries`, `schemaRetries`, `maxTokensPerStep`, `settingSources`, `location` e `resultVia`. A configuração vale mais que as opções da chamada `agent()`; os defaults do papel valem menos.",
    "- `labels` guarda as mesmas preferências por glob (`*` e `?`) do `label` da etapa, só para etapas **sem** papel. Vale o glob com mais caracteres literais; empate vai para o primeiro.",
    "- `WF_MODEL_<PAPEL>` troca o modelo de um papel: o nome do papel em maiúsculas, com `.` e `-` como `_` (`WF_MODEL_REVIEW`, `WF_MODEL_IMPLEMENT_LOW`), ou um apelido que o workflow declara (`WF_MODEL_LOW`). O valor `id` troca só o ID e mantém os `params`; `id[param=valor,max]` troca também os `params` (`max` liga o max mode; `id[]` limpa os `params`). Variáveis que não casam com um papel do workflow são ignoradas.",
    "- `execTimeoutMs` é uma preferência do workflow, não de um papel: o tempo máximo, em milissegundos, de um comando que o workflow roda com `ctx.exec` sem passar o próprio `timeoutMs` (padrão: 600000, 10 minutos). Passado o tempo, o motor mata o comando. Entra na configuração efetiva do `run-start`, com a origem, e vale a cada execução, resumes inclusive.",
    "- `settings` guarda os **ajustes** do próprio workflow: o workflow declara os nomes e os padrões em `meta.settings`, lê o resultado em `ctx.settings`, e só o arquivo global e o do repositório os trocam (o do repositório vale mais). Cada ajuste vale inteiro: o de uma camada de cima troca o de baixo, sem combinar campos. Não há variável de ambiente, flag nem `overrides` do chat para eles. Um nome que o workflow não declara é erro, com o caminho do campo, como um papel desconhecido. O `run-start` e o `wf config show` trazem os ajustes em vigor (`config.settings`), com a origem de cada um em `provenance` (`/settings/<nome>`). Os do `implement-issue` estão na seção \"Ajustes de um workflow\".",
    "- `maxTokensPerStep` entra na configuração efetiva e no `run-start`, e o motor o aplica **durante** a etapa: a cada turno do agente (`turn-ended`), a soma dos tokens de todas as tentativas da etapa é comparada com ele, e a etapa que passa dele (estritamente) tem o run do agente cancelado e falha com `errorKind: \"budget\"`, sem nova tentativa. O `maxTokens` do run funciona do mesmo jeito sobre o gasto do run inteiro, resumes inclusive, e cancela todas as etapas ativas. A ultrapassagem é de no máximo um turno por etapa ativa; um turno do SDK pode ser o laço inteiro do agente, e é o `timeoutMs` que freia dentro dele.",
    "",
    "## Etapas na nuvem",
    "",
    "`location` escolhe onde as etapas de um papel rodam: `local` (o padrão) ou `cloud`, um cloud agent da Cursor. Mandar código para uma VM é decisão do dono da máquina, então a nuvem só vale com três condições juntas:",
    "",
    "1. o arquivo **global** lista `cloud` em `caps.allowedLocations` (sem a chave, só `local`; `null` libera todos). Se não lista, o papel roda local e o pedido vira uma **violação**: um pull request que edita o arquivo do repositório não liga a nuvem;",
    "2. o workflow declara o papel `ok` ou `read-only` em `meta.roles`. Um papel `never` na nuvem é erro de configuração, recusado antes do run (e uma etapa de papel `read-only` que pode escrever falha antes de gastar). `location` só vale em papéis: num glob de `labels` é erro;",
    "3. se a etapa escreve (as `tools` dela não são só de leitura), o papel não é `read-only`: a etapa que escreve roda na nuvem só num papel `ok`, e o trabalho dela volta para o worktree (veja \"Etapas que escrevem\").",
    "",
    "Antes da etapa o motor empurra o estado do worktree da etapa, o não commitado inclusive, como uma branch descartável `wf/cloud-snapshot/<run>/<id>` para o remote `cloud.remote` (padrão `origin`), e a apaga quando a etapa termina, de qualquer jeito que termine. O cloud agent só enxerga o que foi empurrado. **CI:** cada snapshot é um push, e uma pipeline que roda em toda branch rodaria a cada etapa. Exclua o prefixo `wf/cloud-snapshot/` (ou `wf/**`) da pipeline do remote, ou aponte `cloud.remote` para um fork. A etapa precisa de um plano da Cursor com Cloud Agents e de um code host conectado com acesso de escrita.",
    "",
    "Uma etapa na nuvem é um subconjunto estrito de uma local: o cloud agent não recebe custom tools, allowlist de tools nem camadas de configuração (o motor avisa que as `settingSources` são ignoradas), o memo não vale, e a saída estruturada vem de um bloco `json` no fim da resposta, validado com o mesmo Ajv e corrigido por follow-ups dentro dos `schemaRetries` (ou do arquivo `result.json`, com `resultVia: \"artifact\"`: veja \"Resultado estruturado\"). Tokens e custo vêm do uso do cloud agent e entram nos mesmos tetos. O `step-start` e o `step-end` do log trazem `location`. Uma branch de snapshot que ficou para trás (o processo morreu entre o push e a exclusão, ou o remote recusou apagá-la) é varrida pelo `wf gc`, no remote `cloud.remote`: sai quando o run que a fez é deste repositório, nenhum processo o executa e o último evento dele tem mais de `gcSnapshotGraceHours` horas (padrão 24, em `workflows.implement-issue.settings`: o cloud agent que o processo morto iniciou pode ainda estar partindo da branch); senão fica, com o motivo no plano. A de um run cortado no meio da etapa dona dela fica por `gcFailedAfterDays` dias, e a de um run cancelado sem limite (o gc também mantém o run), porque o resume reanexa ao agente e traz o trabalho dessa branch. A que um crash deixou também é apagada quando o resume reanexa ao agente da etapa.",
    "",
    "**Etapas que escrevem.** O cloud agent trabalha na própria branch de snapshot (`workOnCurrentBranch`, sem PR) e commita nela; o prompt da etapa ganha a instrução de commitar ali, mesmo que o prompt do workflow, escrito para um agente local, diga para não rodar comandos git, e de não criar outra branch, não reescrever o histórico e não abrir PR. Quando o run termina, o motor busca a branch e avança o worktree até ela (fast-forward: arquivos, índice e branch atual), e só então apaga o snapshot. O worktree termina limpo na árvore do agente. Se o worktree tinha mudanças não commitadas, o commit de snapshot que as guarda (`wf: snapshot of the worktree for ...`) passa a fazer parte do histórico local, porque é nele que o agente se apoiou; com o worktree limpo, o snapshot é o próprio `HEAD` e o histórico ganha só os commits do agente. Os comandos que o workflow roda depois com `ctx.exec` (a suíte de testes do TDD, por exemplo) rodam aqui, no worktree já avançado.",
    "",
    "Trazer o trabalho de volta é um fast-forward ou nada. O motor recusa, sem mudar nada no worktree, e a etapa falha (sem nova tentativa, mesmo com `retries` sobrando: outra pagaria um agente novo) quando: a branch do agente deixou de conter o snapshot de onde ele partiu (ele reescreveu o histórico); a branch local andou enquanto o agente trabalhava (um commit, um reset); ou os arquivos do worktree já não são o que foi empurrado, caso em que trazer o trabalho sobrescreveria as mudanças feitas nesse meio tempo; ou o agente adiciona um arquivo num caminho onde o worktree tem um que o git ignora (o snapshot não o guarda, e o avanço o sobrescreveria). Uma etapa na nuvem recusada assim não deixa nada para desfazer no worktree, então o `revertOnRetry` da chamada e o cancelamento não o tocam: o que a pessoa mudou nesse meio tempo fica. Se o avanço falha depois de começar a mexer no índice e nos arquivos, o motor devolve o worktree ao que era antes da etapa (`reverted` no `step-end`); a branch só anda por último. O agente que não commitou nada não muda nada, e o motor avisa: a etapa que escreve precisa commitar o trabalho. Se o run do agente informa que empurrou só para outra branch que não a de snapshot, a etapa falha dizendo qual (o trabalho dele não está na branch a que o worktree avança), e essa branch fica no remote para ser apagada à mão.",
    "",
    "**Resultado estruturado.** `resultVia` escolhe como uma etapa na nuvem do papel entrega o resultado estruturado (só roles, e só vale na nuvem: no local o resultado vem de uma tool). `json-block` (o padrão) lê o último bloco de código `json` da resposta final. `artifact` pede ao agente que salve o resultado no arquivo `result.json` dos artefatos dele (`/opt/cursor/artifacts/result.json`), e o motor o baixa depois do run (`listArtifacts` e `downloadArtifact` do SDK); serve quando ler o resultado do texto se mostra pouco confiável. Nos dois casos o resultado é validado contra o schema da etapa, com follow-ups dentro dos `schemaRetries`. Falta conferir com a API real onde o agente grava o arquivo e como a API lista o caminho (a doc só diz que ele é relativo ao diretório `artifacts/` do workspace): o motor aceita `result.json`, `artifacts/result.json` e `/opt/cursor/artifacts/result.json`.",
    "",
    "**Ciclo de vida.** O motor grava o id do cloud agent no log (evento `cloud-agent`) assim que o agente existe. Se o processo morre e o run é retomado com o mesmo `runId`, a etapa reanexa ao agente que ainda roda, em vez de criar outro, e usa a resposta do run que ele já tinha (ou a que ele deu enquanto ninguém olhava). Cancelar um run que está executando cancela os runs dele na nuvem; um run cujo processo já morreu não tem a quem cancelar (o cancelamento, o do dashboard inclusive, não chama a API da Cursor): retome-o com o mesmo `runId` e cancele, ou o agente na nuvem termina por conta própria (o mesmo vale para o agente de uma etapa que o resume não chega a executar). O cliente do SDK desiste de esperar um run da nuvem depois de duas horas: o motor pergunta à nuvem e, se o run continua, espera de novo; o `timeoutMs` da etapa é quem a limita. Se o agente deixou de existir na nuvem (404), a etapa cria outro e avisa; se não dá para falar com a nuvem, a tentativa falha e a seguinte reanexa de novo, sem criar outro.  Um run reanexado não tem stream: o log não guarda o que o agente fez no intervalo (só a resposta final dele entra, como uma mensagem do agente), e os tetos de tokens ao vivo só atuam quando o run termina.",
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
  out.push("---", "", place.footer);
  return `${out.join("\n").trimEnd()}\n`;
}

if (isEntryPoint(import.meta.url)) {
  const page = generateConfigReference(readFileSync(CONFIG_SCHEMA, "utf8"));
  process.exitCode = writeGeneratedPage({ root: ROOT, path: CONFIG_PAGE, page, script: "docs:config", check: process.argv.includes("--check") });
}
