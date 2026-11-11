---
name: workflow-authoring
description: Referência para escrever ou editar um workflow em workflows/*.ts com o runtime deste repositório (agent/parallel/pipeline/phase sobre o Cursor SDK). Use antes de criar ou alterar qualquer workflow.
---

# Escrever um workflow

Um workflow é um módulo TypeScript em `workflows/<nome>.ts` com `export default defineWorkflow({...})`.
O **código** decide o que roda, quando roda e quantas vezes roda. O modelo só executa cada etapa.
Se uma decisão pode ser tomada por código (label, contagem, teste passou ou não, tamanho do diff),
ela **tem** de ser tomada por código.

## Esqueleto

```ts
import { defineWorkflow } from "../src/runtime/workflow.js";

export default defineWorkflow<{ target: string }>({
  meta: {
    name: "meu-fluxo",                       // vira o nome da tool (MCP) e do comando (CLI)
    description: "Uma linha.",
    whenToUse: "Quando o usuário pedir X.",  // o agente do chat lê isto
    phases: [{ title: "Descobrir" }, { title: "Executar" }],
    argsSchema: { type: "object", required: ["target"], properties: { target: { type: "string" } } },
  },
  defaults: { model: { id: "composer-2.5" }, timeoutMs: 20 * 60_000 },
  async run(ctx) {
    ctx.phase("Descobrir");
    const found = await ctx.agent<{ files: string[] }>(`Liste os arquivos de ${ctx.args.target}.`, {
      tools: ["read", "grep", "glob", "ls"],
      schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } },
    });
    ctx.phase("Executar");
    return ctx.pipeline(found.files, (f: string) => ctx.agent(`Processe ${f}.`, { label: f, phase: "Executar" }));
  },
});
```

## API do contexto

| Chamada | O que faz |
|---|---|
| `ctx.agent(prompt, opts)` | Cria um agente novo do Cursor SDK e roda uma etapa. Com `schema`, devolve o objeto validado (o agente precisa chamar `submit_result`). Sem `schema`, devolve o texto final. **Lança erro** se falhar após `retries`. |
| `ctx.parallel(thunks)` | Barreira: roda em paralelo e espera todos. Item que falha vira `null`. Teto de custo e conta sem acesso ao SDK (`plan_required`) abortam tudo. |
| `ctx.pipeline(items, ...stages)` | Sem barreira: cada item segue pelos estágios de forma independente. Estágio que falha descarta o item (`null`). |
| `ctx.phase(t)` / `ctx.log(m)` | Progresso, que aparece em `wait_workflow` e no CLI. |
| `ctx.args`, `ctx.cwd`, `ctx.runId` | Entrada, repositório e id do run. |
| `ctx.budget` | `spentCents()`, `chargedCents()`, `spentTokens()`, `remainingCents()`, para rebaixar o modelo ou parar antes do teto. `spentCents()` é o que o teto em centavos compara: a soma, por tentativa, do maior entre `rawCostCents` e `chargedCents`. `chargedCents()` é só o cobrado (0 para uso incluído no plano, BYOK e créditos). |

Opções de `agent()`: `model`, `schema`, `tools` (allowlist: `["read","grep","glob","ls"]` para etapas só de leitura),
`disallowedTools`, `cwd` (por exemplo um worktree), `agents` (subagents inline), `mcpServers`, `timeoutMs`, `retries`,
`schemaRetries`, `sandbox`, `settingSources` (contexto carregado pela etapa), `memo` (cache de resultado entre
runs, só para etapas de leitura), `label` e `phase`. O `schema` precisa ter `type: "object"` na raiz.

## Regras

1. **Determinismo para o resume.** O journal guarda cada etapa por hash de `prompt + opções`. Não ponha data/hora,
   valores aleatórios nem dados voláteis no prompt. Se precisar de data, receba por `args`.
2. **Use schema em toda etapa cujo resultado o código lê.** Texto livre só no fim, ou para o humano.
3. **Verificação é código.** Rode testes, lint e `git diff` com `execFileSync` dentro do workflow, não peça ao modelo
   "rode os testes e me diga se passou". Laços de correção sempre com teto (`for (round = 1; round <= N; ...)`).
4. **O modelo é escolhido no código.** Use um mapa `tier → ModelSelection`. Confirme os IDs com `npm run models`
   (a lista depende do plano e das restrições do admin). O Auto é `default`; `auto-low` não existe. Um ID fora do
   catálogo faz a etapa falhar. `RunResult.model` traz o ID resolvido (`resolvedModel` no `step-end`), mas com
   `default` não mostra o modelo que o Router escolheu.
5. **Escrita em paralelo só com isolamento.** Duas etapas simultâneas não podem editar os mesmos arquivos. Crie um
   `git worktree` por item e passe em `cwd`.
6. **Efeitos externos ficam no código.** Commit, push, abrir PR e comentar em issue são feitos com `gh` ou `git` no
   workflow, depois das verificações, não pelo agente.
7. **Nada de corte silencioso.** Se limitar cobertura (top-N, amostragem), registre com `ctx.log` o que ficou de fora.
8. **Etapa exigida não vira `null` em silêncio.** `ctx.parallel` e `ctx.pipeline` transformam falhas em `null`.
   Se o resultado for obrigatório (um review exigido, por exemplo), confira e encerre o run com um status
   explícito quando faltar algum.
9. **Efeitos idempotentes.** O resume reexecuta o código fora das etapas de agente. Proteja commit
   (`git diff --cached --quiet`), push e criação de PR (`gh pr view` antes de `gh pr create`) para que rodar de
   novo não quebre.
10. **Não dispare workflows de dentro de etapas.** O runtime barra o disparo acidental (MCP `workflows` sem tools
    nas etapas e `WF_INSIDE_WORKFLOW` no CLI), mas não é barreira de segurança: uma etapa com `shell` pode
    contorná-lo. Para compor, chame funções TypeScript compartilhadas.

## Observabilidade (detalhes em `docs/09-observabilidade.md`)

O runtime grava as métricas de cada etapa no SQLite do usuário. O workflow precisa acrescentar o que significa
**entregar**:

- **Status:** devolva `{ status: "done", ... }` quando entregou e outro status explícito quando não entregou
  (`"tests-failed"`, `"review-blocking"`…). É isso que permite medir custo por entrega.
- **`ctx.metric(nome, valor)`** para os sinais de resultado (testes passaram, achados de review, linhas de diff) e
  para a **covariável de dificuldade** (ex.: `tier`). Sem ela, comparar modelos mistura tarefas fáceis e difíceis.
- **`label` explícito** em toda etapa. Sem label, o runtime usa um hash, e a análise por etapa fica ilegível.

## Custo (detalhes em `docs/08-custos-e-cache.md`)

- **Meça.** O resultado do run traz `usage` (tokens por tipo e `cacheHitRatio`), e cada `step-end` traz o uso da
  etapa.
- **Não chame o modelo** quando código decide, e use `memo: true` em etapas só de leitura.
- **Contexto fixo mínimo.** Em etapas que não precisam do repositório, `settingSources: []` corta `AGENTS.md`,
  hooks, MCP do projeto e skills. `["team","mdm"]` mantém os hooks do time e MDM, mas ainda carrega as skills
  (medido; ver `docs/research/verificacoes-locais.md` §7). Allowlist de `tools` sem `"task"`. `mcpServers` só onde
  usa.
- **Prefixo estável.** Instruções como constantes no topo do módulo, e prompt = `INSTRUÇÕES + "\n\n" + dados`.
  Nada volátil antes das instruções.
- **Conversas curtas.** Um agente por etapa, e resumos estruturados entre etapas, não saídas inteiras.
- **Saída mínima.** Schema só com o que o código lê.

## Padrões úteis

- **Roteamento por label/complexidade**: veja `workflows/implement-issue.ts`.
- **Verificação adversarial**: N revisores com lentes diferentes em `ctx.parallel`. Um achado só sobrevive com
  maioria. Use schema `{ refuted: boolean, evidence: string }`.
- **Loop até secar**: rodadas de busca até K rodadas seguidas sem achado novo, com deduplicação por chave no código.
- **Escalonamento de modelo**: tente com o modelo barato, valide com código e, se falhar, repita com o tier acima.

## Antes de entregar

- Passe pelo checklist de custo (`docs/08-custos-e-cache.md` §6) e registre no topo do workflow a estimativa de
  custo por caminho.
- `npm run typecheck`
- Escreva um teste em `test/` com o fake SDK (`test/fake-sdk.ts`) cobrindo os ramos principais (tier, review
  condicional, falha de teste) e rode `npm test`.
- Rode uma vez de verdade com tetos baixos:
  `npm run wf -- run <nome> --args '{...}' --max-cents 100 --max-tokens 2000000`. Passe os dois. Se o Cursor
  ainda não reportou o custo de uma tentativa, o runtime emite um `warning`: o teto em centavos não a contou, o de
  tokens sim. Em uso cobrado por request (planos legados e alguns Enterprise), `rawCostCents` vem 0 e só o teto de
  tokens protege.
