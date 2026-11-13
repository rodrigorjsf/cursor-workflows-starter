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

## Validação no Cursor IDE

Os workflows acima conferem o SDK. Quem confere o kit dentro do Cursor IDE é o assistente guiado
[`validate-cursor-ide.sh`](validate-cursor-ide.sh): ele monta o repositório descartável com o `setup-sandbox-repo.sh`,
roda os sete cenários com você (e um oitavo, opcional, a etapa na nuvem) e escreve `validation-report.json`. O roteiro está em
[2.3](../../docs/usage/03-invocacao-no-cursor-ide.md#validar-no-cursor-ide).
