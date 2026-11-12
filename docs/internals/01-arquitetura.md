# 3.1 · Arquitetura

## Visão geral

```mermaid
flowchart TB
  subgraph Entradas
    CHAT["Chat do Cursor IDE<br/>/run-workflow"] --> CREG[".cursor/mcp.json<br/>habilitado em Customize"]
    CCODE["Claude Code"] --> CCREG[".mcp.json<br/>aprovação na sessão interativa"]
    TERM["Terminal / CI"] --> CLI[packages/runtime/src/cli.ts]
  end
  CREG -->|MCP stdio| MCP[packages/runtime/src/mcp-server.ts]
  CCREG -->|MCP stdio| MCP
  MCP --> JOBS[jobs.ts<br/>.workflows/jobs/*.json<br/>só a identidade do job]
  CLI --> JOBS
  CLI --> ENG
  JOBS --> ENG[engine.ts<br/>agent · parallel · pipeline · phase]
  REG[registry.ts<br/>workflows/ + .agents/workflows/] --> ENG
  ENG --> JR[run-store.ts<br/>.workflows/runs/&lt;runId&gt;/<br/>events.jsonl · journal.jsonl · run.lock]
  JOBS -.->|"estado do job: projeção do log"| JR
  ENG -->|1 linha por run| IDX[("~/.cursor-workflows/runs.jsonl")]
  ENG --> ST[structured.ts<br/>submit_result + Ajv]
  ENG -->|"Agent.create({model, local:{cwd, settingSources, customTools}})"| SDK["@cursor/sdk<br/>(loop local)"]
  SDK -->|inferência + cobrança| CUR[Backend Cursor]
  ENG -->|"execFileSync: git, gh, testes"| REPO[(Repo + worktrees)]
```

## Ciclo de uma etapa (`ctx.agent`)

0. **Antes do run:** `args` são validados contra `meta.argsSchema` (Ajv), e o ambiente recebe
   `WF_INSIDE_WORKFLOW=1`. O shell das etapas herda a marca (medido em 2026-11-11), e o CLI recusa `run`/`start`
   com ela. Os servidores do `.cursor/mcp.json` **não** herdam, porque o SDK não repassa o ambiente a eles; por
   isso o passo 4 encobre o servidor `workflows`.
1. **Chave do journal:** `sha256(prompt + {model, schema, cwd, tools, agents, settingSources})` mais o número da
   ocorrência.
   - Se a chave já estiver no journal, devolve o resultado salvo sem chamar a API.
   - Com `memo: true` (só etapas de leitura), consulta também `.workflows/memo/`, com chave na etapa e no estado do
     repositório (HEAD + mudanças locais + arquivos novos). Um acerto vale entre runs diferentes.
2. **Validação local:** etapa sem modelo, ou com `schema` cuja raiz não é `type: "object"`, falha antes de criar
   o agente.
3. **Teto** (antes de cada tentativa): se `spentCents ≥ maxCents` ou `spentTokens ≥ maxTokens`, lança
   `BudgetExceededError`.
   - `spentCents` soma, por tentativa, o maior entre `rawCostCents` (custo bruto) e `chargedCents` (cobrado). Só o
     cobrado não basta: ele é 0 para uso incluído no plano, BYOK e créditos
     [DOC](https://cursor.com/docs/sdk/typescript#agentgetusage) (acesso em 2026-11-11), e o teto nunca dispararia
     no uso do plano.
   - Em uso cobrado por request (planos legados e alguns Enterprise por request), `rawCostCents` vale 0
     [DOC](https://cursor.com/docs/sdk/typescript#agentgetusage). Aí o teto em centavos fica cego e só
     `--max-tokens` / `WF_MAX_TOKENS` protege. Configure sempre os dois tetos.
   - O gasto é do run, não da execução: ao abrir o run, o engine o recompõe a partir do log de eventos (todas as
     execuções anteriores, tentativas que falharam inclusive), então um resume nunca recomeça do zero. `--max-cents` e
     `--max-tokens` num resume são o novo teto **total**; com o mesmo teto, o resume para no mesmo ponto.
   - O teto não interrompe uma tentativa que já começou, e ela não tem teto de tokens próprio: só o `timeoutMs` de
     cada envio a limita (o pedido e cada re-prompt de schema têm o seu). Medido em 2026-11-11: uma etapa começou abaixo de `--max-tokens 300000` e o run fechou em 344 mil
     ([verificações locais](../research/verificacoes-locais.md) §9).
4. **Agente novo:** `Agent.create` com o modelo da etapa, a allowlist de tools, os subagents e MCP servers
   inline, o sandbox (se pedido) e `settingSources: ["project","team","mdm"]`.
   - Com `schema`, registra a custom tool `submit_result` e garante `"mcp"` na allowlist.
   - Quando a etapa carrega camadas de arquivo (`project`, `user`, `plugins` ou `all`), registra também um MCP
     inline `workflows` (ou `WF_MCP_SERVER_NAME`) sem tools, `packages/runtime/src/runtime/nested-mcp-guard.mjs`. Ele vence o
     servidor de mesmo nome do `.cursor/mcp.json`, e a etapa não vê `start_workflow` (medido em 2026-11-11; ver
     [2.2 §5](../usage/02-configuracao-inicial.md#5-contexto-do-projeto-nos-agentes)).
   - O SDK valida o modelo contra o catálogo da conta; um ID inválido faz a etapa falhar ("Cannot use this
     model"). A tabela de erros do SDK põe `model.id` inválido em `ConfigurationError` e manda conferir o ID com
     `Cursor.models.list()`, que lista os modelos liberados para a conta e o time da API key
     [DOC](https://cursor.com/docs/sdk/typescript#errors) [DOC](https://cursor.com/docs/sdk/typescript#cursormodelslist).
   - No plano Free, o `Agent.create` já falha com `UnknownAgentError` `plan_required` (403): a validação local do
     modelo consulta o catálogo (`GET /v1/models`), bloqueado no Free (medido em 2026-11-11,
     [verificações locais](../research/verificacoes-locais.md) §4).
5. **Run:** `send(prompt)` (tolera `AgentBusyError` com espera curta; nenhum apareceu nas 3 etapas com schema
   medidas em 2026-11-11) e `wait()` com timeout. Ao estourar o timeout, o engine **aguarda** `run.cancel()` antes
   de seguir, para a próxima tentativa não editar o mesmo cwd em paralelo.
6. **Schema:** se a run terminou e o agente não chamou `submit_result` com JSON válido, o engine reenvia o
   pedido na mesma conversa (`schemaRetries`, default 2). O Ajv valida dentro do `execute()`, e o erro volta para
   o modelo corrigir. Medido em 2026-11-11 ([verificações locais](../research/verificacoes-locais.md) §7): o
   `submit_result` aparece e é chamado, e uma submissão inválida foi corrigida dentro do mesmo turno (2 chamadas,
   `schemaReprompts: 0`). O re-prompt do engine não foi exercitado ao vivo, porque o modelo chamou `submit_result`
   até num prompt que pedia só texto; ele está coberto só pelos testes offline.
7. **Custo:** `agent.getUsage()` lê o custo e os tokens por tipo (input, output, cache read, cache write), também
   quando a tentativa falha ou estoura o tempo, e tenta de novo se o custo ainda não chegou. O custo pode levar um
   momento para assentar depois do fim da run, e `cost` fica ausente até lá
   [DOC](https://cursor.com/docs/sdk/typescript#agentgetusage). Cada tentativa soma o maior entre bruto e cobrado
   em `spentCents`, e só o cobrado em `chargedCents`; `RunOutcome`, o estado do job e `ctx.budget` expõem os
   dois. O resultado do run traz `usage.cacheHitRatio` = cache read ÷ input (medido: `inputTokens` já inclui cache
   read e cache write; ver [5.2 §3](../operating/02-custos-e-cache.md#3-medir-antes-de-otimizar)).
   - Se o `getUsage()` responde sem `cost` (custo ainda não assentado), os tokens vêm dele e o teto de tokens
     conta a tentativa. O teto em centavos não a conta, e o engine emite `warning` ("custo da tentativa ainda não
     reportado ...").
   - Se o `getUsage()` falha, os tokens vêm da soma dos eventos `turn-ended` da tentativa, e o teto de tokens
     continua valendo. O custo fica desconhecido: o teto em centavos não conta a tentativa, e o engine emite
     `warning` ("getUsage() falhou (...)"). Isso acontece, por exemplo, com `403 feature_unavailable`
     (`UnknownAgentError` com `code === "feature_unavailable"`): o uso de agentes locais é liberado por conta
     [DOC](https://cursor.com/docs/sdk/typescript#agentgetusage). Nesse caso o engine não tenta de novo. Turno sem
     uso reportado, como o de uma run cancelada antes de fechar o turno, fica fora da soma
     [DOC](https://cursor.com/docs/sdk/typescript#token-usage) (ver [5.3](../operating/03-observabilidade.md)).
   - Num Premium, em 2026-11-11, foi o caso de toda chamada, inclusive do `Agent.getUsage(agentId)` estático
     depois do descarte. Os tokens dos `turn-ended` bateram com os de `RunResult.usage`
     ([verificações locais](../research/verificacoes-locais.md) §5–6).
8. **Sucesso:** grava no journal e devolve o valor.
9. **Falha** (status `error`/`cancelled`, timeout, schema não entregue): repete até `retries` (default 1) com
   um agente novo e então lança `StepFailedError`. `RateLimitError` cobre o limite de rajada e o teto mensal de uso
   do plano ("Usage limit exceeded"); o SDK marca `isRetryable: true` nos casos transitórios
   [DOC](https://cursor.com/docs/sdk/typescript#errors). O retentável espera com backoff exponencial; o não
   retentável (teto do plano) vira `BudgetExceededError`.
   - Erro de conta (`plan_required`) não é repetido: vira `AccountAccessError`, que encerra o run na primeira
     tentativa, inclusive dentro de `parallel`/`pipeline`.
   - A doc não liga a nenhuma classe de erro do SDK os limites de gasto de time, de membro ou de service account.
     O de service account tem erro próprio, "Service account spend limit reached"
     [DOC](https://cursor.com/docs/account/enterprise/service-accounts).
10. **Descarte:** o agente é fechado com `await agent[Symbol.asyncDispose]()`, como no cookbook oficial.
11. **Métricas:** cada tentativa emite `step-start`, `turn` (via `onDelta`) e `step-end` (tokens, `raw_cents`,
    passos, tool calls, tipo de erro e `resolvedModel`, o ID que o Cursor resolveu). O recorder grava no SQLite do usuário. Falha ao gravar vira `warning`,
    nunca falha do workflow (ver [5.3](../operating/03-observabilidade.md)).
12. **Conteúdo:** o texto do prompt, o que o agente disse (uma mensagem por turno), cada chamada de tool e a saída dos
    comandos de shell vão para o log de eventos como eventos `content`, e só para ele: nem o recorder, nem os ouvintes
    de `onEvent`, nem o estado do job os recebem. Antes de gravar, o engine troca por `[REDACTED]` os formatos
    conhecidos de segredo e o valor de toda variável de ambiente com KEY, TOKEN, SECRET ou PASSWORD no nome; depois corta
    cada texto em 32768 caracteres. Ao iniciar um run, o `text` dos runs do repositório fora da retenção (os últimos 30
    runs ou 14 dias) é apagado; o resto do log fica.

## O que o runtime garante

| Garantia | Mecanismo |
|---|---|
| Toda etapa do código roda, na ordem do código | O fluxo é TypeScript; não há "o modelo decidiu pular" |
| Etapa concluída tem saída no formato esperado | `submit_result` + Ajv + re-prompt; senão a etapa falha |
| Falha é explícita | `agent()` lança erro. `parallel`/`pipeline` transformam a falha de um item em `null` e registram `warning`, mas o teto de custo e o erro de conta (`plan_required`) sempre abortam |
| O modelo de cada etapa é o do código ou o que a configuração pôs no papel dela, e um ID não liberado falha | Validação do SDK contra o catálogo da conta. A configuração em camadas (código < arquivo global < arquivo do repositório < ambiente < flag < override do chat) troca modelo, tempo e tentativas por papel; os tetos do arquivo global limitam tudo e só podem ser apertados. O `run-start` grava a configuração efetiva e a origem de cada valor ([6.2 · Referência de configuração](../reference/config.md)) |
| Teto de gasto checado antes de cada tentativa (não é gasto máximo) | Teto por run (centavos e tokens) + `RateLimitError`. Etapa iniciada não é interrompida e não tem teto de tokens próprio, só o `timeoutMs` da tentativa (criação do agente, envio e re-prompts dividem esse tempo): a ultrapassagem chega a concorrência × uma etapa sem limite (medido: 344 mil tokens com `--max-tokens 300000`, [verificações locais](../research/verificacoes-locais.md) §9). O teto em centavos depende do custo do `getUsage()`: em uso cobrado por request (passo 3) e quando o `getUsage()` falha (passo 7), só o de tokens vale, contado pelos eventos `turn-ended` |
| Retomar sem repetir etapas | Journal + `runId` gravado no job desde o início |
| Um run sobrevive a reinício do Cursor e do MCP server | Todo job roda em um processo destacado (`spawnJob`, nova sessão, sem pipe com quem o iniciou); o MCP server e o CLI só iniciam, leem o estado e pedem o cancelamento ([ADR-0003](../adr/0003-detached-jobs.md)) |
| Um run que caiu aparece como `failed`, com o `runId` para retomar | O processo do job atualiza um heartbeat no registro do job (a cada 5 s, por uma thread própria: uma chamada síncrona longa, como uma suíte de testes, não o atrasa). Processo morto, ou heartbeat parado há mais de 30 s, projeta `failed` |
| Cancelar para os agentes, desfaz a etapa que escrevia e deixa o run retomável | `cancel_workflow` e `wf cancel` mandam `SIGTERM` ao processo do job (só se a linha de comando dele leva o id do job); `SIGINT` e `SIGTERM` no processo fazem o mesmo, e um segundo sinal sai na hora; um processo travado (vivo, sem heartbeat) é encerrado com `SIGKILL`, sem desfazer a etapa, e o run segue retomável. O motor cancela os agentes ativos, desfaz o diretório da etapa que escrevia, grava o `run-end` com `status: cancelled` e solta o lock. A etapa cancelada não entra no journal, e o gasto dela fica no orçamento |
| A etapa cancelada não deixa edições pela metade | Antes de uma etapa que pode escrever, o motor registra os arquivos do diretório dela (os que o git não ignora) e o índice, byte a byte, sem filtros do git (`core.autocrlf`, `.gitattributes`, LFS) e sem mexer no índice. No cancelamento, o que a etapa criou é apagado, o que mudou ou apagou volta, e o índice volta. Não são desfeitos: commits que a etapa fez, arquivos fora do diretório dela e arquivos ignorados. Duas etapas escrevendo no mesmo diretório ao mesmo tempo voltam cada uma ao próprio ponto de partida, então o resultado não é preciso. Fora de um repositório git nada é desfeito, e o log traz um `warning` dizendo isso |
| O orçamento acumula entre resumes | O gasto parte do que o log do run já registra (tentativas que falharam inclusive), e o teto de um resume é o novo teto total |
| O estado de um job tem uma só fonte | O registro do job (`.workflows/jobs/<jobId>.json`) guarda só id do job, id do run, pid e heartbeat. Status, fase, últimas linhas, gasto e resultado são projetados do log de eventos a cada leitura (`wf status`, `wf jobs`, `get_workflow_status`, `wait_workflow`). Não há arquivo de estado para ficar pela metade, e as linhas de `recent` são resumos de uma linha, nunca texto de prompt ou de saída |
| O conteúdo das etapas fica só no log local, sem segredos, por tempo limitado | Eventos `content` + redação antes da gravação + retenção ao iniciar o run (ver passo 12). O banco de métricas e os exports dele nunca recebem conteúdo |
| Todo evento do run fica registrado, e a estrutura do run dá para refazer só com o log | Log de eventos por run (`events.jsonl`): `v`, `ts` e `runId` em todo evento; `stepId`, `parentId` e `groupId` nas etapas; `group-start`/`group-end` em `parallel` e `pipeline`. Campos em [6.1 · Referência de eventos](../reference/events.md), gerada do tipo |
| Uma queda no meio de uma gravação não impede o resume | Log e journal em JSON Lines: a última linha incompleta é ignorada, e a seguinte começa em linha nova. Os demais arquivos de estado (job, memo, progresso do workflow) são trocados por inteiro (arquivo temporário + `rename`) |
| Um run não roda duas vezes ao mesmo tempo | `run.lock` no diretório do run: o segundo processo é recusado com `já está em execução`; o lock de um processo que morreu é retomado |
| Retomar um run com o workflow alterado não passa em silêncio | O `workflowHash` do `run-start` é comparado ao da execução anterior; mudou, o log recebe um `warning` |
| Os runs de todos os repositórios são encontráveis | Cada run novo acrescenta uma linha (id, repositório, workflow, início) a `~/.cursor-workflows/runs.jsonl` (`WF_HOME` muda o diretório) |
| Workflow não dispara workflow por acidente | MCP inline `workflows` sem tools nas etapas, que encobre o do `.cursor/mcp.json` (passo 4), + `WF_INSIDE_WORKFLOW` herdado pelo shell, com recusa no CLI. Medido em 2026-11-11: sem o inline, a etapa via `start_workflow`; com ele, só `FetchMcpResource` e `submit_result`. Não é fronteira de segurança (ver abaixo) |

## O que ele não garante

- **Qualidade da etapa.** Um modelo pequeno pode entregar um JSON válido e errado. Por isso as verificações
  objetivas (testes, lint, diff) ficam no código, e as etapas críticas ganham review.
- **Determinismo do modelo.** Dois runs podem gerar código diferente. O determinismo está no *processo*.
- **Que o modelo que rodou é o pedido.** `RunResult.model` traz o ID resolvido (alias `composer` →
  `composer-2.5`, medido), gravado como `resolvedModel`. Com `default` (Auto), volta `default`, sem o modelo que o
  Router escolheu. Se uma substituição por política do admin, do lado do servidor, aparece ali não foi testado
  (conta pessoal).
- **Isolamento de segurança.** Por padrão, as runs locais executam tools (shell, edit, write) sem aprovação
  [DOC](https://cursor.com/docs/sdk/typescript#quickstart-approves-tool-calls-automatically), e o sandbox do SDK
  vem desligado [DOC](https://cursor.com/docs/sdk/typescript#sandbox-options). Custom tools, como `submit_result`,
  nunca pedem aprovação; regras de deny e o sandbox ainda valem para elas
  [DOC](https://cursor.com/docs/sdk/typescript#custom-tools). Medido em 2026-11-11: uma etapa de correção editou
  um arquivo fora do repositório ([verificações locais](../research/verificacoes-locais.md) §9). A regra de escopo
  nas instruções das etapas que escrevem é só um pedido no prompt, e o sandbox não foi testado neste kit. Veja
  [5.1 · Governança](../operating/01-governanca-e-custos.md#segurança).
- **Gasto máximo.** O teto é checado antes de cada tentativa, e uma tentativa só é limitada pelo `timeoutMs` dela.
  Uma etapa pode passar do teto sozinha (passo 3; [2.2 §3](../usage/02-configuracao-inicial.md#3-teto-de-custo)).
- **Barreira contra recursão.** A guarda do passo 4 e o `WF_INSIDE_WORKFLOW` evitam o disparo acidental. Uma etapa
  com `shell` ainda pode contorná-los, por exemplo rodando o CLI sem a variável.
- **Notar a queda de um job no mesmo instante.** O job cujo processo morreu aparece como `failed` com o `runId` na
  próxima consulta, e o que parou de dar sinal de vida (processo travado, parado, ou um pid reaproveitado), depois de
  30 s sem heartbeat. Relance com `start_workflow {resumeRunId}` ou `wf start --resume <runId>`; o journal evita
  refazer o que já terminou. O log do processo fica em `.workflows/jobs/<jobId>.log`. Um processo travado que ainda
  existe segura o lock do run: a retomada é recusada (`já está em execução`) até ele ser encerrado.
- **Imunidade a promises rejeitadas do SDK.** O cookbook avisa que o SDK dispara promises não aguardadas na
  inicialização. O kit instala `unhandledRejection` (registra e segue) e `uncaughtException` (grava um `run-end`
  `failed` com o motivo no log de cada run em execução, o que faz os jobs aparecerem como `failed`, e sai).
- **Pausar para perguntar ao humano.** Igual ao Claude Code: divida em dois workflows ou receba a decisão por
  `args`.

## Diferenças deliberadas em relação ao Claude Code

| Tema | Claude Code | Este kit | Motivo |
|---|---|---|---|
| Sandbox do script | Ambiente isolado: sem acesso direto a filesystem e shell, sem `import()`; `Date.now()`, `Math.random()` e `new Date()` sem argumento lançam erro [DOC](https://code.claude.com/docs/en/workflows) | Node completo | Permite `git`, `gh` e testes no próprio workflow, sem gastar tokens. Em troca, a disciplina de determinismo é sua |
| Chave de resume | Maior prefixo inalterado na ordem de início [DOC](https://code.claude.com/docs/en/workflows#which-agents-run-again) | Hash de prompt e opções + ocorrência | `pipeline` muda a ordem de conclusão; o hash tolera isso |
| `agent()` com falha | Devolve `null` só se você interromper o agente ou num erro de API irrecuperável; schema contraditório, validação que falha 5 vezes e agente travado em todas as tentativas lançam erro ([DOC](https://code.claude.com/docs/en/workflows)) | **Lança erro** | "Garantir execução completa": falha precisa ser visível. Em `parallel`/`pipeline` vira `null`, como no Claude Code |
| Concorrência | 16 por padrão, ajustável [DOC](https://code.claude.com/docs/en/workflows#behavior-and-limits) | 4 (configurável) | O Cursor não documenta o rate limit por usuário |

---

[← Anterior: 2.3 · Invocação no Cursor IDE (e no Claude Code)](../usage/03-invocacao-no-cursor-ide.md) · [Índice](../README.md) · [Próximo: 4.1 · Escrevendo workflows →](../authoring/01-escrevendo-workflows.md)
