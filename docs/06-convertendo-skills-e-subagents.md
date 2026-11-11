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
`.agents/skills/` roda no Cursor mas é invisível ao Claude Code. Depois da conversão, o fluxo deixa de depender de
onde cada harness procura: as etapas são código, e as instruções compartilhadas ficam em `AGENTS.md`.

## Quando converter (e quando não)

| Converta | Mantenha como skill |
|---|---|
| O fluxo é repetível e tem critério de pronto objetivo (testes, checklist, PR aberto) | Exploração aberta, brainstorming, perguntas |
| Etapas são "esquecidas" ou feitas fora de ordem pelo modelo | Fluxo curto, de 1 ou 2 passos, que o modelo já faz bem |
| Você quer usar modelos baratos na maior parte das etapas | O fluxo precisa de conversa com o humano no meio |
| O custo precisa de teto previsível | — |

## As seis etapas da conversão

1. **Inventário.** Tabela com cada skill e subagent: gatilho atual, entradas, saídas, tools, modelo e efeitos
   externos.
2. **Decisões implícitas.** Tudo o que hoje o modelo decide ("quando relevante", "se necessário", "repita até…",
   "verifique se passou"). Cada uma vira uma regra em código ou um classificador barato com schema.
3. **Mapeamento** para `ctx.agent`, `ctx.parallel`, `ctx.pipeline`, `execFileSync` e laços com teto. A tabela
   completa está na skill.
4. **Otimização de custo** (obrigatória): checklist de [08](08-custos-e-cache.md#6-checklist-de-custo) etapa por
   etapa (tier, `tools`, `settingSources`, `memo`, prompt com parte fixa primeiro, schema mínimo, limites) e
   estimativa de custo por caminho.
5. **Geração** de `workflows/<nome>.ts` e `test/<nome>.test.ts`, seguida de `npm run typecheck && npm test`.
6. **Relatório**: o que foi convertido, o que não foi e por quê, a paridade Cursor/Claude Code e o comando do
   primeiro run real.

## Exemplo resumido

**Antes** (skill + 2 subagents, tudo decidido pelo modelo):

```markdown
<!-- .agents/skills/implementar-feature/SKILL.md -->
1. Entenda a issue e, se for complexa, faça um plano.
2. Implemente. Use o subagent `tester` para escrever testes quando relevante.
3. Rode os testes e corrija até passar.
4. Se a mudança for grande, peça review ao subagent `reviewer`.
5. Abra o PR.
```

```markdown
<!-- .cursor/agents/reviewer.md -->
---
name: reviewer
description: Revisa mudanças antes do PR
model: inherit
readonly: true
---
Revise o diff procurando bugs e problemas de segurança...
```

**Decisões implícitas encontradas e regras adotadas:**

| No original | No workflow |
|---|---|
| "se for complexa" | Label `complexity:*`, ou classificador `composer-2.5` com schema `{tier}` |
| "quando relevante" (tester) | Sempre: etapa `escrever-testes` após implementar, modelo LOW |
| "corrija até passar" | Até 2 rodadas, escalando o modelo na correção; depois falha explícita |
| "se a mudança for grande" | `diffLines > 300` ou tier HIGH |
| (review que falha "passa" sem ninguém notar) | Review exigido que não roda encerra o run com `review-failed`; depois de corrigir achados, testes e review rodam de novo |
| `model: inherit` (reviewer) | `MODELS.REVIEW` explícito; `readonly: true` → `tools: ["read","grep","glob","ls","shell"]` (o shell é para `git diff`) |
| "abra o PR" | `gh pr create` no código, só com testes verdes e sem achado bloqueante |

**Otimização de custo aplicada** (passo 4):

| Etapa | Antes | Depois |
|---|---|---|
| Classificar | Inexistente: o modelo do chat decidia "se for complexa" no meio da conversa | Só quando falta label; modelo `composer-2.5`; `tools: []`; `settingSources: ["team","mdm"]` (tira o `AGENTS.md` e o projeto, mas não as skills; ver [08 §4.3](08-custos-e-cache.md#43-contexto-fixo-mínimo-por-etapa)); `memo` |
| Planejar | Modelo do chat, sempre | Só MED/HIGH; tools de leitura; `memo` (relançar no mesmo commit não paga de novo) |
| Testes | O agente rodava e interpretava | Rodados pelo código: zero tokens. Só a falha (truncada) volta para um agente |
| Review | Subagent `reviewer` com `inherit`, chamado "se a mudança for grande" | Só HIGH ou diff > 300 linhas; modelo explícito; sem `task` |
| Prompts | Corpo da skill + contexto da conversa | Constantes de instruções no topo + dados no fim |

**Depois:** o resultado é praticamente o [`workflows/implement-issue.ts`](../workflows/implement-issue.ts).

## Pós-conversão

- Não apague o fluxo original de imediato. Marque a skill antiga com `disable-model-invocation: true`, ou troque o
  corpo dela por "use `/run-workflow <nome>`". Com `true`, a skill só roda quando o usuário digita `/nome`, no
  Cursor ([DOC](https://cursor.com/docs/skills#disabling-automatic-invocation)) e no Claude Code
  ([DOC](https://code.claude.com/docs/en/skills#control-who-invokes-a-skill)). No Claude Code, ela também deixa de
  ser pré-carregada em subagents que a listam em `skills`.
- Compare os dois com tetos baixos (`--max-cents` e `--max-tokens`), olhando custo (`spentCents`), taxa de
  conclusão e retrabalho. `spentCents` soma, por tentativa, o maior entre o custo bruto e o cobrado, então o uso
  incluído no plano também aparece; `chargedCents` traz só o cobrado. Em uso cobrado por request (planos legados e
  alguns Enterprise), o bruto vem 0 e só o teto de tokens protege.
- Se o fluxo era do Claude Code e você também quer o runtime nativo de lá, a mesma estrutura vira um
  `.claude/workflows/<nome>.js` (ver [04](04-invocacao-no-cursor-ide.md#paridade-cursor--claude-code)).
