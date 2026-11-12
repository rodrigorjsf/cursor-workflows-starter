# 6.1 · Referência de eventos

<!-- Gerado por scripts/events-reference.ts a partir de packages/runtime/src/runtime/events.ts. Não edite à mão: rode `npm run docs:events`. O `npm test` falha se esta página divergir do código. -->

Todo evento de um run é acrescentado ao **log de eventos** do run, `<repo>/.workflows/runs/<runId>/events.jsonl`: um objeto JSON por linha (JSON Lines). O log é a fonte de verdade do run. Um resume acrescenta ao mesmo arquivo, e cada execução abre com o seu `run-start`.

- Todo evento tem `v`, `ts` e `runId` ([`EventBase`](#eventbase)). As etapas e os grupos dizem onde estão na estrutura do run ([`StepRef`](#stepref)), o bastante para montar o grafo do run só com o log.
- Quem lê ignora uma última linha incompleta (queda no meio de uma gravação) e trata um `type` desconhecido, ou um `v` maior que o seu, como opaco.
- As descrições dos campos vêm dos comentários do tipo, em `packages/runtime/src/runtime/events.ts`.
- Tipos importados de `@cursor/sdk`: `ModelSelection`, `RunUsage`, `SettingSource`.
- Tipos importados de `./workflow.js`: `UsageTotals`.

## EventBase

Campos de todo evento.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `v` | `number` | sim | Versão do esquema do evento (hoje 1). Quem lê trata uma versão maior, ou um `type` desconhecido, como opaco. |
| `ts` | `string` | sim | Instante em que o evento foi emitido: ISO 8601 em UTC. |
| `runId` | `string` | sim | Id do run. Um resume continua o mesmo run e acrescenta ao mesmo log. |

## StepRef

Posição de uma etapa (uma chamada de `agent()`) na estrutura do run. As três ids bastam para montar o grafo do run só com os eventos: nós = etapas e grupos, arestas = `parentId`, agrupamento = `groupId`.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `stepId` | `string` | sim | Identifica a etapa. É o mesmo em todas as tentativas e em todo resume do run (deriva da chave do journal). |
| `parentId` | `string \| null` | sim | O nó (etapa ou grupo) de que esta etapa continua: a etapa anterior da sequência, o estágio anterior do mesmo item de um `pipeline`, ou o grupo que a abriu quando é a primeira do ramo. `null` na primeira etapa do run. |
| `groupId` | `string \| null` | sim | O `parallel` ou `pipeline` mais interno que contém a etapa; `null` fora de qualquer grupo. |

## Eventos

### `log`

Mensagem de `ctx.log`.

Inclui os campos de [`EventBase`](#eventbase).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `message` | `string` | sim | O texto passado a `ctx.log`. |

### `phase`

Mudança de fase (`ctx.phase`). As etapas seguintes ficam nessa fase.

Inclui os campos de [`EventBase`](#eventbase).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `title` | `string` | sim | O título passado a `ctx.phase`. |

### `run-start`

O run começou (ou foi retomado: cada execução emite o seu).

Inclui os campos de [`EventBase`](#eventbase).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `workflow` | `string` | sim | `meta.name` do workflow. |
| `workflowHash` | `string` | sim | Hash do código e da meta do workflow: compare métricas só entre versões iguais. |
| `argsHash` | `string` | sim | Hash dos args: dá para ver que dois runs tiveram a mesma entrada sem guardar a entrada. |
| `repo` | `{ name: string; hash: string }` | sim | O repositório do run: nome da pasta raiz do git e um hash curto do remote `origin` (ou do caminho). |
| `config` | `EffectiveConfig` | sim | A configuração efetiva desta execução, lida dos arquivos e do ambiente no início. Um resume lê de novo. |
| `provenance` | `Record<string, ConfigSource>` | sim | De onde veio cada valor de `config`: ponteiro JSON em `config` (`/limits/maxTokens`, `/roles/review/model/id`) → origem. |
| `violations` | `ConfigViolation[]` | sim | Pedidos que tentaram afrouxar um teto e não tiveram efeito. Vazio quando não houve nenhum. |

### `run-end`

O run terminou.

Inclui os campos de [`EventBase`](#eventbase).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `status` | `"finished" \| "failed"` | sim | `finished` = o workflow retornou; `failed` = lançou um erro (inclusive teto de custo ou de tokens). |
| `outcomeStatus` | `string` | não | O campo `status` do resultado do workflow, quando ele devolve um objeto com esse campo (por exemplo `done`). |
| `error` | `string` | não | A mensagem do erro que encerrou o run. |

### `group-start`

Um `parallel` ou `pipeline` começou. Os ramos são etapas com este `groupId`; o grupo fecha com `group-end`.

Inclui os campos de [`EventBase`](#eventbase).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `groupId` | `string` | sim | Identifica o grupo. Estável entre execuções do mesmo run: nasce da posição do grupo no código do workflow. |
| `kind` | `"parallel" \| "pipeline"` | sim | `parallel` (ramos independentes) ou `pipeline` (cada item atravessa os estágios por conta própria). |
| `size` | `number` | sim | Número de ramos: thunks do `parallel`, itens do `pipeline`. |
| `parentId` | `string \| null` | sim | O nó de que o grupo continua (mesmo sentido de `parentId` nas etapas); `null` no início do run. |
| `parentGroupId` | `string \| null` | sim | O grupo que contém este (grupos aninhados); `null` no nível de cima. |

### `group-end`

O grupo terminou: o que vem depois dele no código continua deste nó.

Inclui os campos de [`EventBase`](#eventbase).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `groupId` | `string` | sim | O grupo que fecha: o `groupId` do `group-start`. |
| `ok` | `boolean` | sim | false quando um erro fatal (teto, conta) abortou o grupo: os ramos que ainda rodavam podem emitir eventos depois deste, e o `groupId` deles continua valendo. Ramos que falharam sem ser fatais viram `null` e avisos. |

### `step-start`

Uma tentativa de etapa começou (ou uma etapa foi servida do journal ou do memo, sem chamar a API).

Inclui os campos de [`EventBase`](#eventbase) e de [`StepRef`](#stepref).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `attemptId` | `string` | sim | Identifica a tentativa: liga o `step-start`, os `turn` e o `step-end` dela. Uma etapa tem uma tentativa por retry. |
| `stepKey` | `string` | sim | Chave do journal: hash do prompt e das opções + nº da ocorrência. `stepId` é a forma curta dela. |
| `label` | `string` | sim | O `label` da etapa; sem ele, `etapa-` e um hash do prompt (nunca o começo do prompt). |
| `phase` | `string` | não | A fase em que a etapa começou (`phase` da chamada ou o último `ctx.phase`). |
| `cached` | `false \| "journal" \| "memo"` | sim | De onde vem o resultado sem chamar a API: journal do run (resume) ou memo entre runs. `false` = tentativa real. |
| `role` | `string` | não | O papel da etapa (`role` da chamada), quando ela declara um. |
| `model` | `string` | não | O ID do modelo pedido. |
| `modelKey` | `string` | não | Modelo + parâmetros ordenados, como `composer-2[reasoning_effort=low]`: esforço e contexto contam como modelos distintos. |
| `modelParams` | `ModelSelection["params"]` | não | Os parâmetros do modelo pedidos (esforço de raciocínio, contexto…). |
| `attempt` | `number` | sim | Número da tentativa, a partir de 1. |
| `tools` | `string[]` | não | A allowlist de tools da etapa, quando há. |
| `settingSources` | `SettingSource[]` | sim | As camadas de configuração que a etapa carrega. |
| `promptHash` | `string` | sim | Hash do prompt: o conteúdo não vai para o log por padrão. |
| `promptChars` | `number` | sim | Tamanho do prompt em caracteres. |
| `prompt` | `string` | não | Só quando WF_METRICS_STORE_PROMPTS=1. |

### `turn`

Um turno do agente terminou (pode ter vários passos/chamadas ao modelo).

Inclui os campos de [`EventBase`](#eventbase) e de [`StepRef`](#stepref).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `attemptId` | `string` | sim | A tentativa a que o turno pertence (o `attemptId` do `step-start`). |
| `idx` | `number` | sim | Número do turno na tentativa, a partir de 0. |
| `steps` | `number` | sim | Passos (chamadas ao modelo) do turno. |
| `usage` | `TurnUsage` | sim | Tokens do turno. |

### `step-end`

Uma tentativa de etapa terminou (ou a etapa foi servida do journal ou do memo).

Inclui os campos de [`EventBase`](#eventbase) e de [`StepRef`](#stepref).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `attemptId` | `string` | sim | A tentativa que terminou (o `attemptId` do `step-start`). |
| `stepKey` | `string` | sim | Chave do journal da etapa: igual à do `step-start`. |
| `label` | `string` | sim | O `label` da etapa. |
| `phase` | `string` | não | A fase da etapa. |
| `attempt` | `number` | não | Número da tentativa; ausente quando a etapa foi servida do journal ou do memo. |
| `ok` | `boolean` | sim | A tentativa entregou um resultado válido. |
| `cached` | `false \| "journal" \| "memo"` | sim | De onde veio o resultado sem chamar a API: journal do run (resume) ou memo entre runs. |
| `chargedCents` | `number` | sim | O que o Cursor cobrou pela tentativa (0 para uso incluído no plano). |
| `rawCents` | `number` | não | O custo bruto reportado. O teto de custo usa o maior entre o bruto e o cobrado. |
| `costFinal` | `boolean` | não | false = o Cursor ainda não tinha reportado custo; `wf metrics reconcile` completa depois. |
| `model` | `string` | não | O ID do modelo pedido. |
| `resolvedModel` | `string` | não | `RunResult.model.id`: o ID que o Cursor resolveu (alias → ID do catálogo). Com `default` (Auto), continua `default`. |
| `modelKey` | `string` | não | Modelo + parâmetros, como no `step-start`. |
| `usage` | `UsageTotals` | não | Tokens da tentativa por tipo, como o Cursor os reportou. |
| `reasoningTokens` | `number` | não | Tokens de raciocínio, quando o modelo os reporta. |
| `errorKind` | `ErrorKind` | não | Por que a tentativa falhou, quando `ok` é false. |
| `error` | `string` | não | A mensagem do erro, quando `ok` é false. |
| `schemaReprompts` | `number` | não | Re-prompts feitos até o agente chamar `submit_result` com JSON válido. |
| `turns` | `number` | não | Turnos do agente na tentativa. |
| `steps` | `number` | não | Passos (chamadas ao modelo) na tentativa. |
| `toolCalls` | `Record<string, number>` | não | Chamadas de tool por nome. |
| `summaries` | `number` | não | Vezes que o contexto foi resumido durante a tentativa. |
| `agentId` | `string` | não | O id do agente no Cursor. |
| `usageRuns` | `RunUsage[]` | não | O uso por run do agente, como o Cursor o reporta. |
| `durationMs` | `number` | não | Duração da tentativa em milissegundos. |

### `metric`

Métrica de negócio do run (`ctx.metric`).

Inclui os campos de [`EventBase`](#eventbase).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `name` | `string` | sim | O nome passado a `ctx.metric`. |
| `value` | `number \| string` | sim | O valor passado a `ctx.metric`. |

### `warning`

Aviso que não derruba o run: custo não reportado, ramo que falhou, workflow que mudou entre execuções…

Inclui os campos de [`EventBase`](#eventbase).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `message` | `string` | sim | O texto do aviso, para quem lê o run. |

## Tipos auxiliares

### EffectiveConfig

A configuração efetiva de um run: o que as camadas e os tetos globais decidiram para este workflow.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `workflow` | `string` | sim | `meta.name` do workflow. |
| `limits` | `EffectiveLimits` | sim | Limites do run. |
| `caps` | `EffectiveCaps` | sim | Tetos globais em vigor. |
| `roles` | `Record<string, EffectiveRole>` | sim | Um item por papel que o workflow declara (`meta.roles`). |
| `labels` | `Record<string, EffectiveRole>` | sim | Preferências por glob de label, para etapas sem papel. |

### EffectiveLimits

Limites do run depois de aplicar as camadas e os tetos globais. `null` = sem limite.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `maxTokens` | `number \| null` | sim | Tokens totais do run. |
| `maxTokensPerStep` | `number \| null` | sim | Tokens de uma etapa, para as etapas sem teto próprio no papel. |
| `maxCents` | `number \| null` | sim | Custo do run, em centavos. |
| `concurrency` | `number` | sim | Agentes simultâneos. |

### EffectiveCaps

Os tetos globais em vigor (o `caps` do arquivo global). `null` = sem teto.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `maxTokens` | `number \| null` | sim | Teto de tokens por run. |
| `maxTokensPerStep` | `number \| null` | sim | Teto de tokens por etapa. |
| `maxCents` | `number \| null` | sim | Teto de custo por run, em centavos. |
| `allowedModels` | `string[] \| null` | sim | Modelos permitidos (IDs ou globs com `*`); `null` libera todos. |
| `allowedSettingSources` | `SettingSource[] \| null` | sim | Camadas de configuração que uma etapa pode carregar; `null` libera todas. |
| `allowedLocations` | `Array<"local" \| "cloud"> \| null` | sim | Onde uma etapa pode rodar; `null` libera todos. |
| `maxConcurrency` | `number \| null` | sim | Agentes simultâneos; `null` = sem teto. |

### EffectiveRole

As configurações de uma etapa por papel (ou por glob de label). Só aparece o que alguma camada definiu.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `model` | `Partial<ModelSelection>` | não | Modelo: o ID, os parâmetros e o max mode, cada um com a sua origem em `provenance`. Um glob de label pode trazer só parte deles. |
| `timeoutMs` | `number` | não | Tempo máximo da etapa, em milissegundos. |
| `retries` | `number` | não | Tentativas extras quando a etapa termina em erro. |
| `schemaRetries` | `number` | não | Re-prompts quando o agente não entrega o JSON do schema. |
| `maxTokensPerStep` | `number \| null` | não | Teto de tokens da etapa. Ausente: vale o do workflow (`limits`). |
| `settingSources` | `SettingSource[]` | não | Camadas de configuração que a etapa carrega, já reduzidas pelo teto `allowedSettingSources`. |

### ConfigSource

De onde veio um valor da configuração efetiva.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `layer` | `"default" \| "global" \| "repo" \| "env" \| "flag" \| "mcp" \| "cap"` | sim | A camada que decidiu o valor: `default` (o código do workflow e do motor), `global` (`~/.cursor-workflows/config.json`), `repo` (`.agents/workflows/config.json`), `env` (variável de ambiente), `flag` (flag do CLI ou opção de quem chama o motor), `mcp` (override do chat em `start_workflow`) ou `cap` (o valor pedido passava do teto global e foi reduzido a ele). |
| `ref` | `string` | não | O arquivo, a variável de ambiente ou a flag que trouxe o valor. Ausente em `default`. |

### ConfigViolation

Uma tentativa de afrouxar um teto, ou um valor inválido que a camada trouxe. O teto vale e o pedido não tem efeito.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `layer` | `"global" \| "repo" \| "env" \| "flag" \| "mcp"` | sim | A camada que fez o pedido. |
| `ref` | `string` | não | O arquivo, a variável de ambiente ou a flag do pedido. |
| `path` | `string` | sim | Onde o valor está: ponteiro JSON dentro do arquivo (`/workflows/implement-issue/maxTokens`), ou o nome da variável ou da opção. |
| `requested` | `unknown` | sim | O que a camada pediu. |
| `applied` | `unknown` | sim | O que passou a valer: o teto, ou o valor que já valia antes do pedido. |
| `message` | `string` | sim | A explicação, em uma linha. |

### TurnUsage

Tokens de um turno do agente (evento `turn-ended` do SDK: soma de todos os passos do turno).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `inputTokens` | `number` | sim | Tokens de entrada do turno. Já incluem os lidos e escritos no cache (medido). |
| `outputTokens` | `number` | sim | Tokens de saída do turno. |
| `cacheReadTokens` | `number` | sim | Parte da entrada lida do cache de prompt do provedor. |
| `cacheWriteTokens` | `number` | sim | Parte da entrada escrita no cache de prompt do provedor. |
| `reasoningTokens` | `number` | não | Tokens de raciocínio do turno, quando o modelo os reporta. |

### ErrorKind

Por que uma tentativa de etapa falhou: estourou o tempo, o run do agente terminou em erro, o JSON do schema nunca veio válido, limite de uso do plano, ou exceção.

```ts
type ErrorKind = "timeout" | "run-error" | "schema" | "rate-limit" | "exception";
```

---

[← Anterior: 5.3 · Observabilidade: custo, tokens, contexto e eficiência](../operating/03-observabilidade.md) · [Índice](../README.md) · [Próximo: 6.2 · Referência de configuração →](config.md)
