# 05 · Escrevendo workflows

A referência operacional, que o agente do Cursor também usa, está na skill
[`.agents/skills/workflow-authoring/SKILL.md`](../.agents/skills/workflow-authoring/SKILL.md). Este documento
explica o *porquê* das regras e traz receitas.

## Princípio

> Se uma decisão pode ser tomada por código, ela **tem** de ser tomada por código.

| Decisão | Por código | Por modelo |
|---|---|---|
| Qual modelo usar | Label da issue, tamanho do diff, `ctx.budget` | Só quando não há sinal objetivo: classificador barato com schema |
| Se uma etapa roda | `if` sobre dados | Nunca |
| Quantas vezes repetir | Laço com teto | Nunca |
| Se passou | Exit code de teste, lint, typecheck | Review como *segunda* camada, nunca a única |
| Efeitos externos (commit, PR) | Sempre | Nunca |

### Efeitos colaterais: o que o código garante e o que é só pedido

| Regra | Onde | Força |
|---|---|---|
| Commit, push e PR feitos pelo código, depois das verificações | Código do workflow | Garantida |
| Varredura de segredos antes do commit | `implement-issue`, fase Entrega | Checada por código, só nesses formatos |
| Testes no ambiente de quem chamou (`bash -c`, não `bash -lc`) | `runTests` | Garantida |
| Não escrever fora do repositório (`SCOPE_RULE`) | Instruções das etapas que escrevem | **Só pedido no prompt** |
| Sandbox (`sandbox: true`) | Opção da etapa | Não testado neste kit |

- **Varredura de segredos.** Antes do commit, o `implement-issue` examina as linhas adicionadas no diff staged
  (`git diff --cached`) atrás de chaves `crsr_` e `sk-` e da própria chave salva do SDK (ou a de
  `CURSOR_API_KEY`), e os arquivos staged chamados `auth.json`, `.env` ou `.env.*`. Num acerto, não faz commit,
  push nem PR e devolve `status: "secret-blocked"`, com `reason` dizendo só a regra que disparou, nunca o trecho.
  O motivo: issues LOW e MED com diff de até 300 linhas pulam o review, um corpo de issue com prompt injection
  pode levar uma etapa a copiar `~/.cursor/sdk/auth.json` para o worktree, e o sandbox não restringe leitura.
- **Regra de escopo.** Medido em 2026-11-11, antes dela: uma etapa de correção editou um arquivo fora do
  repositório para "consertar" o ambiente depois de uma falha causada pelo shell de login dos testes
  ([verificações locais](research/verificacoes-locais.md) §9). A `SCOPE_RULE` reduz a chance, mas nada impede a
  escrita. Ver [07 · Segurança](07-governanca-e-custos.md#segurança).
- **Sandbox.** No Linux exige `bubblewrap`. Segundo a doc, restringe só as chamadas de shell e os processos que
  elas disparam (escrita no cwd, em temporários e nos caminhos do `sandbox.json`; leitura livre; rede só pela
  allowlist) e não diz que restringe `edit` e `write` ([02 §5](02-configuracao-inicial.md#5-contexto-do-projeto-nos-agentes)).
- **`timeoutMs` curto nas etapas que escrevem.** Uma etapa não tem teto de tokens próprio, o teto do run só é
  checado antes de cada tentativa, e cada envio (o pedido e cada re-prompt de schema) tem o seu `timeoutMs` ([02 §3](02-configuracao-inicial.md#3-teto-de-custo)).

## Custo

Toda receita abaixo deve passar pelo [checklist de custo](08-custos-e-cache.md#6-checklist-de-custo). As
práticas que mais pesam:

- decidir por código em vez de chamar o modelo;
- `memo: true` em etapas de leitura;
- `settingSources` mínimo por etapa;
- prompt com parte fixa primeiro;
- modelo certo por etapa.

## Receitas

### Roteamento por label → modelo

```ts
const tier = issue.labels.map((l) => LABEL_TIERS[l.name]).find(Boolean)
  ?? (await ctx.agent<{ tier: Tier }>(classifyPrompt, { model: MODELS.CLASSIFY, schema: TIER_SCHEMA })).tier;
await ctx.agent(task, { model: MODELS[tier], cwd: worktree, schema: IMPL_SCHEMA });
```

### Review condicional por complexidade

```ts
if (tier === "HIGH" || diffLines > 300) {
  const reviews = await ctx.parallel(LENSES.map((lens) => () =>
    ctx.agent(reviewPrompt(lens), { model: MODELS.REVIEW, tools: ["read", "grep", "glob", "ls", "shell"], schema: REVIEW_SCHEMA })));
  const blocking = reviews.flatMap((r) => r?.findings ?? []).filter((f) => f.severity === "blocking");
  if (blocking.length) await ctx.agent(fixPrompt(blocking), { model: MODELS[tier], cwd: worktree, schema: IMPL_SCHEMA });
}
```

### Corrigir até passar (com teto)

```ts
let t = runTests(cmd, worktree);
for (let round = 1; !t.ok && round <= 2; round++) {
  await ctx.agent(`Testes falharam:\n${t.output}`, { model: MODELS.HIGH, cwd: worktree, schema: IMPL_SCHEMA });
  t = runTests(cmd, worktree);
}
if (!t.ok) return { status: "tests-failed", output: t.output };
```

### Fan-out com isolamento

```ts
await ctx.pipeline(files, async (file: string, _item, i) => {
  const wt = createWorktree(`wf/migrate-${i}`);           // git worktree add, no código
  return ctx.agent(`Migre ${file} para TS.`, { cwd: wt, label: file, phase: "Migrar", schema: IMPL_SCHEMA });
}, (r, file) => verify(file, r));                         // verificação por item, sem barreira
```

### Verificação adversarial

```ts
const votes = await ctx.parallel([0, 1, 2].map((v) => () =>
  ctx.agent(`Tente REFUTAR: ${claim}. Na dúvida, refuted=true.`, { label: `v${v}`, schema: VERDICT })));
const survives = votes.filter(Boolean).filter((x) => !x!.refuted).length >= 2;
```

### Etapa de leitura barata e reaproveitável

```ts
const PLAN_INSTRUCTIONS = "Leia o código e escreva um plano... Não edite arquivos."; // constante: prefixo estável
const plan = await ctx.agent(`${PLAN_INSTRUCTIONS}\n\n${issueBlock(issue)}`, {
  model: MODELS.MED,
  tools: ["read", "grep", "glob", "ls", "semSearch"], // só leitura, sem "task"
  schema: PLAN_SCHEMA,
  memo: true,                                         // mesmo estado do repo → custo zero no próximo run
});
await ctx.agent(`${CLASSIFY_INSTRUCTIONS}\n\n${text}`, {
  model: MODELS.CLASSIFY, tools: [], settingSources: ["team", "mdm"], schema: TIER_SCHEMA, memo: true,
});
```

### Escalonar o modelo por orçamento

```ts
const model = ctx.budget.remainingCents() < 100 ? MODELS.MED : MODELS.HIGH;
```

`remainingCents()` é o teto em centavos menos `spentCents()`, a soma, por tentativa, do maior entre o custo bruto
(`rawCostCents`) e o cobrado (`chargedCents`). Assim o uso incluído no plano, com cobrado 0, também conta.
`chargedCents()` traz só o cobrado. Sem teto em centavos (`--max-cents` ou `WF_MAX_CENTS`), `remainingCents()` é
`Infinity`. Em uso cobrado por request (planos legados e alguns Enterprise), o bruto vem 0 e esse sinal não cai:
lá, só `--max-tokens` / `WF_MAX_TOKENS` protege. O mesmo vale quando o `getUsage()` falha: num Premium, em
2026-11-11, ele deu `feature_unavailable` em toda chamada ([verificações locais](research/verificacoes-locais.md)
§5). Com isso, `spentCents()` fica em 0 e `remainingCents()` não cai. Para escalonar por orçamento nessa conta, use
`ctx.budget.spentTokens()`.

## Escrevendo bons prompts de etapa

- **Autocontidos:** a etapa não vê o histórico do chat nem as etapas anteriores. Passe no prompt tudo o que ela
  precisa, inclusive os resultados de etapas anteriores.
- **Uma responsabilidade por etapa.** "Planeje" e "implemente" são duas etapas. Isso ajuda os modelos pequenos.
- **Diga o que não fazer:** "não faça commit", "não edite os testes, salvo se estiverem errados".
- **Schema enxuto:** só os campos que o código vai ler.

## Testando

1. Crie `test/<nome>.test.ts`. O `tsconfig.test.json` troca `@cursor/sdk` por `test/fake-sdk.ts`.
2. No fake, `script.push(fn)` define o comportamento de cada `send()`:
   - `() => ({ result: "texto" })` simula texto livre;
   - `(o) => { o.local.customTools.submit_result.execute(obj, {}); return {}; }` simula saída estruturada;
   - `() => ({ status: "error" })` simula uma falha;
   - `() => ({ hang: true })` simula uma run que não termina (para testar `timeoutMs`).
   `stats` expõe `maxActive`, `disposed` e `usageReads` para checar concorrência, descarte e leitura de custo.
3. Cubra cada ramo: tier por label e sem label, review ligado e desligado, testes falhando até o teto.
4. Para etapas com `execFileSync` (`gh`, `git`), extraia funções e injete stubs por `args`, ou rode o teste num
   repositório temporário.

```bash
npm test && npm run typecheck
npm run wf -- run <nome> --args '{...}' --max-cents 100 --max-tokens 2000000   # primeiro run real, tetos baixos
```
