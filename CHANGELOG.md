# Changelog

## Não lançado

### Adicionado

- **Dashboard: o app, o quadro (Board) e `ctx.card`.** A página inicial do dashboard passa a ser um app em React com três
  menus, Runs, Board e Metrics (o painel de métricas de antes, no menu Metrics). O app é empacotado com o esbuild quando o
  dashboard sobe, guardado por hash do conteúdo em `~/.cursor-workflows/dashboard-cache/` e servido pelo próprio
  dashboard: sem CDN, sem passo de build, com a política de conteúdo `script-src 'self'`. O Board tem um quadro por
  workflow, com as fases do workflow (agora declaradas no `run-start`, campo `phases`) e as colunas Awaiting approval, Done,
  Failed e Cancelled, e um cartão por run, que muda de coluna sozinho enquanto o run anda (`GET /api/board`). Um workflow
  decide o que o cartão mostra com `ctx.card({ title, subtitle, links, badges })` (novo evento `card`; o quadro mostra o
  último de cada run). O `implement-issue` põe o cartão no ar depois da triagem, com `#<n> <título>` e o tier, e o atualiza
  na entrega, com a branch e o link da PR; o link da PR mostra se ela está aberta, mesclada ou fechada, perguntado ao `gh` em
  segundo plano e guardado em cache (o quadro nunca espera pelo GitHub). `GET /api/runs` traz agora `phases`, `outcome` e
  `card` de cada run, e o servidor só relê o log de um run quando ele cresceu. O pacote do dashboard ganha as dependências
  `react`, `react-dom` e `esbuild`; o runtime não ganha nenhuma.
- **Dashboard local: servidor, API de runs e início automático.** O dashboard agora é o pacote `packages/dashboard/`
  (`@cursor-workflows/dashboard`), separado do runtime: as dependências dele nunca entram nele, e ele só importa do runtime
  `@cursor-workflows/runtime/observe`. É um só por usuário, para os runs de todos os repositórios: `GET /api/runs` lista os
  runs do índice global (`~/.cursor-workflows/runs.jsonl`) com o status lido do log de eventos de cada um, `GET
  /api/runs/<runId>` traz a projeção de um run (linhas de andamento, resultado, tokens) e `/api/summary` mantém o resumo
  de métricas. Um run sem `run-end` e sem processo segurando o lock aparece como `failed`, com o comando para retomar.
  Ele sobe numa máquina sem histórico (antes saía com `banco de métricas não encontrado`): sem índice de runs e sem banco
  a API devolve listas vazias, e o banco passa a ser lido assim que o primeiro run o cria. Escuta só em `127.0.0.1`, recusa
  `Host` que não seja `127.0.0.1` ou `localhost`, aceita só `GET` e `HEAD`. O `start_workflow` inicia o dashboard
  destacado quando nada responde na porta (`WF_DASH_PORT`, padrão 4317; um só processo, mesmo com chamadas simultâneas;
  pid em `~/.cursor-workflows/dashboard.pid`, saída em `dashboard.log`) e devolve `dashboardUrl`
  (`http://127.0.0.1:<porta>`, o endereço que o navegador do Windows alcança quando o kit roda no WSL2); se não consegue
  subir, devolve `dashboardWarning` com o motivo e o job começa do mesmo jeito. `dashboard.autoStart: false` no arquivo
  global de configuração, ou `WF_DASH_AUTOSTART=off`, desliga o início (um `dashboard` no arquivo do repositório é
  violação e não tem efeito). A skill `run-workflow` abre o `dashboardUrl` no navegador embutido do Cursor. `npm run dash`
  continua iniciando o dashboard à mão. O processo do dashboard não carrega o `@cursor/sdk` (o `reconcile` das métricas o
  importa só quando roda): 86 MB de memória em vez de 315 MB, e a subida cai de 0,7 s para 0,1 s no import.
- **Dashboard: stream de eventos ao vivo e conteúdo das etapas.** `GET /api/runs/<runId>/events` é um stream de
  Server-Sent Events do log do run: reenvia o que já está no log e depois cada evento que o run acrescenta, cada um com o
  número da linha dele no log como `id`. O `Last-Event-ID` (o `EventSource` reconecta com ele sozinho) ou `?lastEventId=`
  retoma de onde o cliente parou, sem lacuna e sem repetição, mesmo se a retenção reescreveu o log nesse meio-tempo;
  `?content=false` deixa o conteúdo das etapas de fora e `?stepId=` deixa só os eventos de uma etapa (o log ao vivo de uma
  etapa é o conteúdo dela mais um stream aberto a partir do `lastEventId` que ele devolve). Uma linha só sai quando está
  completa, e as linhas danificadas ou em branco só gastam o número delas. Eventos de outra versão do esquema ou de tipo
  desconhecido passam sem alteração.
  `GET /api/runs/<runId>/steps/<stepId>/content` devolve o conteúdo de uma etapa (prompt, mensagens do agente, chamadas de
  tool e saída de comandos, como o log os guardou, já sem segredos) e o `id` da última linha lida, para abrir o stream a
  partir dele. Um log que a projeção não consegue ler derrubava `GET /api/runs` inteiro com `500`; agora só aquele run
  aparece como `missing`, com o motivo. O runtime expõe `tailRun` e `readStepContent` em
  `@cursor-workflows/runtime/observe`.
- **Dashboard: o run como grafo ao vivo.** `http://127.0.0.1:<porta>/runs/<runId>` desenha o run como um grafo que cresce
  enquanto os eventos chegam: as etapas de agente e os comandos de `ctx.exec` são nós, ligados pelo `parentId`; um `parallel`
  ou `pipeline` abre num nó e fecha num círculo; cada fase é uma raia. Um nó em andamento pisca, e passar o mouse mostra o
  modelo, onde rodou, as tentativas, os tokens, o custo, a duração e o tipo do erro. Um run que terminou pode ser refeito
  evento a evento (**Replay**, de 1× a 20×, com pausa e barra de posição). O grafo vem só dos eventos (React Flow para
  desenhar, elkjs para o layout), tolera eventos de outra versão do esquema e de tipo desconhecido, e um run que parou com
  um nó em andamento o mostra como interrompido. O app é empacotado pelo próprio dashboard com o `esbuild` quando ele sobe e
  servido da memória (`/assets/run-<hash>.js`), sem CDN e sob uma política de conteúdo que só permite scripts e conexões da
  própria origem. As bibliotecas do app são dependências do pacote do dashboard, nunca do runtime.
- **`wf gc`: limpa o que os runs do `implement-issue` deixam.** Cada run tem o seu worktree, a sua branch local e, depois
  do push, a sua branch no origin, e nada as removia. `wf gc` lista o que vai remover e remove: o worktree, a branch
  local e a branch do origin de um run cujo PR foi mergeado ou fechado, e os de um run que falhou há mais de
  `gcFailedAfterDays` dias (novo ajuste do `implement-issue`, padrão 14; falhou é terminar com erro ou com um status de
  falha, ou o processo cair sem terminar, e um run cancelado não conta). `wf gc --dry-run` só imprime o plano. Nunca toca
  num run que um processo está executando (o lock do run decide, e é tomado também durante a remoção), numa branch fora de
  `wf/`, num caminho fora de `.workflows/worktrees/`, nem num commit do origin que o run não empurrou; a branch do
  origin de um run que falhou também fica se o PR dela está aberto (apagar fecharia o PR). Uma branch `wf/` do origin que
  nenhum run deste repositório possui (o run foi feito em outro clone) sai quando o PR dela foi mergeado ou fechado; sem
  PR, ou com o PR aberto, fica. Para um run que falhou, o plano avisa o que se perde com ele: arquivos não commitados no
  worktree e commits que não estão em nenhum remoto. O estado do run em `.workflows/runs/<runId>/` (log, journal) fica. Se o `gh` não diz o que houve com um PR, o run fica e o comando sai
  com 1. A branch fixa `wf/issue-<n>` que todos os runs de uma issue usavam antes desta
  mudança sai, com o worktree `.workflows/worktrees/wf-issue-<n>`, quando o PR dela foi mergeado ou fechado e nenhum
  processo executa um desses runs antigos; até lá, aparece como mantida. A saída é um JSON em stdout (`remove`, `kept`, `errors`), e o plano
  vai antes para o stderr.
- **Ajustes de um workflow na configuração, e os limites do `implement-issue` entre eles.** Um workflow declara seus
  ajustes e os padrões em `meta.settings`, lê o resultado em `ctx.settings`, e os arquivos de configuração (global,
  depois o do repositório) os trocam em `workflows.<nome>.settings`; um nome que o workflow não declara é erro, com o
  caminho do campo. O `run-start` e o `wf config show` trazem os ajustes em vigor (`config.settings`) e a origem de
  cada um. O `implement-issue` declara oito: `sliceCaps` (fatias por tier, padrão LOW 1, MED 3, HIGH 5), `extraSlices`
  (2), `fixRounds` (2), `redGreenAttempts` (2), `maxDiffChars` (40000), `labelTiers` (o mapa label → tier),
  `maxStepCrashes` (2) e `gcFailedAfterDays` (14, do `wf gc`). O esquema os valida e a referência da configuração (`docs/reference/config.md`, regerada por
  `npm run docs:config`) os documenta.
- **`revertOnRetry` em `agent()`.** Antes de cada nova tentativa de uma etapa que escreve, o motor põe o `cwd` de volta
  como estava no começo da etapa (o mesmo desfazer do cancelamento). Opt-in: o desfazer restaura o diretório inteiro,
  então só vale para uma etapa que escreve num diretório só dela. O `step-end` da tentativa que falhou leva
  `reverted: true`.
- **`ctx.exec`: comandos do workflow assíncronos, com tempo limite e registrados.** `ctx.exec(comando, args, { label,
  timeoutMs, cwd, env })` roda o comando em um processo assíncrono (o job continua respondendo a status e cancelamento
  durante um teste longo), o mata no `timeoutMs` (`SIGTERM` ao grupo de processos, `SIGKILL` dois segundos depois) e
  devolve `{ ok, exitCode, timedOut, tail, error? }`. O padrão do tempo vem da configuração: `workflows.<nome>.execTimeoutMs`
  (600000 sem ela), que o `run-start` registra. A saída vai para o log de eventos enquanto o comando roda (eventos
  `content` `command-output`, com `stream`), com a redação e a retenção do conteúdo de um agente, e cada chamada é um nó
  do run (`exec-start`/`exec-end`, com `stepId`, `parentId` e `groupId`). O cancelamento mata o comando e o que ele
  iniciou. A skill de autoria documenta o `ctx.exec`, e um teste do repositório reprova chamadas síncronas
  (`execFileSync`, `execSync`, `spawnSync`) em arquivos de workflow. O próprio motor também deixa de rodar `git`
  síncrono: o estado do repositório que o memo lê a cada etapa e a identidade do repositório no `run-start` vêm de um
  `git` assíncrono, com teto de tempo (um git que não responde a tempo desliga o memo da etapa, não trava o processo).
- **Workflow `smoke` e o assistente de validação no Cursor IDE.** O `smoke` é uma etapa estruturada no `composer-2.5`,
  sem tools e sem contexto do projeto, com teto de 50 mil tokens (medido: 21.628): prova chat → MCP → SDK → resultado
  estruturado sem pagar um `implement-issue`. O `scripts/verify/validate-cursor-ide.sh` conduz os seis cenários de
  validação: cria o repositório descartável (reaproveitando o `setup-sandbox-repo.sh`), roda `wf init` e `wf doctor`
  nele, diz o que digitar no chat, registra o que a pessoa viu (e sobrevive ao reinício do Cursor do cenário 5) e
  escreve `validation-report.json`, com caminhos e nomes de repositório anonimizados. Mostra o corpo da issue e só a
  abre depois da confirmação. O `redaction` do log de eventos passa a cobrir também o formato `crsr_` da chave do Cursor.
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
  `wf config show [workflow]` imprime os três. `start_workflow` aceita `overrides` que só apertam. O teto
  `requireSandbox: true` liga o sandbox do SDK em toda etapa, mesmo que o código do workflow o desligue. A referência
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
- **Instalador do kit, `wf upgrade` e o guia para agentes.** O `scripts/install.sh --tag vX.Y.Z` clona o kit na tag em
  `~/.cursor-workflows/kit`, instala as dependências (`npm ci`), escreve o comando `wf` em `~/.local/bin`, liga as skills
  do kit em `~/.claude/skills/` (que o Cursor também lê) por links simbólicos e grava a configuração global padrão
  (`templates/global-config.json`: 3.000.000 de tokens e 500 centavos por run, 600.000 tokens por etapa, simultaneidade 4,
  só etapas locais) se o arquivo não existir. Para antes de instalar se o Node for mais antigo que o `engines.node`, e não
  toca numa pasta de skill, num link ou num `wf` que seja do usuário. `--dev` faz do kit instalado um link para a cópia de
  trabalho (sem `npm ci`, que esvaziaria o `node_modules` dela, nem num `--refresh` depois), e `--refresh` refaz dependências, comando, links e
  configuração para o kit que já está no lugar. O `wf upgrade` busca as tags, leva o kit instalado à release mais nova
  (pré-lançamentos não contam) e roda o `install.sh --refresh` dessa tag: uma skill nova ganha link e o link de uma skill
  que saiu é removido. Ele recusa uma instalação de desenvolvimento, um `wf` que roda de outra pasta e a falta de rede, sem
  mexer no kit. O `INSTALL-AGENT.md`, público, em inglês e fixado na tag do pacote, conduz um agente da instalação ao
  `wf init` e ao `wf doctor` sem outro documento; o `npm test` reprova se a tag dele, a dos READMEs e a do capítulo 2.1
  divergirem da versão do pacote. A nova skill `cursor-workflows-setup` cobre init, doctor, upgrade, a validação no Cursor
  IDE e a configuração. A dica do `wf doctor` para um kit mais antigo que a faixa passa a citar o `wf upgrade`, e a de
  dependências ausentes cita o guia. A linha de uso do `wf` passa a listar `models`, que já existia. O capítulo 2.1 e os
  READMEs passam a descrever esse fluxo.
- **O estado do runtime funciona em worktree ligado e submódulo**, onde `.git` é um arquivo: antes, qualquer acesso a
  `.workflows/` falhava com `ENOTDIR`.

### Mudado

- **O teto de tempo dos testes do `implement-issue` sai dos args do run.** `testTimeoutSec` passa a ser só um ajuste
  (`workflows.implement-issue.settings.testTimeoutSec`, padrão 600), como os outros limites: um run que ainda o passe
  como arg é recusado com `invalid args`. Os ajustes de um workflow só vêm dos arquivos de configuração (ADR-0001).

- **Um resume não refaz, vazios, o worktree e a branch que alguém removeu.** Se nem o worktree nem a branch do run
  existem mais (o `wf gc`, ou a mão, os removeu) e o run já tinha fatias, o resume falha dizendo isso e mandando começar um
  run novo. Antes ele criava o worktree de novo a partir do commit-base, dava as fatias por prontas, entregava uma árvore
  vazia e a empurrava por cima do trabalho no origin (o lease do push é o do próprio run). Um run que falhou antes da
  primeira fatia continua podendo ser retomado: não havia nada a perder.
- **O `implement-issue` fica robusto contra três falhas e tem limites configuráveis.**
  - **O tier vem da label mais alta.** Com `complexity:low` e `complexity:high` na mesma issue, vale HIGH, em qualquer
    ordem das labels; antes valia a primeira que casava, e a ordem podia rebaixar uma issue difícil. Uma label com o
    nome de um membro de `Object.prototype` (`constructor`) deixa de ser lida como um tier.
  - **Um laço de quedas para.** Quando um resume encontra uma etapa de escrita em andamento (o processo caiu no meio
    dela), soma uma queda a essa etapa; passado o limite (`maxStepCrashes`, 2), o run encerra com
    `status: "step-crash-loop"` e o id da etapa, em vez de retomá-la de novo. A contagem fica no progresso do run, então
    o resume seguinte também para; subir o limite na configuração libera. Um cancelamento no meio da etapa não conta.
    Antes, o contador existia no progresso e nunca era lido nem incrementado.
  - **Toda nova tentativa de uma etapa de escrita parte de uma árvore limpa.** O worktree volta ao estado de antes da
    etapa antes de cada nova tentativa (`revertOnRetry`), não só antes da falha final: antes, o que a tentativa que
    falhou deixou (um arquivo novo, uma edição pela metade) estava lá na seguinte e podia ir para o commit. O desfazer
    do resume (`revertTo`) também apaga os arquivos novos que ninguém pôs no índice, que o `read-tree` deixava.
  - **Limites em `workflows.implement-issue.settings`**: tetos de fatias por tier, fatias extras, rodadas de correção,
    tentativas de red e green, tamanho do diff, mapa label → tier, limite de quedas e os tetos de tempo dos testes
    (`testTimeoutSec`) e dos comandos de rede (`networkTimeoutSec`). A lista e os padrões estão em
    [`docs/reference/config.md`](docs/reference/config.md#ajustes-de-um-workflow).
- **O `implement-issue` roda `git`, `gh` e os testes por `ctx.exec`.** Nenhum comando dele trava mais o processo: o
  status e o cancelamento respondem durante uma suíte, e cancelar mata o comando na hora. Cada suíte do laço TDD
  (`suite:baseline`, `suite:red:1`, `suite:green:1`, `suite:final`…) e cada chamada de `git` e `gh` é um nó de comando
  no log do run, com a saída da suíte ao lado. O `git push` e todo `gh` têm teto de tempo (ajuste
  `networkTimeoutSec`, 120 s): um push que espera credencial, ou uma conexão parada, falha a etapa com
  `git push … timed out after Ns`, e o resume entrega. O `git` local segue o `execTimeoutMs` do workflow (10 minutos
  por padrão); o `wf gc` pergunta o estado do PR no `--repo` em que o run entregou. Um erro do `gh` na busca
  do PR existente (autenticação, rede) passa a falhar o run com a mensagem dele; antes virava "não há PR" e o
  workflow tentava criar outro. As respostas do `git` e do `gh` que o workflow lê (diffs, listas de arquivos, a issue
  e seus comentários) vêm inteiras, não do `tail` de 32768 caracteres do `ctx.exec`: a trava de segredos continua
  vendo o diff todo. Essa saída (dados que o código lê, como um diff ou o JSON da issue) não vai para o log de eventos,
  que mostra o comando, o `stderr` e o resultado; a saída das suítes, do `git push` e do `git commit` vai. O `runTests` agora é assíncrono e não devolve mais `overflow`, porque a saída não passa por um
  buffer. Uma suíte morta por um sinal (o OOM killer, por exemplo) deixa de contar como red: o run para com
  `tests-killed`, em vez de pedir a um agente que "faça passar" um runner que caiu.
- **O `implement-issue` entrega com segurança e pode rodar várias vezes na mesma issue.** Cada run tem a sua branch
  (`wf/issue-<n>-<run>`, antes a fixa `wf/issue-<n>`) e o seu worktree (`.workflows/worktrees/wf-issue-<n>-<run>`),
  registrados no progresso do run; um run novo parte da cabeça atual da branch padrão (a que o `origin/HEAD` aponta, ou
  a branch em uso; a cópia local, não a do origin: rode `git pull` antes para partir do que está lá) e nunca reaproveita
  o worktree de outro run. Um worktree no lugar do run que ele não criou falha o run, sem apagar nada; um caminho que o próprio run
  registrou e que não é um worktree (um `git worktree add` interrompido) é refeito. Como a branch é do run, um segundo
  run na mesma issue, depois do primeiro, abre um PR novo na sua branch. Um run começado antes desta mudança retoma na
  branch e no worktree antigos. Uma issue tem no máximo um run ativo: o segundo run volta
  `status: "issue-locked"` com o `activeRunId` do que está ativo, sem branch, worktree nem agente (o lock é o arquivo
  `.workflows/locks/issue-<n>.lock`, do mesmo tipo do `run.lock`, com um hash do `--repo` no nome quando o run o
  passa, porque a issue #5 de outro repositório é outra issue; o de um processo que morreu é retomado). A entrega
  empurra com `--force-with-lease`, só em branch `wf/`: o resume depois de o PR existir refaz o commit e entrega por
  cima, em vez de falhar com non-fast-forward. Se a branch no origin tem um commit que o run não empurrou (alguém
  empurrou uma correção), o run volta `status: "push-refused"` e não sobrescreve nada; o trabalho fica no worktree. Um run que entregou antes
  desta mudança não tem a lista do que empurrou: para ele, o commit do origin é seu quando o repositório o tem, o único pai
  é a base do run e a mensagem é a da entrega.
- **A execução do agente fica atrás de uma interface, o `AgentBackend`.** O motor deixa de falar com o SDK: cada
  tentativa de uma etapa vai a `AgentBackend.run(prompt, opções resolvidas, sinal de aborto, callback de eventos)`, que
  devolve o resultado da tentativa. A execução local (criar o agente, enviar, esperar, entregar o resultado estruturado,
  ler o uso, descartar) é o backend local, com o comportamento de antes: os testes do motor, da observabilidade e do
  `implement-issue` passam sem mudança. Os tetos de tokens ao vivo, o `timeoutMs` e o cancelamento do run chegam ao
  backend como o aborto do sinal da tentativa, com o motivo em `signal.reason`. `RunOptions.backend` troca o backend
  (os testes usam). A interface é a de [3.1](docs/internals/01-arquitetura.md#o-agentbackend-quem-roda-a-tentativa) e o
  backend de nuvem ([ADR-0005](docs/adr/0005-cloud-backend-and-location-cap.md)) entra por ela.
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
