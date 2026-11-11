# 05 · Escrevendo workflows

A referência operacional, que o agente do Cursor também usa, está na skill
[`.agents/skills/cursor-workflow-authoring/SKILL.md`](../.agents/skills/cursor-workflow-authoring/SKILL.md). Este
documento explica o *porquê* das regras e traz as receitas, que a skill aponta.

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
| Varredura de segredos antes do commit, do comentário na issue e do corpo do PR | `implement-issue` | Checada por código, só nesses formatos |
| Testes no ambiente de quem chamou (`bash -c`, não `bash -lc`) | `runTests` | Garantida |
| Não escrever fora do repositório (`SCOPE_RULE`) | Instruções das etapas que escrevem | **Só pedido no prompt** |
| Sandbox (`sandbox: true`) | Opção da etapa | Não testado neste kit |

- **Varredura de segredos.** Antes do commit, o `implement-issue` desfaz os commits que um agente tenha feito
  (`git reset --soft` para a base, mantendo a árvore) e examina as linhas adicionadas desde a base atrás de chaves
  `crsr_` e `sk-` e da própria chave salva do SDK (ou a de `CURSOR_API_KEY`), e os arquivos chamados `auth.json`,
  `.env` ou `.env.*`. As mesmas regras de texto valem para o comentário das seams e para o corpo do PR, que leva
  saída de teste. Num acerto, não comenta, não faz commit, push nem PR e devolve `status: "secret-blocked"`, com
  `reason` dizendo só a regra que disparou, nunca o trecho. O motivo: um corpo de issue com prompt injection pode
  levar uma etapa a copiar `~/.cursor/sdk/auth.json` para o worktree, e o sandbox não restringe leitura. O review
  de segurança é uma segunda camada, não a única.
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

### Review em eixos

Revisores paralelos, um por eixo (no `implement-issue`: Standards, Spec e Segurança), cada um com o schema das
suas categorias de achado. O código calcula a entrada (diff desde a base), confere que todos rodaram e decide o
que bloqueia e para onde cada achado vai; os relatórios nunca se misturam.

```ts
const diff = diffSinceBase(worktree, baseCommit);                       // calculado pelo código, truncado
const reports = await ctx.parallel(AXES.map((axis) => () =>
  ctx.agent(`${AXIS_INSTRUCTIONS[axis]}\n\n## Rodada ${round}\n\n## Diff\n${diff}`, {
    label: `review:${axis}:${round}`, model: MODELS.REVIEW, cwd: worktree,
    tools: ["read", "grep", "glob", "ls"], settingSources: [], schema: AXIS_SCHEMAS[axis], memo: true,
  })));
if (reports.some((r) => r === null)) return { status: "review-failed" };  // review exigido não vira "sem achados"
const b = blockingOf(reports);   // missing/wrong → fatia TDD extra; hard/blocking → refactor; judgement → corpo do PR
```

A rodada entra no prompt: sem ela, a rodada 2 de um resume teria a mesma chave de journal da rodada 1 e receberia
a resposta antiga. Depois da correção, só os eixos que bloquearam são revistos.

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
  model: MODELS.CLASSIFY, tools: [], settingSources: [], schema: TIER_SCHEMA, memo: true, // [] corta as skills
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

### Invariantes entre etapas

Uma regra do processo que o modelo policiaria sozinho ("red antes de green", "só toque arquivos de teste", "o teste
é a especificação") vira uma **invariante** que o código confere entre duas etapas. As peças estão em
[`workflows/implement-issue/tdd.ts`](../workflows/implement-issue/tdd.ts):

- **Quem tocou o quê:** `snapshotTree` (uma árvore git do worktree, que enxerga também `git add`, `stash`,
  `commit` e `skip-worktree` feitos pelo agente) antes e depois da etapa, e `changesBetween`, sem detecção de
  renomeação (um arquivo movido aparece como apagado e criado).
- **Estado observável:** o código roda o comando e confere o resultado esperado com `runTests`, que tem teto de
  tempo e devolve `kind` (`passed`, `failed`, `timeout`, `overflow`): só `failed` vale como red. Ele tira
  `NODE_TEST_CONTEXT`, que faz um `node --test` aninhado sair com 0 mesmo falhando.
- **O que a etapa pode mudar:** além dos globs de teste, a configuração do runner (`protectedGlobs` e os scripts do
  `package.json`) e o arquivo do teste da fatia (hash guardado no red). Sem isso, a etapa green desligaria o teste
  em vez de implementar.
- **Violação:** `revertTo` desfaz a etapa, uma nova tentativa leva o problema no prompt e, na segunda, o run
  encerra com um status próprio (`tdd-violation`, `test-not-red`).
- **Partida:** a invariante vale antes do primeiro item (suíte verde, senão `baseline-red`).

```ts
const before = snapshotTree(worktree);
await ctx.agent(`${TEST_INSTRUCTIONS}\n\n${sliceBlock}`, { label: `teste-${n}`, cwd: worktree, schema: TEST_SCHEMA });
const changed = changesBetween(worktree, before, snapshotTree(worktree));
if (changed.some((c) => !isTestFile(c.path) || c.status === "D")) { revertTo(worktree, before); /* nova tentativa */ }
const red = runTests(testCommand, worktree);
if (red.kind !== "failed") { /* o teste não é red: nova tentativa, ou o comportamento já existia */ }
```

### Resume com invariantes

O journal devolve o **resultado** de uma etapa, não o efeito dela no disco, e o código entre as etapas roda de
novo sobre o disco como ele está. Uma invariante que compara antes e depois erraria numa etapa reaproveitada, e uma
etapa interrompida deixaria edições pela metade. Por isso o `implement-issue`:

- guarda o progresso por item (e as saídas que viram evidência) em `.workflows/runs/<runId>/tdd-progress.json`,
  fora da árvore versionada (`ProgressStore`), com a chave de cada item derivada do conteúdo, não da posição;
- marca a etapa de escrita em andamento antes de chamá-la e, no resume, volta ao snapshot de antes dela; uma etapa
  que falha é desfeita antes de o erro subir;
- põe um número de sequência no prompt de cada etapa de escrita, para o journal nunca devolver uma escrita antiga;
- guarda os relatórios de review por rodada, para o resume não pedir um review novo sobre um diff diferente;
- reaproveita a branch existente no resume (sem `worktree add -B`, que a zeraria) e roda a suíte de novo antes do
  commit.

### Checkpoint em dois runs

O runtime não pausa para perguntar. Quando o fluxo precisa da aprovação de um humano no meio (a skill `tdd` manda
combinar as seams antes dos testes), o mesmo workflow roda duas vezes:

1. O run 1 vai até o resultado a aprovar, guarda-o no progresso do run e devolve um status pendente (no
   `implement-issue`, `seams-proposed`) com `runId` e `next`, o comando de retomada. O status entra em `PENDING`
   ([`src/observability/recorder.ts`](../src/observability/recorder.ts)); fora dele, o run contaria como falha no
   custo por entrega.
2. O código publica o resultado onde o humano decide: no `implement-issue`, um comentário na issue com um marcador
   e o `runId` (uma vez por run), o comando pelo CLI (`--resume <runId>`, com os args entre aspas simples
   escapadas) e o caminho pelo chat (`resumeRunId`). O texto passa pela trava de segredos antes.
3. O run 2 é o resume com o arg de aprovação (`approveSeams: true`) e executa **o resultado guardado**, não um
   recalculado: uma issue editada ou um arquivo de contexto novo mudaria o prompt do planejador e o plano. Uma
   edição do humano (`seams: [...]`) refaz a etapa com a edição no prompt.
4. A skill [`run-workflow`](../.agents/skills/run-workflow/SKILL.md) trata qualquer resultado com `next`: mostra o
   resultado, pergunta ao usuário e relança só com a aprovação dele.

## Escrevendo bons prompts de etapa

- **Autocontidos:** a etapa não vê o histórico do chat nem as etapas anteriores. Passe no prompt tudo o que ela
  precisa, inclusive os resultados de etapas anteriores.
- **Uma responsabilidade por etapa.** "Planeje" e "implemente" são duas etapas. Isso ajuda os modelos pequenos.
- **Diga o alvo, e a trava junto dele:** "altere só arquivos de teste", "o workflow faz o commit: não rode git".
  Uma proibição sozinha lembra o modelo do comportamento proibido; o código confere o que importa (receita
  "Invariantes entre etapas").
- **Schema enxuto:** só os campos que o código vai ler.

## Testando

1. Crie `test/<nome>.test.ts`. O `tsconfig.test.json` troca `@cursor/sdk` por `test/fake-sdk.ts`.
2. No fake, `script.push(fn)` define o comportamento de cada `send()`:
   - `() => ({ result: "texto" })` simula texto livre;
   - `(o) => { o.local.customTools.submit_result.execute(obj, {}); return {}; }` simula saída estruturada;
   - `() => ({ status: "error" })` simula uma falha;
   - `() => ({ hang: true })` simula uma run que não termina (para testar `timeoutMs`).
   `stats` expõe `maxActive`, `disposed` e `usageReads` para checar concorrência, descarte e leitura de custo.
3. Cubra cada ramo (tier por label e sem label, etapa pulada, laço no teto), cada `status` de retorno, cada
   invariante (violação, nova tentativa, status) e o resume (depois de `done` e depois de uma falha no meio).
4. Para fluxos com `ctx.parallel`, `gh` ou `git`, copie o arnês de
   [`test/implement-issue.fixture.ts`](../test/implement-issue.fixture.ts):
   - um despachante por `label` no fake SDK, porque com `ctx.parallel` a ordem dos `send()` varia e a fila
     `script` segue a ordem;
   - `gh` falso no `PATH` (script Node com estado em JSON);
   - repositório git temporário com `user.name` e `user.email` configurados e um repositório bare como `origin`;
   - o comando de teste real do projeto (`node --test`), que o workflow roda por `runTests`.
5. Para cada defeito que um review encontrar, escreva o teste que o reproduz antes da correção e confirme que ele
   falha no código antigo ([`test/implement-issue.hardening.test.ts`](../test/implement-issue.hardening.test.ts)).

```bash
npm test && npm run typecheck
npm run wf -- run <nome> --args '{...}' --max-cents 100 --max-tokens 2000000   # primeiro run real, tetos baixos
```
