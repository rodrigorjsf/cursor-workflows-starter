# 6.2 · Referência de configuração

<!-- Gerado por scripts/config-reference.ts a partir de packages/runtime/schema/config.schema.json. Não edite à mão: rode `npm run docs:config`. O `npm test` falha se esta página divergir do esquema. -->

O comportamento do kit se configura em JSON, em dois arquivos que um único esquema valida. A configuração é lida de novo a cada `start_workflow`, `wf run` e resume: uma edição vale no run seguinte, sem reiniciar o servidor MCP.

## Onde ficam os arquivos

- **Global**, `~/.cursor-workflows/config.json` (a pasta muda com `WF_HOME`): os tetos rígidos (`caps`) e preferências suas, valem em todos os repositórios.
- **Do repositório**, `.agents/workflows/config.json`: preferências por workflow e por papel, e a faixa `kit`. Vai para o controle de versão, então só pode **apertar** os tetos globais, nunca afrouxar.
- **O esquema** é `packages/runtime/schema/config.schema.json`. Aponte `$schema` para ele e o editor completa e valida. Arquivo inválido, ou com uma chave que o esquema não conhece (`unknown key`), derruba o run (e o `start_workflow`) antes de qualquer etapa, com o arquivo e o caminho do campo como ponteiro JSON, por exemplo `/workflows/implement-issue/roles/review/retries`.
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
- Um `dashboard` no arquivo do repositório é violação e não tem efeito: o dashboard é um só por usuário, para os runs de todos os repositórios.
- Um `overrides` do chat que afrouxaria o valor em vigor é violação e não tem efeito; apertar o valor é permitido. O `maxTokensPerStep` do chat vale como teto de todos os papéis e globs de label.
- Um valor que não é um limite válido (um `concurrency` 0, um `maxTokens` fracionário) numa flag, num `overrides` ou numa variável de ambiente é erro, com o nome de onde veio. Uma chave de `overrides` fora das quatro é erro também: `unknown override: <chave> (use maxTokens, maxTokensPerStep, maxCents, concurrency)`.
- Um modelo fora de `allowedModels` pedido pela configuração não tem efeito. Um modelo padrão do código que a lista recusa vira uma violação da camada `default` no `run-start`, e as etapas desse papel falham até a configuração trocá-lo.
- `settingSources` fora de `allowedSettingSources` são removidos, em todas as etapas.

As violações aparecem no `run-start` do log, como aviso no andamento do run, na resposta do `start_workflow` e no `wf config show`.

## `null` e chave ausente

`null` desliga um limite (num teto: sem teto; numa preferência: sem limite próprio, e os tetos globais seguem valendo). Uma chave ausente herda da camada de baixo. Zero é zero, nunca "sem valor".

## Papéis, globs de label e variáveis

- Um workflow declara seus **papéis** em `meta.roles`; os nomes são as chaves de `workflows.<nome>.roles` (`wf config show` e `list_workflows` os mostram). Cada papel declara a capacidade de nuvem em `cloud`: `ok`, `read-only` ou `never` (veja "Etapas na nuvem" abaixo). Um papel que o workflow não declara é erro, na configuração e em `agent({ role })`.
- Por papel se configura o modelo (com `params`), `timeoutMs`, `retries`, `schemaRetries`, `maxTokensPerStep`, `settingSources`, `location` e `resultVia`. A configuração vale mais que as opções da chamada `agent()`; os defaults do papel valem menos.
- `labels` guarda as mesmas preferências por glob (`*` e `?`) do `label` da etapa, só para etapas **sem** papel. Vale o glob com mais caracteres literais; empate vai para o primeiro.
- `WF_MODEL_<PAPEL>` troca o modelo de um papel: o nome do papel em maiúsculas, com `.` e `-` como `_` (`WF_MODEL_REVIEW`, `WF_MODEL_IMPLEMENT_LOW`), ou um apelido que o workflow declara (`WF_MODEL_LOW`). O valor `id` troca só o ID e mantém os `params`; `id[param=valor,max]` troca também os `params` (`max` liga o max mode; `id[]` limpa os `params`). Variáveis que não casam com um papel do workflow são ignoradas.
- `execTimeoutMs` é uma preferência do workflow, não de um papel: o tempo máximo, em milissegundos, de um comando que o workflow roda com `ctx.exec` sem passar o próprio `timeoutMs` (padrão: 600000, 10 minutos). Passado o tempo, o motor mata o comando. Entra na configuração efetiva do `run-start`, com a origem, e vale a cada execução, resumes inclusive.
- `settings` guarda os **ajustes** do próprio workflow: o workflow declara os nomes e os padrões em `meta.settings`, lê o resultado em `ctx.settings`, e só o arquivo global e o do repositório os trocam (o do repositório vale mais). Cada ajuste vale inteiro: o de uma camada de cima troca o de baixo, sem combinar campos. Não há variável de ambiente, flag nem `overrides` do chat para eles. Um nome que o workflow não declara é erro, com o caminho do campo, como um papel desconhecido. O `run-start` e o `wf config show` trazem os ajustes em vigor (`config.settings`), com a origem de cada um em `provenance` (`/settings/<nome>`). Os do `implement-issue` estão na seção "Ajustes de um workflow".
- `maxTokensPerStep` entra na configuração efetiva e no `run-start`, e o motor o aplica **durante** a etapa: a cada turno do agente (`turn-ended`), a soma dos tokens de todas as tentativas da etapa é comparada com ele, e a etapa que passa dele (estritamente) tem o run do agente cancelado e falha com `errorKind: "budget"`, sem nova tentativa. O `maxTokens` do run funciona do mesmo jeito sobre o gasto do run inteiro, resumes inclusive, e cancela todas as etapas ativas. A ultrapassagem é de no máximo um turno por etapa ativa; um turno do SDK pode ser o laço inteiro do agente, e é o `timeoutMs` que freia dentro dele.

## Etapas na nuvem

`location` escolhe onde as etapas de um papel rodam: `local` (o padrão) ou `cloud`, um cloud agent da Cursor. Mandar código para uma VM é decisão do dono da máquina, então a nuvem só vale com três condições juntas:

1. o arquivo **global** lista `cloud` em `caps.allowedLocations` (sem a chave, só `local`; `null` libera todos). Se não lista, o papel roda local e o pedido vira uma **violação**: um pull request que edita o arquivo do repositório não liga a nuvem;
2. o workflow declara o papel `ok` ou `read-only` em `meta.roles`. Um papel `never` na nuvem é erro de configuração, recusado antes do run (e uma etapa de papel `read-only` que pode escrever falha antes de gastar). `location` só vale em papéis: num glob de `labels` é erro;
3. se a etapa escreve (as `tools` dela não são só de leitura), o papel não é `read-only`: a etapa que escreve roda na nuvem só num papel `ok`, e o trabalho dela volta para o worktree (veja "Etapas que escrevem").

Antes da etapa o motor empurra o estado do worktree da etapa, o não commitado inclusive, como uma branch descartável `wf/cloud-snapshot/<run>/<id>` para o remote `cloud.remote` (padrão `origin`), e a apaga quando a etapa termina, de qualquer jeito que termine. O cloud agent só enxerga o que foi empurrado. **CI:** cada snapshot é um push, e uma pipeline que roda em toda branch rodaria a cada etapa. Exclua o prefixo `wf/cloud-snapshot/` (ou `wf/**`) da pipeline do remote, ou aponte `cloud.remote` para um fork. A etapa precisa de um plano da Cursor com Cloud Agents e de um code host conectado com acesso de escrita.

Uma etapa na nuvem é um subconjunto estrito de uma local: o cloud agent não recebe custom tools, allowlist de tools nem camadas de configuração (o motor avisa que as `settingSources` são ignoradas), o memo não vale, e a saída estruturada vem de um bloco `json` no fim da resposta, validado com o mesmo Ajv e corrigido por follow-ups dentro dos `schemaRetries` (ou do arquivo `result.json`, com `resultVia: "artifact"`: veja "Resultado estruturado"). Tokens e custo vêm do uso do cloud agent e entram nos mesmos tetos. O `step-start` e o `step-end` do log trazem `location`. Uma branch de snapshot que ficou para trás (o processo morreu entre o push e a exclusão, ou o remote recusou apagá-la) é varrida pelo `wf gc`, no remote `cloud.remote`: sai quando o run que a fez é deste repositório, nenhum processo o executa e o último evento dele tem mais de `gcSnapshotGraceHours` horas (padrão 24, em `workflows.implement-issue.settings`: o cloud agent que o processo morto iniciou pode ainda estar partindo da branch); senão fica, com o motivo no plano. A de um run cortado no meio da etapa dona dela fica por `gcFailedAfterDays` dias, e a de um run cancelado sem limite (o gc também mantém o run), porque um resume pode reanexar ao agente e trazer o trabalho dessa branch (o gc não pergunta à nuvem se o run do agente foi cancelado, caso em que o resume cria outro: veja "Ciclo de vida"). A que um crash deixou também é apagada pelo resume que retoma a etapa, reanexe ele ao agente ou crie outro.

**Etapas que escrevem.** O cloud agent trabalha na própria branch de snapshot (`workOnCurrentBranch`, sem PR) e commita nela; o prompt da etapa ganha a instrução de commitar ali, mesmo que o prompt do workflow, escrito para um agente local, diga para não rodar comandos git, e de não criar outra branch, não reescrever o histórico e não abrir PR. Quando o run termina, o motor busca a branch e avança o worktree até ela (fast-forward: arquivos, índice e branch atual), e só então apaga o snapshot. O worktree termina limpo na árvore do agente. Se o worktree tinha mudanças não commitadas, o commit de snapshot que as guarda (`wf: snapshot of the worktree for ...`) passa a fazer parte do histórico local, porque é nele que o agente se apoiou; com o worktree limpo, o snapshot é o próprio `HEAD` e o histórico ganha só os commits do agente. Os comandos que o workflow roda depois com `ctx.exec` (a suíte de testes do TDD, por exemplo) rodam aqui, no worktree já avançado.

Trazer o trabalho de volta é um fast-forward ou nada. O motor recusa, sem mudar nada no worktree, e a etapa falha (sem nova tentativa, mesmo com `retries` sobrando: outra pagaria um agente novo) quando: a branch do agente deixou de conter o snapshot de onde ele partiu (ele reescreveu o histórico); a branch local andou enquanto o agente trabalhava (um commit, um reset); ou os arquivos do worktree já não são o que foi empurrado, caso em que trazer o trabalho sobrescreveria as mudanças feitas nesse meio tempo; ou o agente adiciona um arquivo num caminho onde o worktree tem um que o git ignora (o snapshot não o guarda, e o avanço o sobrescreveria). Uma etapa na nuvem recusada assim não deixa nada para desfazer no worktree, então o `revertOnRetry` da chamada e o cancelamento não o tocam: o que a pessoa mudou nesse meio tempo fica. Se o avanço falha depois de começar a mexer no índice e nos arquivos, o motor devolve o worktree ao que era antes da etapa (`reverted` no `step-end`); a branch só anda por último. O agente que não commitou nada não muda nada, e o motor avisa: a etapa que escreve precisa commitar o trabalho. Se o run do agente informa que empurrou só para outra branch que não a de snapshot, a etapa falha dizendo qual (o trabalho dele não está na branch a que o worktree avança), e essa branch fica no remote para ser apagada à mão.

**Resultado estruturado.** `resultVia` escolhe como uma etapa na nuvem do papel entrega o resultado estruturado (só roles, e só vale na nuvem: no local o resultado vem de uma tool). `json-block` (o padrão) lê o último bloco de código `json` da resposta final. `artifact` pede ao agente que salve o resultado no arquivo `result.json` dos artefatos dele (`/opt/cursor/artifacts/result.json`), e o motor o baixa depois do run (`listArtifacts` e `downloadArtifact` do SDK); serve quando ler o resultado do texto se mostra pouco confiável. Nos dois casos o resultado é validado contra o schema da etapa, com follow-ups dentro dos `schemaRetries`. Falta conferir com a API real onde o agente grava o arquivo e como a API lista o caminho (a doc só diz que ele é relativo ao diretório `artifacts/` do workspace): o motor aceita `result.json`, `artifacts/result.json` e `/opt/cursor/artifacts/result.json`.

**Ciclo de vida.** O motor grava o id do cloud agent no log (evento `cloud-agent`) assim que o agente existe. Se o processo morre e o run é retomado com o mesmo `runId`, a etapa reanexa ao agente que ainda roda, em vez de criar outro, e usa a resposta do run que ele já tinha (ou a que ele deu enquanto ninguém olhava). Cancelar um run que está executando cancela os runs dele na nuvem. Num run cujo processo já morreu, ou travou (vivo, sem heartbeat: o cancelamento o mata com `SIGKILL` antes), o cancelamento (`wf cancel`, `cancel_workflow`, o do dashboard inclusive) lê no log os cloud agents cuja tentativa não terminou e cancela os runs deles pela API da Cursor, a menos que um processo esteja executando o run de novo; isso alcança também o agente de uma etapa que o resume não chega a executar. O cancelamento não grava nada no log, então a etapa continua interrompida. O cliente do SDK desiste de esperar um run da nuvem depois de duas horas: o motor pergunta à nuvem e, se o run continua, espera de novo; o `timeoutMs` da etapa é quem a limita. Dois casos fazem a etapa criar outro agente, que custa de novo, em vez de reanexar: o agente deixou de existir na nuvem (404; aviso `cloud agent <id>, left by an interrupted attempt, is no longer there: starting a new one`), ou nenhum run dele roda e o mais novo foi cancelado, como depois do cancelamento de um run cujo processo morreu ou travou (aviso `cloud agent <id>, left by an interrupted attempt, was cancelled: starting a new one`). O que o agente substituído commitou na branch de snapshot dele não volta para o worktree: o resume apaga essa branch. Se não dá para falar com a nuvem, a tentativa falha e a seguinte reanexa de novo, sem criar outro. Um run reanexado não tem stream: o log não guarda o que o agente fez no intervalo (só a resposta final dele entra, como uma mensagem do agente), e os tetos de tokens ao vivo só atuam quando o run termina.

## O que cada run grava

O `run-start` do log de eventos ([6.1 §run-start](events.md#run-start)) leva a configuração efetiva (`config`), de onde veio cada valor (`provenance`, por ponteiro JSON em `config`) e as violações (`violations`). `wf config show [workflow]` imprime os três para o repositório atual, com o caminho dos dois arquivos e se foram achados.

## Raiz do arquivo

Valida os dois arquivos de configuração do kit: o global (`~/.cursor-workflows/config.json`) e o do repositório (`.agents/workflows/config.json`).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `$schema` | `string` | não | Endereço deste esquema: dá autocompletar e validação no editor. |
| `kit` | `string` | não | Faixa semver do kit que este repositório aceita (por exemplo `>=0.3.0 <0.4.0`). Só vale no arquivo do repositório: um kit fora da faixa é recusado. |
| `caps` | [Tetos globais (caps)](#tetos-globais-caps) | não | Tetos rígidos. Só valem no arquivo global: o arquivo do repositório e o chat só podem apertá-los, nunca afrouxar. Um `caps` no arquivo do repositório é registrado como violação e não tem efeito. |
| `cloud` | [Etapas na nuvem](#etapas-na-nuvem) | não | Preferências das etapas na nuvem (`location: "cloud"`). Valem nos dois arquivos; o do repositório vale mais. |
| `dashboard` | [O dashboard](#o-dashboard) | não | O dashboard local. Só vale no arquivo global: ele é um só por usuário, para os runs de todos os repositórios. Um `dashboard` no arquivo do repositório é registrado como violação e não tem efeito. |
| `workflows` | objeto: nome → [Preferências de um workflow](#preferências-de-um-workflow) | não | Preferências por workflow, pelo `meta.name` dele. Uma preferência acima de um teto global é reduzida ao teto e registrada como violação. |

## Tetos globais (caps)

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `maxTokens` | `integer \| null` | não | Teto de tokens por run. Números: vale o menor entre o teto e o valor pedido. |
| `maxTokensPerStep` | `integer \| null` | não | Teto de tokens por etapa. |
| `maxCents` | `number \| null` | não | Teto de custo por run, em centavos. `null` desliga. |
| `allowedModels` | `array de string \| null` | não | Modelos permitidos, pelo ID como escrito na config (aceita `*` como curinga: `composer-*`). Listas: vale a interseção. Uma etapa cujo modelo não está na lista falha. `null` libera todos. |
| `allowedSettingSources` | `array de "project" \| "user" \| "team" \| "mdm" \| "plugins" \| "all" \| null` | não | Camadas de configuração (`settingSources`) que uma etapa pode carregar. Listas: vale a interseção. O instalador grava todas menos `all`. `null` libera todas. |
| `allowedLocations` | `array de "local" \| "cloud" \| null` | não | Onde as etapas podem rodar: `local`, `cloud` ou os dois. Sem a chave, só `local`: mandar código para uma VM na nuvem é decisão do dono da máquina, e o arquivo do repositório nunca a toma. Listas: vale a interseção. `null` libera todos. Um papel com `location: "cloud"` que a lista não permite roda local, e o pedido vira uma violação. |
| `maxConcurrency` | `integer \| null` | não | Máximo de agentes simultâneos num run. `null` desliga. |
| `requireSandbox` | `boolean \| null` | não | `true` liga o sandbox local do SDK em toda etapa, mesmo quando o código do workflow o desliga: um pull request que edita um workflow não afrouxa o sandbox. Ausente, `false` ou `null`: vale o `sandbox` de cada etapa. |

## Etapas na nuvem

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `remote` | `string` | não | Nome do remote do git para onde vão as branches de snapshot do worktree, que o cloud agent lê. Padrão: `origin`. Aponte para um fork se o pipeline de CI do `origin` não deve rodar a cada snapshot (as branches ficam sob `wf/cloud-snapshot/` e são apagadas quando a etapa termina; o `wf gc` varre, neste remote, as que ficaram para trás). |

## O dashboard

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `autoStart` | `boolean` | não | `false` impede o `start_workflow` de iniciar o dashboard quando ele não está rodando (a variável de ambiente `WF_DASH_AUTOSTART=off` faz o mesmo). Um dashboard que já está de pé continua sendo informado na resposta (`dashboardUrl`). Padrão: `true`. |

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
| `fixRounds` | `integer` | não | `implement-issue`: rodadas de correção de uma fatia cuja suíte falha depois do green; passadas todas, o run encerra com `tests-failed`. Uma rodada só conta quando a etapa de correção chega ao fim: interrompida (cancelamento ou queda), o resume a refaz. Padrão: 2. |
| `redGreenAttempts` | `integer` | não | `implement-issue`: tentativas de cada etapa red e de cada etapa green de uma fatia. Uma tentativa que viola o TDD é desfeita e a próxima leva o problema no prompt; na última, o run encerra com `tdd-violation` ou `test-not-red`. Padrão: 2. |
| `maxDiffChars` | `integer` | não | `implement-issue`: tamanho máximo, em caracteres, do diff que entra no prompt do review e no do PR. O que passa dele é cortado (com a estatística do diff inteiro) e o agente lê o resto nos arquivos. Padrão: 40000. |
| `labelTiers` | `objeto: nome → "LOW" \| "MED" \| "HIGH"` | não | `implement-issue`: label da issue (sem diferenciar maiúsculas) → tier. Quando várias labels casam, vale o tier mais alto, qualquer que seja a ordem. Sem nenhuma label que case, um classificador barato decide. Troca o mapa padrão inteiro (`complexity:low` e `good first issue` são LOW, `complexity:medium` é MED, `complexity:high` e `security` são HIGH). |
| `maxStepCrashes` | `integer` | não | `implement-issue`: quantas vezes uma mesma etapa de escrita pode derrubar o processo (um resume que a encontra em andamento) e ser retomada. Na vez seguinte o run encerra com `step-crash-loop`, em vez de repetir a etapa. Um cancelamento no meio da etapa não conta. Padrão: 2. |
| `gcFailedAfterDays` | `integer` | não | `implement-issue`: o `wf gc` remove o worktree e as branches (local e do origin) de um run que falhou há mais dias que isto. Falhou quer dizer terminou com erro ou com um status de falha (`tests-failed`, `baseline-red`…), ou o processo caiu sem terminar; um run cancelado não conta. A branch do origin só sai se o PR não está aberto e o commit nela é de um push do próprio run. Um run cujo PR foi mergeado ou fechado sai antes, sem esperar. Padrão: 14. |
| `gcSnapshotGraceHours` | `number` | não | `implement-issue`: o `wf gc` varre as branches de snapshot (`wf/cloud-snapshot/<run>/<id>`, que as etapas na nuvem empurram para o `cloud.remote`) que a etapa não apagou: o processo caiu, foi morto, ou o remote recusou apagar. A branch sai quando o run que a fez é deste repositório, nenhum processo o executa e o último evento dele tem mais horas que isto; enquanto isso ela fica, com o motivo no plano. A espera existe porque o cloud agent que o processo morto iniciou pode ainda estar partindo da branch, e ninguém mediu na API real quanto ele demora a lê-la. Um run cortado no meio da etapa dona da branch (o resume pode reanexar ao agente, a não ser que o run dele tenha sido cancelado, e o trabalho de uma etapa que escreve está nela) a mantém por `gcFailedAfterDays` dias, e a de um run cancelado (que o gc também mantém, porque ele pode ser retomado) sem limite. Padrão: 24. |
| `testTimeoutSec` | `number` | não | `implement-issue`: tempo máximo, em segundos, de cada rodada de testes (e do `setupCommand`). Passado esse tempo o comando é morto: uma rodada de testes encerra o run com `tests-timeout`, e o `setupCommand` com `setup-failed`, como qualquer falha dele. Padrão: 600. |
| `networkTimeoutSec` | `number` | não | `implement-issue` e `wf gc`: tempo máximo, em segundos, de cada comando de rede (`git push`, `git ls-remote` e todo `gh`): uma credencial pedida ou uma conexão parada falha a etapa em vez de travar o run. O git local usa o `execTimeoutMs` do workflow. Padrão: 120. |

## Teto de fatias por tier

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `LOW` | `integer` | sim | Fatias de uma issue LOW. |
| `MED` | `integer` | sim | Fatias de uma issue MED. |
| `HIGH` | `integer` | sim | Fatias de uma issue HIGH. |

## Preferências de um papel ou de um glob de label

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `location` | `"local" \| "cloud"` | não | Onde as etapas do papel rodam. Padrão: `local`. `cloud` roda a etapa num cloud agent da Cursor, contra um snapshot do worktree empurrado para o remote, e só vale se o teto global `caps.allowedLocations` incluir `cloud` e o workflow declarar o papel como `ok` ou `read-only` (um papel `never` é recusado). Só vale em papéis, não em globs de `labels`. |
| `resultVia` | `"json-block" \| "artifact"` | não | Como uma etapa do papel que roda na nuvem entrega o resultado estruturado. Padrão: `json-block`, o último bloco de código `json` da resposta final do agente. `artifact` pede ao agente que salve o resultado no arquivo `result.json` dos artefatos dele, e o motor o baixa depois do run; serve quando ler o resultado do texto se mostra pouco confiável. Nos dois casos o resultado é validado contra o schema da etapa, com follow-ups dentro de `schemaRetries`. Só vale em papéis, não em globs de `labels`, e só em etapas na nuvem: no local o resultado vem de uma tool. |
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
        "design:*": {
          "maxTokensPerStep": 150000
        }
      }
    }
  }
}
```

---

[← Anterior: 6.1 · Referência de eventos](events.md) · [Índice](../README.md) · [Próximo: 7.1 · ADR-0001: Layered config with hard caps →](../adr/0001-layered-config-with-hard-caps.md)
