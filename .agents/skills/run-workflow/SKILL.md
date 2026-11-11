---
name: run-workflow
description: Roda um workflow determinístico deste repositório (ex.: implement-issue) e espera o resultado. Use quando o usuário digitar /run-workflow <nome> <args>.
disable-model-invocation: true
---

# Rodar um workflow

Um workflow já define em código cada etapa, o modelo de cada uma, as revisões e os critérios de parada.
Seu papel aqui é **só disparar e acompanhar**. Não refaça nem pule etapas e não tente "ajudar" editando arquivos
enquanto o job roda.

## Passos

1. Identifique o workflow e os args a partir do pedido. Exemplo: `/run-workflow implement-issue 123` →
   `name: "implement-issue"`, `args: { "issue": 123 }`.
   - Se não souber o nome exato ou o formato dos args, chame a tool MCP `list_workflows` (servidor `workflows`)
     e use o `argsSchema` que ela devolver.
   - Se faltar um arg obrigatório, pergunte ao usuário antes de iniciar.
2. Chame `start_workflow` com `{ name, args }` e guarde o `jobId`.
3. Chame `wait_workflow` com `{ jobId, timeoutSec: 45 }` repetidamente, enquanto `status` for `running`.
   - A cada retorno, mostre ao usuário a `phase` atual e as últimas linhas de `recent`, em uma ou duas linhas.
   - Não chame outra coisa entre as esperas.
   - No Cursor, cada chamada MCP segue o Run Mode, como os comandos de terminal; ela não fica isenta de
     aprovação. Se o Cursor pedir aprovação a cada espera, diga ao usuário que ele pode pôr `wait_workflow` e
     `get_workflow_status` na allowlist.
   - Se `recent` trouxer o aviso de custo ainda não reportado ou o de `getUsage() falhou`, repasse-o: o teto em
     centavos não contou aquela tentativa (o de tokens, sim).
4. Quando `status` for `finished`, apresente o `result`: o que foi feito, a branch ou o PR e o custo
   (`spentCents`, que soma, por tentativa, o maior entre o custo bruto e o cobrado; `chargedCents` traz só o
   cobrado, que é 0 em uso incluído no plano).
   - `spentCents: 0` junto com um aviso `getUsage() falhou` (em `recent` ou visto numa espera anterior) quer dizer
     custo **desconhecido**, não zero. Diga isso e informe `spentTokens` no lugar do custo.
   - Se `result.status` não for `done` (por exemplo `tests-failed`, `review-failed`, `review-blocking`,
     `secret-blocked`), diga isso claramente: o workflow terminou sem entregar. Em `secret-blocked`, repasse o
     `reason` (a regra que disparou) e não procure o segredo no worktree.
5. Quando `status` for `failed`, mostre o `error` sem tentar corrigir por conta própria e ofereça relançar
   **retomando**: `start_workflow` com o mesmo `name` e `args` e `resumeRunId` igual ao `runId` do job. As etapas
   concluídas não são repetidas.

## Sem o servidor MCP

Se as tools `workflows` não estiverem disponíveis, use o CLI pelo terminal:

```bash
npm run wf -- start implement-issue --args '{"issue":123}'   # devolve {"jobId": "..."}
npm run wf -- wait <jobId> --timeout 240                     # repita até status != running
```
