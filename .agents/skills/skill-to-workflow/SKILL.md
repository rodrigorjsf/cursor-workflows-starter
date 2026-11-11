---
name: skill-to-workflow
description: Converte um fluxo feito de skills e subagents (.agents/skills, .cursor/skills, .claude/skills, .codex/skills + .cursor/agents, .claude/agents, .codex/agents) em um workflow determinístico em workflows/*.ts ou .agents/workflows/*.ts. Use quando o usuário digitar /skill-to-workflow e indicar as skills ou subagents de referência.
disable-model-invocation: true
---

# Converter skills e subagents em workflow

**Entrada:** caminhos para um ou mais `SKILL.md` (`.agents/skills/`, `.cursor/skills/`, `.claude/skills/`,
`.codex/skills/`), arquivos de subagent (`.cursor/agents/*.md`, `.claude/agents/*.md`, `.codex/agents/*.md`) e, se
existirem, instruções (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`), comandos ou hooks que participam do fluxo.

**Saída:** `workflows/<nome>.ts` (dentro do kit) ou `.agents/workflows/<nome>.ts` (num repositório que usa o kit
instalado fora), `test/<nome>.test.ts` e um relatório de conversão no chat.

Antes de começar, carregue a skill `workflow-authoring` (a API do runtime e as regras) e leia
`docs/08-custos-e-cache.md` (práticas de custo e cache, usadas no passo 4).

## Passo 1: inventário (só leitura)

Leia cada arquivo indicado e tudo o que ele referencia: scripts, templates, outros agentes e MCP servers. Monte esta tabela:

| Unidade | Caminho | Tipo | Gatilho atual | Harnesses que descobrem hoje | Entradas | Saídas | Tools | Modelo | Efeitos externos |
|---|---|---|---|---|---|---|---|---|---|

Para "Harnesses que descobrem hoje", use esta regra:

- **`.agents/skills/`**: Cursor e Codex. **Não** o Claude Code, que não lê nada sob `.agents/`.
- **`.claude/skills/`**: Claude Code, mais o Cursor por compatibilidade.
- **`.cursor/agents/`**: só o Cursor.
- **`.claude/agents/`**: Claude Code, mais o Cursor por compatibilidade. Nas runs do SDK (as etapas), porém, a
  doc só cita `.cursor/agents/*.md`.

O lado do Cursor está nas páginas de [skills](https://cursor.com/docs/skills#skill-directories) e de
[subagents](https://cursor.com/docs/subagents#file-locations) [DOC] (acesso em 2026-11-11). O do SDK está na
[referência TypeScript](https://cursor.com/docs/sdk/typescript) [DOC].

Essa coluna mostra o que hoje só funciona num harness e passa a funcionar nos dois depois da conversão, porque o
workflow é disparado pelo mesmo MCP server.

Os campos vêm destas fontes:

- **Subagent**:
  - `name`, `description`, `model` e o corpo como prompt.
  - No Cursor, `readonly`/`is_background`. `model: inherit` (o default) usa o modelo do agente pai
    ([DOC](https://cursor.com/docs/subagents#configuration-fields)). Nas runs do SDK, a doc não lista `readonly` nem
    `is_background`, nem em `.cursor/agents/*.md` (só `name`, `description` e `model`) nem no `agents` inline. Por
    isso o passo 3 traduz `readonly` em allowlist de `tools`.
  - No Claude Code, `tools`/`disallowedTools`, `permissionMode` (ignorado em subagents de plugin), `skills`,
    `maxTurns`, `isolation: worktree` e `effort`. `model: inherit` usa o modelo da **conversa principal**, que num
    subagent aninhado pode não ser o do pai. Um `model` passado na invocação tem precedência, e com
    `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` ligado o Claude Code ignora o campo
    ([DOC](https://code.claude.com/docs/en/sub-agents)).
- **Skill**:
  - os passos numerados, as condições ("se X, faça Y") e os scripts chamados.
  - `disable-model-invocation`, que diz se a skill era explícita ou dependia do modelo para disparar. Com `true`,
    só o usuário dispara, com `/nome`, no Cursor ([DOC](https://cursor.com/docs/skills#disabling-automatic-invocation))
    e no Claude Code ([DOC](https://code.claude.com/docs/en/skills#control-who-invokes-a-skill)).

## Passo 2: achar as decisões implícitas

Liste toda decisão que hoje **o modelo** toma. Sinais típicos:

- "quando relevante", "se necessário", "use o subagent X para…" (delegação decidida pelo modelo);
- "repita até…" sem número máximo;
- "verifique se os testes passam" (verificação feita por quem gerou o código);
- escolha de modelo implícita, quando tudo herda o modelo do chat.

Para cada decisão, proponha a regra em código que a substitui: um campo, uma label, uma contagem, um exit code ou
um schema. Se não houver regra objetiva possível, ela vira uma etapa `ctx.agent` com `schema` (um classificador
barato), e o **código** age sobre a resposta.

## Passo 3: mapear para o runtime

| Origem | Destino |
|---|---|
| Instruções gerais (`CLAUDE.md`, `.cursor/rules/`) usadas pelo fluxo | Mova o que for comum para `AGENTS.md`, que as etapas carregam via `settingSources: ["project"]`. Deixe no prompt da etapa só o que é específico dela |
| Passo de skill executado pelo modelo | `ctx.agent(prompt, { schema, tools, model })`. O prompt é o texto do passo mais as entradas explícitas |
| Subagent chamado por delegação | `ctx.agent(corpoDoSubagent + tarefa, { model, tools })`. `readonly: true` vira `tools: ["read","grep","glob","ls"]` |
| Vários subagents independentes | `ctx.parallel` (barreira) ou `ctx.pipeline` (por item) |
| Script chamado pela skill (lint, testes, build) | `execFileSync` no workflow; o resultado decide o próximo passo |
| "Repita até passar" | `for (let round = 1; round <= N && !ok; round++)` |
| Revisão/crítica | Etapa separada com modelo próprio e schema `{findings, severity}`; o código decide se bloqueia. Revisor que falha (`null`) encerra o run com status explícito; depois de corrigir, revise de novo |
| Hook `stop`/`subagentStop` com `followup_message` (loop) | Laço explícito no workflow; o hook deixa de ser necessário |
| Efeito externo (commit, PR, comentário) | Código no fim, depois das verificações |
| Subagent que o workflow quer delegar *dentro* de uma etapa | `agents: { nome: { description, prompt, model } }` na opção da etapa |
| Claude Code `isolation: worktree` | `git worktree add` no código e `cwd` da etapa apontando para ele |
| Claude Code `maxTurns` | `timeoutMs` e `retries` da etapa (o SDK não expõe teto de turnos) |
| Claude Code `effort` | `model.params` (ex.: `[{ id: "reasoning_effort", value: "high" }]`), se o modelo oferecer; confira em `npm run models` |
| Claude Code `tools` / `disallowedTools` | `tools` / `disallowedTools` do SDK (nomes diferentes: `Read`→`read`, `Bash`→`shell`, `Edit`/`Write`→`edit`) |

**Modelos:** troque `inherit` por um tier explícito. Use um modelo barato para etapas mecânicas e de leitura e reserve
o modelo de fronteira para planejamento difícil e revisão. Confirme os IDs com `npm run models`.

## Passo 4: otimizar custo (obrigatório)

Antes de gerar, aplique a cada etapa o checklist de custo de `docs/08-custos-e-cache.md` §6. Registre a decisão
de cada item numa tabela:

| Etapa | Modelo (tier) | `tools` | `settingSources` | `memo` | Prompt fixo → dados | Schema mínimo | Laço/timeout |
|---|---|---|---|---|---|---|---|

Regras que valem sempre:

- **Decisão objetiva vira código**, não etapa de agente. É a maior economia.
- **Etapa só de leitura:** `tools` só de leitura + `memo: true`.
- **Etapa que não precisa do repositório** (classificar, resumir, revisar texto): `settingSources: []` ou
  `["team","mdm"]`. A camada `project` carrega `AGENTS.md`, regras, hooks e tools do MCP do projeto em toda
  chamada. `["team","mdm"]` tira o `AGENTS.md` e mantém os hooks do time e MDM, mas o SDK ainda carrega as skills
  (58 nos dois casos, medido); só `[]` as corta, e aí saem também os hooks do time e MDM
  (`docs/research/verificacoes-locais.md` §7).
- **Sem `"task"` na allowlist**, salvo se a etapa precisa delegar. O Cursor põe nome e descrição de cada subagent
  custom na descrição da tool Task, e o contexto fixo cresce com o número deles: o catálogo de subagents ainda não
  tem teto nem corte, ao contrário do de skills. A fonte é um relato sobre o IDE no
  [fórum](https://forum.cursor.com/t/162001) [FÓRUM], com resposta provavelmente da equipe do Cursor (2026-05-31).
  A doc diz só que a descrição aparece nas dicas da Task ([DOC](https://cursor.com/docs/subagents#configuration-fields)).
  Nenhuma fonte diz se os subagents embutidos (`explore`, `browser`) entram nessa lista.
- **Instruções da skill original viram constantes** no topo do módulo, e o prompt é `INSTRUÇÕES + dados`. O
  prefixo estável ajuda o cache do provedor e mantém journal e memo estáveis.
- **O corpo de um subagent vira instruções da etapa.** O que era `model: inherit` ganha tier explícito, e o modelo
  de fronteira fica só onde se justifica.
- **Logs e diffs são truncados** antes de entrar no prompt. O output pedido é só o que o código lê.
- **Fan-out só de itens independentes;** itens pequenos são agrupados.

Depois, **estime o custo por caminho**: para cada combinação de ramos (ex.: LOW sem review; HIGH com review e uma
correção), conte as etapas de agente e o modelo de cada uma. Compare com o fluxo original, em que tudo rodava no
modelo do chat, com delegações que repetem o contexto fixo.

## Passo 5: gerar

1. Escreva o workflow seguindo `workflow-authoring`, com `meta.whenToUse` copiado e adaptado da
   `description` da skill original.
2. Escreva `test/<nome>.test.ts` com o fake SDK, cobrindo cada ramo criado no passo 2.
3. No topo do workflow, comente a estimativa de custo por caminho do passo 4.
   Defina também **o que é entregar**: os `status` de retorno (`done` e os de falha) e as métricas de resultado e
   de dificuldade emitidas com `ctx.metric` (ver `docs/09-observabilidade.md` §6). Dê `label` a toda etapa.
4. Rode `npm run typecheck` e `npm test` e corrija até passar.
5. **Não apague** as skills e os subagents originais. Sugira ao usuário marcar a skill antiga com
   `disable-model-invocation: true`, ou trocar o corpo dela por "use /run-workflow <nome>".

## Passo 6: relatório no chat

- Tabela do passo 1 e lista de decisões implícitas, com a regra adotada para cada uma.
- **Custo:** a tabela do passo 4, a estimativa por caminho e o que mudou em relação ao original (etapas
  eliminadas por código, modelos rebaixados, etapas com memo, contexto reduzido).
- O que **não** foi convertido e por quê: por exemplo, uma interação com o humano no meio do fluxo. O runtime não
  pausa para perguntar; divida em dois workflows ou receba a resposta por `args`.
- Paridade: se o fluxo original era do Claude Code, aponte o que muda no Cursor (formato dos hooks, `loop_limit`,
  subagents lidos de `.claude/agents/`, MCP em cloud). Em cloud, os MCP servers vêm primeiro do `send` (que
  substitui os do `create`, sem somar) ou do `create`, depois do usuário e do time em cursor.com/agents;
  `local.settingSources` não vale em cloud ([DOC](https://cursor.com/docs/sdk/typescript)).
- O comando para o primeiro teste real com tetos baixos:
  `npm run wf -- run <nome> --args '{...}' --max-cents 100 --max-tokens 2000000`. Passe os dois: em uso cobrado
  por request (planos legados e alguns Enterprise), `rawCostCents` vem 0, o teto em centavos não enxerga nada e
  só o de tokens protege. Depois desse run, compare o custo por etapa com a estimativa (`npm run stats` ou
  `npm run dash`) e ajuste os tiers. As duas etapas mais caras são as primeiras candidatas. Com alguns runs
  acumulados, compare custo por entrega com o fluxo original.
