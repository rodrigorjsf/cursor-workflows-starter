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
- **Com `settingSources` contendo `"project"` (o default), o repositório alvo roda código na sua máquina:** hooks de
  `.cursor/hooks.json` e de `.claude/settings.json` e servidores MCP de `.cursor/mcp.json`. Não use o default em
  repositórios em que você não confia.
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
  (`https://usuario:token@host/...`) é tirada antes de a URL ir para a API da Cursor. Detalhes em
  [6.2 §Etapas na nuvem](docs/reference/config.md#etapas-na-nuvem).

## A chave do Cursor

- `npm run wf -- login` cria uma chave de usuário válida por 90 dias e a grava em texto puro em
  `~/.cursor/sdk/auth.json` (permissão 0600). Qualquer etapa de workflow consegue ler esse arquivo, com o sandbox ligado
  também, a menos que um `sandbox.json` tenha `readBoundary: "workspace"` (medido em 2026-11-14, veja acima).
- O `implement-issue` bloqueia a entrega (`status: "secret-blocked"`, sem commit, push nem PR) se o diff staged tiver
  um arquivo `auth.json`, `.env` ou `.env.*`, uma credencial num dos formatos que o redator do log conhece (chaves
  `crsr_` e `sk-`, tokens do GitHub, GitLab, AWS, npm, Slack, Google e Stripe, blocos de chave privada), a própria chave salva
  ou o valor de uma variável de ambiente com nome de segredo. Isso fecha o caminho
  "issue com prompt injection → etapa copia a chave → PR público", mas não impede a leitura da chave nem o vazamento por
  outro caminho que não seja o diff. O sandbox ligado, que é o padrão do instalador, nega a rede e a escrita fora do
  repositório.
- **Revogue a chave no dashboard do Cursor** depois de testar o kit, e imediatamente em caso de suspeita.

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
- **O `wf doctor` avisa, e não falha.** Num repositório com `origin` no GitHub, depois de `gh auth status`, o check `forge`
  roda `gh api -i --silent user` e lê só o cabeçalho `X-OAuth-Scopes`, que um token clássico devolve. Se ele lista algum dos
  escopos acima, o check sai com `status: "warn"` (o `ok` do relatório continua `true` e o código de saída, 0), nomeia os
  escopos e diz como tirá-los: `gh auth refresh --remove-scopes <escopos>`. O doctor não lê, não imprime nem registra o
  token; só os escopos. Um token fine-grained não devolve esse cabeçalho, então o doctor não vê as permissões dele: com
  `GH_TOKEN` no ambiente e sem o cabeçalho, o check passa e diz que há um token com escopo em uso. O doctor também não lê o token do `glab`.
- **O token recomendado é um fine-grained, de um repositório só.** Crie-o em *Settings → Developer settings → Personal access
  tokens → Fine-grained tokens*, com acesso só ao repositório alvo, as permissões **Contents**, **Pull requests** e
  **Issues** em leitura e escrita, **Metadata** em leitura e **uma data de expiração**. Ponha-o em `GH_TOKEN` no ambiente que
  abre o IDE e o terminal: o `gh` o usa no lugar do login guardado
  ([`gh help environment`](https://cli.github.com/manual/gh_help_environment)). Sem a permissão **Workflows**, o push de um
  commit que altera um arquivo de `.github/workflows/` é recusado, o que é o desejado.

## Nunca versione

`.workflows/`, `metrics-export/`, bancos `*.db` (incluindo `~/.cursor-workflows/metrics.db`), `auth.json`,
`CURSOR_API_KEY` e outras chaves, `.env*`, e exports feitos com `--no-anonymize`. O `.gitignore` cobre os arquivos;
variáveis de ambiente e saídas de comando coladas em issues são responsabilidade de quem cola.
