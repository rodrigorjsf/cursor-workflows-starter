# 9.4 · Scripts do mantenedor

Um procedimento que se repete vira um script em `scripts/`, e não uma sequência de passos que cada agente deduz de
novo. Dois requisitos valem para todo script:

1. **Um cabeçalho WHAT/WHY/WHEN/HOW** nas primeiras linhas, em comentário: o que faz, por que existe, quando rodar e
   como. O cabeçalho fica em inglês, como o resto do texto escrito para agentes.
2. **Uma linha na tabela abaixo.** Os módulos de apoio em `scripts/lib/` (hoje, `scripts/lib/markdown.ts`) não são
   procedimentos e ficam fora da tabela, mas também levam o cabeçalho.

O `npm test` confere os dois (`test/scripts-conventions.test.ts`): um script sem cabeçalho ou fora da tabela reprova.

| Script | O que faz | Quando usar | Como |
|---|---|---|---|
| `scripts/check-docs.ts` | Confere links relativos, âncoras, índice, H1 e rodapés do livro | Sempre: roda no `npm test`. Avulso, depois de editar a documentação | `npm run docs:check` |
| `scripts/check-mermaid.ts` | Renderiza cada bloco Mermaid com o `mermaid-cli` e falha em erro de sintaxe | No CI (job `mermaid`). Localmente só com `--list`, porque o `mermaid-cli` trava | `npm run docs:mermaid` (CI); `npm run docs:mermaid -- --list` |
| `scripts/events-reference.ts` | Gera `docs/reference/events.md` (6.1) a partir dos tipos em `packages/runtime/src/runtime/events.ts` | Depois de mudar um evento, um campo ou um comentário em `events.ts`; o `npm test` falha se a página divergir. O número e o rodapé da página vêm do índice do livro: não há o que ajustar ao inserir capítulos ao redor | `npm run docs:events`; `npx tsx scripts/events-reference.ts --check` só compara |
| `scripts/link-claude-skills.sh` | Liga `.agents/skills/*` em `.claude/skills/` para o Claude Code | Uma vez por clone, se o time usa o Claude Code neste repositório | `scripts/link-claude-skills.sh` |
| `scripts/probe-sdk.ts` | Faz um `send` curto contra a API real e mede eventos, uso e custo | Ao atualizar o `@cursor/sdk`, numa conta nova, ou para ver se o `getUsage()` passou a informar custo | `npx tsx scripts/probe-sdk.ts --model <id> --mode smoke` |
| `scripts/verify/setup-probe-repo.sh` | Monta o repositório descartável dos workflows `verify-*` | Antes de rodar os três `verify-*` | `scripts/verify/setup-probe-repo.sh <diretório-novo>` |
| `scripts/verify/setup-sandbox-repo.sh` | Cria um repositório GitHub descartável, com uma issue `complexity:low`, para o teste ponta a ponta do `implement-issue` | Antes de um run real do `implement-issue` | `scripts/verify/setup-sandbox-repo.sh <dono/repositório-novo>` |
| `scripts/verify/verify-structured.ts` | Workflow: saída estruturada (`submit_result`, correção, re-prompt) | Conta nova ou SDK novo | [`scripts/verify/README.md`](../../scripts/verify/README.md) |
| `scripts/verify/verify-context.ts` | Workflow: o que `settingSources` carrega e a guarda contra recursão | Conta nova ou SDK novo | [`scripts/verify/README.md`](../../scripts/verify/README.md) |
| `scripts/verify/verify-cache.ts` | Workflow: cache de prompt entre agentes irmãos | Conta nova ou SDK novo | [`scripts/verify/README.md`](../../scripts/verify/README.md) |

Os três `verify-*` custam tokens: rode sempre com `--max-tokens`, e veja a
[política de custo](01-contribuindo.md#testes-contra-a-api-real-política-de-custo).

---

[← Anterior: 9.3 · Convenções de diagramas](03-diagramas.md) · [Índice](../README.md)
