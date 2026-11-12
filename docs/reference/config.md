# 6.2 · Referência de configuração

<!-- Gerado por scripts/config-reference.ts a partir de packages/runtime/schema/config.schema.json. Não edite à mão: rode `npm run docs:config`. O `npm test` falha se esta página divergir do esquema. -->

O comportamento do kit se configura em JSON, em dois arquivos que um único esquema valida. A configuração é lida de novo a cada `start_workflow`, `wf run` e resume: uma edição vale no run seguinte, sem reiniciar o servidor MCP.

## Onde ficam os arquivos

- **Global**, `~/.cursor-workflows/config.json` (a pasta muda com `WF_HOME`): os tetos rígidos (`caps`) e preferências suas, valem em todos os repositórios.
- **Do repositório**, `.agents/workflows/config.json`: preferências por workflow e por papel, e a faixa `kit`. Vai para o controle de versão, então só pode **apertar** os tetos globais, nunca afrouxar.
- **O esquema** é `packages/runtime/schema/config.schema.json`. Aponte `$schema` para ele e o editor completa e valida. Arquivo inválido, ou com chave desconhecida, derruba o run (e o `start_workflow`) antes de qualquer etapa, com o arquivo e o caminho do campo como ponteiro JSON, por exemplo `/workflows/implement-issue/roles/review/retries`.
- Todo objeto aceita `$comment`, que é ignorado.

## Precedência

Cada valor vem da camada mais alta que o define:

1. os defaults do código: do motor, do workflow (`defaults`, `budget`) e do papel (`meta.roles[].defaults`);
2. o arquivo global;
3. o arquivo do repositório;
4. variáveis de ambiente: `WF_MAX_TOKENS`, `WF_MAX_CENTS` e `WF_MODEL_*` (veja abaixo);
5. flags do CLI (`--max-tokens`, `--max-cents`) e opções de quem embute o motor;
6. os `overrides` que o chat passa ao `start_workflow`: só apertam.

Os campos do modelo (`id`, `params`, `maxMode`) se combinam um a um: quem troca só o `id` herda os `params` da camada de baixo.

## Tetos

Depois das camadas, os tetos do arquivo global limitam o resultado: **números** valem o menor entre o teto e o valor pedido, **listas** valem a interseção. O que a configuração pede acima de um teto é reduzido ao teto e registrado como **violação**, e o teto vale. Isso vale também para as flags. Os defaults do código acima de um teto são reduzidos sem violação.

- Um `caps` no arquivo do repositório é violação e não tem efeito.
- Um `overrides` do chat que afrouxaria o valor em vigor é violação e não tem efeito; apertar o valor é permitido. O `maxTokensPerStep` do chat vale como teto de todos os papéis e globs de label.
- Um valor que não é um limite válido (um `concurrency` 0, um `maxTokens` fracionário) numa flag, num `overrides` ou numa variável de ambiente é erro, com o nome de onde veio.
- Um modelo fora de `allowedModels` pedido pela configuração não tem efeito. Um modelo padrão do código que a lista recusa vira uma violação da camada `default` no `run-start`, e as etapas desse papel falham até a configuração trocá-lo.
- `settingSources` fora de `allowedSettingSources` são removidos, em todas as etapas.

As violações aparecem no `run-start` do log, como aviso no andamento do run, na resposta do `start_workflow` e no `wf config show`.

## `null` e chave ausente

`null` desliga um limite (num teto: sem teto; numa preferência: sem limite próprio, e os tetos globais seguem valendo). Uma chave ausente herda da camada de baixo. Zero é zero, nunca "sem valor".

## Papéis, globs de label e variáveis

- Um workflow declara seus **papéis** em `meta.roles`; os nomes são as chaves de `workflows.<nome>.roles` (`wf config show` e `list_workflows` os mostram). Cada papel traz o que a spec de nuvem vai usar: `cloud` é `ok`, `read-only` ou `never`. Um papel que o workflow não declara é erro, na configuração e em `agent({ role })`.
- Por papel se configura o modelo (com `params`), `timeoutMs`, `retries`, `schemaRetries`, `maxTokensPerStep` e `settingSources`. A configuração vale mais que as opções da chamada `agent()`; os defaults do papel valem menos.
- `labels` guarda as mesmas preferências por glob (`*` e `?`) do `label` da etapa, só para etapas **sem** papel. Vale o glob com mais caracteres literais; empate vai para o primeiro.
- `WF_MODEL_<PAPEL>` troca o modelo de um papel: o nome do papel em maiúsculas, com `.` e `-` como `_` (`WF_MODEL_REVIEW`, `WF_MODEL_IMPLEMENT_LOW`), ou um apelido que o workflow declara (`WF_MODEL_LOW`). O valor `id` troca só o ID e mantém os `params`; `id[param=valor,max]` troca também os `params` (`max` liga o max mode; `id[]` limpa os `params`). Variáveis que não casam com um papel do workflow são ignoradas.
- `execTimeoutMs` é uma preferência do workflow, não de um papel: o tempo máximo, em milissegundos, de um comando que o workflow roda com `ctx.exec` sem passar o próprio `timeoutMs` (padrão: 600000, 10 minutos). Passado o tempo, o motor mata o comando. Entra na configuração efetiva do `run-start`, com a origem, e vale a cada execução, resumes inclusive.
- `settings` guarda os **ajustes** do próprio workflow: o workflow declara os nomes e os padrões em `meta.settings`, lê o resultado em `ctx.settings`, e só o arquivo global e o do repositório os trocam (o do repositório vale mais). Cada ajuste vale inteiro: o de uma camada de cima troca o de baixo, sem combinar campos. Não há variável de ambiente, flag nem `overrides` do chat para eles. Um nome que o workflow não declara é erro, com o caminho do campo, como um papel desconhecido. O `run-start` e o `wf config show` trazem os ajustes em vigor (`config.settings`), com a origem de cada um em `provenance` (`/settings/<nome>`). Os do `implement-issue` estão na seção "Ajustes de um workflow".
- `maxTokensPerStep` entra na configuração efetiva e no `run-start`, e o motor o aplica **durante** a etapa: a cada turno do agente (`turn-ended`), a soma dos tokens de todas as tentativas da etapa é comparada com ele, e a etapa que passa dele (estritamente) tem o run do agente cancelado e falha com `errorKind: "budget"`, sem nova tentativa. O `maxTokens` do run funciona do mesmo jeito sobre o gasto do run inteiro, resumes inclusive, e cancela todas as etapas ativas. A ultrapassagem é de no máximo um turno por etapa ativa; um turno do SDK pode ser o laço inteiro do agente, e é o `timeoutMs` que freia dentro dele.

## O que cada run grava

O `run-start` do [log de eventos](events.md#run-start) leva a configuração efetiva (`config`), de onde veio cada valor (`provenance`, por ponteiro JSON em `config`) e as violações (`violations`). `wf config show [workflow]` imprime os três para o repositório atual, com o caminho dos dois arquivos e se foram achados.

## Raiz do arquivo

Valida os dois arquivos de configuração do kit: o global (`~/.cursor-workflows/config.json`) e o do repositório (`.agents/workflows/config.json`).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `$schema` | `string` | não | Endereço deste esquema: dá autocompletar e validação no editor. |
| `kit` | `string` | não | Faixa semver do kit que este repositório aceita (por exemplo `>=0.3.0 <0.4.0`). Só vale no arquivo do repositório: um kit fora da faixa é recusado. |
| `caps` | [Tetos globais (caps)](#tetos-globais-caps) | não | Tetos rígidos. Só valem no arquivo global: o arquivo do repositório e o chat só podem apertá-los, nunca afrouxar. Um `caps` no arquivo do repositório é registrado como violação e não tem efeito. |
| `workflows` | objeto: nome → [Preferências de um workflow](#preferências-de-um-workflow) | não | Preferências por workflow, pelo `meta.name` dele. Uma preferência acima de um teto global é reduzida ao teto e registrada como violação. |

## Tetos globais (caps)

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `maxTokens` | `integer \| null` | não | Teto de tokens por run. Números: vale o menor entre o teto e o valor pedido. |
| `maxTokensPerStep` | `integer \| null` | não | Teto de tokens por etapa. |
| `maxCents` | `number \| null` | não | Teto de custo por run, em centavos. `null` desliga. |
| `allowedModels` | `array de string \| null` | não | Modelos permitidos, pelo ID como escrito na config (aceita `*` como curinga: `composer-*`). Listas: vale a interseção. Uma etapa cujo modelo não está na lista falha. `null` libera todos. |
| `allowedSettingSources` | `array de "project" \| "user" \| "team" \| "mdm" \| "plugins" \| "all" \| null` | não | Camadas de configuração (`settingSources`) que uma etapa pode carregar. Listas: vale a interseção. O instalador grava todas menos `all`. `null` libera todas. |
| `allowedLocations` | `array de "local" \| "cloud" \| null` | não | Onde as etapas podem rodar. Hoje só `local` existe; `cloud` é reservado. `null` libera todos. |
| `maxConcurrency` | `integer \| null` | não | Máximo de agentes simultâneos num run. `null` desliga. |
| `requireSandbox` | `boolean \| null` | não | `true` liga o sandbox local do SDK em toda etapa, mesmo quando o código do workflow o desliga: um pull request que edita um workflow não afrouxa o sandbox. Ausente, `false` ou `null`: vale o `sandbox` de cada etapa. |

## Preferências de um workflow

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `maxTokens` | `integer \| null` | não | Teto de tokens por run deste workflow. O teto global `maxTokens` vale sempre. |
| `maxTokensPerStep` | `integer \| null` | não | Teto de tokens por etapa, para todas as etapas do workflow. |
| `maxCents` | `number \| null` | não | Teto de custo por run, em centavos. |
| `concurrency` | `integer` | não | Agentes simultâneos. O teto global `maxConcurrency` vale sempre. |
| `execTimeoutMs` | `integer` | não | Tempo máximo, em milissegundos, de um comando que o workflow roda com `ctx.exec` e não passa o próprio `timeoutMs`. Passado esse tempo o comando é morto. Padrão: 600000 (10 minutos). |
| `settings` | [Ajustes de um workflow](#ajustes-de-um-workflow) | não | Ajustes do próprio workflow, pelo nome que ele declara em `meta.settings`: o padrão está no código do workflow e só o arquivo global e o do repositório o trocam. Um nome que o workflow não declara é erro. Os ajustes que o kit distribui estão na seção de ajustes de um workflow. |
| `roles` | objeto: nome → [Preferências de um papel ou de um glob de label](#preferências-de-um-papel-ou-de-um-glob-de-label) | não | Preferências por papel nomeado (o `meta.roles` do workflow). Um papel que o workflow não declara é erro. |
| `labels` | objeto: nome → [Preferências de um papel ou de um glob de label](#preferências-de-um-papel-ou-de-um-glob-de-label) | não | Preferências por glob do `label` da etapa (`*` e `?`), só para etapas sem papel. Vale o glob com mais caracteres literais; empate vai para o primeiro. |

## Ajustes de um workflow

Os campos abaixo são os ajustes do `implement-issue`, validados pelo esquema. Um workflow do seu repositório pode declarar ajustes com outros nomes em `meta.settings`: o kit não confere o tipo deles. Cada ajuste tem um valor só: o de uma camada de cima troca o de baixo inteiro, sem combinar campos.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `sliceCaps` | [Teto de fatias por tier](#teto-de-fatias-por-tier) | não | `implement-issue`: máximo de fatias TDD (ciclos red → green) por tier. As fatias do plano que passam do teto ficam adiadas: o PR só referencia a issue, sem fechá-la. Padrão: LOW 1, MED 3, HIGH 5. |
| `extraSlices` | `integer` | não | `implement-issue`: máximo de fatias extras que o review pode abrir (um requisito faltando ou errado vira uma fatia TDD nova). Padrão: 2. |
| `fixRounds` | `integer` | não | `implement-issue`: rodadas de correção de uma fatia cuja suíte falha depois do green; passadas todas, o run encerra com `tests-failed`. Padrão: 2. |
| `redGreenAttempts` | `integer` | não | `implement-issue`: tentativas de cada etapa red e de cada etapa green de uma fatia. Uma tentativa que viola o TDD é desfeita e a próxima leva o problema no prompt; na última, o run encerra com `tdd-violation` ou `test-not-red`. Padrão: 2. |
| `maxDiffChars` | `integer` | não | `implement-issue`: tamanho máximo, em caracteres, do diff que entra no prompt do review e no do PR. O que passa dele é cortado (com a estatística do diff inteiro) e o agente lê o resto nos arquivos. Padrão: 40000. |
| `labelTiers` | `objeto: nome → "LOW" \| "MED" \| "HIGH"` | não | `implement-issue`: label da issue (sem diferenciar maiúsculas) → tier. Quando várias labels casam, vale o tier mais alto, qualquer que seja a ordem. Sem nenhuma label que case, um classificador barato decide. Troca o mapa padrão inteiro (`complexity:low` e `good first issue` são LOW, `complexity:medium` é MED, `complexity:high` e `security` são HIGH). |
| `maxStepCrashes` | `integer` | não | `implement-issue`: quantas vezes uma mesma etapa de escrita pode derrubar o processo (um resume que a encontra em andamento) e ser retomada. Na vez seguinte o run encerra com `step-crash-loop`, em vez de repetir a etapa. Um cancelamento no meio da etapa não conta. Padrão: 2. |
| `gcFailedAfterDays` | `integer` | não | `implement-issue`: o `wf gc` remove o worktree e as branches (local e do origin) de um run que falhou há mais dias que isto. Falhou quer dizer terminou com erro ou com um status de falha (`tests-failed`, `baseline-red`…), ou o processo caiu sem terminar; um run cancelado não conta. A branch do origin só sai se o PR não está aberto e o commit nela é de um push do próprio run. Um run cujo PR foi mergeado ou fechado sai antes, sem esperar. Padrão: 14. |
| `testTimeoutSec` | `number` | não | `implement-issue`: tempo máximo, em segundos, de cada rodada de testes (e do `setupCommand`). Passado esse tempo o comando é morto e o run encerra com `tests-timeout`. O arg `testTimeoutSec` do run vence. Padrão: 600. |
| `networkTimeoutSec` | `number` | não | `implement-issue` e `wf gc`: tempo máximo, em segundos, de cada comando de rede (`git push`, `git ls-remote` e todo `gh`): uma credencial pedida ou uma conexão parada falha a etapa em vez de travar o run. O arg `networkTimeoutSec` do run vence. O git local usa o `execTimeoutMs` do workflow. Padrão: 120. |

## Teto de fatias por tier

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `LOW` | `integer` | sim | Fatias de uma issue LOW. |
| `MED` | `integer` | sim | Fatias de uma issue MED. |
| `HIGH` | `integer` | sim | Fatias de uma issue HIGH. |

## Preferências de um papel ou de um glob de label

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `model` | [Modelo](#modelo) | não | Modelo da etapa, campo a campo: o que não aparece herda da camada de baixo. |
| `timeoutMs` | `integer` | não | Tempo máximo da etapa, em milissegundos. |
| `retries` | `integer` | não | Tentativas extras quando a etapa termina em erro. |
| `schemaRetries` | `integer` | não | Re-prompts quando o agente não entrega o JSON do schema. |
| `maxTokensPerStep` | `integer \| null` | não | Teto de tokens desta etapa. Ausente: herda o do workflow. O teto global `maxTokensPerStep` vale sempre. |
| `settingSources` | `array de "project" \| "user" \| "team" \| "mdm" \| "plugins" \| "all"` | não | Camadas de configuração que a etapa carrega. A interseção com `caps.allowedSettingSources` é o que vale. |

## Modelo

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `id` | `string` | não | ID do modelo no catálogo da conta (`npm run models`). Ausente: herda. |
| `params` | array de [Parâmetro de modelo](#parâmetro-de-modelo) | não | Parâmetros do modelo. Ausente: herda, também quando só o `id` muda. Lista vazia: sem parâmetros. |
| `maxMode` | `boolean` | não | Liga o max mode do modelo. |

## Parâmetro de modelo

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `id` | `string` | sim | Nome do parâmetro (por exemplo `reasoning_effort`). |
| `value` | `string` | sim | Valor do parâmetro (por exemplo `high`). |

## Exemplos

**Arquivo global**

```json
{
  "$schema": "https://raw.githubusercontent.com/rodrigorjsf/cursor-workflows-starter/v0.3.0/packages/runtime/schema/config.schema.json",
  "caps": {
    "maxTokens": 3000000,
    "maxTokensPerStep": 600000,
    "maxCents": 500,
    "allowedModels": null,
    "allowedSettingSources": [
      "project",
      "user",
      "team",
      "mdm",
      "plugins"
    ],
    "allowedLocations": [
      "local"
    ],
    "maxConcurrency": 4
  }
}
```

**Arquivo do repositório**

```json
{
  "kit": ">=0.3.0 <0.4.0",
  "workflows": {
    "implement-issue": {
      "maxCents": 300,
      "roles": {
        "review": {
          "model": {
            "id": "grok-4.7",
            "params": [
              {
                "id": "reasoning_effort",
                "value": "medium"
              }
            ]
          },
          "timeoutMs": 900000
        },
        "implement.low": {
          "retries": 0
        }
      },
      "labels": {
        "desenhar:*": {
          "maxTokensPerStep": 150000
        }
      }
    }
  }
}
```

---

[← Anterior: 6.1 · Referência de eventos](events.md) · [Índice](../README.md) · [Próximo: 7.1 · ADR-0001: Layered config with hard caps →](../adr/0001-layered-config-with-hard-caps.md)
