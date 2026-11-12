# 9.1 · Contribuindo

## Antes de abrir um PR

Rode `npm ci`, `npm run typecheck` e `npm test`. Os testes são offline (SDK falso), não precisam de conta nem de rede,
e são os mesmos do CI (Node 22.13.0 e 22.x). O `npm test` inclui o [docs check](02-convencoes-do-livro.md#o-que-o-docs-check-confere):
um link quebrado, um rodapé errado ou um capítulo fora do índice reprova o PR.

## Onde fica cada coisa

O repositório é um produto (`packages/runtime/`, `skills/`, `templates/`) mais um espaço de desenvolvimento (a raiz). O
`CLAUDE.md` (guia canônico do mantenedor; `AGENTS.md` é um link para ele) tem as regras para quem edita o código. Ele é
carregado no contexto de todo agente e por isso tem limite de linhas: guarda o essencial, e o detalhe fica neste livro. A
decisão por trás do desenho está no [ADR-0004](../adr/0004-workspaces-and-claude-md-symlink.md).

```
.
├── CLAUDE.md               # guia canônico do mantenedor, em inglês (AGENTS.md é um link simbólico para ele)
├── packages/
│   └── runtime/            # o produto (workspace npm @cursor-workflows/runtime)
│       ├── src/
│       │   ├── runtime/
│       │   │   ├── workflow.ts     # tipos públicos + defineWorkflow()
│       │   │   ├── engine.ts       # agent/parallel/pipeline/phase, retries, modelo, teto de custo
│       │   │   ├── events.ts       # o tipo dos eventos (a referência 6.1 é gerada dele)
│       │   │   ├── run-store.ts    # log de eventos, journal e lock de cada run
│       │   │   ├── structured.ts   # saída estruturada via custom tool submit_result + Ajv
│       │   │   ├── journal.ts      # resume sem repetir etapas concluídas
│       │   │   ├── jobs.ts         # jobs: processo destacado, heartbeat, cancelamento e estado projetado do log
│       │   │   ├── heartbeat-worker.mjs  # thread que atualiza o heartbeat do job mesmo com a principal bloqueada
│       │   │   ├── worktree-snapshot.ts  # registra e restaura os arquivos de uma etapa que escreve (cancelamento)
│       │   │   ├── registry.ts     # descobre workflows/*.ts
│       │   │   └── nested-mcp-guard.mjs  # servidor MCP sem tools que barra workflow dentro de etapa
│       │   ├── observability/      # banco SQLite de métricas, recorder, consultas, dashboard localhost
│       │   ├── init.ts             # wf init: planeja e grava os arquivos do kit no repositório alvo (sem commit)
│       │   ├── doctor.ts           # wf doctor: as verificações do ambiente
│       │   ├── doctor-report.ts    # o formato do relatório do doctor (só a biblioteca padrão: o node-check.ts o usa num Node antigo)
│       │   ├── mcp-launch.ts       # como o IDE inicia o servidor MCP (o `workflows` do .cursor/mcp.json e do .mcp.json)
│       │   ├── kit-version.ts      # versão do kit e a faixa `kit` que o repositório declara
│       │   ├── upgrade.ts          # wf upgrade: leva o kit instalado à tag mais nova e roda o install.sh --refresh dela
│       │   ├── unified-diff.ts     # o diff que o wf init imprime
│       │   ├── cli.ts              # wf login | whoami | models | list | init | doctor | upgrade | config | run | start | wait | status | cancel | jobs | stats | metrics
│       │   └── mcp-server.ts       # tools MCP: list_workflows, start_workflow, wait_workflow, get_workflow_status, cancel_workflow
│       ├── workflows/
│       │   ├── smoke.ts            # teste de fumaça: uma etapa estruturada, num modelo incluído, com teto de 50 mil tokens
│       │   ├── implement-issue.ts  # exemplo: TDD fatia a fatia conferido pelo código → review em 3 eixos → PR com evidência
│       │   └── implement-issue/    # prompts (paráfrases das skills de mattpocock/skills), laço TDD, review, corpo do PR
│       └── test/                   # testes offline (fake SDK)
├── skills/                 # skills distribuídas (autossuficientes: SKILL.md + references/)
│   ├── run-workflow/       # /run-workflow <nome> <args>: dispara e acompanha
│   ├── cursor-workflow-authoring/ # referência para escrever workflows
│   ├── skill-to-workflow/  # /skill-to-workflow: converte skills e subagents em workflow
│   └── cursor-workflows-setup/ # init, doctor, upgrade, validação no Cursor IDE e configuração
├── templates/              # arquivos que o setup do kit grava: o bloco do AGENTS.md (repositório alvo) e global-config.json (tetos padrão do usuário)
├── INSTALL-AGENT.md        # guia público de instalação para agentes, fixado numa tag (inglês)
├── test/                   # testes do repositório (layout, MCP dogfood, scripts da raiz, docs)
├── .agents/                # local neutro (Cursor e Codex leem nativamente)
│   ├── skills/             # links simbólicos para skills/ (dogfood)
│   └── workflows/          # workflows do repositório (carregados junto com os de packages/runtime/workflows/)
├── .claude/rules/          # regras do Claude Code com escopo por caminho
├── .cursor/mcp.json        # MCP server no Cursor
├── .mcp.json               # o mesmo MCP server no Claude Code
├── scripts/                # procedimentos do mantenedor (tabela em 9.4); install.sh é o instalador do kit
├── SECURITY.md · CHANGELOG.md · README.md · README.en.md
└── docs/                   # o livro: README.md é o índice; uma pasta por parte (vision/, usage/, internals/, ..., adr/)
```

## Idioma

- **Inglês:** o `CLAUDE.md`, as skills distribuídas, os templates, os ADRs e qualquer texto escrito para agentes.
- **pt-BR:** este livro e o `README.md`. O `README.en.md` é o hub em inglês, com a mesma estrutura.

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
   custo em [8.2](../research/verificacoes-locais.md). Nesta conta o `getUsage()`
   não informa custo de agentes locais: o valor real fica no dashboard de uso do Cursor.
4. **Segurança primeiro.** Nunca imprima nem versione a chave, e não rode etapas que escrevem fora de um repositório
   descartável. Veja [SECURITY.md](../../SECURITY.md).

---

[← Anterior: 8.2 · Verificações locais (2026-11-11)](../research/verificacoes-locais.md) · [Índice](../README.md) · [Próximo: 9.2 · Convenções do livro →](02-convencoes-do-livro.md)
