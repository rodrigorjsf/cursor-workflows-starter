# Cursor Workflows Starter Kit

> English summary: [README.en.md](README.en.md).

Esqueleto de repositório para criar **workflows de agentes determinísticos** sobre o
[Cursor SDK](https://cursor.com/docs/sdk/typescript) (`@cursor/sdk`). Os workflows podem ser invocados do **chat do
Cursor IDE** (via MCP), do **terminal** e de **CI** (via CLI).

Um workflow é um arquivo TypeScript em que **o código decide** a ordem das etapas, os ramos, os laços, o modelo de
cada etapa, quando revisar e quando parar. Cada etapa é um agente do Cursor com uma tarefa pequena e uma saída
validada por schema. Assim, modelos menores executam bem a maior parte do trabalho, e o fluxo termina por completo
ou falha de forma explícita, nunca "pula" uma etapa em silêncio.

A ideia é a mesma dos *dynamic workflows* do Claude Code (`agent`, `parallel`, `pipeline`, `phase`), trazida para o
Cursor, que não tem esse runtime nativo. O porquê e a comparação completa estão em
[`docs/research/relatorio-pesquisa.md`](docs/research/relatorio-pesquisa.md).

> **Status: pré-release 0.2.0 (2026-11-11).** Verificado contra a API real num único ambiente: plano **Premium** da
> The X Subscription, `@cursor/sdk@1.3.1`, Linux x64 (WSL2). Evidência completa em
> [`docs/research/verificacoes-locais.md`](docs/research/verificacoes-locais.md).
>
> - **Plano:** no Free o SDK não roda (`plan_required` já no `Agent.create`); no Premium, sim. Outros planos não
>   foram testados.
> - **Medido:** login sem navegador local; catálogo de modelos; saída estruturada; o que `settingSources` carrega
>   (`AGENTS.md`, hooks do Cursor e do Claude Code, `.cursor/mcp.json`); guarda contra recursão; cache entre agentes;
>   tokens por tipo; dashboard só em localhost; Claude Code lista as tools MCP e lê `CLAUDE.md` → `@AGENTS.md`.
> - **Ponta a ponta:** caminhos **LOW** e **MED** do `implement-issue` (TDD fatia a fatia conferido pelo código,
>   review em três eixos, PR no template; no MED, seams aprovadas em dois runs e fatias além do teto adiadas):
>   339 mil tokens no LOW e 769 mil no MED (issue inteira, dois runs), resume sem repetir etapas (§13 das
>   verificações). O HIGH ("Design it
>   twice") e o review que bloqueia só têm testes offline.
> - **Custo:** nesta conta o `getUsage()` do SDK responde `feature_unavailable` para agentes locais, então o kit não
>   lê o custo real: o teto em centavos fica cego e só o de tokens protege.
> - **Incidente:** num teste anterior, uma etapa sem sandbox editou um arquivo fora do repositório. Foi corrigido e
>   retestado, mas leia [SECURITY.md](SECURITY.md) antes de usar.
> - **Pendente:** Cursor IDE (MCP, skills, `/run-workflow`), sandbox, caminho HIGH, hooks do time e MDM,
>   políticas de admin, macOS e Windows. Lista completa no §12 das verificações.
> - 79 testes offline (SDK falso), rodados no Node 22.13.0 e no 22.23.4.

## Estrutura

```
.
├── AGENTS.md               # instruções dos agentes (Cursor, etapas dos workflows, Codex)
├── CLAUDE.md               # só `@AGENTS.md`, para o Claude Code ler as mesmas instruções
├── src/
│   ├── runtime/
│   │   ├── workflow.ts     # tipos públicos + defineWorkflow()
│   │   ├── engine.ts       # agent/parallel/pipeline/phase, retries, modelo, teto de custo
│   │   ├── structured.ts   # saída estruturada via custom tool submit_result + Ajv
│   │   ├── journal.ts      # resume sem repetir etapas concluídas
│   │   ├── jobs.ts         # execução assíncrona com estado em disco (start/wait)
│   │   ├── registry.ts     # descobre workflows/*.ts
│   │   └── nested-mcp-guard.mjs  # servidor MCP sem tools que barra workflow dentro de etapa
│   ├── observability/      # banco SQLite de métricas, recorder, consultas, dashboard localhost
│   ├── cli.ts              # wf login | whoami | models | list | run | start | wait | status | jobs | stats | metrics
│   └── mcp-server.ts       # tools MCP: list_workflows, start_workflow, wait_workflow, get_workflow_status
├── workflows/
│   ├── implement-issue.ts  # exemplo: TDD fatia a fatia conferido pelo código → review em 3 eixos → PR com evidência
│   └── implement-issue/    # prompts (paráfrases das skills de mattpocock/skills), laço TDD, review, corpo do PR
├── test/                   # testes offline (fake SDK)
├── .agents/                # local neutro (Cursor e Codex leem nativamente)
│   ├── skills/
│   │   ├── run-workflow/       # /run-workflow <nome> <args>: dispara e acompanha
│   │   ├── cursor-workflow-authoring/ # referência para escrever workflows
│   │   └── skill-to-workflow/  # /skill-to-workflow: converte skills e subagents em workflow
│   └── workflows/          # workflows do repositório (carregados junto com workflows/)
├── .cursor/mcp.json        # MCP server no Cursor
├── .mcp.json               # o mesmo MCP server no Claude Code
├── scripts/
│   ├── link-claude-skills.sh   # expõe .agents/skills ao Claude Code (que não lê .agents/)
│   ├── probe-sdk.ts            # sonda o SDK contra a API real (eventos, uso, custo)
│   └── verify/                 # workflows e scripts que reproduzem as verificações
├── SECURITY.md · PROVENANCE.md · CHANGELOG.md
└── docs/
```

## Começo rápido

Requisitos: Node 22.13 ou mais novo, um plano pago do Cursor (no Free o SDK não roda), `git` e `gh` autenticado.

```bash
npm ci
npm test && npm run typecheck
npm run wf -- login          # login do Cursor no navegador; o uso fica na SUA conta (NO_OPEN_BROWSER=1 imprime a URL)
npm run models               # IDs de modelo liberados para você
# primeiro run real: num repositório de teste (com commit e remote GitHub), com tetos baixos
npm run wf -- run implement-issue --cwd /caminho/do/repo-de-teste --args '{"issue":1}' --max-cents 100 --max-tokens 300000
npm run stats                # custo, tokens, eficiência (banco ~/.cursor-workflows/metrics.db)
npm run dash                 # dashboard em http://127.0.0.1:4317
```

Defina sempre os dois tetos. O de centavos depende do custo que o Cursor informa, e pode ficar cego; os dois são
checados antes de cada etapa, então uma etapa sozinha pode passar do teto ([02 §3](docs/02-configuracao-inicial.md#3-teto-de-custo)).
Para reproduzir as medições numa conta sua, use [`scripts/verify/`](scripts/verify/README.md).

**Ainda não testado:** no Cursor IDE, habilite o MCP server `workflows` em **Customize**, na barra lateral
([DOC](https://cursor.com/docs/mcp), acesso em 2026-11-11). No Enterprise, o admin pode precisar liberar o servidor
antes ([01 §6](docs/01-instalacao.md#6-habilitar-no-cursor-ide)). Depois, digite no chat:

```
/run-workflow implement-issue 123
```

## Documentação

| Documento | Conteúdo |
|---|---|
| [01 · Instalação](docs/01-instalacao.md) | Requisitos, dependências, instalação, teste de fumaça |
| [02 · Configuração inicial](docs/02-configuracao-inicial.md) | Autenticação (conta do usuário × service account), modelos, teto de custo, variáveis |
| [03 · Arquitetura](docs/03-arquitetura.md) | Como o runtime funciona e o que ele garante (e o que não garante) |
| [04 · Invocação no Cursor IDE](docs/04-invocacao-no-cursor-ide.md) | MCP, CLI, skill, hooks; paridade com o Claude Code |
| [05 · Escrevendo workflows](docs/05-escrevendo-workflows.md) | O porquê das regras, efeitos garantidos × pedidos, receitas, prompts de etapa, testes (API e regras na skill `cursor-workflow-authoring`) |
| [06 · Convertendo skills e subagents](docs/06-convertendo-skills-e-subagents.md) | O processo da skill `/skill-to-workflow`, com um exemplo |
| [07 · Governança e custos (Enterprise)](docs/07-governanca-e-custos.md) | Orçamento por usuário, políticas de admin, auditoria, riscos |
| [08 · Custos, cache e boas práticas](docs/08-custos-e-cache.md) | De onde vem o custo, que caches existem (e quem controla), memo, contexto mínimo, prefixo estável, checklist |
| [09 · Observabilidade](docs/09-observabilidade.md) | Banco SQLite por usuário, o que é medido (e o que não dá), views, receitas SQL, dashboard localhost, export, privacidade |
| [Relatório de pesquisa](docs/research/relatorio-pesquisa.md) | Por que o kit existe: Workflow do Claude Code × Cursor SDK, autenticação e cobrança, paridade |
| [Verificações locais](docs/research/verificacoes-locais.md) | O que foi testado contra a doc ao vivo e a API real, com evidência, e o que ficou pendente |
| [Segurança](SECURITY.md) · [Proveniência](PROVENANCE.md) · [Mudanças](CHANGELOG.md) | Riscos e como reportar; de onde o kit veio; o que mudou em cada versão |
| [Contribuindo](CONTRIBUTING.md) | Testes antes do PR e a política de custo dos testes contra a API real |

## Transparência: o que este kit faz por baixo

- Cada etapa cria um **agente local** do Cursor SDK na sua máquina. A inferência roda nos servidores da Cursor e é
  cobrada na conta da chave usada.
- Os agentes **executam tools sem pedir aprovação** (é o padrão das runs locais do SDK) e podem escrever fora do
  repositório: isso já aconteceu num teste ([SECURITY.md](SECURITY.md)). O kit limita as tools por etapa, pede às
  etapas que não saiam do repositório e bloqueia commits com segredos. Leia [07 · Governança](docs/07-governanca-e-custos.md)
  antes de usar em um repositório sensível.
- O estado fica em `.workflows/` (journal, jobs, logs, worktrees) do repositório onde o workflow roda. O runtime
  o adiciona a `.git/info/exclude`, sem mexer no `.gitignore` do repositório.
- Cada run grava métricas (tokens, custo, modelo, passos, resultado) em `~/.cursor-workflows/metrics.db`. Os prompts
  ficam só como hash. Desligue com `WF_METRICS=off` (ver [09](docs/09-observabilidade.md)).
- Por padrão, os agentes das etapas carregam `AGENTS.md`, regras, skills, hooks e MCP do projeto, e hooks do time
  e Enterprise (`settingSources: ["project","team","mdm"]`). No `implement-issue`, as etapas só de leitura usam
  `[]`: nada disso chega a elas, nem os hooks do time e do MDM. Uma guarda evita que uma etapa dispare outro workflow
  por acidente; ela não é uma fronteira de segurança.
- Commit, push, PR e comentário na issue são feitos pelo **código do workflow**, com `git` e `gh`. O
  `implement-issue` sempre faz o commit local na branch `wf/issue-<n>`; push e PR, só com `openPr: true`. Em issues
  MED e HIGH, o primeiro run comenta as seams propostas na issue, com ou sem `openPr`.
