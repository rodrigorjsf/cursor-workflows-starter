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
- **Tetos de tokens ao vivo, por etapa e por run.** A cada turno de uma etapa (`turn-ended`), o motor compara os
  tokens com o `maxTokensPerStep` da etapa (todas as tentativas dela somadas) e com o `maxTokens` do run (o gasto do log,
  resumes inclusive, mais os turnos em andamento). Passou de um dos dois: o run do agente é cancelado na hora e a
  tentativa falha com o novo `errorKind: "budget"`, sem nova tentativa. A etapa que passa do próprio teto falha
  sozinha; o teto do run cancela todas as etapas ativas, nenhuma etapa nova começa e o run termina com
  `Teto de tokens atingido`, depois de as etapas canceladas fecharem a conta. A ultrapassagem é de no máximo um turno
  por etapa ativa. Antes, um teto só era checado antes de cada tentativa.
- **Configuração em camadas, com tetos globais e papéis.** Dois arquivos JSON, validados por um esquema que vai com o
  kit (`packages/runtime/schema/config.schema.json`): o global (`~/.cursor-workflows/config.json`, com os tetos
  rígidos `caps`) e o do repositório (`.agents/workflows/config.json`). Precedência: código < global < repositório <
  ambiente < flag < override do chat; depois os tetos globais limitam tudo (números: o menor; listas: a interseção), e
  o repositório e o chat só podem apertá-los (o que tenta afrouxar vira violação e não tem efeito). Os workflows
  declaram **papéis** em `meta.roles` (`implement-issue`: `classify`, `implement.low|med|high`, `review`, `fix`,
  `design`, `pr-text`), e a configuração define por papel o modelo (com `params`), o tempo, as tentativas e as camadas
  de configuração, com globs de label como alternativa. `null` desliga um limite, chave ausente herda. A configuração
  é lida de novo a cada run; o `run-start` grava a configuração efetiva, a origem de cada valor e as violações;
  `wf config show [workflow]` imprime os três. `start_workflow` aceita `overrides` que só apertam. A referência
  (`docs/reference/config.md`) é gerada do esquema (`npm run docs:config`), e o `npm test` falha se ela divergir.
- **Jobs destacados, com heartbeat.** `start_workflow` passa a iniciar cada run em um processo destacado (o mesmo que
  `wf start` já usava): reiniciar o Cursor ou o servidor MCP não o interrompe, e o servidor novo o encontra pelos
  arquivos do job. O processo do job atualiza um heartbeat no registro a cada 5 s, por uma thread própria, então uma
  chamada síncrona longa (uma suíte de testes) não o atrasa. Um job cujo processo morreu, ou cujo heartbeat está parado
  há mais de 30 s, aparece como `failed` com o `runId` para retomar. `overrides` do chat chegam ao processo pela flag
  `--overrides` de `wf run`/`wf start` (só apertam).
- **Cancelamento.** A nova tool MCP `cancel_workflow` e o comando `wf cancel <jobId>` mandam `SIGTERM` ao processo do
  job (só se a linha de comando dele leva o id do job); `SIGINT` e `SIGTERM` no processo do run fazem o mesmo, e um
  segundo sinal sai na hora. O motor cancela os agentes ativos, **desfaz a etapa que estava escrevendo** (os arquivos que
  o git não ignora e o índice voltam, byte a byte, ao estado de antes da etapa; commits e arquivos fora do diretório
  dela não), grava `run-end` com `status: cancelled` e solta o lock. O job passa a ter o status `cancelled`, o run
  continua retomável (`resumeRunId`) e o gasto da tentativa cancelada fica no orçamento. `wf run` sai com 130 quando o
  run é cancelado. A skill `run-workflow` documenta o cancelamento e só o usa a pedido do usuário. Em `outcome_class`
  do banco de métricas, o run cancelado é `cancelled`.
- **Tempo das etapas.** A criação do agente e o envio passam a ter o `timeoutMs` da tentativa (antes só a espera pelo
  resultado tinha), e os re-prompts de schema dividem o tempo da tentativa em vez de reiniciá-lo.
- **`wf init` grava os arquivos do kit no repositório alvo.** Num repositório novo, ele cria o `.cursor/mcp.json`
  (aponta para o kit por usuário em `${userHome}/.cursor-workflows/kit`, sem `WF_MAX_*`), o `.mcp.json` do Claude Code
  (`${HOME}`), o `.agents/workflows/config.json` com `$schema` e a faixa de versão do kit, a linha `.workflows/` no
  `.gitignore` e um bloco de quatro linhas no `AGENTS.md` (criado se preciso). Imprime o diff do que mudou e não faz
  commit. Rodar de novo não muda nada; os outros servidores de um `mcp.json` existente ficam; `--no-agents-md` pula o
  bloco e `--remove` o tira. Como o Claude Code lê o `CLAUDE.md` e não o `AGENTS.md`, o comando avisa no stderr quando o
  `CLAUDE.md` não importa o `AGENTS.md` (não o edita). O `templates/agents-md-block.md` ganhou o link para o guia de instalação. O endereço
  `$schema` do esquema passou a ser o da URL bruta (`raw.githubusercontent.com`): a da página do GitHub devolve HTML, que
  o editor não lê.
- **`wf doctor` confere o ambiente que o IDE usa.** Roda oito verificações, cada falha com a dica de como corrigir:
  o `node` do PATH (o que o IDE usa para iniciar o servidor, mínimo 22.13), as dependências do kit (o comando do
  `mcp.json`), o login no SDK, os modelos da configuração contra o catálogo da conta, o `gh`, o servidor MCP (ele é
  iniciado como o IDE o inicia e precisa responder `tools/list`), a configuração e a versão do kit (a do `wf` e a que
  cada servidor MCP diz ser). O `node` segue o `env.PATH` da entrada do `mcp.json`, quando ela define um. Num Node
  antigo demais para carregar o kit, o próprio `wf doctor` ainda entrega o relatório, só com a falha do Node. O relatório
  passa pela redação de segredos dos logs. Sai com 1 quando alguma falha e, com `--json`, imprime o relatório em JSON. O `wf doctor`, o `wf run`, o `wf start` e o
  `start_workflow` recusam um kit fora da faixa semver que o `kit` do `.agents/workflows/config.json` declara, com a
  versão do kit, a faixa e o que fazer; um `kit` que não é uma faixa semver também é recusado. A dependência `semver`
  entra no pacote do runtime.
- **O estado do runtime funciona em worktree ligado e submódulo**, onde `.git` é um arquivo: antes, qualquer acesso a
  `.workflows/` falhava com `ENOTDIR`.

### Mudado

- **`WF_METRICS_STORE_PROMPTS` foi removida.** O banco de métricas nunca mais guarda o texto de um prompt (só hash e
  tamanho); o texto fica no log de eventos local. O evento `step-start` perdeu o campo `prompt`. A coluna
  `attempts.prompt_text` continua no esquema, sempre vazia, e a migração 3 do banco apaga o texto que versões antigas
  gravaram com a opção.
- **`WF_MODEL_*` agora é por papel e mantém os `params`.** `WF_MODEL_REVIEW=grok-5` troca só o ID; `id[param=valor]`
  troca também os `params`. `WF_MODEL_LOW`, `MED` e `HIGH` seguem valendo como apelidos de `implement.low|med|high`. As
  etapas de correção e de plano/desenho são os papéis `fix` e `design`: não seguem mais `WF_MODEL_MED` nem
  `WF_MODEL_HIGH`. `WF_MAX_CENTS` e `WF_MAX_TOKENS` passam a ser a camada de ambiente da configuração (um valor inválido
  é erro, em vez de ignorado), e o servidor MCP não os lê mais no início.
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

- **O README vira um hub enxuto e a Parte 1 do livro conta a visão.** O `README.md` traz o problema, a ideia, um
  diagrama de visão geral, o começo rápido, a tabela "O que você leva" e links para o livro; o `README.en.md` o espelha em
  inglês. A Parte 1 ganha três capítulos: [1.1 · O problema](docs/vision/01-o-problema.md), [1.2 · A ideia e as
  referências](docs/vision/02-a-ideia-e-as-referencias.md) (que absorve o antigo `PROVENANCE.md` e o `CREDITS.md`, agora
  removidos) e [1.3 · Conceitos](docs/vision/03-conceitos.md). A seção de transparência do README foi para
  [5.1](docs/operating/01-governanca-e-custos.md#transparência-o-que-o-kit-faz-por-baixo), e a árvore do repositório
  para [9.1](docs/contributing/01-contribuindo.md#onde-fica-cada-coisa).
- **Cinco ADRs, em inglês, na Parte 7** ([7.1](docs/adr/0001-layered-config-with-hard-caps.md) a
  [7.5](docs/adr/0005-cloud-backend-and-location-cap.md)): configuração em camadas com tetos globais, o log de eventos
  como fonte da verdade, jobs destacados, workspaces com o `CLAUDE.md` canônico, e o backend de nuvem com o teto de
  location. Como registrar um novo: [9.2](docs/contributing/02-convencoes-do-livro.md#adrs).
- **A referência de eventos (6.1) tira o número e o rodapé do índice do livro**, em vez de uma cópia fixa no gerador:
  inserir um capítulo ao redor dela não exige mais editar `scripts/events-reference.ts`.

## 0.2.0 (pré-release, 2026-11-11)

### Mudado

- **`implement-issue` segue as skills `tdd`, `codebase-design`, `code-review` e `pr`** de
  [mattpocock/skills](https://github.com/mattpocock/skills) 1.3.1 (MIT; créditos em [1.2 · A ideia e as referências](docs/vision/02-a-ideia-e-as-referencias.md#créditos)):
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
