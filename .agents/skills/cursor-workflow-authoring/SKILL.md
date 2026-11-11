---
name: cursor-workflow-authoring
description: Workflows defineWorkflow do Cursor SDK (workflows/*.ts, .agents/workflows/*.ts). Use antes de criar, editar ou testar um.
---

# Escrever um workflow

Um workflow é um módulo TypeScript em `workflows/<nome>.ts` (do kit) ou `.agents/workflows/<nome>.ts` (do
repositório alvo, que vence em nome repetido), com `export default defineWorkflow({...})`. Módulos auxiliares ficam
na subpasta `<nome>/`, porque o runtime importa todo `.ts`, `.js` e `.mjs` do primeiro nível. Em
`.agents/workflows/` de um repositório com o kit instalado fora, o import relativo do esqueleto não resolve: siga a
forma B de `docs/04-invocacao-no-cursor-ide.md` (objeto exportado direto, só `import type`, desenvolvido e testado
no kit).

O workflow é **determinístico**: o código decide o que roda, quando roda e quantas vezes roda; o modelo só executa
cada etapa. Se uma decisão pode ser tomada por código (label, contagem, teste passou ou não, tamanho do diff), ela
**tem** de ser tomada por código.

## Esqueleto

```ts
// Custo por caminho (docs/08-custos-e-cache.md §7): etapas × modelo, típico e pior caso.
import { defineWorkflow } from "../src/runtime/workflow.js";

const LISTAR = "Liste os arquivos que o alvo abaixo envolve.";  // instruções em constantes: prefixo estável
const PROCESSAR = "Processe o arquivo abaixo.";

export default defineWorkflow<{ target: string }>({
  meta: {
    name: "meu-fluxo",                       // `name` do start_workflow (MCP) e de `wf run <nome>` (CLI)
    description: "Uma linha.",
    whenToUse: "Quando o usuário pedir X.",  // o agente do chat lê isto
    phases: [{ title: "Descobrir" }, { title: "Executar" }],
    argsSchema: { type: "object", required: ["target"], properties: { target: { type: "string" } } },
  },
  defaults: { model: { id: "composer-2.5" }, timeoutMs: 20 * 60_000 },
  budget: { maxTokens: 1_000_000 },          // teto padrão; --max-tokens troca
  async run(ctx) {
    ctx.phase("Descobrir");
    const found = await ctx.agent<{ files: string[] }>(`${LISTAR}\n\n${ctx.args.target}`, {
      label: "listar",
      tools: ["read", "grep", "glob", "ls"],
      settingSources: [],
      memo: true,
      schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } },
    });
    ctx.phase("Executar");
    // Uma etapa por arquivo no mesmo cwd; etapas que editam arquivos em comum pedem um worktree por item (regra 5).
    const out = await ctx.pipeline(found.files, (f: string) =>
      ctx.agent(`${PROCESSAR}\n\n${f}`, { label: `processar:${f}`, phase: "Executar" }));
    const failed = found.files.filter((_, i) => out[i] === null);
    ctx.metric("arquivos", found.files.length);
    ctx.metric("falhas", failed.length);
    if (failed.length) return { status: "items-failed", failed };
    return { status: "done", processed: found.files.length };
  },
});
```

## API do contexto

| Chamada | O que faz |
|---|---|
| `ctx.agent(prompt, opts)` | Cria um agente novo do Cursor SDK e roda uma etapa. Com `schema`, devolve o objeto validado (o agente precisa chamar `submit_result`). Sem `schema`, devolve o texto final. **Lança erro** se falhar após `retries`. |
| `ctx.parallel(thunks)` | Barreira: roda em paralelo e espera todos. Item que falha vira `null`. |
| `ctx.pipeline(items, ...stages)` | Sem barreira: cada item segue pelos estágios de forma independente. Estágio que falha descarta o item (`null`). |
| `ctx.phase(t)` / `ctx.log(m)` | Progresso, que aparece em `wait_workflow` e no CLI. |
| `ctx.metric(nome, valor)` | Sinal de resultado ou de dificuldade do run, gravado na tabela `metrics` (ver Observabilidade). |
| `ctx.args`, `ctx.cwd`, `ctx.runId` | Entrada, repositório e id do run (o mesmo no resume). |
| `ctx.budget` | `remainingCents()`, `spentCents()`, `chargedCents()`, `spentTokens()` e `usage()`, para rebaixar o modelo ou parar antes do teto. Antes de escalonar por ele, leia a receita "Escalonar o modelo por orçamento": o sinal em centavos pode nunca cair. |

Teto de centavos, teto de tokens, limite de uso do plano (`RateLimitError` não retentável) e conta sem acesso ao SDK
(`plan_required`) abortam o run inteiro, também dentro de `parallel` e `pipeline`.

Opções de `agent()`: a interface `AgentCallOptions` em `src/runtime/workflow.ts` documenta as opções e as restrições
(`memo` só com `tools` de leitura; `schema` com `type: "object"` na raiz). O default de `settingSources`, quando a
etapa não passa o seu, está em `RunOptions` (`src/runtime/engine.ts`).

## Regras

1. **Prompt e opções são a chave da etapa.** O journal (resume) reconhece uma etapa pelo hash do prompt e do
   `fingerprint` de `agentCall` em `src/runtime/engine.ts` (modelo, schema, `cwd`, `tools`, `disallowedTools`, `agents`,
   `settingSources`), mais a ordem em que esse hash aparece no run; `label`, `timeoutMs`, `mcpServers` e `sandbox` ficam
   de fora; o `memo` e o cache do provedor também dependem do prompt.
   Monte o prompt com as instruções em constantes de módulo e só dados
   determinísticos: `args`, resultados de etapas e o que o código calcula deles e do disco (saída de teste, diff). Data
   entra por `args`, não por `Date.now()`. Dê ao worktree um caminho derivado do
   item, como a branch em `workflows/implement-issue.ts`. Duas chamadas que devem ser distintas (a mesma etapa em
   rodadas diferentes) levam a rodada no prompt.
2. **Schema em toda etapa cujo resultado o código lê**, só com os campos que ele lê. Texto livre só no fim, ou para
   o humano.
3. **Verificação é código.** Rode testes, lint e `git diff` com `execFileSync` dentro do workflow; o exit code
   decide o próximo passo. Laços de correção sempre com teto (`for (round = 1; round <= N; ...)`).
4. **O modelo é escolhido no código.** Use um mapa `tier → ModelSelection` e confirme cada ID em `npm run models`:
   ID fora do catálogo da conta faz a etapa falhar. O Auto é `default`; com ele, as métricas registram `default`, e
   não o modelo que o Router escolheu, então compare modelos com IDs explícitos.
5. **Escrita em paralelo só com isolamento.** Duas etapas simultâneas não podem editar os mesmos arquivos. Crie um
   `git worktree` por item e passe em `cwd`.
6. **Efeitos externos ficam no código.** Commit, push, abrir PR e comentar em issue são feitos com `gh` ou `git` no
   workflow, depois das verificações. Tudo o que sai da máquina passa antes pela trava de segredos
   de `workflows/implement-issue.ts`: o diff staged desde a base, antes do commit (`findStagedSecret`, que também barra
   `auth.json` e `.env`), e todo texto (corpo de PR, comentário), antes de publicar (`findSecretInText`).
7. **Corte e falha sempre explícitos.** Ao limitar cobertura (top-N, amostragem), registre com `ctx.log` o que
   ficou de fora. `ctx.parallel` e `ctx.pipeline` transformam falhas em `null`: quando o resultado é obrigatório
   (um review exigido, por exemplo), confira os `null` e encerre o run com um `status` de falha explícito.
8. **Efeitos idempotentes.** O resume reexecuta o código fora das etapas de agente, e o journal devolve o
   resultado de uma etapa, não o efeito dela no disco. Proteja commit (`git diff --cached --quiet`), push e criação
   de PR (`gh pr view` antes de `gh pr create`). Se o código confere o disco entre etapas, guarde o progresso por
   item (receita "Resume com invariantes").
9. **Componha com funções TypeScript compartilhadas**, chamadas a partir do `run`.

## Observabilidade

O runtime já mede cada etapa; o workflow registra se o run **entregou** (como cada `status` vira `outcome_class` e
como consultar os números: `docs/09-observabilidade.md` §3, §4 e §6):

- **Status:** devolva `{ status: "done", ... }` quando entregou e outro status explícito quando não entregou
  (`"tests-failed"`, `"review-blocking"`…). Um checkpoint que espera o humano devolve `status: "pending"`, ou um
  status acrescentado a `PENDING` em `src/observability/recorder.ts`, com `runId` e `next` (receita "Checkpoint em dois
  runs"). Qualquer outro nome conta como falha no custo por entrega.
- **`ctx.metric(nome, valor)`** para os sinais de resultado (testes passaram, achados de review, linhas de diff) e
  para a **covariável de dificuldade** (ex.: `tier`). Sem ela, comparar modelos mistura tarefas fáceis e difíceis.
- **`label` explícito** em toda etapa. Sem label, o runtime usa um hash, e a análise por etapa fica ilegível.

## Custo

Antes de escrever a primeira etapa, leia o checklist de `docs/08-custos-e-cache.md` §6 e aplique cada item a cada
etapa. Ele é a fonte única das regras de custo (`memo`, `settingSources`, allowlist de `tools`, prefixo estável,
schema mínimo, truncagem, fan-out, teto padrão); o porquê de cada uma está nas §4.1–4.8.

## Receitas

As receitas de `docs/05-escrevendo-workflows.md` (seção Receitas) trazem o código de cada padrão. Leia a do caso
antes de escrever a etapa:

- **roteamento por label**: o tier, e com ele o modelo, sai de um dado da entrada (label, tamanho do diff);
- **corrigir até passar**: um laço de correção que termina num exit code;
- **fan-out com isolamento**: o mesmo trabalho em itens independentes;
- **verificação adversarial**: uma afirmação que só vale se sobreviver a refutadores paralelos;
- **etapa de leitura barata e reaproveitável**: classificar, planejar ou revisar sem editar;
- **escalonar o modelo por orçamento**: o tier cai com o gasto do run (escalonar na falha é `docs/08-custos-e-cache.md`
  §4.2);
- **invariante** entre etapas: uma regra do processo que o código confere (red antes de green, só arquivos de teste
  mudam);
- **checkpoint**: o fluxo precisa da aprovação de um humano no meio;
- **resume com invariantes**: o código entre as etapas depende do estado do disco;
- **review em eixos**: revisores paralelos cujos achados o código roteia.

## Antes de entregar

O workflow só está entregue com os três itens cumpridos:

- **Custo:** cada item do checklist de `docs/08-custos-e-cache.md` §6 atendido ou com o motivo da exceção num
  comentário.
- **Testes offline:** `test/<nome>.test.ts` com o fake SDK (receitas e arnês em `docs/05-escrevendo-workflows.md`,
  seção Testando), com um caso por ramo que o código decide (tier, etapa pulada, laço no teto), um por `status` de
  retorno, um por invariante (violação, nova tentativa, status) e o resume (depois de `done` e depois de uma falha no
  meio). `npm run typecheck` e `npm test` verdes, com o workflow em `workflows/`: o `tsconfig.json` do typecheck
  não inclui `.agents/workflows/` nem `test/`.
- **Um run real com tetos baixos.** Ele gasta cota e pode ter efeitos externos: rode-o só se o usuário pedir. Sem o
  pedido, o item fica cumprido ao entregar a ele o comando, o `status` esperado e a estimativa (passo 6 da
  `/skill-to-workflow`):
  `npm run wf -- run <nome> --args '{...}' --max-cents 100 --max-tokens <N>`, com `<N>` até o `budget.maxTokens` do
  workflow e sempre com os dois tetos (o de centavos fica cego quando o Cursor não reporta custo;
  `docs/02-configuracao-inicial.md` §3). Workflow com efeito externo roda com `--cwd` num repositório descartável:
  com push, PR ou comentário, `scripts/verify/setup-sandbox-repo.sh <dono/repo-novo>` cria um no GitHub, com uma
  issue; só com commit, basta o repositório local de `scripts/verify/setup-probe-repo.sh`. Pronto quando o run
  devolve o `status` esperado e o uso de cada etapa (os `step-end` no stderr do CLI, ou as linhas da `v_attempts`
  com o `run_id`, agrupadas por `label`: `docs/09-observabilidade.md` §3 e §4) cabe na estimativa; se não couber,
  ajuste os tiers ou a estimativa.
