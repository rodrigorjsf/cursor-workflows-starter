# 9.1 · Contribuindo

## Antes de abrir um PR

Rode `npm ci` e `npm run check`, que faz o `typecheck` e o `npm test` (com o Node do `mise.toml`: `mise exec -- npm run check`). Os testes são offline (SDK falso), não precisam de conta nem de rede,
e são os mesmos do CI (Node 22.13.0, 22.x, 24.x e 26.x). O `npm test` inclui o docs check ([9.2](02-convencoes-do-livro.md#o-que-o-docs-check-confere)):
um link quebrado, um rodapé errado ou um capítulo fora do índice reprova o PR.

O `.npmrc` da raiz desliga os scripts de instalação das dependências (`ignore-scripts=true`) e faz o `engines` valer
(`engine-strict=true`); o `install.sh` e o CI repetem `--ignore-scripts`, para que um `.npmrc` editado não os religue. No CI,
todo `uses:` é fixado num SHA de commit com a versão no comentário (o Dependabot, que espera 7 dias antes de propor uma versão
nova, mantém os SHAs), todo `actions/checkout` tem `persist-credentials: false`, cada job tem `timeout-minutes` e cada script
`test` passa `--test-timeout` (120000 na raiz e no dashboard, 600000 no runtime). O prazo vale para cada arquivo de teste inteiro,
não só para cada teste: o `doctor.process.test.ts` leva 165 s sozinho, e um arquivo que precise de mais que o valor do pacote pede um
valor maior para o pacote, não um `timeout` no teste. O
`test/supply-chain.test.ts` confere isso. Renomear um item da matriz de Node renomeia o check obrigatório `test (<versão>)`: quem
mexe na matriz põe na descrição do PR o `gh api -X PUT` que atualiza o ruleset `main`, e o dono o roda ao integrar.

O `typecheck` roda o `tsc` nos seis projetos (a raiz, as duas páginas do dashboard e os testes de cada diretório) com as opções de
`packages/runtime/tsconfig.json`, que todos estendem: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`, `isolatedModules`,
`noUncheckedSideEffectImports` e `moduleDetection: "force"`. Um índice que pode não existir se resolve com uma checagem, nunca com
`!`. O `test/typescript-strictness.test.ts` confere que nenhum projeto desliga uma delas, que o registro de workflows não tem `any` e
que nenhum `JSON.parse(...) as T` entra no código que o kit entrega: o dado que vem de um arquivo de estado, do `.mcp.json` ou do `gh` e
do `glab` passa pelo `parseJson` (zod) ou pelo `isRecord`, de `packages/runtime/src/runtime/parse-json.ts`, e um dado de outra forma
dá um erro que nomeia a origem e o campo. O `test/floating-promises.test.ts` usa o checker do TypeScript e reprova uma promessa que
ninguém espera, devolve, marca com `void` ou termina com `.catch` em `packages/*/src` e `packages/*/workflows`.

Uma vez por clone, ative o hook de pre-commit, que passa o `gitleaks` no que está staged e recusa o commit que traz um
segredo: `git config core.hooksPath .githooks`. Vale para todos os worktrees do clone e pede o `gitleaks` no `PATH`. O
job `secrets` do CI roda o mesmo `gitleaks dir .` na árvore. Um valor falso que um teste usa de propósito entra no
`.gitleaks.toml` com a regra, o arquivo e o valor exato, nunca só pelo caminho.

Mudou o dashboard? Monte runs de fixture com `scripts/dev/dash-fixtures.ts` e capture as telas com
`scripts/dev/dash-shots.py` ([9.4](04-scripts-do-mantenedor.md)), em vez de montar runs e capturas à mão.

## Onde fica cada coisa

O repositório é um produto (`packages/runtime/`, `packages/dashboard/`, `skills/`, `templates/`) mais um espaço de desenvolvimento (a raiz). O
`CLAUDE.md` (guia canônico do mantenedor; `AGENTS.md` é um link para ele) tem as regras para quem edita o código. Ele é
carregado no contexto de todo agente e por isso tem limite de linhas: guarda o essencial, e o detalhe fica neste livro. A
decisão por trás do desenho está no [ADR-0004](../adr/0004-workspaces-and-claude-md-symlink.md).

```
.
├── CLAUDE.md               # guia canônico do mantenedor, em inglês (AGENTS.md é um link simbólico para ele)
├── CODING_STANDARDS.md     # as regras de julgamento que o review aplica, em inglês (o review do implement-issue o lê)
├── packages/
│   ├── dashboard/          # o dashboard local (workspace npm @cursor-workflows/dashboard): servidor HTTP sobre os runs e as métricas, que só lê, a não ser para iniciar um workflow num repositório que conhece, para retomar um run parado e para cancelar um run
│   │   ├── src/            # server.ts (API JSON, stream SSE e páginas), main.ts (o processo), board.ts (as colunas do quadro), pr-state.ts (estado das PRs e MRs, com cache, pelo `observe` do runtime), start.ts (o que o Start diz ao navegador e recebe dele: o corpo do `POST /api/start`, as respostas e o esqueleto dos args), resume.ts (as respostas do `POST /api/runs/<runId>/resume`), seams.ts (os corpos e as respostas do `POST /api/runs/<runId>/seams/approve` e `/seams/replace`), request-body.ts (o corpo JSON que as ações com corpo compartilham), backlog.ts (o Backlog: o `GET /api/backlog` e o cache de 60 segundos da resposta do forge por repositório),
│   │   │                   # web-bundle.ts (o esbuild que empacota as duas páginas quando o dashboard sobe, com cache por hash), pages.ts (o HTML delas)
│   │   ├── app/            # a página `/`, em React (menus Runs, Board e Metrics, e o painel Start: StartPanel.tsx, start-form.ts, start-api.ts; BoardView.tsx e backlog-board.ts, a coluna Backlog do quadro); o esbuild a empacota quando o dashboard sobe
│   │   ├── run-view/       # a página do run, `/runs/<runId>` (React, React Flow, elkjs; tsconfig próprio, sem Node nem runtime):
│   │   │                   # run-graph.ts (eventos → nós, arestas e raias), run-layout.ts (posições, elkjs), RunView.tsx (a tela), SeamsPanel.tsx e seams-form.ts (a proposta de seams de um run do `implement-issue`, com Approve e Replace seams)
│   │   └── test/           # testes do servidor por HTTP, do grafo e do layout (puros) e um contrato com o engine de verdade
│   └── runtime/            # o produto (workspace npm @cursor-workflows/runtime)
│       ├── src/
│       │   ├── runtime/
│       │   │   ├── workflow.ts     # tipos públicos + defineWorkflow()
│       │   │   ├── engine.ts       # agent/parallel/pipeline/phase, retries, modelo, teto de custo
│       │   │   ├── backend.ts      # AgentBackend: onde cada tentativa roda; o backend local, que fala com o SDK
│       │   │   ├── backend-cloud.ts  # o backend de nuvem: a tentativa num cloud agent, contra um snapshot do worktree
│       │   │   ├── cloud-snapshot.ts # a branch de snapshot: push, exclusão e o fast-forward do trabalho do agente de volta
│       │   │   ├── cloud-cancel.ts # cancela, pela API da Cursor, os cloud agents que um run de processo morto deixou rodando
│       │   │   ├── events.ts       # o tipo dos eventos (a referência 6.1 é gerada dele)
│       │   │   ├── outcome.ts      # a classe de um run terminado (entregue, falhou, cancelado…): o recorder e o `wf gc` leem a mesma
│       │   │   ├── run-store.ts    # log de eventos, journal, lock de cada run e locks nomeados do repositório (`.workflows/locks/`)
│       │   │   ├── structured.ts   # saída estruturada via custom tool submit_result + Ajv
│       │   │   ├── journal.ts      # resume sem repetir etapas concluídas
│       │   │   ├── jobs.ts         # jobs: o que roda um job (heartbeat, `startJob`, os sinais de cancelamento); reexporta o job-spawn.ts
│       │   │   ├── job-spawn.ts    # o que inicia um job: o registro (`createJob`) e o processo destacado (`spawnJob`), sem o engine (o dashboard o usa)
│       │   │   ├── job-state.ts    # o registro de um job, o estado projetado do log e o cancelamento, sem o engine (o dashboard o usa)
│       │   │   ├── job-children.ts # os grupos de processo dos comandos vivos de um job: o job os grava, e o cancelamento de um job travado os mata (o `SIGKILL` pula o gancho de saída)
│       │   │   ├── run-view.ts     # os runs de todos os repositórios, lidos do índice global e do log, para quem observa de fora (o dashboard), e de que issue cada run do `implement-issue` trata (`runOriginsOf`)
│       │   │   ├── run-tail.ts     # o log de eventos de um run lido por posição (cada linha tem um id): o stream ao vivo e o conteúdo de uma etapa
│       │   │   ├── run-cancel.ts   # cancela um run de fora do processo que o executa (o botão Cancel do dashboard), pelo mesmo `cancelJob` do `wf cancel`
│       │   │   ├── run-start.ts    # inicia um job de fora do processo que o executa (o painel Start do dashboard): só num repositório do índice global e num workflow que o runtime lista, com o `launchJob` que o resume também usa; sem o engine
│       │   │   ├── run-resume.ts   # retoma um run parado de fora do processo que o executava (o botão Resume run do dashboard, e a decisão sobre as seams, que é um resume com outros args): repete o start do registro do job pelo mesmo caminho do Start (`launchJob`, em `launchResume`); sem o engine
│       │   │   ├── args-schema.ts  # confere os args com o `argsSchema` do workflow, para o engine e para o Start; sem o engine
│       │   │   ├── inside-workflow.ts  # a variável `WF_INSIDE_WORKFLOW` que marca um processo dentro de uma etapa
│       │   │   ├── pr-by-url.ts    # o estado de uma PR (`gh`) ou MR (`glab api`) pela URL exata, nos hosts permitidos (github.com, gitlab.com e os do config do glab), para o dashboard
│       │   │   ├── dashboard-instance.ts  # onde o dashboard escuta, o pid file e o `ensureDashboard` que o `start_workflow` chama
│       │   │   ├── heartbeat-worker.mjs  # thread que atualiza o heartbeat do job mesmo com a principal bloqueada
│       │   │   ├── worktree-snapshot.ts  # registra e restaura os arquivos de uma etapa que escreve (cancelamento)
│       │   │   ├── registry.ts     # descobre workflows/*.ts
│       │   │   └── nested-mcp-guard.mjs  # servidor MCP sem tools que barra workflow dentro de etapa
│       │   ├── observability/      # banco SQLite de métricas, recorder, consultas
│       │   ├── observe.ts          # a única entrada que outro pacote importa do runtime (`@cursor-workflows/runtime/observe`)
│       │   ├── init.ts             # wf init: planeja e grava os arquivos do kit no repositório alvo (sem commit)
│       │   ├── doctor.ts           # wf doctor: as verificações do ambiente
│       │   ├── doctor-report.ts    # o formato do relatório do doctor (só a biblioteca padrão: o node-check.ts o usa num Node antigo)
│       │   ├── mcp-launch.ts       # como o IDE inicia o servidor MCP (o `workflows` do .cursor/mcp.json e do .mcp.json)
│       │   ├── kit-version.ts      # versão do kit e a faixa `kit` que o repositório declara
│       │   ├── kit-state.ts        # o estado do kit instalado pelo git: mudanças locais e tags do HEAD, que o upgrade e o doctor usam
│       │   ├── upgrade.ts          # wf upgrade: leva o kit instalado à tag mais nova e roda o install.sh --refresh dela
│       │   ├── unified-diff.ts     # o diff que o wf init imprime
│       │   ├── cli.ts              # wf login | whoami | models | list | init | doctor | upgrade | config | run | start | wait | status | cancel | jobs | gc | stats | metrics
│       │   └── mcp-server.ts       # tools MCP: list_workflows, start_workflow, wait_workflow, get_workflow_status, cancel_workflow
│       ├── workflows/
│       │   ├── smoke.ts            # teste de fumaça: uma etapa estruturada, num modelo incluído, com teto de 50 mil tokens
│       │   ├── implement-issue.ts  # exemplo: TDD fatia a fatia conferido pelo código → review em 3 eixos → PR com evidência
│       │   └── implement-issue/    # prompts (paráfrases das skills de mattpocock/skills), laço TDD, review, corpo do PR, `gc.ts` (o `wf gc`), `backlog.ts` (as issues prontas e sem run, pelo forge, para o Backlog do dashboard), `plan.ts` (o plano e a regra do comando de teste), `seams-approval.ts` (a proposta de seams que um run espera e a decisão sobre ela, de fora do processo: aprovar ou trocar as seams pelo dashboard)
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
├── .githooks/              # o hook de pre-commit que barra segredos com o gitleaks (ative com `git config core.hooksPath .githooks`)
├── .gitleaks.toml          # as regras do gitleaks: as padrão, mais as credenciais falsas dos testes, uma a uma
├── scripts/                # procedimentos do mantenedor (tabela em 9.4); install.sh é o instalador do kit
├── SECURITY.md · CHANGELOG.md · README.md · README.en.md
└── docs/                   # o livro: README.md é o índice; uma pasta por parte (vision/, usage/, internals/, ..., adr/)
```

## Idioma

Cada texto é escrito na língua de quem o lê (o livro em pt-BR, o que agentes leem em inglês); essa regra e a dos
comentários de código estão no [`CODING_STANDARDS.md`](../../CODING_STANDARDS.md).

## Skills distribuídas

Crie e atualize toda skill com `/mattpocock-skills:writing-for-agents`; a regra de que cada skill é autossuficiente
está no [`CODING_STANDARDS.md`](../../CODING_STANDARDS.md).

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
   ([8.2 §12](../research/verificacoes-locais.md#12-não-executado-pendências)):
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
