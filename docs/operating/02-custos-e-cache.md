# 5.2 · Custos, cache e boas práticas

Este documento reúne o que torna um workflow barato sem perder a garantia de execução. É a referência da
seção de custo das skills `cursor-workflow-authoring` e `/skill-to-workflow`.

> **Marcas de confiança:**
> - **[PKG]**: lido no pacote `@cursor/sdk@1.3.1`.
> - **[DOC]**: doc oficial. Quando há link, ele aponta para a página oficial (acesso em 2026-11-11).
> - **[FÓRUM]**: relato no fórum oficial do Cursor (indica quando a equipe respondeu).
> - **[TESTE]**: medido contra a API real em 2026-11-11
>   ([docs/research/verificacoes-locais.md](../research/verificacoes-locais.md)).
> - **[I]**: inferência.
>
> Preços e comportamento de cache mudam com frequência. Confira a página
> [*Models & Pricing*](https://cursor.com/docs/models-and-pricing) do Cursor antes de fazer contas.

## 1. De onde vem o custo

Cada chamada de um agente envia ao modelo, nesta ordem aproximada:

1. **Contexto fixo do harness:** system prompt do Cursor, definições de tools (nativas, MCP e custom tools),
   regras (`AGENTS.md`, `.cursor/rules`), descrições de skills e descrições de subagents.
2. **O prompt da etapa.**
3. **O histórico da conversa** (em agentes com vários turnos), incluindo os resultados de tools.
4. A **saída** gerada, que é o token mais caro.

Um agente faz vários turnos dentro de uma etapa (ler arquivo, rodar comando, editar…), e cada turno reenvia o
contexto acumulado. A maior parte do custo de um agente de código costuma ser **releitura de contexto**, não
escrita [I].

**Quanto custa o Auto.** No catálogo do SDK, o Auto é o ID `default` (alias `auto`); `auto-low` não existe
[[TESTE]](../research/verificacoes-locais.md). O Auto **não** tem preço fixo por token. Ele tem três modos: Cost,
Balance e Intelligence [[DOC]](https://cursor.com/docs/models-and-pricing#auto-modes)
[[DOC]](https://cursor.com/help/models-and-usage/available-models):

| Modo do Auto | Como é cobrado |
|---|---|
| Cost (o Auto clássico) | Como requisição de modelo Cursor, do pool incluído (semanal), qualquer que seja o modelo que atende. Sem *Cursor Token Rate* |
| Balance e Intelligence (Teams/Enterprise com Cursor Router ligado) | Preço de tabela do modelo roteado. Rota para modelo Cursor: sai do pool semanal. Rota para modelo de terceiro: uso de terceiro, pago do crédito pré-pago, mais a *Cursor Token Rate* (salvo isenção) |

Planos individuais só têm o modo Cost. As páginas divergem num ponto: a de
[Cursor Router](https://cursor.com/help/models-and-usage/cursor-router) e a do
[SDK](https://cursor.com/docs/sdk/typescript) dizem que **todos** os modos, Cost inclusive, cobram pelo preço de tabela
do modelo roteado. O preço por token de cada modelo está na tabela por modelo da página de preços.

Em Teams/Enterprise, requisições **elegíveis** a modelos de terceiros pagam também a *Cursor Token Rate*: US$ 0,25
por milhão sobre input, output e tokens em cache. Ficam isentos os modelos Cursor (Grok, Composer), o modo Cost e os
modelos de terceiros cujo cache read custa **estritamente** menos de US$ 0,10/M em todas as faixas de preço. Um
modelo a exatamente US$ 0,10/M paga. A isenção vale também com chave própria (BYOK), e planos individuais não pagam
[[DOC]](https://cursor.com/docs/models-and-pricing#cursor-token-rate)
[[DOC]](https://cursor.com/help/models-and-usage/token-rate). Segundo a Admin API, contas enterprise cobradas por
requisição também não têm a taxa [[DOC]](https://cursor.com/docs/account/teams/admin-api).

## 2. Que caches existem, e quem controla cada um

| Camada | Quem controla | O que economiza | Como aproveitar |
|---|---|---|---|
| **Cache de prompt do provedor** (prefixo idêntico) | O Cursor e o provedor, de forma automática. O SDK **não** expõe opção de cache, só mede `cacheReadTokens`/`cacheWriteTokens` [PKG] | Input relido sai pelo preço de cache read | Prefixo estável (§4.4) e conversas curtas (§4.5) |
| **Cache entre turnos de um agente** | O SDK, automático por agente: uma chave estável mantém "o cache de blobs entre turnos do servidor" [PKG] | Retries e re-prompts na mesma conversa | O re-prompt de schema do kit já roda na mesma conversa |
| **Journal do run** | Este kit, automático | Etapas já concluídas ao retomar um run | `--resume <runId>` / `start_workflow {resumeRunId}` |
| **Memo entre runs** | Este kit, opcional (`memo: true`) | Etapa de leitura repetida com o repositório no mesmo estado: **custo zero** | §4.1 |
| Cache do scan do workspace | Config do SDK: `workspaceScanCacheTtlMs`, default 20 s, ou `CURSOR_RIPWALK_CACHE_TTL_MS` [PKG] | Tempo e CPU para achar regras e skills, não tokens | Aumente num MCP server de vida longa sobre um checkout estável |

**Diferença em relação ao Claude Code.** Nos dynamic workflows do Claude Code, dois agentes com o mesmo modelo,
nível de esforço (effort), tipo de agente, tools, schema de saída e cwd montam o **mesmo prefixo** (tools + system
prompt). Um agente que começa depois que a resposta de um irmão igual já começou lê o cache desse irmão na primeira
requisição. Quando um fan-out dispara vários agentes iguais juntos, o runtime segura todos menos o primeiro até a
resposta dele começar, por no máximo `CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS` (default `5000` ms; `0` desliga; sem
espera com `DISABLE_PROMPT_CACHING`). O cache de um agente de workflow dura 5 min por padrão, mesmo em assinatura
Claude. Ele dura 1 h com `subagentPromptCacheTtl: "1h"`, com `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h` (que vence a
setting) ou com `ENABLE_PROMPT_CACHING_1H=1`. `FORCE_PROMPT_CACHING_5M=1` vence todos, e a API cobra mais pela
gravação de cache de 1 h [[DOC]](https://code.claude.com/docs/en/workflows)
[[DOC]](https://code.claude.com/docs/en/prompt-caching) [[DOC]](https://code.claude.com/docs/en/env-vars).

No Cursor, não há controle equivalente, e a doc não diz se agentes compartilham cache de prompt: o SDK só expõe
`cacheReadTokens` e `cacheWriteTokens` [[DOC]](https://cursor.com/docs/sdk/typescript). Num *Project* do Cursor, a
equipe confirmou que workers (cloud agents filhos) e o coordenador **não** compartilham cache: cada um mantém o seu
e paga uma vez a gravação do contexto de abertura, cerca de 1% dos tokens de um worker
[[FÓRUM]](https://forum.cursor.com/t/173200) (resposta da equipe do Cursor). Para subagents da tool Task e agentes
paralelos em geral, nem a doc nem o fórum dizem o mesmo. A equipe já mostrou um chat novo no IDE lendo do cache um
prefixo gravado por outros chats do mesmo repositório [[FÓRUM]](https://forum.cursor.com/t/151439) (resposta da
equipe do Cursor).

Medido com agentes do SDK [[TESTE]](../research/verificacoes-locais.md): quatro etapas com o mesmo prompt e as mesmas
opções (`composer-2.5`, `tools: ["read"]`, `settingSources: []`), cada uma um agente novo, lendo 3 arquivos.

| Etapa | `inputTokens` | `cacheReadTokens` | Leitura |
|---|---|---|---|
| `par-1` (em `ctx.parallel`) | 11.287 | 4.160 | só o prefixo fixo |
| `par-2` (terminou 1,2 s depois da irmã) | 11.287 | 8.064 | prefixo fixo + o trecho com os arquivos, gravado pela irmã |
| `seq-1` | 11.287 | 4.160 | só o prefixo fixo |
| `seq-2` (começou depois do fim de `seq-1`) | 11.287 | 4.160 | não reaproveitou o trecho com os arquivos |

O prefixo fixo (~4,2 mil tokens) veio do cache em todo agente novo. O trecho variável foi reaproveitado uma vez em
paralelo e nenhuma em sequência; o `cacheHitRatio` do run foi 0,455. É uma amostra pequena e sem garantia. Por isso
este kit **não** promete economia de cache entre agentes. Ele mede (`cacheHitRatio`) para você decidir com dados.

## 3. Medir antes de otimizar

> Tudo o que está abaixo também fica gravado por run no banco de métricas, com histórico, views e dashboard. Veja
> [5.3 · Observabilidade](03-observabilidade.md). A análise de **faixa de contexto × custo** está lá.

Todo run devolve `spentCents`, `chargedCents` e `usage` com tokens por tipo e `cacheHitRatio`. Cada etapa emite
`step-end` com o próprio `usage`, `chargedCents` e `rawCents` (o `rawCostCents` do Cursor):

```json
{ "status": "finished", "spentCents": 0, "chargedCents": 0,
  "usage": { "inputTokens": 11260, "outputTokens": 256, "cacheReadTokens": 4480, "cacheWriteTokens": 0,
             "totalTokens": 11516, "cacheHitRatio": 0.398 } }
```

O `usage` acima é de uma run real (`composer-2.5`, lendo 4 arquivos), e `spentCents` 0 é o que essa conta
reporta, porque lá o `getUsage()` dá `feature_unavailable` [[TESTE]](../research/verificacoes-locais.md).

- **`inputTokens` já inclui cache read e cache write**, e `totalTokens` = input + output. Medido duas vezes
  [[TESTE]](../research/verificacoes-locais.md): 3.377 = 3.345 + 32 e 11.516 = 11.260 + 256, com o cache read contido
  no input. A doc Python bate com o dado; a fórmula de `totalTokens` da doc TypeScript, não. Por isso o kit usa
  `cacheHitRatio = cacheRead / input`, e a soma dos eventos `turn-ended` deu os mesmos números de
  `RunResult.usage`. Compare runs entre si, não com números de outros clientes.
- `chargedCents` é o valor cobrado: **0 para uso incluído no plano, BYOK e créditos** (credit grant)
  [[DOC]](https://cursor.com/docs/sdk/typescript). `rawCostCents` é o custo do modelo **sem desconto** [DOC]. A doc
  não diz com todas as letras que ele continua acima de zero no uso incluído no plano; o kit parte dessa leitura [I].
- **Teto em centavos.** `--max-cents` / `WF_MAX_CENTS` compara com `spentCents`: a soma, por tentativa, do maior
  entre `rawCostCents` e `chargedCents`. Antes o kit somava só `chargedCents`, que é 0 no uso incluído no plano, BYOK
  e créditos, e o teto nunca disparava no uso incluído no plano. `RunOutcome` e o estado do job expõem também
  `chargedCents`, e `ctx.budget` tem `chargedCents()` (só o cobrado).
- **Custo ainda não reportado.** O custo pode levar um momento para fechar depois do fim da run [DOC]. Se o Cursor
  ainda não reportou o custo de uma tentativa, o engine emite um `warning`: o teto em centavos não contou essa
  tentativa (o de tokens, sim).
- **Uso cobrado por request** (planos legados e alguns planos Enterprise por request): `rawCostCents` é **0**
  [[DOC]](https://cursor.com/docs/sdk/typescript)
  [[DOC]](https://cursor.com/docs/account/pricing/legacy-cursor-plans). Aí o teto em centavos fica cego, e só
  `--max-tokens` / `WF_MAX_TOKENS` protege. **Defina sempre os dois tetos.**
- **Agentes locais:** `getUsage()` é liberado por conta, aos poucos. Até lá, ele devolve `403 feature_unavailable`
  [[DOC]](https://cursor.com/docs/sdk/typescript). Nesse caso, o kit conta os tokens dessa tentativa pelos eventos
  `turn-ended`, e o teto de tokens vale. O custo fica desconhecido, e o teto em centavos não conta a tentativa. A
  doc sugere ler tokens de `run.usage` e o custo no dashboard de uso. Isso acontece em plano pago: num Premium,
  toda chamada deu `feature_unavailable`, inclusive o `Agent.getUsage(agentId)` estático depois do descarte
  [[TESTE]](../research/verificacoes-locais.md). O custo dos testes saiu só da estimativa da tabela `pricing`
  (`cost_source = estimate`, ver [5.3](03-observabilidade.md)).
- Use tokens para comparar runs.
- Rotina sugerida: rode o workflow uma vez com `--max-cents` e `--max-tokens` baixos e leia os `step-end` no stderr
  do CLI ou em `recent` do job. Ataque primeiro as **duas etapas mais caras**: costuma haver uma que relê o
  repositório inteiro, ou que roda num modelo caro sem necessidade.

## 4. Padrões, em ordem de impacto

### 4.1 Não chamar o modelo

- **Decisão objetiva é código:** label, contagem, exit code, tamanho do diff. Cada `if` que substitui um
  "decida se…" é uma chamada a menos.
- **Pule etapas condicionalmente:** plano só para MED/HIGH, review só para HIGH ou diff grande.
- **Resume pelo journal:** nunca relance um run falho do zero.
- **`memo: true` em etapas só de leitura** (`tools` só com read, grep, glob, ls, semSearch…): a mesma etapa com
  o repositório no mesmo estado (HEAD + mudanças locais + arquivos novos) devolve o resultado salvo, mesmo em
  outro run. O runtime recusa `memo` em etapa que pode escrever.

```ts
await ctx.agent(`${PLAN_INSTRUCTIONS}\n\n${issueBlock(issue)}`, {
  model: MODELS.MED, tools: ["read", "grep", "glob", "ls", "semSearch"], settingSources: [], schema: PLAN_SCHEMA, memo: true,
});
```

### 4.2 Modelo certo por etapa

- **Tier por etapa, não por workflow.** Use um modelo barato para classificar, resumir e corrigir lint, e o de
  fronteira só para planejamento difícil e review.
- **Escalone na falha:** tente com o barato, valide **com código** e repita com o tier acima só se falhar.
- **Parâmetros:** prefira variantes com raciocínio baixo para tarefas mecânicas (`model.params`, por exemplo
  `reasoning_effort`; confira em `npm run models`). Evite `maxMode` salvo necessidade.

### 4.3 Contexto fixo mínimo por etapa

O contexto fixo é pago em **toda** chamada de **toda** etapa. Ele cresce com o que o agente carrega:

| Fonte de contexto | Como reduzir |
|---|---|
| `settingSources: "project"`: `AGENTS.md`, regras, **descrições de skills**, hooks e **tools dos MCP servers do `.cursor/mcp.json`** | Por etapa, `settingSources: ["team","mdm"]` tira o `AGENTS.md` e mantém a governança, mas **não** as skills: o SDK carregou as mesmas 58 skills com ele e com `"project"` ([[TESTE]](../research/verificacoes-locais.md) §7). Só `[]` zerou as skills, e aí saem também os hooks do time e do MDM. Mesmo prompt com `shell` e `mcp`: 30,4 mil tokens de input com `"project"` × 25,5 mil com `[]` ([[TESTE]](../research/verificacoes-locais.md) §7). A origem das 58 skills não foi isolada. Para etapas só de leitura, mesmo as que leem o repositório (planejar, revisar, escrever o texto do PR; o classificar nem o lê), `[]` corta mais: no lugar do `AGENTS.md`, o código lista no prompt os arquivos de contexto que importam e existem (padrões, glossário, ADRs). Se o time exige hooks de time ou MDM em toda run, fique com `["team","mdm"]` |
| `"user"`: `~/.cursor/agents`, `~/.cursor/skills`, `~/.claude/skills`, MCP do usuário | O kit **não** carrega `user` por padrão. Um relato mostra mais de 60 subagents em `~/.cursor/agents` somando cerca de 10 mil tokens no início de cada chat (11,4 k → 1,4 k ao tirá-los da pasta). Uma resposta no fórum, provavelmente da equipe do Cursor, confirmou a causa [[FÓRUM]](https://forum.cursor.com/t/162001) |
| Tool `task`: a descrição lista nome e descrição de **todo subagent custom** (`.cursor/agents/`, `~/.cursor/agents/`). O contexto cresce linearmente com o número deles, e o catálogo de subagents não tinha limite em maio de 2026, ao contrário do de skills [[FÓRUM]](https://forum.cursor.com/t/162001) (resposta provavelmente da equipe do Cursor). A doc diz só que a descrição aparece nas dicas da tool Task [[DOC]](https://cursor.com/docs/subagents). Nenhuma fonte diz se os subagents nativos (`explore`, `browser`) entram do mesmo jeito | Use allowlist de `tools` sem `"task"`, salvo se a etapa precisar delegar |
| Definições de tools | Allowlist de `tools`. `[]` = só texto (o kit acrescenta `mcp` quando há schema) |
| MCP servers por etapa | Passe `mcpServers` só na etapa que usa |
| `AGENTS.md` longo | Mantenha curto. Instruções de uma etapa específica vão no prompt dela |

### 4.4 Prefixo estável (para o cache de prompt)

O cache do provedor reaproveita só o **prefixo idêntico**. Então:

- **Instruções fixas primeiro, dados variáveis no fim.** Declare as instruções como constantes no topo do módulo
  (`const PLAN_INSTRUCTIONS = "..."`) e monte o prompt como `INSTRUÇÕES + "\n\n" + dados`. Veja
  `packages/runtime/workflows/implement-issue.ts`.
- **Nada volátil no começo do prompt:** sem data, id de run, contador de rodada ou saída de teste antes das
  instruções. Isso também preserva o journal e o memo, que usam o prompt na chave.
- **Mesma configuração entre irmãos:** mesmo modelo, ordem de `tools`, schema e `settingSources` em etapas
  paralelas parecidas. Agentes novos com configuração idêntica leram do cache o prefixo fixo (~4,2 mil tokens)
  ([[TESTE]](../research/verificacoes-locais.md) §8; números em §2 deste doc). Que mudar qualquer um muda o prefixo
  não foi medido [I, por analogia com o Claude Code].
- **Schema estável:** o schema vira `inputSchema` da tool `submit_result`, que faz parte das definições de tools.

### 4.5 Conversas curtas

- **Um agente novo por etapa** (o padrão do kit) mantém o histórico pequeno. Cada chamada ao modelo relê do cache
  o contexto acumulado: não só a cada mensagem, mas a cada tool call, leitura ou edição dentro dela. O contexto
  também segue para as próximas mensagens do mesmo chat, então conversas longas multiplicam a conta. Usuários
  relatam contagens muito altas de cache read, até em pedidos pequenos de um prompt só num chat novo. Respostas no
  fórum explicam o mecanismo e recomendam um chat novo por tarefa
  [[FÓRUM]](https://forum.cursor.com/t/151439) [[FÓRUM]](https://forum.cursor.com/t/173469)
  [[FÓRUM]](https://forum.cursor.com/t/161676). A doc oficial não descreve esse mecanismo.
- **Reaproveite a conversa só para o que depende dela:** o re-prompt de schema, por exemplo.
- **Passe resumos entre etapas, não saídas inteiras:** use o resultado estruturado (schema) da etapa anterior e
  trunque saídas longas. O exemplo usa os últimos 4.000 caracteres da saída de teste.

### 4.6 Saídas enxutas

O output é o token mais caro. Peça só os campos que o código lê (schema mínimo) e nada de "explique seu
raciocínio" em etapas mecânicas.

### 4.7 Paralelismo consciente

N agentes em paralelo pagam N vezes o contexto fixo, e nenhuma fonte garante cache compartilhado entre eles. Num
*Project* do Cursor, a equipe confirmou que os workers **não** compartilham (§2)
[[FÓRUM]](https://forum.cursor.com/t/173200). Com agentes do SDK de configuração idêntica, o prefixo fixo (~4,2 mil
tokens) veio do cache em todo agente novo, e o trecho variável (o conteúdo dos arquivos) foi reaproveitado uma vez
entre duas etapas paralelas e nenhuma entre duas em sequência ([[TESTE]](../research/verificacoes-locais.md) §8;
números em §2 deste doc). O
cache reduz o preço de parte do contexto, sem garantia; o volume de input continua N vezes maior.

- Faça fan-out só de itens realmente independentes.
- Agrupe itens pequenos numa etapa só: um agente para 5 arquivos pequenos, em vez de 5 agentes.
- Mantenha `concurrency` baixa quando o teto de custo for apertado.

### 4.8 Limites sempre

Laços de correção com teto, `timeoutMs` por etapa, `retries` pequeno (default 1), `--max-cents` e `--max-tokens`
juntos por run (um cobre o ponto cego do outro; ver §3), um teto padrão declarado pelo workflow em `budget` (vale
quando o run não informa outro; o `implement-issue` declara 3 milhões de tokens, porque o texto da issue pode empurrar
o run para o pior caso), e polling barato no chat (modelo barato e esperas de
45–50 s; ver [2.3](../usage/03-invocacao-no-cursor-ide.md)).

## 5. Skills e subagents: o que custam no IDE e como ficam no workflow

| No IDE (skills e subagents) | No workflow convertido |
|---|---|
| As descrições das skills entram no contexto do sistema, e o agente as usa para decidir quando uma skill serve [[DOC]](https://cursor.com/docs/agent/prompting) [[DOC]](https://cursor.com/docs/skills). Exceções: com `paths` ou numa pasta de skills aninhada, a skill só aparece para arquivos que casam; com `disable-model-invocation: true`, só entra quando você digita `/skill-name`; como Custom Mode, fica no contexto a sessão toda. Coleções grandes de skills têm limite automático [[FÓRUM]](https://forum.cursor.com/t/162726) (resposta da equipe do Cursor). Recursos e referências carregam sob demanda, mas a doc não diz com todas as letras que o corpo do `SKILL.md` fica fora do contexto até a skill ser usada | Só o trecho necessário da skill entra, como **constante de instruções** da etapa (prefixo estável) |
| Nome e descrição de todo subagent custom entram na descrição da tool Task [[FÓRUM]](https://forum.cursor.com/t/162001) (resposta provavelmente da equipe do Cursor). Cada delegação abre um contexto novo e paga o contexto fixo de novo | Cada subagent vira uma etapa com modelo, tools e `settingSources` próprios e mínimos. Sem `"task"` na allowlist |
| `model: inherit`: tudo roda no modelo do chat, muitas vezes o mais caro | Modelo explícito por etapa (tier) |
| O modelo decide quantas vezes repetir | Laço com teto no código |
| Retomar = começar de novo | Journal + memo |

## 6. Checklist de custo

Use ao escrever um workflow e na etapa de otimização da `/skill-to-workflow`.

- [ ] Toda decisão objetiva é código (não é uma etapa de agente).
- [ ] Etapas opcionais têm condição explícita (tier, tamanho, flag).
- [ ] Cada etapa tem modelo explícito; o de fronteira só onde se justifica; há escalonamento na falha.
- [ ] Etapas só de leitura (classificar, planejar, revisar, escrever o texto do PR) têm `tools` só de leitura,
  `memo: true` e `settingSources: []`; as que leem o repositório recebem no prompt os arquivos de contexto que
  importam e existem. `["team","mdm"]` só quando a etapa precisa dos hooks do time ou MDM (§4.3). Etapas que
  escrevem ficam sem `settingSources`, no default do engine (`["project","team","mdm"]`).
- [ ] `tools` é uma allowlist; sem `"task"` se a etapa não delega; `mcpServers` só onde usa.
- [ ] Prompts: constante de instruções primeiro, dados no fim; nada volátil no começo.
- [ ] Schemas mínimos; nenhuma etapa mecânica pede explicação longa.
- [ ] Saídas grandes (logs, diffs) truncadas ou resumidas antes de virar prompt.
- [ ] Fan-out só de itens independentes; itens pequenos agrupados.
- [ ] Laços com teto; `timeoutMs` e `retries` definidos; teto padrão do run em `budget`.
- [ ] Estimativa de custo por caminho (§7) registrada no topo do workflow.
- [ ] Primeiro run real com `--max-cents` e `--max-tokens` baixos; `usage` por etapa revisado.

## 7. Estimar antes de rodar

Para cada caminho do workflow, no caso típico e no pior caso (ex.: no `implement-issue`, LOW com uma fatia e três
revisores; HIGH com três desenhos, juiz, cinco fatias e uma correção), liste as etapas com:

```
custo ≈ Σ etapas × turnos_estimados × (contexto_fixo + prompt + histórico_médio) × preço_input/cache
        + Σ etapas × saída_estimada × preço_output
```

Na prática, a estimativa mais confiável é empírica: rode cada caminho uma vez com teto baixo, anote `usage` e
o custo por etapa (`rawCents` e `chargedCents` do `step-end`; o `spentCents` do run soma o maior dos dois; se o
`getUsage()` não responde, a estimativa `cost_cents` da `v_attempts`, [5.3 §3](03-observabilidade.md#3-modelo-de-dados)) e
registre a faixa num comentário no topo do workflow. A `/skill-to-workflow` gera esse quadro no relatório de
conversão.

---

[← Anterior: 5.1 · Governança e custos (Cursor Teams/Enterprise)](01-governanca-e-custos.md) · [Índice](../README.md) · [Próximo: 5.3 · Observabilidade: custo, tokens, contexto e eficiência →](03-observabilidade.md)
