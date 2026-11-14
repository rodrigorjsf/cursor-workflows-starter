# Workflows de verificação

Reproduzem contra a API real as verificações registradas em
[`docs/research/verificacoes-locais.md`](../../docs/research/verificacoes-locais.md). Use-os para checar o kit numa conta
nova, por exemplo a Enterprise do seu time, antes de adotar.

**Custam tokens.** Na medição de 2026-11-11, com `composer-2.5`: `verify-structured` usou cerca de 110 mil tokens,
`verify-context` cerca de 60 mil e `verify-cache` cerca de 46 mil. Rode sempre com `--max-tokens` e `--max-cents`. Prefira os modelos
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
mise exec -- scripts/verify/gitlab-e2e.sh                                  # o glab fixado no mise.toml fica no PATH
GITLAB_E2E_STAGES=closing,quick-actions,references mise exec -- scripts/verify/gitlab-e2e.sh   # sem gastar tokens
GITLAB_E2E_IMAGE=gitlab/gitlab-ce:latest mise exec -- scripts/verify/gitlab-e2e.sh   # a imagem mais nova, só para ver
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
máquina), pronta para a descrição do PR, e sai com 1 se uma prova não valeu. Cada "não aconteceu nada" vem ao lado do mesmo
texto sem o filtro, que acontece: sem esse controle a checagem não prova nada.

| Etapa | O que faz | Vale quando |
|---|---|---|
| `closing` | Mergeia um MR por frase de fechamento (`Closes #N`, `Implements #N`, `Fixing #N`, `Resolves grupo/projeto#N`, a URL da issue, em frase…), com a frase como está e passada pelo `sanitizeModelText` | A frase como está fecha a issue (o `Closes #N` do controle sempre), e a mesma frase depois do filtro não fecha. Responde se o padrão de fechamento do GitLab casa `Implement(s\|ed\|ing) #N` |
| `quick-actions` | Posta 11 formas de `/close` (`/CLOSE`, com tab, depois de `\r`, em cerca de crase, til ou quatro crases, depois de `<div>`, `>>>` ou `$$`, numa cerca que fica aberta…) como nota numa issue e como descrição de MR | Um `/close` solto fecha a issue (ou o MR), e nenhuma forma passada pelo filtro roda |
| `references` | Renderiza e posta `!1`, `~bug` e `%v1` antes e depois do espaço de largura zero | O texto como está vira link e deixa uma nota de referência no `!1`, e o filtrado não |
| `workflow` | Roda `implement-issue` (etapas locais, `testCommand: npm test`) na issue 1 de um projeto Node mínimo, mergeia o MR que ele abriu e espera a issue fechar | O run termina `done`, o MR abre com `Closes #1` na descrição, e o merge fecha a issue |

## Validação no Cursor IDE

Os workflows acima conferem o SDK. Quem confere o kit dentro do Cursor IDE é o assistente guiado
[`validate-cursor-ide.sh`](validate-cursor-ide.sh): ele monta o repositório descartável com o `setup-sandbox-repo.sh`,
roda os sete cenários com você (e um oitavo, opcional, a etapa na nuvem) e escreve `validation-report.json`. O roteiro está em
[2.3](../../docs/usage/03-invocacao-no-cursor-ide.md#validar-no-cursor-ide).
