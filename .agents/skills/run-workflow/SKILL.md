---
name: run-workflow
description: Dispara um workflow determinístico deste repositório e acompanha o job até o resultado: /run-workflow <nome> <args>.
disable-model-invocation: true
---

# Rodar um workflow

O workflow já define em código as etapas, o modelo de cada uma, as revisões e os critérios de parada. Seu papel é
**disparar, acompanhar e repassar**: o que o job devolve (progresso, resultado, falha, pedido de aprovação) chega
ao usuário como veio, e corrigir ou aprovar é decisão dele. Enquanto o job roda, os arquivos são do workflow e
suas chamadas são só as esperas do passo 3.

## Passos

1. Monte `name` e `args` a partir do pedido. Exemplo: `/run-workflow implement-issue 123` →
   `name: "implement-issue"`, `args: { "issue": 123 }`. O passo termina com todos os args `required` em mãos.
   - Se o nome exato ou o formato dos args não estiver claro, chame `list_workflows` (servidor MCP `workflows`) e
     siga o `argsSchema` devolvido. Se faltar um arg `required`, pergunte ao usuário.
   - Um `resumeRunId` no pedido é parâmetro de `start_workflow`, ao lado de `args`. Dentro de `args` ele é
     ignorado, e o run começa do zero, sem o journal.
2. Chame `start_workflow` com `{ name, args }` (e `resumeRunId`, se houver) e guarde o `jobId`.
3. Encadeie chamadas `wait_workflow` com `{ jobId, timeoutSec: 45 }`, uma logo após a outra, até `status` deixar
   de ser `running`.
   - A cada retorno, mostre ao usuário a `phase` atual e as linhas novas de `recent`, em uma ou duas linhas.
   - Anote os avisos de custo (`getUsage() falhou`, custo da tentativa ainda não reportado) para o passo 4:
     `recent` guarda só os 20 eventos mais recentes.
   - Se o harness pedir aprovação a cada espera, diga ao usuário que ele pode liberar `wait_workflow` e
     `get_workflow_status`: no Cursor, na allowlist do Run Mode; no Claude Code, em `permissions.allow`, como
     `mcp__workflows__wait_workflow` e `mcp__workflows__get_workflow_status`.
4. Quando `status` for `finished`, apresente o custo e o `result` conforme o `result.status`. Custo: `spentCents`
   (o que o teto em centavos conta) e `chargedCents` (só o cobrado; 0 em uso incluído no plano). Com aviso de custo
   anotado, `spentCents` não contou todas as tentativas; `spentCents: 0` com `getUsage() falhou` é custo
   **desconhecido**, não zero: diga isso e informe `spentTokens` no lugar.
   - `done`: o que foi feito e a branch ou o PR.
   - Resultado com `next` (um checkpoint, como o `seams-proposed` do `implement-issue` em issues MED/HIGH): o
     workflow parou à espera de uma decisão do usuário. Mostre o que o resultado traz para ele decidir (no
     `implement-issue`, `seams` e `slices`) e pergunte. Com a aprovação dele, chame `start_workflow` com o mesmo
     `name`, os `args` mais os de aprovação que `next` indica (no `implement-issue`, `approveSeams: true`, ou
     `seams: [...]` com as que ele pedir) e `resumeRunId` igual ao `result.runId`.
   - `secret-blocked`: repasse o `reason` (a regra que disparou, sem o segredo) e deixe a inspeção do `worktree`
     com o usuário, para o segredo ficar fora do chat.
   - Qualquer outro: o workflow terminou **sem entregar**. Repasse o status e o que o resultado trouxer (`output`,
     `findings`, `worktree`).
5. Quando `status` for `failed`, repasse o `error` e ofereça relançar **retomando**: `start_workflow` com o mesmo
   `name` e `args` e `resumeRunId` igual ao `runId` do job. As etapas concluídas não são repetidas.

## Sem o servidor MCP

Se as tools `workflows` não estiverem disponíveis, use o CLI pelo terminal. Ele grava o mesmo estado de job, então
os passos 3 a 5 valem igual, com `--resume <runId>` no lugar de `resumeRunId`:

```bash
npm run wf -- start <nome> --args '<json>' [--resume <runId>]   # devolve {"jobId": "..."}
npm run wf -- wait <jobId> --timeout 240                        # repita até status != running
```

Num repositório que usa o kit instalado fora, não há script `wf`: troque `npm run wf --` por
`<kit>/node_modules/.bin/tsx <kit>/src/cli.ts` e acrescente `--cwd "$PWD"`, com `<kit>` tirado do `command` do
servidor `workflows` em `.cursor/mcp.json` ou `.mcp.json`.
