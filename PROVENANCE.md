# Proveniência

Este repositório nasceu de um estudo no [ai-study-library](https://github.com/rodrigorjsf/ai-study-library), na pasta
`ai/study/cursor-agent-sdk-workflows/`. O kit foi escrito numa sessão na nuvem, sem acesso a cursor.com nem a uma
conta Cursor. Depois foi verificado e corrigido numa sessão local, com a documentação ao vivo e a API real.

## Commits de origem (ai-study-library)

| Commit | Data | O que entrou |
|---|---|---|
| [`f3dd5ee`](https://github.com/rodrigorjsf/ai-study-library/commit/f3dd5eefcadabf64848595460bf50a718396c908) | 2026-11-11 | Espelho da doc de *dynamic workflows* do Claude Code |
| [`6640d40`](https://github.com/rodrigorjsf/ai-study-library/commit/6640d40252900648f02674d8f9c25d40f0e66c8c) | 2026-11-11 | Plano do estudo |
| [`e444790`](https://github.com/rodrigorjsf/ai-study-library/commit/e444790a3b936bbd6af918e5c434e138aa6c787c) | 2026-11-11 | Relatório de pesquisa e primeira versão do kit |
| [`9a6b24f`](https://github.com/rodrigorjsf/ai-study-library/commit/9a6b24fbb4d4eeea1a67f59afc6634840f4735f9) | 2026-11-11 | Revisão independente aplicada; layout `.agents/` |
| [`1774f87`](https://github.com/rodrigorjsf/ai-study-library/commit/1774f87fad3d52f4b92578bdd859fa45abac0df8) | 2026-11-11 | Custos e cache |
| [`9855bda`](https://github.com/rodrigorjsf/ai-study-library/commit/9855bdae0b2de5076b73732808c35344f409b862) | 2026-11-11 | Plano da observabilidade V1 |
| [`a69f2a2`](https://github.com/rodrigorjsf/ai-study-library/commit/a69f2a21a78b7d5689fb21b6ed3c89d6890019db) | 2026-11-11 | Observabilidade V1: **estado do kit que serviu de base** |
| [`81d7356`](https://github.com/rodrigorjsf/ai-study-library/commit/81d7356c86be3c4429c42fbc79f2818a39111585) | 2026-11-11 | Prompt que conduziu a verificação local e esta publicação |
| [`4aaa4f8`](https://github.com/rodrigorjsf/ai-study-library/commit/4aaa4f8b0f3d670ce00e00552373f60585646ade) | 2026-11-11 | Espelhos atualizados da doc do Cursor usados como evidência na verificação |

O conteúdo do kit em `81d7356` é idêntico ao de `a69f2a2`
(`git diff --stat a69f2a2 81d7356 -- ai/study/cursor-agent-sdk-workflows/starter-kit` não lista nada).

## Sessões

| Sessão | Ambiente | Papel |
|---|---|---|
| <https://claude.ai/code/session_01FoetnbEHq7GuDkLCZpYC7f> | Nuvem (Claude Code), sem acesso a cursor.com nem conta Cursor | Pesquisa, relatório, kit, revisões |
| <https://claude.ai/code/session_01FoetnZWeHSTocfBFv51gxV> | Local (Claude Code no WSL2), com conta Cursor (Free e depois Premium) | Verificação contra a doc ao vivo e a API real, correções, montagem deste repositório |

## O que mudou entre `a69f2a2` e a versão 0.1.0

Veja o [CHANGELOG](CHANGELOG.md) e, com a evidência de cada item,
[`docs/research/verificacoes-locais.md`](docs/research/verificacoes-locais.md).

## Fontes primárias

Consultadas em 2026-11-11. As páginas não são reproduzidas aqui: os docs citam a URL oficial e, quando cabe, a linha da
página em Markdown naquela data.

- Cursor: <https://cursor.com/docs/sdk/typescript>, <https://cursor.com/docs/sdk/python>,
  <https://cursor.com/docs/sdk/bridge>, <https://cursor.com/docs/release-notes/sdk>, <https://cursor.com/docs/hooks>,
  <https://cursor.com/docs/subagents>, <https://cursor.com/docs/skills>, <https://cursor.com/docs/mcp>,
  <https://cursor.com/docs/rules>, <https://cursor.com/docs/cli/overview>, <https://cursor.com/docs/models-and-pricing>,
  <https://cursor.com/help/account-and-billing/pricing>, <https://cursor.com/docs/account/enterprise/service-accounts>.
  Índice: <https://cursor.com/llms.txt>.
- Claude Code: <https://code.claude.com/docs/en/workflows>, <https://code.claude.com/docs/en/memory>,
  <https://code.claude.com/docs/en/skills>, <https://code.claude.com/docs/en/mcp>,
  <https://code.claude.com/docs/en/hooks>, <https://code.claude.com/docs/en/sub-agents>.
- Pacote `@cursor/sdk@1.3.1` no npm (tipos `.d.ts` e README).
- Fórum oficial do Cursor (<https://forum.cursor.com>), citado como relato de usuário quando não há doc.
- Testes contra a API real: [`docs/research/verificacoes-locais.md`](docs/research/verificacoes-locais.md) e os
  workflows de [`scripts/verify/`](scripts/verify/README.md).

Cópias dessas páginas, feitas na mesma data, ficam no estudo de origem
([`ai/docs/cursor/`](https://github.com/rodrigorjsf/ai-study-library/tree/main/ai/docs/cursor)) e não neste repositório.
