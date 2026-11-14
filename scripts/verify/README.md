# Workflows de verificação

Reproduzem contra a API real as verificações registradas em
[`docs/research/verificacoes-locais.md`](../../docs/research/verificacoes-locais.md). Use-os para checar o kit numa conta
nova, por exemplo a Enterprise do seu time, antes de adotar.

**Custam tokens.** Na medição de 2026-11-11, com `composer-2.5`: `verify-structured` usou cerca de 110 mil tokens,
`verify-context` cerca de 60 mil e `verify-cache` cerca de 46 mil; o `verify-turn-granularity`, o `verify-sandbox` e o `verify-cloud` têm a sua
seção, abaixo. Rode sempre com `--max-tokens` e `--max-cents`. Prefira os modelos
incluídos no plano; modelos que consomem cota paga são permitidos quando o teste precisar deles
([política de custo](../../docs/contributing/01-contribuindo.md#testes-contra-a-api-real-política-de-custo)).

```bash
scripts/verify/setup-probe-repo.sh ~/tmp/wf-probe-repo      # repositório descartável (AGENTS.md, hooks, mcp.json)
export WORKFLOWS_DIR=scripts/verify WF_METRICS_DB=~/tmp/wf-verify.db
npm run wf -- run verify-structured --cwd ~/tmp/wf-probe-repo --args '{}' --max-tokens 150000 --max-cents 25
npm run wf -- run verify-context    --cwd ~/tmp/wf-probe-repo --args '{}' --max-tokens 120000 --max-cents 25
npm run wf -- run verify-cache      --cwd ~/tmp/wf-probe-repo --args '{}' --max-tokens 100000 --max-cents 25
```

`WF_VERIFY_MODEL` troca o modelo (default `composer-2.5`; confira os seus com `npm run models`).

| Workflow | O que olhar no resultado | Resultado medido em 2026-11-11 |
|---|---|---|
| `verify-structured` | `a` e `b` válidos; no stderr, o `step-end` de `b` com `mcp: 2` (JSON recusado e corrigido) | as três etapas entregaram; `b` corrigiu no mesmo turno |
| `verify-context` | `project.marker`, `project.mcpTools`, `project.blockedCommand`, `insideEnv`; os arquivos em `.probe/` | com `project`: marcador lido, hooks do Cursor e do Claude Code disparam (o deny bloqueia), sem tools do `workflows`, `inside=1`; sem settings: nada disso |
| `verify-cache` | `cacheReadTokens` de cada etapa nos eventos `turn` | só o prefixo fixo (~4 mil tokens) é reaproveitado com garantia |

## `verify-turn-granularity`: uma etapa local longa

Mede até onde os tetos de tokens ao vivo alcançam ([2.2 §3](../../docs/usage/02-configuracao-inicial.md#3-teto-de-custo)): eles só
olham o uso quando o SDK entrega um `turn-ended`, então o que importa é quantos `turn-ended` um envio longo que escreve gera. O
workflow faz **três envios** do mesmo pedido (uma biblioteca de seis módulos com testes, escrita um módulo por vez, com
`node --test` entre eles):

1. a etapa `long-write`, pelo motor (`ctx.agent`): os eventos `turn` do `events.jsonl` contra o `step-end` (`turns`, `usage.totalTokens`);
2. um envio direto pelo SDK, vendo cada update: quantos `turn-ended` chegam e se a soma dos `token-delta` bate com `RunResult.usage`
   (o motor não repassa `token-delta`, por isso a via direta);
3. um segundo envio direto, cancelado com `Run.cancel()` no meio do turno (quando a soma dos `token-delta` chega a 3 mil ou na
   terceira tool call, o que vier primeiro): quanto `cancel()` e `wait()` levam para assentar. É um cancelamento direto no SDK,
   não um corte do motor: uma etapa com `maxTokensPerStep` baixo só seria cortada no fim do envio.

**Custa:** na medição de 2026-11-14, com `composer-2.5`, o run inteiro gastou de 134 mil a 268 mil tokens na etapa do motor e
cerca de 128 mil no envio direto longo, o que dá **cerca de 10 centavos por run no preço de lista** (a tabela `pricing`), com 0
cobrado (uso incluído no plano). Só o `--max-tokens` limita a etapa `long-write` (o workflow recusa rodar sem os dois tetos): os dois envios diretos não passam
pelo motor, e cada um tem como freio um limite de 8 minutos. Numa conta em que o `getUsage()` de agente local não vem (`feature_unavailable`), o
`--max-cents` também não dispara.

```bash
scripts/verify/setup-probe-repo.sh ~/tmp/wf-turn-repo        # um repositório NOVO: o workflow recusa um que já tem lib/
export WORKFLOWS_DIR=scripts/verify WF_METRICS_DB=~/tmp/wf-verify.db
npm run wf -- run verify-turn-granularity --cwd ~/tmp/wf-turn-repo --args '{}' --max-tokens 400000 --max-cents 40
```

| O que olhar | Onde | Resultado medido em 2026-11-14 |
|---|---|---|
| `engine.turnEvents` e `engine.stepEndTurns`, com `engine.stepEndTotalTokens` | o resultado do run | 1 e 1; 267.526 e 133.969 tokens (dois runs) |
| `deltas.turnEnded` e `deltas.updates` | o resultado do run | 1 `turn-ended` e 1 `step-completed` para 21 tool calls e 14 `tool-requests-listed` |
| `deltas.tokenDeltas.total` e `deltas.sum.ratios` | o resultado do run | a soma passa do `outputTokens` (1,41 a 1,53 vezes) e vale 4,4% do `totalTokens`: não soma ao uso |
| `cancel.cancel.waitSettledMs`, `cancel.result.status` e `cancel.turnEnded` | o resultado do run | `wait()` assenta 3 ms depois do `cancel()`, `status: "cancelled"`, nenhum `turn-ended` |
| `rule` | o resultado do run | `3`: a regra do [#37](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/37) (1: vários `turn-ended`; 2: um, com `token-delta` somável; 3: nenhum dos dois) |

O resultado dessas medições, com as contagens de cada run, está em [8.2 §15](../../docs/research/verificacoes-locais.md).

## `verify-sandbox`: uma etapa que escreve, no sandbox do SDK

Mede se o sandbox do SDK segura o que uma etapa que leu texto não confiável poderia fazer ([#62](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/62)).
O workflow roda **uma etapa que escreve**, com o sandbox ligado, todas as tools e o `settingSources` default, como as do
`implement-issue`, e escreve um `.cursor/sandbox.json` com `readBoundary: "workspace"` e a rede negada, salvo um host. Três
tentativas decidem o resultado, cada uma com **PASS** se foi bloqueada e **FAIL** se passou:

1. `curl` para um host fora da allowlist (`example.com`);
2. escrita fora do repositório (`touch` na home);
3. `cat ~/.cursor/sdk/auth.json` (a saída vai para o `/dev/null`: a chave não entra no contexto nem no log).

O veredito não vem do que o agente diz. Vem do log de eventos (a chamada e a saída de cada tool) e dos arquivos que o código do
workflow confere de fora do sandbox, e cada tentativa tem um controle: o mesmo `curl` e a mesma leitura fora do sandbox, e uma
escrita dentro do repositório. Uma tentativa que o agente não fez, ou que a máquina também não faria sem o sandbox, sai
**INCONCLUSIVE**, nunca PASS. Fora do portão, o resultado traz um `curl` para o host da allowlist, uma escrita fora do
repositório pela tool `edit` e as variáveis `CURSOR_SANDBOX_*` que o shell da etapa enxerga (qual backend impôs as regras).

**Precisa do `bubblewrap`** (`bwrap` no PATH): sem ele o run para, nomeando o `bubblewrap`, e isso não é registrado como resultado
do sandbox. Recusa um run sem os dois tetos e um repositório que já tem `.cursor/sandbox.json`; no fim apaga o arquivo que
escreveu, os marcadores e o que as tentativas criaram fora do repositório.

**Custa:** na medição de 2026-11-14, com `composer-2.5`, de 24 mil a 83 mil tokens por run (cinco runs, 291 mil no total), o que dá
**cerca de 2 centavos por run no preço de lista**, com 0 cobrado (uso incluído no plano). Os dois tetos valem para a etapa, que é a
única chamada ao modelo.

```bash
mkdir -p ~/tmp/wf-sandbox-probe && cd ~/tmp/wf-sandbox-probe && git init -q -b main && printf '{ "name": "wf-sandbox-probe", "private": true, "type": "module" }\n' > package.json && cd -   # repositório descartável, sem remoto
export WORKFLOWS_DIR=scripts/verify WF_METRICS_DB=~/tmp/wf-verify.db
npm run wf -- run verify-sandbox --cwd ~/tmp/wf-sandbox-probe --args '{}' --max-tokens 150000 --max-cents 25
npm run wf -- run verify-sandbox --cwd ~/tmp/wf-sandbox-probe --args '{"readBoundary":"unset"}' --max-tokens 150000 --max-cents 25   # base de comparação, fora do portão
```

Qualquer repositório descartável serve; o [`setup-sandbox-repo.sh`](setup-sandbox-repo.sh) cria um no GitHub, o que esta sonda não
precisa (ela não usa o remoto).

| O que olhar | Onde | Resultado medido em 2026-11-14 |
|---|---|---|
| `report`, com uma linha por tentativa, e `allBlocked` | o resultado do run | com `readBoundary: "workspace"`: as três PASS em todos os runs; `allBlocked: true` |
| `attempts[2]` (leitura da chave) com `{"readBoundary":"unset"}` | o resultado do run | FAIL: o `cat` saiu com 0. Só o `readBoundary` bloqueia a leitura |
| `extras.allowlistHonoured`, `extras.editToolWrite` e `extras.backendVariables` | o resultado do run | `yes`; `blocked` (a tool `edit` foi recusada); `CURSOR_SANDBOX_LANDLOCK_STATUS=fully_enforced` |
| `controls` | o resultado do run | `networkReachableOutside` e `authFileReadableOutside`, os dois `true` |

O resultado dessas medições, com a decisão e o que não foi medido, está em [8.2 §16](../../docs/research/verificacoes-locais.md).

## `verify-cloud`: uma etapa na nuvem

O `verify-cloud` roda **uma etapa de leitura num cloud agent**. Antes dela, deixa na raiz do repositório um arquivo
`.wf-verify-cloud-marker` (não commitado, não ignorado) com um valor aleatório, e pede ao agente da nuvem que leia esse
arquivo e o `package.json` e responda num bloco JSON; depois confere se a branch de snapshot que o motor empurrou sumiu do
remote. Mede o que só a API real confirma: que o agente parte de uma branch empurrada, que enxerga o arquivo não
commitado, que a resposta final traz o bloco JSON, e o uso e o custo por run.

Pede mais que os outros três, e **empurra e apaga uma branch `wf/cloud-snapshot/…` no `origin` do repositório**:

- um plano da Cursor com Cloud Agents;
- um repositório cujo `origin` está num code host conectado à conta da Cursor, com acesso de escrita: o do
  [`setup-sandbox-repo.sh`](setup-sandbox-repo.sh) serve, e não use um repositório que importa;
- a nuvem liberada na configuração global (só o dono da máquina libera, `caps.allowedLocations`). Uma configuração
  descartável, sem tocar na sua, resolve:

```bash
export WF_HOME=~/tmp/wf-verify-cloud-home WF_METRICS_DB=~/tmp/wf-verify.db
mkdir -p "$WF_HOME" && cat > "$WF_HOME/config.json" <<'JSON'
{ "caps": { "allowedLocations": ["local", "cloud"] },
  "workflows": { "verify-cloud": { "roles": { "probe": { "location": "cloud" } } } } }
JSON
export WORKFLOWS_DIR=scripts/verify
npm run wf -- run verify-cloud --cwd ~/tmp/wf-sandbox --args '{}' --max-tokens 60000 --max-cents 25
```

| O que olhar | Onde |
|---|---|
| `sawUncommittedFile: true` (o agente leu o arquivo que só o snapshot tem) e `snapshotBranches.after: 0` | o resultado do run |
| O evento `cloud-agent` (`agentId` `bc-…`, `snapshot.branch`) e o `step-end` com `location: "cloud"`, `usage` e `costFinal` | `<repositório>/.workflows/runs/<runId>/events.jsonl` |
| `schemaReprompts` no `step-end` (0 se o primeiro bloco JSON valeu) | o mesmo `step-end` |

O ciclo de vida se confere à mão, com o mesmo comando:

1. **Reanexar.** Rode o comando acima, espere o evento `cloud-agent` aparecer no `events.jsonl` e mate o processo do `wf`
   com `kill -9`. Rode de novo com `--resume <runId>`: tem de aparecer o aviso `reattaching to cloud agent bc-…`, o mesmo
   id de agente termina a etapa e nenhum segundo `bc-…` é criado. O `ls-remote` do `origin` não pode listar nenhuma
   `wf/cloud-snapshot/*`.
2. **Cancelar.** Ctrl-C (ou `wf cancel`) com a etapa rodando: o run termina `cancelled`, e o run do agente aparece como
   cancelado na Cursor.
3. O limite de espera de duas horas do cliente só se confere com uma etapa de `timeoutMs` acima disso: está coberto pelos
   testes offline, que simulam o limite.

O resultado dessas conferências vai em [8.2 §14](../../docs/research/verificacoes-locais.md).

## GitLab de verdade no Docker: `gitlab-e2e.sh`

O código de GitLab do runtime é testado offline contra um `glab` falso. As saídas desse falso não são escritas à mão: o
[`gitlab-e2e.sh`](gitlab-e2e.sh) sobe um GitLab CE de verdade no Docker, roda o `glab` de verdade contra cada comando e
rota de API que o runtime usa e grava o que ele imprimiu em
[`packages/runtime/test/fixtures/glab/recordings.json`](../../packages/runtime/test/fixtures/glab/recordings.json). O token, a
senha do root e o host local saem trocados por placeholders fixos, e o gravador (`record-glab-fixtures.ts`) não escreve nada se
sobrar um segredo. Depois do gravador, o mesmo GitLab serve às provas do [`prove-gitlab.ts`](prove-gitlab.ts), num projeto
`owner/proof` que ele cria. É decisão do [ADR-0009](../../docs/adr/0009-forge-seam-github-and-gitlab.md).

**Custa memória, tempo e, na última prova, tokens.** O GitLab CE em modo de pouca memória (um processo Puma, Sidekiq enxuto, sem
Prometheus, 256 MB de memória compartilhada) usa cerca de 2,5 GB e leva alguns minutos para subir; o script recusa rodar com
menos de 4 GiB no Docker. A última prova roda o `implement-issue` de verdade, com etapas locais, contra a API da Cursor
(`wf login` feito) e passa `--max-tokens` e `--max-cents` ao `wf run`. Fica fora do `npm run check` e do CI.

```bash
GITLAB_E2E_MAX_TOKENS=600000 GITLAB_E2E_MAX_CENTS=100 mise exec -- scripts/verify/gitlab-e2e.sh   # o glab fixado no mise.toml fica no PATH
GITLAB_E2E_STAGES=closing,quick-actions,references mise exec -- scripts/verify/gitlab-e2e.sh   # sem gastar tokens
GITLAB_E2E_IMAGE=gitlab/gitlab-ce:latest GITLAB_E2E_MAX_TOKENS=600000 GITLAB_E2E_MAX_CENTS=100 mise exec -- scripts/verify/gitlab-e2e.sh   # a imagem mais nova, só para ver
```

| Variável | Padrão | O que muda |
|---|---|---|
| `GITLAB_E2E_IMAGE` | `gitlab/gitlab-ce:19.5.5-ce.0` | A imagem do GitLab. Um resultado só se reproduz com a tag fixada |
| `GITLAB_E2E_PORT` | `8929` | A porta em `127.0.0.1`: o GitLab nunca fica exposto na rede |
| `GITLAB_E2E_NAME` | `wf-gitlab-e2e` | O nome do container e o prefixo dos três volumes (`-config`, `-logs`, `-data`) |
| `GITLAB_E2E_TIMEOUT_SECONDS` | `1800` | Quanto esperar o GitLab responder |
| `GITLAB_E2E_POLL_SECONDS` | `10` | De quanto em quanto tempo olhar se ele já responde |
| `GITLAB_E2E_MIN_MEMORY_MB` | `4096` | A memória mínima que o script aceita do Docker; abaixo disso ele recusa rodar |
| `GITLAB_E2E_MAX_TOKENS` | `600000` | O `--max-tokens` do `implement-issue` da última prova (um LOW gasta cerca de 340 mil) |
| `GITLAB_E2E_MAX_CENTS` | `100` | O `--max-cents` do mesmo run |
| `GITLAB_E2E_STAGES` | todas | As provas a rodar, separadas por vírgula: `closing`, `quick-actions`, `references` e `workflow`. Sem a última, nada gasta tokens |
| `GITLAB_E2E_WORKFLOW_TIMEOUT_SECONDS` | `2700` | Quanto o `implement-issue` da última prova pode levar antes de ser cancelado |

O script nunca reinicia nem reconfigura o Docker (use o Docker que já está de pé), recusa rodar se já existe um container
ou um volume com os nomes que ele usaria, e só remove o que ele mesmo criou: no fim,
também quando uma etapa falha ou ele é interrompido, apaga o container e os volumes. O `glab` roda com uma pasta de
configuração descartável, então o `~/.config/glab-cli` de quem roda não é tocado. Depois de uma gravação, confira com
`git diff packages/runtime/test/fixtures/glab` e rode `mise exec -- npm run check`.

### O que as provas mostram

O [`prove-gitlab.ts`](prove-gitlab.ts) imprime no stdout a evidência em Markdown (sem token, senha, host local nem caminho desta
máquina), pronta para a descrição do PR, e sai com 1 se uma prova não valeu. Cada prova tem um controle que tem de acontecer
(o `Closes #N` fecha a issue, um `/close` solto roda, `!1`, `~bug` e `%v1` viram link), senão um "não aconteceu nada" não prova
nada. Todo texto é postado como está e depois do filtro, e a tabela mostra os dois lado a lado: o que não roda nem como está é
texto para esse GitLab, e o filtro o neutraliza do mesmo jeito, para as versões que o leem como comando.

| Prova | O que faz | Vale quando |
|---|---|---|
| `closing` | Mergeia um MR por frase de fechamento (`Closes #N`, `Implements #N`, `Fixing #N`, `Resolves grupo/projeto#N`, a URL da issue, em frase…), com a frase como está e passada pelo `sanitizeModelText` | A frase como está fecha a issue (o `Closes #N` do controle sempre), e a mesma frase depois do filtro não fecha. Responde se o padrão de fechamento do GitLab casa `Implement(s\|ed\|ing) #N` |
| `quick-actions` | Posta 12 formas de `/close` (`/CLOSE`, com tab, depois de `\r`, com CRLF, em cerca de crase, til ou quatro crases, depois de `<div>`, `>>>` ou `$$`, numa cerca que um trecho anterior deixou aberta…) como nota numa issue e como descrição de MR | Um `/close` solto fecha a issue (ou o MR) como controle, e nenhuma forma passada pelo filtro roda |
| `references` | Renderiza e posta `!1`, `~bug` e `%v1` antes e depois do espaço de largura zero | O texto como está vira link e deixa uma nota de referência no `!1`, e o filtrado não |
| `workflow` | Roda `implement-issue` (etapas locais, `testCommand: npm test`) na issue 1 de um projeto Node mínimo, mergeia o MR que ele abriu e espera a issue fechar | O run termina `done`, o MR abre com `Closes #1` na descrição, e o merge fecha a issue |

## Validação no Cursor IDE

Os workflows acima conferem o SDK. Quem confere o kit dentro do Cursor IDE é o assistente guiado
[`validate-cursor-ide.sh`](validate-cursor-ide.sh): ele monta o repositório descartável com o `setup-sandbox-repo.sh`,
roda os sete cenários com você (e um oitavo, opcional, a etapa na nuvem) e escreve `validation-report.json`. O roteiro está em
[2.3](../../docs/usage/03-invocacao-no-cursor-ide.md#validar-no-cursor-ide).
