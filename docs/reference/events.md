# 6.1 · Referência de eventos

<!-- Gerado por scripts/events-reference.ts a partir de packages/runtime/src/runtime/events.ts. Não edite à mão: rode `npm run docs:events`. O `npm test` falha se esta página divergir do código. -->

Todo evento de um run é acrescentado ao **log de eventos** do run, `<repo>/.workflows/runs/<runId>/events.jsonl`: um objeto JSON por linha (JSON Lines). O log é a fonte de verdade do run. Um resume acrescenta ao mesmo arquivo, e cada execução abre com o seu `run-start`.

- Todo evento tem `v`, `ts` e `runId` ([`EventBase`](#eventbase)). As etapas e os grupos dizem onde estão na estrutura do run ([`StepRef`](#stepref)), o bastante para montar o grafo do run só com o log.
- Quem lê ignora uma última linha incompleta (queda no meio de uma gravação) e trata um `type` desconhecido, ou um `v` maior que o seu, como opaco.
- As descrições dos campos vêm dos comentários do tipo, em `packages/runtime/src/runtime/events.ts`.
- Tipos importados de `@cursor/sdk`: `ModelSelection`, `RunUsage`, `SettingSource`.
- Tipos importados de `./workflow.js`: `ForgeName`, `UsageTotals`.

## EventBase

Campos de todo evento.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `v` | `number` | sim | Versão do esquema do evento (hoje 1). Quem lê trata uma versão maior, ou um `type` desconhecido, como opaco. |
| `ts` | `string` | sim | Instante em que o evento foi emitido: ISO 8601 em UTC. |
| `runId` | `string` | sim | Id do run. Um resume continua o mesmo run e acrescenta ao mesmo log. |

## StepRef

Posição de uma etapa (uma chamada de `agent()` ou de `exec()`) na estrutura do run. As três ids bastam para montar o grafo do run só com os eventos: nós = etapas e grupos, arestas = `parentId`, agrupamento = `groupId`.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `stepId` | `string` | sim | Identifica a etapa. É o mesmo em todas as tentativas e em todo resume do run. Numa etapa de agente deriva da chave do journal (`s-…`); num comando de `ctx.exec`, do comando, dos argumentos e do cwd, mais o número da ocorrência (`x-…`). |
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

### `card`

O cartão do run no quadro do dashboard (`ctx.card`). O quadro mostra o último cartão de cada run: chamar `ctx.card` de novo atualiza o cartão.

Inclui os campos de [`EventBase`](#eventbase).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `title` | `string` | sim | O título do cartão. |
| `subtitle` | `string` | não | Uma linha abaixo do título. |
| `links` | `CardLink[]` | não | Links do cartão, como o da pull request. |
| `badges` | `string[]` | não | Rótulos curtos do cartão, como o tier. |

### `run-start`

O run começou (ou foi retomado: cada execução emite o seu).

Inclui os campos de [`EventBase`](#eventbase).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `workflow` | `string` | sim | `meta.name` do workflow. |
| `workflowHash` | `string` | sim | Hash do código e da meta do workflow: compare métricas só entre versões iguais. |
| `argsHash` | `string` | sim | Hash dos args: dá para ver que dois runs tiveram a mesma entrada sem guardar a entrada. |
| `repo` | `{ name: string; hash: string }` | sim | O repositório do run: nome da pasta raiz do git e um hash curto do remote `origin` (ou do caminho). |
| `phases` | `string[]` | não | As fases que o workflow declara em `meta.phases`, na ordem: os títulos que `ctx.phase` usa. O dashboard monta as colunas do quadro com elas. Ausente em logs de versões antigas e em workflow que não declara fases. |
| `jobId` | `string` | não | O job (`wf start`, `start_workflow`) que iniciou esta execução. Ausente em `wf run`. O estado de um job é a projeção das execuções que levam o id dele. |
| `config` | `EffectiveConfig` | sim | A configuração efetiva desta execução, lida dos arquivos e do ambiente no início. Um resume lê de novo. |
| `provenance` | `Record<string, ConfigSource>` | sim | De onde veio cada valor de `config`: ponteiro JSON em `config` (`/limits/maxTokens`, `/roles/review/model/id`) → origem. |
| `violations` | `ConfigViolation[]` | sim | Pedidos que tentaram afrouxar um teto e não tiveram efeito. Vazio quando não houve nenhum. |

### `run-end`

O run terminou.

Inclui os campos de [`EventBase`](#eventbase).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `status` | `RunStatus` | sim | Como a execução terminou. |
| `outcomeStatus` | `string` | não | O campo `status` do resultado do workflow, quando ele devolve um objeto com esse campo (por exemplo `done`). |
| `result` | `unknown` | não | O valor que o workflow retornou. É o que `wait_workflow` e `wf status` devolvem como `result`. Não é conteúdo de etapa: a retenção não o apaga (o workflow decide o que devolve), mas a redação de segredos vale para ele. |
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
| `label` | `string` | sim | O `label` da etapa; sem ele, `step-` e um hash do prompt (nunca o começo do prompt). |
| `phase` | `string` | não | A fase em que a etapa começou (`phase` da chamada ou o último `ctx.phase`). |
| `cached` | `false \| "journal" \| "memo"` | sim | De onde vem o resultado sem chamar a API: journal do run (resume) ou memo entre runs. `false` = tentativa real. |
| `role` | `string` | não | O papel da etapa (`role` da chamada), quando ela declara um. |
| `location` | `"local" \| "cloud"` | não | Onde a tentativa roda: `local` ou `cloud` (um cloud agent da Cursor). Ausente em etapa servida do journal ou do memo, que não rodou. |
| `model` | `string` | não | O ID do modelo pedido. |
| `modelKey` | `string` | não | Modelo + parâmetros ordenados, como `composer-2[reasoning_effort=low]`: esforço e contexto contam como modelos distintos. |
| `modelParams` | `ModelSelection["params"]` | não | Os parâmetros do modelo pedidos (esforço de raciocínio, contexto…). |
| `attempt` | `number` | sim | Número da tentativa, a partir de 1. |
| `tools` | `string[]` | não | A allowlist de tools da etapa, quando há. |
| `settingSources` | `SettingSource[]` | sim | As camadas de configuração que a etapa carrega. |
| `promptHash` | `string` | sim | Hash do prompt. O texto fica nos eventos `content` do log local, nunca aqui nem no banco de métricas. |
| `promptChars` | `number` | sim | Tamanho do prompt em caracteres. |

### `turn`

Um turno do agente terminou (pode ter vários passos/chamadas ao modelo).

Inclui os campos de [`EventBase`](#eventbase) e de [`StepRef`](#stepref).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `attemptId` | `string` | sim | A tentativa a que o turno pertence (o `attemptId` do `step-start`). |
| `idx` | `number` | sim | Número do turno na tentativa, a partir de 0. |
| `steps` | `number` | sim | Passos (chamadas ao modelo) do turno. |
| `usage` | `TurnUsage` | sim | Tokens do turno. |

### `content`

O conteúdo de uma etapa, que não cabe nos outros eventos: o texto dos prompts, do que o agente disse, das chamadas de tool e da saída de comandos. Só o log de eventos local guarda isto. Não vai para o banco de métricas, nem para os exports dele, nem para os ouvintes de `onEvent`, nem para as linhas de progresso de `wf status` e `wait_workflow`. Chaves e tokens conhecidos já saem do `text` trocados por `[REDACTED]`. O conteúdo de um run velho é apagado ao iniciar outro run (retenção); o evento fica, sem o `text`.

Inclui os campos de [`EventBase`](#eventbase) e de [`StepRef`](#stepref).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `attemptId` | `string` | sim | A tentativa a que o conteúdo pertence (o `attemptId` do `step-start`, ou do `exec-start` quando o conteúdo é de um comando de `ctx.exec`). |
| `kind` | `ContentKind` | sim | O que o `text` guarda. |
| `tool` | `string` | não | O nome da tool (`shell`, `read`…), em `tool-call` e `command-output`. `exec` marca um comando de `ctx.exec`: o `tool-call` traz o comando, os argumentos e o cwd; os `command-output` trazem a saída. |
| `callId` | `string` | não | O id da chamada de tool no stream do agente: liga o `tool-call` ao `command-output` dela. Num comando de `ctx.exec`, é o `attemptId` dele. |
| `stream` | `OutputStream` | não | De qual saída vem o `text` de um `command-output` de `ctx.exec`. A saída de um comando chega em vários eventos, em ordem, cortada em linhas inteiras quando dá. Ausente na saída de uma tool de agente, que junta as duas. |
| `text` | `string` | não | O conteúdo, já sem segredos e cortado em 32768 caracteres. Ausente depois que a retenção o apagou. |
| `chars` | `number` | sim | Tamanho do conteúdo em caracteres antes do corte. Fica depois que a retenção apaga o `text`. |
| `truncated` | `boolean` | não | true quando o `text` é só o começo do conteúdo. |

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
| `location` | `"local" \| "cloud"` | não | Onde a tentativa rodou, como no `step-start`. |
| `chargedCents` | `number` | sim | O que o Cursor cobrou pela tentativa (0 para uso incluído no plano). |
| `rawCents` | `number` | não | O custo bruto reportado. O teto de custo usa o maior entre o bruto e o cobrado. |
| `costFinal` | `boolean` | não | false = o Cursor ainda não tinha reportado custo; `wf metrics reconcile` completa depois. |
| `model` | `string` | não | O ID do modelo pedido. |
| `resolvedModel` | `string` | não | `RunResult.model.id`: o ID que o Cursor resolveu (alias → ID do catálogo). Com `default` (Auto), continua `default`. |
| `modelKey` | `string` | não | Modelo + parâmetros, como no `step-start`. |
| `usage` | `UsageTotals` | não | Tokens da tentativa por tipo, como o Cursor os reportou. |
| `reasoningTokens` | `number` | não | Tokens de raciocínio, quando o modelo os reporta. |
| `errorKind` | `ErrorKind` | não | Por que a tentativa falhou, quando `ok` é false. |
| `reverted` | `boolean` | não | true = as alterações da tentativa no diretório de trabalho foram desfeitas (o diretório voltou ao estado de antes da etapa): o run foi cancelado no meio de uma etapa que escreve, ou a tentativa falhou e a etapa pede `revertOnRetry` antes de tentar de novo. Se não foi possível desfazer, há um `warning` com o motivo. |
| `error` | `string` | não | A mensagem do erro, quando `ok` é false. |
| `schemaReprompts` | `number` | não | Re-prompts feitos até o agente chamar `submit_result` com JSON válido. |
| `turns` | `number` | não | Turnos do agente na tentativa. |
| `steps` | `number` | não | Passos (chamadas ao modelo) na tentativa. |
| `toolCalls` | `Record<string, number>` | não | Chamadas de tool por nome. |
| `summaries` | `number` | não | Vezes que o contexto foi resumido durante a tentativa. |
| `agentId` | `string` | não | O id do agente no Cursor. |
| `usageRuns` | `RunUsage[]` | não | O uso por run do agente, como o Cursor o reporta. |
| `durationMs` | `number` | não | Duração da tentativa em milissegundos. |

### `cloud-agent`

Um agente na nuvem existe para a tentativa. O motor grava o id assim que o backend o tem, antes de a etapa terminar, para que um resume reencontre o agente que ainda roda em vez de criar outro. Só etapas na nuvem emitem este evento; o `step-end` repete o `agentId`, mas só quando a tentativa termina.

Inclui os campos de [`EventBase`](#eventbase) e de [`StepRef`](#stepref).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `attemptId` | `string` | sim | A tentativa a que o agente pertence (o `attemptId` do `step-start`). |
| `agentId` | `string` | sim | O id do agente no Cursor (`bc-…`). |
| `reattached` | `true` | não | true = a tentativa reanexou a um agente que uma execução anterior, interrompida, deixou para trás (rodando ou já terminado sem ninguém olhando): ele não foi criado agora. |
| `snapshot` | `{ remote: string; branch: string; commit?: string }` | não | A branch de snapshot de que o agente parte, o remote para onde foi empurrada e o commit dela (o ponto de partida do agente: uma etapa que escreve só traz o trabalho de volta para um worktree que ainda é esse commit). Quem reanexa a apaga quando a etapa termina. Ausente quando a tentativa reanexou a um agente cuja branch o log não conhece. |

### `exec-start`

Uma chamada de `ctx.exec` começou. É um nó do run, como uma etapa de agente: o comando fecha com um `exec-end` e a saída dele vai em eventos `content`.

Inclui os campos de [`EventBase`](#eventbase) e de [`StepRef`](#stepref).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `attemptId` | `string` | sim | Identifica esta execução do comando: liga o `exec-start`, os `content` da saída e o `exec-end`. Um comando tem uma só; um resume roda o comando de novo, com outro `attemptId` e o mesmo `stepId`. |
| `label` | `string` | sim | O `label` da chamada; sem ele, o nome do comando. |
| `phase` | `string` | não | A fase em que o comando começou (`phase` da chamada ou o último `ctx.phase`). |
| `command` | `string` | sim | O programa, sem os argumentos (`git`, `npm`…). Os argumentos e o cwd ficam num `content` do tipo `tool-call`: podem carregar dados. |
| `timeoutMs` | `number` | sim | O tempo máximo do comando, em milissegundos. Passado esse tempo, o comando é morto. |

### `exec-end`

Uma chamada de `ctx.exec` terminou.

Inclui os campos de [`EventBase`](#eventbase) e de [`StepRef`](#stepref).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `attemptId` | `string` | sim | A execução que terminou (o `attemptId` do `exec-start`). |
| `label` | `string` | sim | O `label` da chamada. |
| `phase` | `string` | não | A fase do comando. |
| `command` | `string` | sim | O programa, como no `exec-start`. |
| `ok` | `boolean` | sim | O comando rodou e saiu com código 0. |
| `outcome` | `ExecOutcome` | sim | Como o comando terminou. |
| `exitCode` | `number` | não | O código de saída. Ausente quando o processo foi morto por um sinal ou não rodou. |
| `signal` | `string` | não | O sinal que matou o processo (`SIGTERM` no timeout e no cancelamento), quando houve. |
| `error` | `string` | não | Por que o processo não pôde rodar (programa inexistente, cwd inválido). |
| `durationMs` | `number` | sim | Duração do comando em milissegundos. |
| `outputChars` | `number` | sim | Tamanho da saída do comando (stdout e stderr) em caracteres, antes de qualquer corte. |
| `outputTruncated` | `true` | não | true quando a saída passou do que o log guarda por comando (262144 caracteres): os `content` têm só o começo dela. O `ctx.exec` devolve ao workflow o fim, em `tail`. |

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

### CardLink

Um link do cartão de um run.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `label` | `string` | sim | O texto do link. |
| `url` | `string` | sim | O endereço. Só `http:` e `https:` aparecem no dashboard; um link de pull request do GitHub ou de merge request do GitLab mostra também o estado dele (aberto, mesclado ou fechado). |

### EffectiveConfig

A configuração efetiva de um run: o que as camadas e os tetos globais decidiram para este workflow.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `workflow` | `string` | sim | `meta.name` do workflow. |
| `limits` | `EffectiveLimits` | sim | Limites do run. |
| `caps` | `EffectiveCaps` | sim | Tetos globais em vigor. |
| `roles` | `Record<string, EffectiveRole>` | sim | Um item por papel que o workflow declara (`meta.roles`). |
| `labels` | `Record<string, EffectiveRole>` | sim | Preferências por glob de label, para etapas sem papel. |
| `execTimeoutMs` | `number` | sim | Tempo máximo, em milissegundos, de um comando de `ctx.exec` que não passa o próprio `timeoutMs`. |
| `cloud` | `EffectiveCloud` | sim | Preferências das etapas na nuvem (`cloud` dos arquivos de configuração). |
| `forges` | `Record<string, ForgeName>` | não | O forge de cada host que o kit não conhece (`forges` dos arquivos de configuração), host a host: o do repositório vale mais que o global. Vazio quando nenhum arquivo declara um; `github.com` e `gitlab.com` não precisam de entrada, o kit os conhece (uma entrada que os repete aparece). A origem de cada host está em `provenance` (`/forges/<host>`). Ausente em logs de versões antigas. |
| `settings` | `Record<string, unknown>` | sim | Os ajustes que o workflow declara (`meta.settings`), cada um com o padrão do código ou o valor que um arquivo de configuração trocou. A origem de cada um está em `provenance` (`/settings/<nome>`). Vazio quando o workflow não declara nenhum. |

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
| `allowedLocations` | `Array<"local" \| "cloud"> \| null` | sim | Onde uma etapa pode rodar; `null` libera todos. Sem a chave no arquivo global, só `local`: a nuvem é decisão do dono da máquina. |
| `maxConcurrency` | `number \| null` | sim | Agentes simultâneos; `null` = sem teto. |
| `requireSandbox` | `boolean \| null` | sim | `true` liga o sandbox do SDK em toda etapa, mesmo que o código do workflow o desligue; `null` deixa o código decidir. |

### EffectiveRole

As configurações de uma etapa por papel (ou por glob de label). Só aparece o que alguma camada definiu.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `location` | `"local" \| "cloud"` | não | Onde as etapas do papel rodam: `local` (o padrão) ou `cloud`. Um `cloud` que o teto `allowedLocations` não permite vira `local`, com uma violação. Só papéis têm location; um glob de label não. |
| `resultVia` | `"json-block" \| "artifact"` | não | Como uma etapa do papel na nuvem entrega o resultado estruturado: `json-block` (o padrão: o último bloco de código `json` da resposta final) ou `artifact` (o arquivo `result.json` que o agente salva nos artefatos dele, baixado depois do run). Só aparece quando uma camada o definiu; só papéis têm um. |
| `model` | `Partial<ModelSelection>` | não | Modelo: o ID, os parâmetros e o max mode, cada um com a sua origem em `provenance`. Um glob de label pode trazer só parte deles. |
| `timeoutMs` | `number` | não | Tempo máximo da etapa, em milissegundos. |
| `retries` | `number` | não | Tentativas extras quando a etapa termina em erro. |
| `schemaRetries` | `number` | não | Re-prompts quando o agente não entrega o JSON do schema. |
| `maxTokensPerStep` | `number \| null` | não | Teto de tokens da etapa. Ausente: vale o do workflow (`limits`). |
| `settingSources` | `SettingSource[]` | não | Camadas de configuração que a etapa carrega, já reduzidas pelo teto `allowedSettingSources`. |

### EffectiveCloud

As preferências das etapas na nuvem, depois das camadas.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `remote` | `string` | sim | O remote do git para onde vão as branches de snapshot das etapas na nuvem. Padrão: `origin`. |

### ConfigSource

De onde veio um valor da configuração efetiva.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `layer` | `"default" \| "global" \| "repo" \| "env" \| "flag" \| "mcp" \| "cap"` | sim | A camada que decidiu o valor: `default` (o código do workflow e do motor), `global` (`~/.cursor-workflows/config.json`), `repo` (`.agents/workflows/config.json`), `env` (variável de ambiente), `flag` (flag do CLI ou opção de quem chama o motor), `mcp` (override do chat em `start_workflow`) ou `cap` (o valor pedido passava do teto global e foi reduzido a ele). |
| `ref` | `string` | não | O arquivo, a variável de ambiente ou a flag que trouxe o valor. Ausente em `default`. |

### ConfigViolation

Uma tentativa de afrouxar um teto, ou um padrão do código que um teto recusa. O teto vale e o pedido não tem efeito.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `layer` | `"default" \| "global" \| "repo" \| "env" \| "flag" \| "mcp"` | sim | A camada que fez o pedido; `default` é o modelo padrão do código de um papel que `allowedModels` recusa (as etapas do papel falham). |
| `ref` | `string` | não | O arquivo, a variável de ambiente ou a flag do pedido. |
| `path` | `string` | sim | Onde o valor está: ponteiro JSON dentro do arquivo (`/workflows/implement-issue/maxTokens`), ou o nome da variável ou da opção. |
| `requested` | `unknown` | sim | O que a camada pediu. |
| `applied` | `unknown` | sim | O que passou a valer: o teto, ou o valor que já valia antes do pedido. |
| `message` | `string` | sim | A explicação, em uma linha. |

### RunStatus

Como uma execução do run terminou: `finished` = o workflow retornou; `failed` = lançou um erro (inclusive teto de custo ou de tokens); `cancelled` = o run foi cancelado (`wf cancel`, `cancel_workflow`, SIGINT ou SIGTERM) e pode ser retomado com o mesmo `runId`.

```ts
type RunStatus = "finished" | "failed" | "cancelled";
```

### TurnUsage

Tokens de um turno do agente (evento `turn-ended` do SDK: soma de todos os passos do turno).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `inputTokens` | `number` | sim | Tokens de entrada do turno. Já incluem os lidos e escritos no cache (medido). |
| `outputTokens` | `number` | sim | Tokens de saída do turno. |
| `cacheReadTokens` | `number` | sim | Parte da entrada lida do cache de prompt do provedor. |
| `cacheWriteTokens` | `number` | sim | Parte da entrada escrita no cache de prompt do provedor. |
| `reasoningTokens` | `number` | não | Tokens de raciocínio do turno, quando o modelo os reporta. |

### ContentKind

O que um `content` guarda: o que foi enviado ao agente, o que ele disse, as tools que chamou, a saída dos comandos.

```ts
type ContentKind = "prompt" | "agent-message" | "tool-call" | "command-output";
```

### OutputStream

De qual saída de um comando vem um texto: `stdout` ou `stderr`.

```ts
type OutputStream = "stdout" | "stderr";
```

### ErrorKind

Por que uma tentativa de etapa falhou: estourou o tempo, o run do agente terminou em erro, o JSON do schema nunca veio válido, limite de uso do plano, teto de tokens (`budget`: o run do agente foi cancelado no turno que passou do teto da etapa ou do run, e a etapa não tenta de novo), o run foi cancelado, ou exceção.

```ts
type ErrorKind = "timeout" | "run-error" | "schema" | "rate-limit" | "budget" | "cancelled" | "exception";
```

### ExecOutcome

Como um comando de `ctx.exec` terminou: `exit` (o processo terminou sozinho, com qualquer código), `timeout` (morto ao passar do tempo), `cancelled` (o run foi cancelado e o comando morto) ou `spawn-error` (o processo não chegou a rodar).

```ts
type ExecOutcome = "exit" | "timeout" | "cancelled" | "spawn-error";
```

---

[← Anterior: 5.3 · Observabilidade: custo, tokens, contexto e eficiência](../operating/03-observabilidade.md) · [Índice](../README.md) · [Próximo: 6.2 · Referência de configuração →](config.md)
