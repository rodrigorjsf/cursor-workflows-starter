# 9.2 · Convenções do livro

A documentação é um livro: um [índice](../README.md), partes, capítulos numerados e um rodapé de anterior/próximo em
cada capítulo. Esta página diz como ele é montado e como o `npm test` impede que ele se desfaça.

## Estrutura

O índice é `docs/README.md`. As nove partes são fixas e têm sempre o mesmo número, mesmo quando ainda não têm capítulos:

| Parte | Pasta | Conteúdo |
|---|---|---|
| 1 · Visão | `docs/vision/` | O problema, a ideia e as referências, os conceitos |
| 2 · Uso | `docs/usage/` | Instalar, configurar e invocar o kit |
| 3 · Internos | `docs/internals/` | Como o runtime funciona e o que ele garante |
| 4 · Escrevendo workflows | `docs/authoring/` | Regras, receitas e a conversão de skills em workflows |
| 5 · Operação | `docs/operating/` | Governança, custos, cache e observabilidade |
| 6 · Referência | `docs/reference/` | Tabelas de consulta |
| 7 · Decisões (ADRs) | `docs/adr/` | As decisões difíceis de reverter, em inglês |
| 8 · Pesquisa | `docs/research/` | Relatórios datados, com a evidência |
| 9 · Contribuindo | `docs/contributing/` | Este capítulo e os vizinhos |

`docs/agents/` guarda a configuração das skills de agentes (issue tracker, labels, docs de domínio). Não é parte do
livro: o docs check o ignora.

## Numeração

- Um capítulo é `parte.posição`, na ordem de leitura do índice: o terceiro capítulo da parte 2 é o **2.3**.
- O H1 do capítulo é o rótulo do índice, igual: `# 2.3 · Invocação no Cursor IDE (e no Claude Code)`.
- O arquivo leva o número da posição na pasta da parte: `docs/usage/03-invocacao-no-cursor-ide.md`. Os relatórios de
  pesquisa mantêm o nome sem número, porque outros arquivos os citam pelo nome.
- Ao inserir um capítulo no meio de uma parte, renumere os seguintes (rótulo do índice, H1 e rodapés). O docs check
  aponta cada ponto que ficou para trás.
- Cite outro capítulo pelo número: `[2.2 §3](../usage/02-configuracao-inicial.md#3-teto-de-custo)`.

## Rodapé

Todo capítulo termina com uma linha em branco, uma linha `---`, outra linha em branco e o rodapé: capítulo anterior,
índice e próximo capítulo, na ordem do índice (o último capítulo de uma parte aponta para o primeiro da seguinte). O primeiro
capítulo do livro não tem "anterior", e o último não tem "próximo".

```markdown
---

[← Anterior: 2.1 · Instalação](01-instalacao.md) · [Índice](../README.md) · [Próximo: 2.3 · Invocação no Cursor IDE (e no Claude Code) →](03-invocacao-no-cursor-ide.md)
```

O texto de cada link é o rótulo do índice, e o caminho é relativo ao arquivo. Quando o rodapé está errado, o docs check
imprime o rodapé esperado: copie dali.

## Como adicionar um capítulo

1. Crie o arquivo na pasta da parte, com o nome `NN-assunto.md` e o H1 `# parte.posição · Título`.
2. Liste o capítulo no índice, na parte e na posição certas, no formato
   `- [parte.posição · Título](pasta/NN-assunto.md): uma linha dizendo o que ele traz`.
3. Rode `npm run docs:check`. Cole o rodapé que ele pede no novo capítulo e ajuste o do vizinho que passou a ter um
   "próximo" ou um "anterior" diferente.
4. Mantenha as medições datadas e as citações `[DOC]` como estão ao mover ou reescrever um capítulo. Atualize só os
   caminhos de arquivos e as referências cruzadas.

## ADRs

Um ADR registra uma decisão difícil de reverter, surpreendente sem contexto e fruto de uma troca real. Os ADRs são o
único conteúdo do livro em inglês, e cada um é um capítulo da Parte 7.

1. Crie `docs/adr/NNNN-assunto.md`, com `NNNN` sequencial (o próximo depois do maior que existe).
2. O H1 é o rótulo do índice, `# 7.N · ADR-NNNN: Short title`. Logo abaixo vem `**Status:** accepted` (ou `proposed`, ou
   `superseded by ADR-NNNN`), com o link da spec que decidiu.
3. As seções são `## Context`, `## Decision`, `## Consequences` e `## Considered options`. O `npm test` confere o título, o
   status, as seções e o idioma (`test/vision-and-adrs.test.ts`).
4. Liste o ADR na Parte 7 do índice e cole o rodapé que o docs check pedir.
5. Uma decisão que muda é um ADR novo, que substitui o antigo: não reescreva o ADR aceito. No novo, o status diz
   `supersedes [ADR-NNNN](...)`; no antigo, troque o status para `superseded by ADR-NNNN`.
6. Um ADR aceito só é editado no lugar para um esclarecimento que mantém a decisão (um motivo que faltava, uma
   consequência que ficou clara depois, um nome que mudou). A edição ganha, no parágrafo logo abaixo do
   `**Status:**`, a linha datada `**Amended:** AAAA-MM-DD: o que foi esclarecido`, em inglês como o resto do ADR. Se a
   edição muda o que foi decidido, ela é um ADR novo (item 5).

## O que o docs check confere

`scripts/check-docs.ts` (`npm run docs:check`) roda dentro do `npm test`, em `test/docs-check.test.ts`. Ele lê todo
Markdown do repositório (menos `node_modules`, estado de runs e links simbólicos), ignorando blocos de código, código
em linha e o front matter YAML das skills e regras, e falha quando encontra:

- um **link relativo** para um arquivo ou pasta que não existe (links inline, com ou sem título, e definições de
  referência `[ref]: alvo`);
- uma **âncora** (`#titulo`) que não é um título do arquivo de destino, com as regras de ids do GitHub (minúsculas,
  sem pontuação, hífens no lugar de espaços, `-1`, `-2` nas repetições);
- um arquivo de `docs/` (fora de `docs/agents/`) que **não está no índice**;
- um **rótulo do índice** que não segue `parte.posição`, ou um **H1** diferente do rótulo;
- um **rodapé** ausente ou diferente do esperado.

Os diagramas Mermaid têm a sua própria verificação, descrita em [9.3](03-diagramas.md#verificação). Os scripts do
mantenedor estão em [9.4](04-scripts-do-mantenedor.md).

---

[← Anterior: 9.1 · Contribuindo](01-contribuindo.md) · [Índice](../README.md) · [Próximo: 9.3 · Convenções de diagramas →](03-diagramas.md)
