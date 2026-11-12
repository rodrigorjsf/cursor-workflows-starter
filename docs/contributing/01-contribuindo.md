# 9.1 · Contribuindo

## Antes de abrir um PR

Rode `npm ci`, `npm run typecheck` e `npm test`. Os testes são offline (SDK falso), não precisam de conta nem de rede,
e são os mesmos do CI (Node 22.13.0 e 22.x). O `npm test` inclui o [docs check](02-convencoes-do-livro.md#o-que-o-docs-check-confere):
um link quebrado, um rodapé errado ou um capítulo fora do índice reprova o PR.

## Onde fica cada coisa

O repositório é um produto mais um espaço de desenvolvimento:

| Pasta | O que é |
|---|---|
| `packages/runtime/` | O produto: engine, CLI, servidor MCP, workflows embutidos e os testes offline deles. Resolve seus arquivos pelo local de instalação, nunca pela raiz do repositório. |
| `skills/` | As skills distribuídas aos usuários. `.agents/skills/` aponta para elas por links simbólicos (dogfood); nunca copie. |
| `templates/` | Arquivos que o setup do kit grava no repositório alvo. |
| raiz | O espaço de desenvolvimento: `CLAUDE.md` (guia canônico do mantenedor; `AGENTS.md` é um link para ele), configuração MCP do dogfood, `docs/`, `scripts/` e os testes do repositório (`test/`). |

O `CLAUDE.md` é carregado no contexto de todo agente, e por isso tem limite de linhas. Tudo o que o Cursor e o Codex
também precisam seguir fica neste livro, e o `CLAUDE.md` só aponta para cá.

## Idioma

- **Inglês:** o `CLAUDE.md`, as skills distribuídas, os templates, os ADRs e qualquer texto escrito para agentes.
- **pt-BR:** este livro e o `README.md`. O `README.en.md` é o resumo em inglês.

## Skills distribuídas

- Cada skill é autossuficiente: toda instrução mora na pasta dela (`SKILL.md` e `references/`), e nada aponta para um
  documento fora dela. Uma referência que duas skills dividem é copiada para as duas, e o `npm test` confere que as
  cópias continuam idênticas.
- Crie e atualize toda skill com `/mattpocock-skills:writing-for-agents`.

## Testes contra a API real: política de custo

O mantenedor assinou o plano **Premium** do Cursor (The X Subscription) **só para implementar e verificar este
projeto da forma mais completa possível**. Vale para quem rodar testes pagos em nome do projeto, pessoa ou agente:

1. **Prefira os modelos incluídos no plano.** No Premium, os modelos do Cursor (`composer-2.5`, `grok-4.7`,
   `grok-4.6`, `grok-4.5`) e o Auto (`default`) saem da franquia semanal do plano, sem cobrança extra
   ([doc](https://cursor.com/help/account-and-billing/pricing), acesso em 2026-11-11). São os defaults do
   `implement-issue` e dos workflows de [`scripts/verify/`](../../scripts/verify/README.md). Use-os sempre que o teste não
   exigir outro modelo.
2. **Modelos que consomem cota paga são permitidos quando o teste precisar deles.** Isso inclui modelos de
   terceiros, cobrados à parte com crédito pré-pago, e uso além da franquia semanal. Itens pendentes que exigem isso
   ([verificações §12](../research/verificacoes-locais.md)):
   - a faixa de contexto do Claude Haiku 5.5 (`claude-haiku-5-5`, acima de 100 mil tokens de input);
   - os caminhos HIGH e de review com um modelo de terceiros (por exemplo `gpt-5.3-codex`), se o teste for justamente
     esse.
3. **Sempre com teto.** Estime o custo antes, rode com `--max-tokens` e `--max-cents`, e registre o resultado e o
   custo em [`docs/research/verificacoes-locais.md`](../research/verificacoes-locais.md). Nesta conta o `getUsage()`
   não informa custo de agentes locais: o valor real fica no dashboard de uso do Cursor.
4. **Segurança primeiro.** Nunca imprima nem versione a chave, e não rode etapas que escrevem fora de um repositório
   descartável. Veja [SECURITY.md](../../SECURITY.md).

---

[← Anterior: 8.2 · Verificações locais (2026-11-11)](../research/verificacoes-locais.md) · [Índice](../README.md) · [Próximo: 9.2 · Convenções do livro →](02-convencoes-do-livro.md)
