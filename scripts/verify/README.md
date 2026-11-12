# Workflows de verificação

Reproduzem contra a API real as verificações registradas em
[`docs/research/verificacoes-locais.md`](../../docs/research/verificacoes-locais.md). Use-os para checar o kit numa conta
nova, por exemplo a Enterprise do seu time, antes de adotar.

**Custam tokens.** Na medição de 2026-11-11, com `composer-2.5`: `verify-structured` usou cerca de 110 mil tokens,
`verify-context` cerca de 60 mil e `verify-cache` cerca de 46 mil. Rode sempre com `--max-tokens`. Prefira os modelos
incluídos no plano; modelos que consomem cota paga são permitidos quando o teste precisar deles
([política de custo](../../docs/contributing/01-contribuindo.md#testes-contra-a-api-real-política-de-custo)).

```bash
scripts/verify/setup-probe-repo.sh ~/tmp/wf-probe-repo      # repositório descartável (AGENTS.md, hooks, mcp.json)
export WORKFLOWS_DIR=scripts/verify WF_METRICS_DB=~/tmp/wf-verify.db
npm run wf -- run verify-structured --cwd ~/tmp/wf-probe-repo --args '{}' --max-tokens 150000
npm run wf -- run verify-context    --cwd ~/tmp/wf-probe-repo --args '{}' --max-tokens 120000
npm run wf -- run verify-cache      --cwd ~/tmp/wf-probe-repo --args '{}' --max-tokens 100000
```

`WF_VERIFY_MODEL` troca o modelo (default `composer-2.5`; confira os seus com `npm run models`).

| Workflow | O que olhar no resultado | Resultado medido em 2026-11-11 |
|---|---|---|
| `verify-structured` | `a` e `b` válidos; no stderr, o `step-end` de `b` com `mcp: 2` (JSON recusado e corrigido) | as três etapas entregaram; `b` corrigiu no mesmo turno |
| `verify-context` | `project.marker`, `project.mcpTools`, `project.blockedCommand`, `insideEnv`; os arquivos em `.probe/` | com `project`: marcador lido, hooks do Cursor e do Claude Code disparam (o deny bloqueia), sem tools do `workflows`, `inside=1`; sem settings: nada disso |
| `verify-cache` | `cacheReadTokens` de cada etapa nos eventos `turn` | só o prefixo fixo (~4 mil tokens) é reaproveitado com garantia |

## Validação no Cursor IDE

Os três workflows acima conferem o SDK. Quem confere o kit dentro do Cursor IDE é o assistente guiado
[`validate-cursor-ide.sh`](validate-cursor-ide.sh): ele monta o repositório descartável com o `setup-sandbox-repo.sh`,
roda os sete cenários com você e escreve `validation-report.json`. O roteiro está em
[2.3](../../docs/usage/03-invocacao-no-cursor-ide.md#validar-no-cursor-ide).
