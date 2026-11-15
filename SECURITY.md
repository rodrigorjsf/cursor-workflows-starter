# Segurança

## Como reportar

Use o **reporte privado de vulnerabilidades** do GitHub: aba *Security* → *Report a vulnerability*
(<https://github.com/rodrigorjsf/cursor-workflows-starter/security/advisories/new>). Não abra issue pública para
falhas de segurança.

## O que o kit faz na sua máquina

- **As etapas executam tools sem pedir aprovação.** É o padrão das runs locais do Cursor SDK: shell, edição e escrita
  rodam direto, com o seu usuário. O kit limita as tools por etapa (allowlist), mas as etapas que implementam e
  corrigem código recebem todas; o sandbox do SDK (abaixo) limita o que elas alcançam na máquina.
- **Uma etapa já escreveu fora do repositório.** No teste ponta a ponta de 2026-11-11, uma etapa de correção sem
  sandbox editou um arquivo do gerenciador de versões do Node, na pasta pessoal do usuário, para "consertar" o
  ambiente depois de uma falha de teste causada por um shell de login. O arquivo foi revertido. Detalhes em
  [`docs/research/verificacoes-locais.md`](docs/research/verificacoes-locais.md) §9.
  - Desde então, os testes rodam com o ambiente de quem chamou o workflow (`bash -c`), e as etapas que escrevem
    recebem a instrução de não alterar nada fora do repositório. **Essa instrução é só um pedido ao modelo, não uma
    trava.** No reteste, o agente respeitou a instrução e nenhum arquivo fora do repositório mudou. A trava é o sandbox
    do SDK (próximo item), que recusou a escrita fora do repositório na medição de 2026-11-14.
- **O sandbox do SDK foi medido, e o instalador o liga.** Em 2026-11-14, no Linux x64 (WSL2, kernel 6.18), com
  `@cursor/sdk@1.3.1` e `composer-2.5`, uma sonda real (`scripts/verify/verify-sandbox.ts`) rodou uma etapa que escreve, com
  o sandbox ligado, e tentou o que uma etapa que leu texto não confiável poderia fazer. Em quatro runs, **os três foram
  bloqueados**: o `curl` para um host fora da allowlist (`CONNECT tunnel failed, response 403`), um `touch` fora do
  repositório (`Permission denied`) e o `cat ~/.cursor/sdk/auth.json` com `.cursor/sandbox.json` em
  `readBoundary: "workspace"` (`Permission denied`). A tool `edit`, pedida para criar um arquivo fora do repositório, não o criou, e criou um arquivo dentro dele
  (controle), e o host da allowlist respondeu 200. Detalhes em [`docs/research/verificacoes-locais.md`](docs/research/verificacoes-locais.md) §16.
  - **A leitura da chave só é bloqueada com `readBoundary: "workspace"`.** Num run sem essa chave, a mesma etapa leu o
    `~/.cursor/sdk/auth.json` (`cat` saiu com 0). Ligar o sandbox sozinho nega a rede e a escrita fora do repositório, o
    que corta o caminho "ler a chave e mandá-la embora", mas não impede a leitura. O kit não grava esse arquivo por você: ponha `{ "readBoundary": "workspace" }` no
    `.cursor/sandbox.json` do repositório, que foi o arquivo medido, e confira com `wf doctor`, que diz se o `readBoundary` está posto.
    O `~/.cursor/sandbox.json`, que a doc do Cursor diz valer para todos os workspaces, o kit não mediu.
  - **O padrão mudou:** o `~/.cursor-workflows/config.json` que o instalador grava traz `caps.requireSandbox: true`, que liga o
    sandbox em toda etapa, e a instalação que já tinha esse arquivo não muda. No Linux o SDK exige `bubblewrap` ou um
    kernel com Landlock: nesta máquina o sandbox impôs as regras pelo Landlock (`CURSOR_SANDBOX_LANDLOCK_STATUS=fully_enforced`),
    mesmo com o `bwrap` fora do PATH, mas o `wf doctor` falha, nomeando o `bubblewrap`, quando o `bwrap` não está no PATH, porque
    não testa o Landlock. Uma etapa que baixa pacotes falha até você listar os hosts em `.cursor/sandbox.json`.
  - **Não medido:** macOS e Windows, e o `implement-issue` inteiro com o sandbox ligado (a sonda é uma etapa que escreve; veja [#99](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/99)).
- **No WSL, a permissão `0600` não protege a chave de um processo do Windows.** O kit suporta Linux e WSL2
  ([`INSTALL-AGENT.md`](INSTALL-AGENT.md)), mas o Windows alcança a home do Linux por `\\wsl$` como o usuário padrão da
  distribuição ([permissões de arquivo no WSL](https://learn.microsoft.com/en-us/windows/wsl/file-permissions)): um programa do
  Windows lê o `~/.cursor/sdk/auth.json` com as permissões desse usuário, e o `0600` não o segura. Com a interoperabilidade ligada
  (o padrão: `[interop] enabled=true` no `/etc/wsl.conf` da distribuição), uma etapa sem sandbox também pode iniciar programas do
  Windows, o que lhe dá esse caminho. Para um repositório em que você não confia, use uma distribuição WSL separada, com a sua
  própria chave e sem as credenciais da distribuição principal, ou desligue a interoperabilidade nela: ponha `[interop]` e
  `enabled=false` no `/etc/wsl.conf` dela e pare-a pelo Windows (`wsl --terminate <distribuição>`) para valer
  ([configurações de interop](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#interop-settings)). Isso fecha o caminho
  de uma etapa iniciar um programa do Windows; não fecha o de um programa que já roda no seu Windows e lê `\\wsl$`. A verificação
  `host` do `wf doctor` lê `/proc/sys/fs/binfmt_misc/WSLInterop` (e `WSLInterop-late`, o nome que uma distribuição com systemd pode
  ter no lugar dele) e, com a interoperabilidade ligada, avisa (`warn`, sem falhar) e nomeia o `auth.json`; avisa também quando um
  desses arquivos existe e não se lê. Ela nunca muda o `wsl.conf` nem reinicia o WSL.
- **O kit instalado fica numa pasta que uma etapa sem sandbox pode editar.** O `~/.cursor-workflows/kit` tem o motor que aplica
  os tetos, a redação e as allowlists, e é o mesmo código em todo repositório. O `git checkout` de uma tag nova mantém um arquivo
  rastreado editado que as duas tags compartilham, e todo arquivo não rastreado (reproduzido num repositório de teste: saiu com 0),
  e o `npm ci` do instalador lê um `.npmrc` que esteja na pasta. Por isso o `wf upgrade` e o instalador recusam um kit com mudanças
  locais, antes de mover o que for (`the kit at <kit> has local changes: <lista>; reinstall it`), e o `wf doctor` tem a verificação
  `kit`: numa instalação por tag, o HEAD tem de estar exatamente na tag da versão do pacote e a árvore tem de estar limpa. Uma
  instalação de desenvolvimento (um link) é informada, não conferida. O que fazer: [reinstalar o kit](docs/usage/01-instalacao.md#reinstalar-o-kit).
  - **Limite:** a verificação vê o que o git vê, e os arquivos que o `.gitignore` ou o `.git/info/exclude` escondem também
    contam (medido: um `.npmrc` listado no `.git/info/exclude` some do `git status`, e aparece com `--ignored=matching`). Ela não vê
    o que está em `.git/` (hooks, configuração do clone) nem no `node_modules/`, que o `npm ci` refaz. Quem pode escrever no kit
    controla o código que ele roda até a próxima reinstalação: o sandbox das etapas é a proteção, e a verificação é como você fica
    sabendo.
- **O instalador e o `wf upgrade` recusam uma tag que se moveu e uma release que não é imutável.** O kit instala de uma tag
  e roda o que ela contém, então quem move a tag (um token roubado, uma sessão comprometida) faz toda instalação seguinte
  rodar o código dele. Os dois buscam as tags sem `--force` (o git recusa sobrescrever uma tag que mudou na origem: `moved
  upstream`) e leem `releases/tags/<tag>` da API do GitHub, sem token, e só seguem se `immutable` for `true`: uma release
  imutável trava a tag no commit dela. Uma release ausente, uma que não é imutável e uma consulta que falha são erros, não
  um pulo. O `--allow-mutable-tag` pula só a consulta, para um fork instalado com `--repo`. O `INSTALL-AGENT.md` não traz o
  checksum do `install.sh`: um commit não contém o próprio hash, então a âncora é a release imutável. Detalhes em [2.1](docs/usage/01-instalacao.md#tag-movida-e-release-que-não-é-imutável).
- **Nenhum script de instalação de dependência roda, nem na sua máquina nem no CI.** Uma dependência comprometida pode rodar
  código no `npm install`. O `.npmrc` do kit tem `ignore-scripts=true`, e o instalador e o CI passam `--ignore-scripts` mesmo assim,
  porque um `.npmrc` editado ou ausente religaria os scripts. No lockfile só o `esbuild` e o `fsevents` declaram um, e a medição
  (`npm ci --ignore-scripts`, Linux x64, Node 22.23.4) passou o build do dashboard e os testes; macOS não foi medido. No CI, as
  ações ficam fixadas num SHA de commit, o `actions/checkout` não deixa o token do workflow no clone, e o Dependabot espera 7 dias
  antes de propor uma versão nova (ver [9.1](docs/contributing/01-contribuindo.md#antes-de-abrir-um-pr)).
- **Com `settingSources` contendo `"project"` (o default), o repositório alvo roda código na sua máquina:** hooks de
  `.cursor/hooks.json` e de `.claude/settings.json` e servidores MCP de `.cursor/mcp.json`. Não use o default em
  repositórios em que você não confia. O kit não bloqueia isso, mas mostra o que vai rodar: o `wf doctor` avisa (a
  verificação `config` fica em `warn`) e lista os comandos de hook e de servidor MCP desses três arquivos, sem o servidor
  `workflows` do próprio kit, e cada run emite um `warning` com a mesma lista antes da primeira etapa. Para impedir que uma
  etapa os carregue, tire `"project"` de `caps.allowedSettingSources` no `~/.cursor-workflows/config.json`; o instalador o
  deixa na lista.
- **Um agente em laço não abre jobs sem fim.** O `start_workflow` é uma tool que o modelo chama, e cada job gasta. O teto
  global `caps.maxRunningJobs` (padrão 3; `null` o tira) faz o `wf start`, o `start_workflow` e o Start do dashboard
  recusarem um job quando esse tanto já roda no repositório, sem criar o job nem o processo, e recusarem um job que roda o
  mesmo workflow com os mesmos args de um que já roda. É um limite de taxa, não uma barreira: dois inícios no mesmo
  instante, de dois processos, podem passar os dois.
- **Os testes e o `setupCommand` rodam sem os seus segredos.** São código do repositório alvo que um agente acabou de
  escrever. O `implement-issue` os roda sem as variáveis de ambiente cujo nome tem `KEY`, `TOKEN`, `SECRET` ou `PASSWORD`
  (`CURSOR_API_KEY`, `GH_TOKEN`...), as mesmas que o redator do log trata como segredo. O `git` e o CLI do forge (`gh` ou
  `glab`) do workflow não passam por aí e continuam com os tokens: a retirada é por comando.
- **O `wf init` não escreve fora do repositório.** Um repositório clonado pode trazer o `.gitignore`, o `.mcp.json` ou o
  `AGENTS.md` como link simbólico para um arquivo da sua home (um rc do shell, `~/.ssh/authorized_keys`), ou uma pasta como
  `.cursor` apontando para fora (CWE-59). O `wf init` resolve cada caminho, e as pastas no meio dele, antes de ler ou
  escrever, e sai com erro, nomeando o arquivo, se o caminho real cai fora do repositório. Um link para outro arquivo do
  repositório (`AGENTS.md` para `CLAUDE.md`) segue valendo.
- **O `start_workflow` sobe um dashboard local** (um servidor HTTP) quando nada responde na porta dele, a menos que
  `dashboard.autoStart` seja `false` no config global ou `WF_DASH_AUTOSTART=off` esteja no ambiente. Ele escuta só em
  `127.0.0.1`, recusa um `Host` estranho, abre o banco de métricas só para leitura e aceita dois `POST`, o de iniciar um
  workflow e o de cancelar um run, os dois protegidos por token CSRF. O de iniciar só vale para um repositório em que o
  dashboard já viu um run e para um workflow que o runtime lista nele, e exige os dois tetos (`maxTokens` e `maxCents`);
  listar os workflows de um repositório importa os arquivos dele no processo do dashboard, e o Backlog roda o `gh` ou o `glab`
  (com o seu login) na pasta de cada repositório que o dashboard conhece, para listar as issues abertas com a label de
  pronta. Num run cujo processo morreu, o
  `POST` de cancelar chama a API da Cursor com a sua chave para cancelar os cloud agents que o run deixou rodando. Detalhes em
  [5.3 §Segurança do dashboard](docs/operating/03-observabilidade.md#segurança-do-dashboard).
- **Uma etapa na nuvem manda o seu código para fora da máquina.** Com `location: "cloud"` num papel (só vale se o teto
  global `allowedLocations` incluir `cloud`, o que o instalador não faz), o motor empurra um snapshot do worktree,
  **inclusive as mudanças não commitadas**, para uma branch `wf/cloud-snapshot/...` no remote `cloud.remote` (padrão
  `origin`), e a etapa roda numa VM da Cursor a partir dele. O remote precisa ser `https://` ou ssh num host: um
  `http://`, `git://`, `file://`, `ext::` ou caminho local é recusado antes do snapshot, e a credencial embutida numa URL
  (`https://usuario:token@host/...`) é tirada antes de a URL ir para a API da Cursor. Apagar a branch depois não despublica
  os commits: o GitHub os mantém alcançáveis pelo SHA, e os forks também. Por isso, antes de empurrar um snapshot que difere do
  HEAD, o motor (1) o varre atrás de segredos, com a mesma varredura do commit do `implement-issue` (um `.env`, um
  `auth.json`, uma credencial, a chave salva), e recusa se achar; e (2) pergunta ao `gh repo view` se o remote é público, e
  recusa se for `PUBLIC` ou se o `gh` não souber dizer (um remote no GitLab, outro host que não o GitHub, sem rede, sem login). A recusa nomeia
  `cloud.allowPublicRemote`, que só vale no arquivo global: `true` pula a pergunta, nunca a varredura. Um snapshot que é o
  próprio HEAD não é perguntado. O `git push` do snapshot segue com `--no-verify`, e a varredura acima faz o papel de um
  hook como o gitleaks. Uma etapa que não escreve e que o run diz ter empurrado uma branch gera um `warning` que a nomeia.
  Detalhes em [6.2 §Etapas na nuvem](docs/reference/config.md#etapas-na-nuvem).

## Quem recebe os seus dados

O kit não tem telemetria própria: o log de eventos, o journal e as métricas ficam em `.workflows/` e em `~/.cursor-workflows/`, e o
código do kit só abre uma conexão por conta própria no instalador e no `wf upgrade` (a API de releases do GitHub, sem token) e no
dashboard local, para o próprio `127.0.0.1`. O resto sai pelo SDK da Cursor, pelo `git` e pelo `gh` ou `glab`, para quatro
destinatários. A tabela diz o que cada um recebe, de qual etapa e o que governa a retenção e o treino.

| Quem | O que recebe | De qual etapa | O que governa a retenção e o treino |
|---|---|---|---|
| A Cursor e os provedores de modelo para onde ela roteia | O prompt de cada etapa, o código do repositório que a etapa lê, a saída das tools e dos comandos que ela roda (os de teste inclusive) e o texto da issue que o `implement-issue` põe no prompt. Uma chave de API própria não tira o pedido do backend da Cursor | Toda etapa de agente, local ou na nuvem | O Privacy Mode da conta, que o kit não consegue ler e só pede que você confirme, e, para um modelo sem retenção zero (ZDR), o `caps.allowedModels`. Com o modo desligado, a Cursor pode guardar esses dados e treinar com eles. [cursor.com/data-use](https://cursor.com/data-use) e a seção [Privacy Mode](#privacy-mode) |
| As VMs na nuvem da Cursor | Um snapshot do worktree, **com os arquivos não commitados**, numa branch `wf/cloud-snapshot/` do remote `cloud.remote`, de onde a Cursor clona o repositório na VM. A VM guarda o código no disco enquanto o agente está acessível, e a Cursor guarda o histórico da conversa (prompts, respostas e chamadas de tool). O agente tem acesso à internet por padrão | Só a etapa de um papel com `location: "cloud"`, que exige `cloud` no teto global `allowedLocations` (o instalador não o põe) | O Privacy Mode: o modo legado não vale para Cloud Agents e, com o modo desligado, a Cursor coleta os prompts e os ambientes para melhorar o produto. O histórico da conversa fica por tempo indeterminado, a menos que um admin do Enterprise o limite a 90 dias, e o snapshot do ambiente é apagado depois de 30 dias sem uso; a API de apagar um agente tira a conversa, não o snapshot. A saída de rede da VM se restringe no dashboard da Cursor. [Secrets & Network](https://cursor.com/docs/cloud-agent/security-network) |
| O GitHub | A branch `wf/...` e os commits que o `implement-issue` empurra, o pull request, os comentários na issue (as seams, o resumo) e as branches de snapshot `wf/cloud-snapshot/`. Num repositório no GitLab, o servidor do GitLab recebe o mesmo, pelo `glab` | O `implement-issue`: o push e o pull request só com `openPr: true`, e só depois das verificações e da varredura de segredos; o comentário das seams; e o snapshot de uma etapa na nuvem | A visibilidade do repositório e a política do GitHub ([declaração de privacidade](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)). Apagar uma branch não despublica os commits: o GitHub os mantém alcançáveis pelo SHA, e os forks também |
| A telemetria do SDK da Cursor | Eventos de uso autenticados com a sua chave, enviados ao backend da Cursor (`https://api2.cursor.sh`, ou o `CURSOR_BACKEND_URL`): a criação e o fim de cada `Run` do SDK, a latência de um envio, a falha de uma operação (tipo e código do erro, id da requisição), o arranque do executor e, quando o SDK acha um PR aberto para a branch do worktree, o vínculo do PR com a sessão. Cada evento leva a versão do SDK, a plataforma e a arquitetura | Toda etapa de agente: o kit chama o SDK em todas | O kit não achou, no `@cursor/sdk` 1.3.1, uma opção que a desligue, e não mediu o que cada evento leva nem se o Privacy Mode muda isso (lido no pacote em 2026-11-15). Não conte com o contrário sem perguntar à Cursor |

## A chave do Cursor

- `npm run wf -- login` cria uma chave de usuário válida por 90 dias e a grava em texto puro em
  `~/.cursor/sdk/auth.json` (permissão 0600). Qualquer etapa de workflow consegue ler esse arquivo, com o sandbox ligado
  também, a menos que um `sandbox.json` tenha `readBoundary: "workspace"` (medido em 2026-11-14, veja acima).
- **Como a chave nasce e quando expira.** O `wf login` chama o `Cursor.auth.login()` do SDK: você entra no navegador, e a Cursor
  cria uma chave de usuário com nome (o nome que o check `login` do `wf doctor` mostra e que a lista de chaves de API do dashboard
  lista) que **expira em 90 dias** por padrão. O `wf login` imprime o `email` e o `expiresAt`, nunca a chave. Passado o `expiresAt`,
  a chave deixa de valer: o check `login` do `wf doctor` falha, e a dica manda rodar `wf login`.
- **Onde ficam as cópias.** O `~/.cursor/sdk/auth.json` guarda uma chave só, em texto puro (um `wf login` novo o sobrescreve), e a
  `CURSOR_API_KEY` guarda a que você pôs no ambiente: o perfil do shell, o ambiente que abre o IDE, a interpolação do `mcp.json`, um
  secret de CI. O kit mantém a chave só na memória do processo e a redige dos logs; não faz outra cópia.
- **Como rotacionar.** Antes do `expiresAt`, rode `wf login` de novo: ele cria uma chave nova e a grava no `~/.cursor/sdk/auth.json`.
  Troque o valor em cada cópia da `CURSOR_API_KEY` e revogue a chave velha (abaixo): ela continua valendo até expirar ou ser
  revogada, mesmo depois que o arquivo guarda outra.
- **Como revogar.** No dashboard da Cursor, apague a chave na lista de chaves de API (pelo nome que o `wf doctor` mostra); depois
  apague o `~/.cursor/sdk/auth.json` e tire a `CURSOR_API_KEY` do ambiente. O kit não tem um `wf logout`, e apagar o arquivo não
  revoga a chave: ela segue valendo na Cursor. Revogue a chave depois de testar o kit, e imediatamente em caso de suspeita.
- **O teto de gasto.** Os tetos do `config.json` (`maxTokens`, `maxCents`) valem só para os runs que o kit inicia: uma chave
  vazada, usada fora do kit, não passa por eles. O limite de gasto do dashboard da Cursor (*Spending* → limite mensal; um time
  também define um por membro) é o teto que vale para ela, então defina um. A doc da Cursor não diz se o limite por membro conta o
  uso do SDK ([5.1](docs/operating/01-governanca-e-custos.md#orçamento-por-usuário)): confirme com o admin.
- O `implement-issue` bloqueia a entrega (`status: "secret-blocked"`, sem commit, push nem PR) se o diff staged tiver
  um arquivo `auth.json`, `.env` ou `.env.*`, uma credencial num dos formatos que o redator do log conhece (chaves
  `crsr_` e `sk-`, tokens do GitHub, GitLab, AWS, npm, Slack, Google e Stripe, blocos de chave privada), a própria chave salva
  ou o valor de uma variável de ambiente com nome de segredo. Isso fecha o caminho
  "issue com prompt injection → etapa copia a chave → PR público", mas não impede a leitura da chave nem o vazamento por
  outro caminho que não seja o diff. O sandbox ligado, que é o padrão do instalador, nega a rede e a escrita fora do
  repositório.
- O log de eventos, o journal e o memo de um run escondem a chave salva pelo `wf login` mesmo quando nenhuma chave foi
  passada ao run e a `CURSOR_API_KEY` não está no ambiente: o motor lê o `~/.cursor/sdk/auth.json` que o SDK lê e põe a chave
  entre os valores que o redator troca por `[REDACTED]`.
- O texto que o modelo escreve para um PR ou um comentário (resumo, risco, seams) não leva dado embora por um link: uma
  imagem Markdown, uma tag HTML ou uma URL para um host que não é o do forge aparece como código, com o `https` quebrado por
  um espaço de largura zero, porque o navegador de quem abre a página busca a imagem e uma query string carrega o que o
  modelo leu. Um link para o `github.com` (no GitLab, `gitlab.com`) continua clicável.

## Privacy Mode

- **Com o Privacy Mode desligado, a Cursor pode guardar o que cada etapa manda e treinar com isso.** Cada etapa envia à Cursor o
  código do repositório, o prompt e a saída dos comandos que ela roda, e o SDK segue as mesmas regras de Privacy Mode do IDE. Com
  o modo desligado, a página de uso de dados da Cursor diz que ela pode guardar e usar código, prompts e ações do editor para
  melhorar os modelos; com ele ligado, diz que não treina com os seus dados, mas que um prompt que dispare um detector de abuso
  pode ser guardado para investigação ([cursor.com/data-use](https://cursor.com/data-use)).
- **O kit não consegue ler o modo, só pedir que você o confirme.** O SDK fixado (1.3.1) não tem uma chamada pública para isso:
  o `Cursor.me()` não devolve o campo, e usar um export interno do SDK seria depender do que a Cursor pode mudar sem aviso. Por isso o
  [`INSTALL-AGENT.md`](INSTALL-AGENT.md) manda o agente que instala parar e perguntar se o Privacy Mode está ligado (em
  *Cursor Settings → General*, numa conta individual, ou imposto pelo admin do time) e só seguir depois da resposta, e a
  verificação `login` do `wf doctor` repete o lembrete sempre que passa. Nenhum dos dois confere o modo: quem responde é você.
- **Modelos sem retenção zero e a sua própria chave de API ficam fora dessa garantia.** Quando a retenção importa, o
  `caps.allowedModels` do `~/.cursor-workflows/config.json` (o instalador grava `null`, que libera todo modelo) deve listar só os
  modelos que a sua conta mostra como de retenção zero de dados (ZDR). O raciocínio está em
  [5.1 §Políticas de admin que se aplicam](docs/operating/01-governanca-e-custos.md#políticas-de-admin-que-se-aplicam).

## O token do GitHub

- **Qualquer etapa sem sandbox lê o token do `gh`.** O kit chama o `gh` com o login que você guardou nele: o `implement-issue`
  lê a issue e abre o pull request, e o dashboard lista o Backlog e consulta o estado de um PR. Uma etapa que rode fora do
  sandbox pode ler esse token (`gh auth token`) e usar tudo o que ele permite. Com o sandbox ligado, o kit só mediu a leitura
  do `~/.cursor/sdk/auth.json` (veja acima), não a do token do `gh`.
- **O que um vazamento expõe depende dos escopos do token.** Os que o kit não precisa e que fazem mais estrago:
  - `admin:public_key` e `write:public_key` cadastram uma chave SSH na sua conta. Ela mantém acesso de escrita a todo
    repositório em que você escreve e **continua valendo depois que o token é revogado**. `admin:ssh_signing_key`,
    `write:ssh_signing_key`, `admin:gpg_key` e `write:gpg_key` cadastram chaves que assinam commits como você.
  - `workflow` cria e altera os arquivos do GitHub Actions: reescrever o CI roda código com os segredos dele.
  - `delete_repo` apaga os repositórios que você administra; `admin:org` e `admin:repo_hook` mexem na organização e nos
    webhooks dos repositórios.
  Fontes: [escopos de OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps) e [gerenciar
  tokens de acesso pessoal](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
- **O `wf doctor` avisa, e não falha.** Quando o forge do repositório é o GitHub (um `origin` no GitHub, ou um `origin` sem host, que o kit trata como GitHub), depois de `gh auth status`, o check `forge`
  roda `gh api -i --silent user` e lê só o cabeçalho `X-OAuth-Scopes`, que um token clássico devolve. Se ele lista algum dos
  escopos acima, o check sai com `status: "warn"` (o `ok` do relatório continua `true` e o código de saída, 0), nomeia os
  escopos e diz como tirá-los: `gh auth refresh --remove-scopes <escopos>`. O doctor não lê, não imprime nem registra o
  token; só os escopos. Um token fine-grained não devolve esse cabeçalho, então o doctor não vê as permissões dele: com
  `GH_TOKEN` no ambiente e sem o cabeçalho, o check passa e diz que há um token com escopo em uso. O doctor também não lê o token do `glab`.
- **O token recomendado é um fine-grained, de um repositório só.** Crie-o em *Settings → Developer settings → Personal access
  tokens → Fine-grained tokens*, com acesso só ao repositório alvo, as permissões **Contents**, **Pull requests** e
  **Issues** em leitura e escrita, **Metadata** em leitura e **uma data de expiração**. Ponha-o em `GH_TOKEN` (num host do GitHub Enterprise Server, em `GH_ENTERPRISE_TOKEN`) no ambiente que
  abre o IDE e o terminal: o `gh` o usa no lugar do login guardado
  ([`gh help environment`](https://cli.github.com/manual/gh_help_environment)). Sem a permissão **Workflows**, o push de um
  commit que altera um arquivo de `.github/workflows/` é recusado, o que é o desejado.

## Nunca versione

`.workflows/`, `metrics-export/`, bancos `*.db` (incluindo `~/.cursor-workflows/metrics.db`), `auth.json`,
`CURSOR_API_KEY` e outras chaves, `.env*`, e exports feitos com `--no-anonymize`. O `.gitignore` cobre os arquivos;
variáveis de ambiente e saídas de comando coladas em issues são responsabilidade de quem cola.
