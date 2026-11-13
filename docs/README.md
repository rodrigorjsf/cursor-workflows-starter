# Cursor Workflows Starter Kit: o livro

Esta é a documentação do kit, organizada como um livro: partes, capítulos numerados (`parte.posição`) e, no fim de cada
capítulo, um rodapé com o anterior e o próximo. A ordem de leitura é a da lista de capítulos abaixo. Como o livro é
montado e como o `npm test` o confere: [9.2 · Convenções do livro](contributing/02-convencoes-do-livro.md).

## Por onde começar

Chegou agora? Leia a Parte 1: o problema ([1.1](vision/01-o-problema.md)), a ideia e as referências ([1.2](vision/02-a-ideia-e-as-referencias.md))
e os conceitos ([1.3](vision/03-conceitos.md)). Depois siga o seu perfil:

| Perfil | Comece por | Depois |
|---|---|---|
| **Usuário**: instalar o kit e rodar workflows | [2.1 · Instalação](usage/01-instalacao.md), [2.2 · Configuração inicial](usage/02-configuracao-inicial.md) e [2.3 · Invocação no Cursor IDE (e no Claude Code)](usage/03-invocacao-no-cursor-ide.md) | [5.1 · Governança e custos](operating/01-governanca-e-custos.md) e [5.2 · Custos, cache e boas práticas](operating/02-custos-e-cache.md) |
| **Autor de workflows**: escrever ou converter workflows | [4.1 · Escrevendo workflows](authoring/01-escrevendo-workflows.md) e [4.2 · Convertendo skills e subagents em workflows](authoring/02-convertendo-skills-e-subagents.md) | [3.1 · Arquitetura](internals/01-arquitetura.md) e [5.3 · Observabilidade](operating/03-observabilidade.md) |
| **Mantenedor**: mudar o próprio kit | [9.1 · Contribuindo](contributing/01-contribuindo.md) e [3.1 · Arquitetura](internals/01-arquitetura.md) | [9.2 · Convenções do livro](contributing/02-convencoes-do-livro.md), [9.3 · Convenções de diagramas](contributing/03-diagramas.md), [9.4 · Scripts do mantenedor](contributing/04-scripts-do-mantenedor.md), as [decisões (ADRs)](#parte-7--decisões-adrs) e a [Pesquisa](#parte-8--pesquisa) |

## Partes e capítulos

### Parte 1 · Visão

- [1.1 · O problema](vision/01-o-problema.md): o que dá errado quando o modelo conduz o processo, o que falta no Cursor e o que um runtime pronto ainda deixa de fora
- [1.2 · A ideia e as referências](vision/02-a-ideia-e-as-referencias.md): o código decide e o modelo executa etapas pequenas; Claude Code, n8n e as skills de mattpocock; créditos e proveniência
- [1.3 · Conceitos](vision/03-conceitos.md): workflow, etapa, role, run, job, journal, log de eventos e location

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
- [6.2 · Referência de configuração](reference/config.md): os arquivos global e do repositório, precedência, tetos, papéis e cada campo, gerada do esquema JSON

### Parte 7 · Decisões (ADRs)

As decisões difíceis de reverter, em inglês, uma por arquivo (`docs/adr/NNNN-slug.md`). Para registrar uma nova, veja
[9.2](contributing/02-convencoes-do-livro.md#adrs).

- [7.1 · ADR-0001: Layered config with hard caps](adr/0001-layered-config-with-hard-caps.md): configuração em JSON em duas camadas; o teto global só pode ser apertado, nunca afrouxado
- [7.2 · ADR-0002: The event log is the source of truth](adr/0002-event-log-source-of-truth.md): o log de eventos por run é a fonte da verdade do status, do gasto e do conteúdo (substituído pelo ADR-0008)
- [7.3 · ADR-0003: Runs are detached processes](adr/0003-detached-jobs.md): `start_workflow` lança um processo destacado; o MCP server só lê o estado
- [7.4 · ADR-0004: npm workspaces and a canonical CLAUDE.md](adr/0004-workspaces-and-claude-md-symlink.md): runtime em pacote próprio; `CLAUDE.md` canônico e `AGENTS.md` como link simbólico
- [7.5 · ADR-0005: The cloud backend and the location cap](adr/0005-cloud-backend-and-location-cap.md): etapas na nuvem só com o teto global e a capacidade declarada pelo workflow (substituído pelo ADR-0006)
- [7.6 · ADR-0006: Cloud steps as built](adr/0006-cloud-steps-as-built.md): o ADR-0005 como foi construído: `read-only` conferido pelo motor, o trabalho que volta por fast-forward ou não volta, `resultVia` e o reanexar sem pagar duas vezes (substituído pelo ADR-0007)
- [7.7 · ADR-0007: Cancelling a run stops its cloud agents](adr/0007-cancel-stops-cloud-agents.md): o ADR-0006 com o ciclo de vida corrigido: cancelar para os cloud agents em qualquer estado do job, e o resume depois de um cancelamento cria um agente novo e paga de novo
- [7.8 · ADR-0008: The job record keeps what the event log cannot](adr/0008-job-record-keeps-what-the-log-cannot.md): o ADR-0002 com o registro do job corrigido: além da identidade, guarda só o que o log não pode guardar (`start`, `refused` e `killedByCancel`, a marca de um job travado que o cancelamento matou); status, gasto e resultado seguem projetados do log
- [7.9 · ADR-0009: The forge is a seam: GitHub and GitLab](adr/0009-forge-seam-github-and-gitlab.md): o forge (GitHub via `gh`, GitLab via `glab`) detectado pelo host do `origin`, com o mapa `forges` na config para hosts self-managed; `glab api` onde o CLI não basta; "PR" segue o termo do kit

### Parte 8 · Pesquisa

- [8.1 · Cursor SDK como motor de workflows determinísticos: relatório de pesquisa](research/relatorio-pesquisa.md): por que o kit existe: Workflow do Claude Code × Cursor SDK, autenticação e cobrança, paridade
- [8.2 · Verificações locais (2026-11-11)](research/verificacoes-locais.md): o que foi testado contra a doc ao vivo e a API real, com evidência, e o que ficou pendente

### Parte 9 · Contribuindo

- [9.1 · Contribuindo](contributing/01-contribuindo.md): testes antes do PR, onde fica cada coisa, idioma, regras das skills e a política de custo dos testes contra a API real
- [9.2 · Convenções do livro](contributing/02-convencoes-do-livro.md): estrutura, numeração, rodapés, como adicionar um capítulo e o que o docs check confere
- [9.3 · Convenções de diagramas](contributing/03-diagramas.md): Mermaid com cores neutras ao tema, sem animação, `stateDiagram-v2` para máquinas de estado
- [9.4 · Scripts do mantenedor](contributing/04-scripts-do-mantenedor.md): a tabela de scripts, cada um com cabeçalho WHAT/WHY/WHEN/HOW

## Fora do livro

[Segurança](../SECURITY.md) · [Mudanças](../CHANGELOG.md) · [README](../README.md) · [English summary](../README.en.md)
