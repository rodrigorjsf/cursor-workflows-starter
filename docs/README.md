# Cursor Workflows Starter Kit: o livro

Esta é a documentação do kit, organizada como um livro: partes, capítulos numerados (`parte.posição`) e, no fim de cada
capítulo, um rodapé com o anterior e o próximo. A ordem de leitura é a da lista de capítulos abaixo. Como o livro é
montado e como o `npm test` o confere: [9.2 · Convenções do livro](contributing/02-convencoes-do-livro.md).

## Por onde começar

| Perfil | Comece por | Depois |
|---|---|---|
| **Usuário**: instalar o kit e rodar workflows | [2.1 · Instalação](usage/01-instalacao.md), [2.2 · Configuração inicial](usage/02-configuracao-inicial.md) e [2.3 · Invocação no Cursor IDE (e no Claude Code)](usage/03-invocacao-no-cursor-ide.md) | [5.1 · Governança e custos](operating/01-governanca-e-custos.md) e [5.2 · Custos, cache e boas práticas](operating/02-custos-e-cache.md) |
| **Autor de workflows**: escrever ou converter workflows | [4.1 · Escrevendo workflows](authoring/01-escrevendo-workflows.md) e [4.2 · Convertendo skills e subagents em workflows](authoring/02-convertendo-skills-e-subagents.md) | [3.1 · Arquitetura](internals/01-arquitetura.md) e [5.3 · Observabilidade](operating/03-observabilidade.md) |
| **Mantenedor**: mudar o próprio kit | [9.1 · Contribuindo](contributing/01-contribuindo.md) e [3.1 · Arquitetura](internals/01-arquitetura.md) | [9.2 · Convenções do livro](contributing/02-convencoes-do-livro.md), [9.3 · Convenções de diagramas](contributing/03-diagramas.md), [9.4 · Scripts do mantenedor](contributing/04-scripts-do-mantenedor.md) e a [Pesquisa](#parte-8--pesquisa) |

## Partes e capítulos

### Parte 1 · Visão

_Em preparação._

### Parte 2 · Uso

- [2.1 · Instalação](usage/01-instalacao.md): requisitos, dependências, instalação, teste de fumaça
- [2.2 · Configuração inicial](usage/02-configuracao-inicial.md): autenticação (conta do usuário × service account), modelos, teto de custo, variáveis
- [2.3 · Invocação no Cursor IDE (e no Claude Code)](usage/03-invocacao-no-cursor-ide.md): MCP, CLI, skill, hooks; paridade com o Claude Code

### Parte 3 · Internos

- [3.1 · Arquitetura](internals/01-arquitetura.md): como o runtime funciona e o que ele garante (e o que não garante)

### Parte 4 · Escrevendo workflows

- [4.1 · Escrevendo workflows](authoring/01-escrevendo-workflows.md): o porquê das regras, efeitos garantidos × pedidos, receitas, prompts de etapa, testes (API e regras na skill `cursor-workflow-authoring`)
- [4.2 · Convertendo skills e subagents em workflows](authoring/02-convertendo-skills-e-subagents.md): o processo da skill `/skill-to-workflow`, com um exemplo

### Parte 5 · Operação

- [5.1 · Governança e custos (Cursor Teams/Enterprise)](operating/01-governanca-e-custos.md): orçamento por usuário, políticas de admin, auditoria, riscos
- [5.2 · Custos, cache e boas práticas](operating/02-custos-e-cache.md): de onde vem o custo, que caches existem (e quem controla), memo, contexto mínimo, prefixo estável, checklist
- [5.3 · Observabilidade: custo, tokens, contexto e eficiência](operating/03-observabilidade.md): banco SQLite por usuário, o que é medido (e o que não dá), views, receitas SQL, dashboard localhost, export, privacidade

### Parte 6 · Referência

- [6.1 · Referência de eventos](reference/events.md): os campos de cada evento do log de eventos do run (`events.jsonl`), gerada do tipo

### Parte 7 · Decisões (ADRs)

_Em preparação._

### Parte 8 · Pesquisa

- [8.1 · Cursor SDK como motor de workflows determinísticos: relatório de pesquisa](research/relatorio-pesquisa.md): por que o kit existe: Workflow do Claude Code × Cursor SDK, autenticação e cobrança, paridade
- [8.2 · Verificações locais (2026-11-11)](research/verificacoes-locais.md): o que foi testado contra a doc ao vivo e a API real, com evidência, e o que ficou pendente

### Parte 9 · Contribuindo

- [9.1 · Contribuindo](contributing/01-contribuindo.md): testes antes do PR, onde fica cada coisa, idioma, regras das skills e a política de custo dos testes contra a API real
- [9.2 · Convenções do livro](contributing/02-convencoes-do-livro.md): estrutura, numeração, rodapés, como adicionar um capítulo e o que o docs check confere
- [9.3 · Convenções de diagramas](contributing/03-diagramas.md): Mermaid com cores neutras ao tema, sem animação, `stateDiagram-v2` para máquinas de estado
- [9.4 · Scripts do mantenedor](contributing/04-scripts-do-mantenedor.md): a tabela de scripts, cada um com cabeçalho WHAT/WHY/WHEN/HOW

## Fora do livro

[Segurança](../SECURITY.md) · [Proveniência](../PROVENANCE.md) · [Créditos](../CREDITS.md) · [Mudanças](../CHANGELOG.md) ·
[README](../README.md) · [English summary](../README.en.md)
