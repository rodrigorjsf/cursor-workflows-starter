---
name: cursor-workflow-authoring
description: Referência para escrever workflows defineWorkflow sobre o Cursor SDK. Use antes de criar ou editar um workflow em workflows/*.ts ou .agents/workflows/*.ts.
---

# Escrever um workflow

Um workflow é um módulo TypeScript em `workflows/<nome>.ts` (do kit) ou `.agents/workflows/<nome>.ts` (do
repositório alvo, que vence em nome repetido), com `export default defineWorkflow({...})`. Módulos auxiliares ficam
na subpasta `<nome>/`, porque o runtime importa todo `.ts` do primeiro nível. Em `.agents/workflows/` de um
repositório com o kit instalado fora, o import relativo do esqueleto não resolve: siga a forma B de
`docs/04-invocacao-no-cursor-ide.md` (objeto exportado direto, só `import type`, desenvolvido e testado no kit).

O **código** decide o que roda, quando roda e quantas vezes roda; o modelo só executa cada etapa. Se uma decisão
pode ser tomada por código (label, contagem, teste passou ou não, tamanho do diff), ela **tem** de ser tomada por
código.

## Esqueleto

```ts
import { defineWorkflow } from "../src/runtime/workflow.js";

const LISTAR = "Liste os arquivos que o alvo abaixo envolve.";  // instruções em constantes: prefixo estável
const PROCESSAR = "Processe o arquivo abaixo.";

export default defineWorkflow<{ target: string }>({
  meta: {
    name: "meu-fluxo",                       // vira o nome da tool (MCP) e do comando (CLI)
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
| `ctx.budget` | `remainingCents()`, `spentCents()`, `chargedCents()`, `spentTokens()` e `usage()`, para rebaixar o modelo ou parar antes do teto. Sem teto em centavos, `remainingCents()` é `Infinity`; quando o `getUsage()` falha ou o uso é cobrado por request, ele não cai: escalone por `spentTokens()`. |

Teto de centavos, teto de tokens e conta sem acesso ao SDK (`plan_required`) abortam o run inteiro, também dentro
de `parallel` e `pipeline`.

Opções de `agent()`: a interface `AgentCallOptions` em `src/runtime/workflow.ts` documenta cada uma, com default e
restrição (`memo` só com `tools` de leitura; `schema` com `type: "object"` na raiz).

## Regras

1. **Prompt e opções são a chave da etapa.** O journal (resume) reconhece uma etapa pelo hash do prompt e das
   opções, `cwd` inclusive, e o `label` fica de fora; o `memo` e o cache do provedor também dependem do prompt.
   Monte o prompt como `INSTRUÇÕES + "\n\n" + dados`, com as instruções em constantes de módulo e os dados vindos
   só de `args` e de resultados de etapas (data também entra por `args`). Dê ao worktree um caminho derivado do
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
   workflow, depois das verificações. Todo texto que sai da máquina (corpo de PR, comentário) passa pela trava de
   segredos antes (`findSecretInText` em `workflows/implement-issue.ts`).
7. **Corte e falha sempre explícitos.** Ao limitar cobertura (top-N, amostragem), registre com `ctx.log` o que
   ficou de fora. `ctx.parallel` e `ctx.pipeline` transformam falhas em `null`: quando o resultado é obrigatório
   (um review exigido, por exemplo), confira os `null` e encerre o run com um `status` de falha explícito.
8. **Efeitos idempotentes.** O resume reexecuta o código fora das etapas de agente, e o journal devolve o
   resultado de uma etapa, não o efeito dela no disco. Proteja commit (`git diff --cached --quiet`), push e criação
   de PR (`gh pr view` antes de `gh pr create`). Se o código confere o disco entre etapas, guarde o progresso por
   item (receita "Resume com invariantes").
9. **Componha com funções TypeScript compartilhadas**, chamadas a partir do `run`. O disparo de workflow de dentro
   de uma etapa já é barrado (`AGENTS.md`, Regras).

## Observabilidade (detalhes em `docs/09-observabilidade.md`)

O runtime grava as métricas de cada etapa no SQLite do usuário. O workflow acrescenta o que significa **entregar**:

- **Status:** devolva `{ status: "done", ... }` quando entregou e outro status explícito quando não entregou
  (`"tests-failed"`, `"review-blocking"`…). Um checkpoint que espera o humano devolve um status pendente com
  `runId` e `next` (receita "Checkpoint em dois runs").
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

- roteamento por label ou tier, corrigir até passar, fan-out com isolamento, verificação adversarial, escalonar o
  modelo;
- **invariante** entre etapas: uma regra do processo que o código confere (red antes de green, só arquivos de teste
  mudam);
- **checkpoint**: o fluxo precisa da aprovação de um humano no meio;
- **resume com invariantes**: o código entre as etapas depende do estado do disco;
- **review em eixos**: revisores paralelos cujos achados o código roteia.

## Antes de entregar

O workflow só está entregue com os três itens cumpridos:

- **Custo:** cada item do checklist de `docs/08-custos-e-cache.md` §6 atendido ou com o motivo da exceção num
  comentário, a estimativa de custo por caminho comentada no topo do workflow e o teto padrão em `budget`.
- **Testes offline:** `test/<nome>.test.ts` com o fake SDK (receitas e arnês em `docs/05-escrevendo-workflows.md`,
  seção Testando), com um caso por ramo que o código decide (tier, etapa pulada, laço no teto), um por `status` de
  retorno, um por invariante (violação, nova tentativa, status) e o resume (depois de `done` e depois de uma falha no
  meio). `npm run typecheck` e `npm test` verdes.
- **Um run real com tetos baixos:**
  `npm run wf -- run <nome> --args '{...}' --max-cents 100 --max-tokens 2000000`, sempre com os dois tetos (o de
  centavos fica cego quando o Cursor não reporta custo; `docs/02-configuracao-inicial.md` §3). Workflow com commit,
  push, PR ou comentário roda com `--cwd` num repositório descartável (os scripts de `scripts/verify/` criam um).
  Pronto quando o run devolve o `status` esperado e o uso de cada etapa (`step-end` no stderr, ou `npm run stats`)
  cabe na estimativa; se não couber, ajuste os tiers ou a estimativa.
