# 06 · Convertendo skills e subagents em workflows

O processo está codificado na skill
[`.agents/skills/skill-to-workflow/SKILL.md`](../.agents/skills/skill-to-workflow/SKILL.md). Use assim:

```
/skill-to-workflow .agents/skills/implementar-feature/SKILL.md .cursor/agents/reviewer.md .claude/agents/tester.md
```

Ela aceita artefatos de qualquer um destes lugares:

- **skills** em `.agents/skills/`, `.cursor/skills/`, `.claude/skills/` e `.codex/skills/`, os lugares que o
  Cursor lê ([DOC](https://cursor.com/docs/skills#skill-directories), acesso em 2026-11-11);
- **subagents** em `.cursor/agents/`, `.claude/agents/` e `.codex/agents/`, os lugares que o Cursor lê; não há
  `.agents/agents/` documentado ([DOC](https://cursor.com/docs/subagents#file-locations)). Nas runs do SDK, a doc
  só cita `.cursor/agents/*.md` ([DOC](https://cursor.com/docs/sdk/typescript));
- **instruções** em `AGENTS.md`, `CLAUDE.md` e `.cursor/rules/`.

O inventário registra **em quais harnesses cada artefato é descoberto hoje** (matriz em
[04](04-invocacao-no-cursor-ide.md#onde-cada-harness-procura-cada-coisa)). Por exemplo, uma skill em
`.agents/skills/` roda no Cursor e só chega ao Claude Code pelos links de `scripts/link-claude-skills.sh`. Depois da conversão, o fluxo deixa de depender de
onde cada harness procura: as etapas são código, e as instruções compartilhadas ficam em `AGENTS.md`.

## Quando converter (e quando não)

| Converta | Mantenha como skill |
|---|---|
| O fluxo é repetível e tem critério de pronto objetivo (testes, checklist, PR aberto) | Exploração aberta, brainstorming, entrevista |
| Etapas são "esquecidas" ou feitas fora de ordem pelo modelo | Fluxo curto, de 1 ou 2 passos, que o modelo já faz bem |
| Você quer usar modelos baratos na maior parte das etapas | O fluxo é uma conversa com o humano do começo ao fim |
| O custo precisa de teto previsível | — |

Uma **aprovação** no meio do fluxo ("confirme as seams com o usuário") não impede a conversão: vira um checkpoint
em dois runs ([05 · Checkpoint em dois runs](05-escrevendo-workflows.md#checkpoint-em-dois-runs)).

## As seis etapas da conversão

1. **Inventário.** Tabela com cada skill e subagent e tudo o que eles referenciam (outras skills, arquivos de
   referência, licença numa skill de terceiros): gatilho atual, entradas, saídas, tools, modelo e efeitos externos.
2. **Decisões implícitas.** Tudo o que hoje o modelo decide ("quando relevante", "repita até…", "verifique se
   passou", "red antes de green", "confirme com o usuário"). Cada uma vira uma regra em código, um arg, uma
   invariante conferida entre etapas, um checkpoint, um classificador barato com schema, ou fica como skill (a lista e
   o critério de pronto estão no passo 2 da skill).
3. **Mapeamento** para `ctx.agent`, `ctx.parallel`, `ctx.pipeline`, `execFileSync` e laços com teto. A tabela
   completa está na skill.
4. **Otimização de custo** (obrigatória): checklist de [08](08-custos-e-cache.md#6-checklist-de-custo) etapa por
   etapa e estimativa de custo por caminho, no caso típico e no pior caso.
5. **Geração** de `workflows/<nome>.ts` e `test/<nome>.test.ts` neste kit, seguida de
   `npm run typecheck && npm test`; com o kit instalado fora, cópia para `.agents/workflows/` do repositório alvo.
6. **Relatório**: o que foi convertido, o que não foi e por quê, os créditos, a paridade entre harnesses e o
   comando do primeiro run real, que é do usuário.

## Exemplo: `implement-issue` a partir de quatro skills de terceiros

O [`workflows/implement-issue.ts`](../workflows/implement-issue.ts) é a conversão de referência. Ele segue, em
código, os fluxos das skills `tdd`, `codebase-design`, `code-review` e `pr` de
[mattpocock/skills](https://github.com/mattpocock/skills) 1.3.1 (MIT); os créditos estão em
[`CREDITS.md`](../CREDITS.md).

**Inventário** (resumo):

| Unidade | Gatilho atual | Harnesses que descobrem hoje | O que traz para o fluxo |
|---|---|---|---|
| `tdd` | Modelo ("test-first", "red-green-refactor") | Claude Code, via plugin | Seams combinadas com o usuário; fatias verticais; red antes de green; teste pela interface pública; cita a `codebase-design` |
| `codebase-design` | Modelo, ou citada pela `tdd` | Claude Code, via plugin | Vocabulário de módulo profundo e seam; "Design it twice" com três ou mais sub-agents em paralelo (o workflow fixa três) |
| `code-review` | Modelo ("review since X") | Claude Code, via plugin | Dois sub-agents em paralelo (Standards, Spec), relatórios lado a lado; baseline de smells de Fowler |
| `pr` | Modelo ("writing a PR body") | Claude Code, via plugin | Template Summary / Evidence / Merge Danger; credita a `show-me` (humanlayer/skills, MIT) |

**Decisões implícitas encontradas e regras adotadas:**

| Na skill | No workflow |
|---|---|
| "confirme as seams com o usuário" (`tdd`) | Checkpoint em MED e HIGH: o run 1 propõe as seams na issue e devolve `seams-proposed`; o run 2, com `approveSeams`, o mesmo `runId` e o mesmo `--cwd`, executa o plano guardado (sem ele, para com `seams-not-proposed`). LOW segue sem parar, com uma fatia |
| "red antes de green", "uma fatia por vez" (`tdd`) | Invariantes conferidas pelo código: só testes mudam no red e a suíte falha; nem testes nem configuração do runner mudam no green e a suíte passa; violação desfaz a etapa e tenta de novo uma vez |
| "Design it twice" quando vale a pena (`codebase-design`) | Só no tier HIGH: três designers em `ctx.parallel` com restrições diferentes e um juiz com schema |
| "dois sub-agents, sem misturar nem reordenar" (`code-review`) | Três eixos em `ctx.parallel` (Standards, Spec e Segurança, este do kit), cada um com o schema das suas categorias; o código roteia: requisito faltando ou errado vira fatia TDD extra (até 2), padrão violado ou falha de segurança vira refactor, e julgamento, fora do pedido e nota de segurança vão para o PR |
| "qual é o ponto fixo?" (`code-review`) | Commit base do worktree, guardado pelo código |
| "Evidence: o teste falhando, depois passando" (`pr`) | Saídas reais da suíte em cada fatia, capturadas pelo código; o agente escreve só Summary e Merge Danger |
| "corrija até passar" | Até 2 correções por fatia, um tier acima (LOW → MED, MED → HIGH; o HIGH continua no HIGH); depois `tests-failed` |
| modelo herdado do chat | Mapa de tiers explícito (`composer-2.5` no LOW, `grok-4.7` no MED, `grok-4.7` com esforço alto no HIGH e no review) |

**Otimização de custo:** a tabela por etapa (modelo, tools, `settingSources`, `memo`) e as estimativas por caminho
estão no cabeçalho do workflow. As etapas que só leem (classificar, planejar, desenhar, julgar, revisar, escrever o
texto do PR) rodam com `settingSources: []`, a única configuração medida que corta as skills
([08 §4.3](08-custos-e-cache.md#43-contexto-fixo-mínimo-por-etapa)). No lugar do `AGENTS.md`, o código lista no prompt
os arquivos de contexto que existem no planejar, desenhar, julgar e no texto do PR, e os de padrão no eixo Standards;
o classificar recebe só a issue, e os eixos Spec e Segurança, a issue e o diff. Testes, diff, commit, comentário e PR são código: zero tokens.
As etapas que escrevem (teste, código, correção, refactor) ficam com todas as tools, `task` inclusive, e o default do
engine (`["project","team","mdm"]`): é a exceção do workflow ao item de `tools` do
[checklist](08-custos-e-cache.md#6-checklist-de-custo).

O que a conversão exigiu além dos passos da skill virou receita em [05](05-escrevendo-workflows.md#receitas)
(invariantes entre etapas, resume com invariantes, checkpoint em dois runs, review em eixos) e referência em
[`ORIGEM.md`](../.agents/skills/skill-to-workflow/ORIGEM.md) (skill citada por outra, sub-agents em paralelo, skill
de terceiros).

## Pós-conversão

- Mantenha o fluxo original até comparar os dois. Numa skill do próprio repositório, marque-a com
  `disable-model-invocation: true`, ou troque o corpo dela por "use `/run-workflow <nome>`". Com `true`, a skill só
  roda quando o usuário digita `/nome`, no Cursor ([DOC](https://cursor.com/docs/skills#disabling-automatic-invocation))
  e no Claude Code ([DOC](https://code.claude.com/docs/en/skills#control-who-invokes-a-skill)). No Claude Code, ela
  também deixa de ser pré-carregada em subagents que a listam em `skills`. Skill de terceiros fica como está.
- Compare os dois com tetos baixos (`--max-cents` e `--max-tokens`), olhando custo, taxa de conclusão e
  retrabalho ([02 §3](02-configuracao-inicial.md#3-teto-de-custo) explica por que os dois tetos).
- Se o fluxo era do Claude Code e você também quer o runtime nativo de lá, a mesma estrutura vira um
  `.claude/workflows/<nome>.js` (ver [04](04-invocacao-no-cursor-ide.md#paridade-cursor--claude-code)).
