# Changelog

## Não lançado

### Adicionado

- **Log de eventos por run como fonte de verdade.** Todo evento é acrescentado a `.workflows/runs/<runId>/events.jsonl`
  com versão do esquema, horário e id do run. As etapas levam `stepId`, `parentId` e `groupId`, e `parallel`/`pipeline`
  emitem `group-start`/`group-end`: a estrutura do run se refaz só com o log. Etapas servidas do journal ou do memo
  também emitem `step-start`. A referência dos eventos (`docs/reference/events.md`) é gerada do tipo
  (`npm run docs:events`), e o `npm test` falha se ela divergir.
- **Runs mais robustos.** Uma última linha incompleta no log ou no journal não impede o resume; um lock por run recusa
  a segunda execução do mesmo `runId` (`já está em execução`); todo arquivo de estado é gravado de forma atômica;
  retomar um run cujo workflow mudou grava um aviso; cada run novo entra no índice global
  `~/.cursor-workflows/runs.jsonl` (`WF_HOME` muda o diretório do usuário).
- **O estado de um job é projetado do log de eventos.** O registro do job (`.workflows/jobs/<jobId>.json`) guarda só id
  do job, id do run, pid e heartbeat. `wf status`, `wf jobs`, `get_workflow_status` e `wait_workflow` calculam status,
  fase, gasto, resultado e as últimas linhas (`recent`) do log a cada leitura: não há arquivo de estado para ficar pela
  metade, e as linhas são resumos de uma linha, nunca texto de prompt ou de saída. O `run-end` passa a levar o `result`,
  e o `run-start`, o `jobId`. Um processo que cai com exceção não tratada fecha o run no log como `failed`.
- **O conteúdo das etapas fica só no log de eventos local.** Prompts, o que o agente disse, chamadas de tool e saída de
  comandos entram no log como eventos `content` (cortados em 32768 caracteres), nunca no banco de métricas, nos exports
  dele, nos ouvintes de `onEvent` nem em `recent`. Formatos conhecidos de segredo e o valor das variáveis de ambiente com
  `KEY`, `TOKEN`, `SECRET` ou `PASSWORD` no nome são trocados por `[REDACTED]` antes de qualquer gravação. Ao iniciar um
  run, o texto dos runs do repositório fora dos 30 mais recentes ou com mais de 14 dias é apagado (`RunOptions.retention`
  muda os limites); os metadados ficam.
- **O orçamento acumula entre resumes.** O gasto (centavos e tokens) é recomposto do log do run, tentativas que falharam
  inclusive, e um resume com `--max-cents`/`--max-tokens` define o novo teto total. Uma tentativa que morreu no meio da
  etapa conta os tokens dos turnos que terminou (o custo em centavos dela nunca chegou ao log).
- **O estado do runtime funciona em worktree ligado e submódulo**, onde `.git` é um arquivo: antes, qualquer acesso a
  `.workflows/` falhava com `ENOTDIR`.

### Mudado

- **`WF_METRICS_STORE_PROMPTS` foi removida.** O banco de métricas nunca mais guarda o texto de um prompt (só hash e
  tamanho); o texto fica no log de eventos local. O evento `step-start` perdeu o campo `prompt`. A coluna
  `attempts.prompt_text` continua no esquema, sempre vazia, e a migração 3 do banco apaga o texto que versões antigas
  gravaram com a opção.
- **O repositório vira npm workspaces.** O runtime (engine, CLI, servidor MCP, workflows embutidos e seus testes
  offline) fica no pacote `packages/runtime/` (`@cursor-workflows/runtime`) e resolve seus assets pelo local de
  instalação, nunca pela raiz do repositório. As skills distribuídas (`run-workflow`, `cursor-workflow-authoring`,
  `skill-to-workflow`) passam para `skills/`, em inglês, e `.agents/skills/` aponta para elas por links simbólicos.
  `templates/agents-md-block.md` guarda as regras para repositórios-alvo. `npm run wf`, `mcp`, `dash`, `stats`,
  `typecheck` e `npm test` seguem iguais na raiz.
- **As skills distribuídas são autossuficientes.** Cada uma carrega em `references/` tudo o que instrui (API do
  runtime, regras, receitas, checklist de custo, observabilidade, testes, onde cada harness procura cada coisa), sem
  apontar para `docs/`, `scripts/` nem para outra skill; as referências que duas skills dividem são cópias idênticas,
  e o `npm test` confere. A `skill-to-workflow` troca `ORIGEM.md` por `references/origin-cases.md`.
- **`CLAUDE.md` é o guia canônico do mantenedor, em inglês, e `AGENTS.md` é um link simbólico para ele.** As regras do
  antigo `AGENTS.md` foram divididas: as de manutenção ficam em `CLAUDE.md`, as de repositórios-alvo em
  `templates/agents-md-block.md`.
- **A documentação vira um livro.** [`docs/README.md`](docs/README.md) é o índice, com a ordem de leitura e por onde
  cada perfil (usuário, autor de workflows, mantenedor) começa. Os nove capítulos foram para a pasta da sua parte
  (`usage/`, `internals/`, `authoring/`, `operating/`), e eles e os dois relatórios de pesquisa passam a ser numerados
  `parte.posição` (o antigo "04" é o 2.3), cada um com um rodapé de anterior/próximo. Medições datadas e citações
  `[DOC]` ficam como estavam; mudaram só os caminhos e as referências cruzadas. O `CONTRIBUTING.md` virou a seção
  `docs/contributing/`, com as convenções do livro, as dos diagramas e a tabela de scripts do mantenedor.
- **O `npm test` confere a documentação.** `scripts/check-docs.ts` (`npm run docs:check`) falha em link relativo
  quebrado, âncora quebrada, capítulo fora do índice, H1 diferente do índice e rodapé errado. O CI ganha o job
  `mermaid` (`npm run docs:mermaid`), que renderiza todo bloco Mermaid e reprova em erro de sintaxe. Todo script de
  `scripts/` tem um cabeçalho WHAT/WHY/WHEN/HOW, e `.claude/rules/diagrams.md` aponta o Claude Code para as
  convenções de diagramas nos arquivos `*.md`.

## 0.2.0 (pré-release, 2026-11-11)

### Mudado

- **`implement-issue` segue as skills `tdd`, `codebase-design`, `code-review` e `pr`** de
  [mattpocock/skills](https://github.com/mattpocock/skills) 1.3.1 (MIT; créditos em [`CREDITS.md`](CREDITS.md)):
  TDD fatia a fatia com red e green conferidos pelo código; seams aprovadas em dois runs em MED e HIGH
  (`seams-proposed` e `approveSeams`); "Design it twice" no HIGH; review sempre, em três eixos paralelos
  (Standards, Spec e Segurança); corpo do PR no template Summary / Evidence / Merge Danger, com a saída real dos
  testes. Novo status de resultado `pending` nas métricas para checkpoints.
- **Skill `workflow-authoring` renomeada para `cursor-workflow-authoring`.** O Claude Code tem uma skill embutida
  com o nome antigo, e a do projeto a substituía.
- **Skills reescritas** pela referência `writing-for-agents` (mattpocock/skills): critério de pronto em cada passo,
  regras sem duplicar `docs/08`, e os casos de origem da `/skill-to-workflow` num arquivo à parte (`ORIGEM.md`). A
  `/run-workflow` trata qualquer checkpoint (resultado com `next`), separa as falhas pela causa e cobre o resume pelo
  CLI.
- **`run-workflow` passa a ser invocável pelo modelo.** Como só do usuário, ela não travava nada: um pedido em prosa
  chegava a `start_workflow` sem passar pela skill. A trava de um workflow pago é a aprovação de `start_workflow`
  (fora da allowlist), descrita em `docs/04` §3.
- **Etapa red descarta o que não é teste.** No run real da issue #7, o `composer-2.5` implementou junto com o teste
  nas duas tentativas e o run parou em `tdd-violation`. Agora o código descarta a mudança fora dos testes e confere
  o red só com o teste; `tdd-violation` e `test-not-red` trazem o motivo em `reason`.
- **Logs do SDK fora do stdout do CLI.** O SDK escreve linhas `INFO` por `console.log`, que sujavam o JSON do `wf run`;
  o desvio para o stderr, que só o servidor MCP tinha, virou um módulo comum.
- **O planejador recebe o teto de fatias do tier.** Na issue #8 ele propôs 5 fatias para um tier de 3, e o PR saiu
  parcial; na #11, com o teto no prompt, 2 fatias cobriram a issue inteira.
- **Comentário das seams marca as fatias adiadas** pelo teto do tier, e a Evidence do PR começa numa linha inteira
  (os dois vistos nos runs reais).
- **`approveSeams` sem plano proposto** no progresso do run (outro `runId` ou outro `--cwd`) para com
  `seams-not-proposed`, em vez de aprovar um plano recalculado que ninguém viu.
- **Teto padrão por workflow:** `budget` na definição vale quando o run não informa `--max-tokens`/`--max-cents`;
  o `implement-issue` declara 3 milhões de tokens.

### Verificado

- Caminhos LOW e MED contra a API real ([PR #9](https://github.com/rodrigorjsf/wf-sandbox/pull/9),
  [PR #10](https://github.com/rodrigorjsf/wf-sandbox/pull/10) e [PR #12](https://github.com/rodrigorjsf/wf-sandbox/pull/12)
  no `wf-sandbox`): 339 mil tokens no LOW e 769 mil no MED, dentro das estimativas; resume sem refazer etapas; nada escrito fora do repositório (`docs/research/verificacoes-locais.md` §13).

### Corrigido

- Revisão adversarial do novo `implement-issue` (24 agentes, 20 achados confirmados), cada correção com teste de
  regressão em `test/implement-issue.hardening.test.ts`: o green não pode mover o teste red, reconfigurar o runner
  nem esconder edições com `skip-worktree`; o red não apaga testes; etapa que falha ou é interrompida é desfeita; o
  resume não refaz review, não recalcula o plano aprovado e não zera a branch; a suíte roda de novo antes do commit;
  commits de agentes são desfeitos antes da trava de segredos, que passa a olhar também o comentário e o corpo do PR;
  os testes têm teto de tempo.

## 0.1.0 (pré-release, 2026-11-11)

Primeira publicação. Base: o kit do estudo no commit
[`a69f2a2`](https://github.com/rodrigorjsf/ai-study-library/commit/a69f2a21a78b7d5689fb21b6ed3c89d6890019db) do
ai-study-library, mais as correções da verificação local contra a documentação ao vivo e a API real. A evidência de
cada item está em [`docs/research/verificacoes-locais.md`](docs/research/verificacoes-locais.md).

### Corrigido

- **Guarda contra recursão não funcionava.** O SDK sobe os servidores do `.cursor/mcp.json` sem repassar o ambiente
  do processo, e uma etapa via `start_workflow`. O engine agora registra um servidor MCP inline `workflows`, sem
  tools, que substitui o do projeto dentro das etapas (§7).
- **Teto de custo cego em uso incluído no plano.** O teto somava só `chargedCents`, que é 0 nesse caso. Agora soma o
  maior entre `rawCostCents` e `chargedCents`, e `chargedCents` aparece à parte (§3).
- **Tetos cegos quando `getUsage()` falha.** Em agentes locais, o `getUsage()` respondeu `403 feature_unavailable`
  mesmo num plano pago. Os tokens passam a vir dos eventos `turn-ended`, e o engine avisa que o custo ficou
  desconhecido (§5).
- **Fórmulas de tokens.** Medido na API: `inputTokens` já inclui leitura e escrita de cache, e
  `totalTokens = input + output`. `prompt_tokens`, `cacheHitRatio` e a estimativa de custo foram corrigidos (§5, §6).
- **`npm run models` quebrado** (`tsx -e` com `await` no topo). Virou o comando `wf models` (§4).
- **Modelos default inexistentes ou fora da franquia.** `auto-low` não existe e `gpt-5.3-codex` exige crédito
  pré-pago no Premium. Defaults: `composer-2.5` (classificar, LOW), `grok-4.7` (MED) e `grok-4.7` com
  `reasoning_effort=high` (HIGH, review) (§5, §6).
- **Testes rodavam num shell de login** (`bash -lc`), que trocava o PATH de quem chamou; isso levou uma etapa de
  correção a editar um arquivo fora do repositório. Agora `bash -c` (§9).
- **Node 22.13 a 22.19:** consultas com parâmetros numerados (`?1`) quebravam `npm test`, `stats` e o dashboard.
- **Comentários e docs:** `RunResult.model` devolve o ID resolvido, e não o pedido; `settingSources` é opt-in para
  `AGENTS.md`, hooks e MCP; 74 afirmações conferidas na doc ao vivo, com 3 refutadas e 38 parciais corrigidas (§11).

### Adicionado

- `plan_required` encerra o run na primeira tentativa, com mensagem clara (o plano Free bloqueia o SDK, §4).
- Trava de segredos no `implement-issue`: diff staged com `auth.json`, `.env*`, chave `crsr_`/`sk-` ou a chave salva
  bloqueia a entrega (`status: "secret-blocked"`).
- Regra de escopo nas instruções das etapas que escrevem (pedido ao modelo, não uma trava).
- Checagem da versão do Node na inicialização do CLI e do servidor MCP.
- `resolvedModel` no `step-end` e no banco (schema v2, com migração); a estimativa de custo usa o modelo resolvido.
- `scripts/probe-sdk.ts` e `scripts/verify/` (workflows de verificação, repositório de teste e repositório do
  ponta a ponta) para reproduzir as medições.
- `WF_MAX_TOKENS` nos `mcp.json` de exemplo; `WF_MCP_SERVER_NAME`.
- `zod` `^4.6.7` (GHSA-mrhx-c7xc-m3w5).
- CI (Node 22.13.0 e 22.x), `SECURITY.md`, `PROVENANCE.md`, `.gitattributes` com LF.

### Verificado contra a API real

Plano Premium da The X Subscription, `@cursor/sdk@1.3.1`, Linux x64 (WSL2): login sem navegador local, modelos,
saída estruturada, contexto do projeto por `settingSources`, hooks do Cursor e do Claude Code nas etapas, guarda
contra recursão, cache entre agentes, e o caminho LOW do `implement-issue` de ponta a ponta (commit, PR e resume
sem repetir), a partir desta árvore. O Claude Code lista as tools do servidor MCP e lê `CLAUDE.md` → `@AGENTS.md`.

### Pendente

Não executado; detalhes e como testar em `docs/research/verificacoes-locais.md` §12:

- Cursor IDE: habilitar o MCP, listar as skills, `/run-workflow` no chat e o timeout de tool MCP.
- Dashboard no navegador do Windows; `scripts/link-claude-skills.sh` no Cursor.
- Sandbox (`sandbox: true`, exige bubblewrap no Linux).
- Caminhos MED e HIGH do `implement-issue` (plano, review), e o `grok-4.7` com `reasoning_effort=high`.
- Re-prompt de schema pelo engine contra a API real.
- Hooks do time e MDM e de `~/.claude/settings.json`; políticas de admin, limite em dólares por membro e chaves Team
  Admin (sem acesso de admin); o erro do teto mensal de uso.
- Reconfirmar `getUsage()` em agentes locais: a Cursor libera conta por conta, e nesta deu `feature_unavailable`;
  quando liberar, o teto em centavos e o `wf metrics reconcile` passam a funcionar.
- Faixa de contexto do Haiku 5.5 (modelo de terceiros exige crédito no Premium); macOS e Windows nativo; limites de
  concorrência.
