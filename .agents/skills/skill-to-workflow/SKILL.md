---
name: skill-to-workflow
description: Converte skills e subagents existentes em um workflow determinístico deste kit, com teste offline e relatório de custo.
disable-model-invocation: true
---

# Converter skills e subagents em workflow

**Entrada:** caminhos para um ou mais `SKILL.md` (`.agents/skills/`, `.cursor/skills/`, `.claude/skills/`,
`.codex/skills/`, ou uma skill de terceiros num cache de plugin ou noutro repositório), arquivos de subagent
(`.cursor/agents/*.md`, `.claude/agents/*.md`, `.codex/agents/*.md`) e, se existirem, instruções (`AGENTS.md`,
`CLAUDE.md`, `.cursor/rules/`), comandos ou hooks que participam do fluxo.

**Saída:** `workflows/<nome>.ts` neste kit, onde typecheck e testes rodam, com prompts e checagens numa pasta
`workflows/<nome>/` quando o módulo cresce; `test/<nome>.test.ts`; `CREDITS.md` quando a origem é de terceiros; e um
relatório de conversão no chat. Se o fluxo é de outro repositório (kit instalado fora), o passo 5 termina copiando o
workflow para `.agents/workflows/` de lá. A conversão de referência é `workflows/implement-issue.ts` (skills `tdd`,
`codebase-design`, `code-review` e `pr`; o cabeçalho resume as decisões), com `test/implement-issue.workflow.test.ts`.

Antes de começar, carregue a skill `cursor-workflow-authoring`: a API do runtime e as regras que os passos 3 a 5
aplicam.

## Passo 1: inventário (só leitura)

Leia cada arquivo indicado e tudo o que ele referencia: scripts, templates, outras skills (a `tdd` chama a
`codebase-design`), os arquivos de referência ao lado do `SKILL.md`, outros agentes, MCP servers e, numa skill de
terceiros, a licença e os créditos dela. Monte esta tabela:

| Unidade | Caminho | Tipo | Gatilho atual | Harnesses que descobrem hoje | Entradas | Saídas | Tools | Modelo | Efeitos externos |
|---|---|---|---|---|---|---|---|---|---|

Para "Harnesses que descobrem hoje", use a matriz de `docs/04-invocacao-no-cursor-ide.md` (§ Onde cada harness
procura cada coisa) e confira se `.claude/skills/` tem links para `.agents/skills/` (`scripts/link-claude-skills.sh`):
com eles, o Claude Code também descobre a skill. Numa skill de plugin ou de outro repositório, anote onde ela está
instalada e qual harness a carrega. Essa coluna alimenta a paridade do relatório (passo 6).

Os campos vêm destas fontes:

- **Skill**: os passos numerados, as condições ("se X, faça Y"), os scripts chamados e `disable-model-invocation`
  (se a skill era explícita ou dependia do modelo para disparar).
- **Subagent**: `name`, `description`, `model` e o corpo como prompt, mais os campos de cada harness (seção
  "Subagent de origem" de [ORIGEM.md](ORIGEM.md)).

Se a origem conversa com o usuário, cita outra skill, tem arquivos de referência ao lado do `SKILL.md` ou leitura
condicional ("leia X, se existir"), dispara sub-agents em paralelo, é de terceiros ou inclui um subagent, leia a
seção do caso em [ORIGEM.md](ORIGEM.md) antes do passo 2.

Pronto quando todo arquivo que as entradas referenciam tem uma linha na tabela ou está citado na linha de quem o
referencia.

## Passo 2: achar as decisões implícitas

Liste toda decisão que hoje **o modelo** toma. Sinais típicos:

- "quando relevante", "se necessário", "use o subagent X para…" (delegação decidida pelo modelo);
- laço sem teto: "repita até…", "corrija até passar";
- "verifique se os testes passam" (verificação feita por quem gerou o código);
- regra imperativa do processo que o modelo policia sozinho ("red antes de green", "só toque arquivos de teste",
  "não junte os relatórios"): vira **invariante** conferida pelo código entre etapas;
- "confirme com o usuário", "pergunte": vira `args`, **checkpoint** ou fica como skill (seção "Conversa com o
  usuário" de [ORIGEM.md](ORIGEM.md));
- escolha de modelo implícita, quando tudo herda o modelo do chat.

Para cada decisão, proponha a regra em código que a substitui: um campo, uma label, uma contagem, um exit code ou
um schema. Se não houver regra objetiva possível, ela vira uma etapa `ctx.agent` com `schema` (um classificador
barato), e o **código** age sobre a resposta.

Pronto quando toda condicional, laço, delegação, verificação, regra imperativa, pedido ao usuário e escolha de
modelo dos passos e das `description` do inventário tem uma linha com a regra adotada.

## Passo 3: mapear para o runtime

As receitas citadas estão em `docs/05-escrevendo-workflows.md` (seção Receitas).

| Origem | Destino |
|---|---|
| Instruções gerais (`CLAUDE.md`, `.cursor/rules/`) usadas pelo fluxo | O que for comum vai para `AGENTS.md`, que as etapas que escrevem carregam pelo default do engine (`["project","team","mdm"]`). Etapas só de leitura ficam com `[]` e recebem no prompt os arquivos que importam |
| Passo de skill executado pelo modelo | `ctx.agent(prompt, { schema, tools, model })`. O prompt é o texto do passo, numa constante de instruções, mais as entradas explícitas |
| Subagent chamado por delegação | `ctx.agent(corpoDoSubagent + tarefa, { model, tools })`; a condição da delegação vira código (passo 2) |
| Vários subagents independentes, ou sub-agents que a própria skill dispara em paralelo | `ctx.parallel` (barreira) ou `ctx.pipeline` (por item); o código confere o mínimo de resultados, e a agregação da skill vira código ou etapa juiz |
| Outra skill citada pela skill ("chame a skill X") | Seção "Outra skill citada e arquivos de referência" de [ORIGEM.md](ORIGEM.md) |
| Script chamado pela skill (lint, testes, build) | `execFileSync` no workflow; o resultado decide o próximo passo |
| Regra imperativa do processo | Receita "Invariantes entre etapas" |
| Aprovação humana de um resultado intermediário | Receita "Checkpoint em dois runs" |
| Laço sem teto | `for (let round = 1; round <= N && !ok; round++)` |
| Revisão/crítica | Receita "Review em eixos": uma etapa por eixo, schema com as categorias de achado da própria skill, roteamento no código |
| Hook de fim de turno que reabre o laço (Cursor: `stop`/`subagentStop` com `followup_message`; Claude Code: `Stop`/`SubagentStop` com `decision: "block"` e `reason`, ou exit 2) | Laço explícito no workflow, com teto; o hook deixa de ser necessário |
| Efeito externo (commit, PR, comentário) | Código no fim, depois das verificações. A saída real que a skill pede no artefato (teste falhando, depois passando) é capturada pelo código; o agente escreve só o texto de julgamento |
| Subagent que o workflow quer delegar *dentro* de uma etapa | `agents: { nome: { description, prompt, model } }` na opção da etapa, com `"task"` na allowlist de `tools` (é a tool que dispara os subagents) |
| Campo de frontmatter de subagent (`readonly`, `model: inherit`, `isolation`, `maxTurns`, `effort`, `tools`…) | Seção "Subagent de origem" de [ORIGEM.md](ORIGEM.md) |

Pronto quando toda linha do inventário e toda decisão do passo 2 têm destino nesta tabela ou numa tabela de
[ORIGEM.md](ORIGEM.md), ou entram na lista do que não foi convertido (passo 6), com o motivo.

## Passo 4: otimizar custo (obrigatório)

Antes de gerar, aplique a cada etapa **todos** os itens do checklist de custo de `docs/08-custos-e-cache.md` §6 e
registre a decisão numa tabela, uma linha por etapa:

| Etapa | Modelo (tier) | `tools` | `settingSources` | `memo` | Prefixo estável | Schema mínimo | Laço/timeout |
|---|---|---|---|---|---|---|---|

Item do checklist sem coluna (condição de etapa opcional, truncamento, fan-out, `mcpServers`, teto padrão) entra
como nota da linha; item que não se aplica leva `n/a` e o motivo. O primeiro run real fica para o usuário (passo 6).

Depois, **estime o custo por caminho** (`docs/08-custos-e-cache.md` §7): para cada combinação de ramos (ex.: LOW
com uma fatia; HIGH com três desenhos, juiz e uma correção), conte as etapas de agente e o modelo de cada uma, no caso típico e no
pior caso (todas as novas tentativas e correções). Compare com o fluxo original, em que tudo rodava no modelo do
chat, com delegações que repetem o contexto fixo.

Pronto quando toda etapa tem uma linha, toda célula tem uma decisão ou `n/a` com motivo, e todo caminho tem
estimativa.

## Passo 5: gerar

1. Escreva `workflows/<nome>.ts` seguindo `cursor-workflow-authoring`, inclusive "Observabilidade" e os itens
   Custo e Testes offline de "Antes de entregar" (o run real fica para o usuário, passo 6). No topo, comente a tabela e a estimativa de custo do passo 4. `meta.whenToUse` é lido pelo agente do
   chat: escreva-o com os gatilhos do fluxo original (a `description` da skill, se ela era invocada pelo modelo; o
   pedido que levava o usuário a digitar `/nome`, se não era; o trabalho pedido, quando várias skills viram um
   fluxo só).
2. Escreva `test/<nome>.test.ts` com os casos de "Testes offline" em "Antes de entregar" de
   `cursor-workflow-authoring`; os ramos são os que as regras do passo 2 criaram no código.
3. Rode `npm run typecheck` e `npm test` até os dois passarem.
4. Se o fluxo é de outro repositório, copie `workflows/<nome>.ts` e, se existir, a pasta `workflows/<nome>/` para
   `.agents/workflows/` de lá, trocando `defineWorkflow({...})` e o import relativo do runtime por
   `export default { meta, defaults, budget, async run(ctx) { ... } }`, o mesmo objeto (imports só de tipo podem
   ficar), como em `docs/04-invocacao-no-cursor-ide.md` (§ Usar o kit em outros repositórios).
5. Mantenha as skills e os subagents originais intactos: apagá-los é decisão do usuário, depois de comparar os dois
   fluxos.

Pronto quando todo caso de "Testes offline" de "Antes de entregar" tem teste (os ramos são os que as regras do
passo 2 criaram no código), a última execução de `npm run typecheck` e `npm test` passou, a cópia do item 4 está em
`.agents/workflows/` do repositório de origem (fluxo de outro repositório) e os originais estão como estavam.

## Passo 6: relatório no chat

- Tabela do passo 1 e lista de decisões implícitas, com a regra adotada para cada uma.
- **Custo:** a tabela do passo 4, a estimativa por caminho e o que mudou em relação ao original (etapas
  eliminadas por código, modelos rebaixados, etapas com memo, contexto reduzido).
- O que **não** foi convertido e por quê: por exemplo, uma conversa aberta com o usuário, que fica como skill.
- **Créditos:** origem, versão, autor e licença de cada skill de terceiros e de quem ela credita.
- **Paridade:** pela coluna "Harnesses que descobrem hoje", onde o fluxo rodava e onde passa a rodar (todo harness
  com o MCP `workflows`). Para cada harness que não descobria a origem, diga o que ele precisa para disparar o
  workflow (no Claude Code: aprovar o servidor do `.mcp.json` e, para `/run-workflow`, os links de
  `scripts/link-claude-skills.sh`). Se a origem tinha hooks do Claude Code em `.claude/settings.json`, avise que os
  `PreToolUse` deles também rodam nas etapas com `settingSources: ["project"]` (`docs/04-invocacao-no-cursor-ide.md`,
  § Paridade Cursor × Claude Code).
- **Original:** numa skill do próprio repositório que o modelo ainda invoca, sugira `disable-model-invocation: true`
  ou trocar o corpo por "use /run-workflow <nome>".
- **Primeiro run real**, que é do usuário porque o workflow pode ter efeitos externos: o comando de "Um run real com
  tetos baixos" em "Antes de entregar" (`cursor-workflow-authoring`), com `--cwd` no repositório de origem quando o
  fluxo é de outro repositório (numa cópia descartável dele, se há efeito externo).
  Depois, compare o custo por etapa com a estimativa (`npm run stats` ou `npm run dash`) e ajuste os tiers,
  começando pelas duas etapas mais caras. Com alguns runs acumulados, compare custo por entrega com o fluxo
  original.

Pronto quando o relatório traz os sete itens acima, e o item que não se aplica (Créditos numa origem do próprio
repositório, Original numa skill de terceiros) diz `n/a` e o motivo.
