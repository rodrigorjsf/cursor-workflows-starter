# Segurança

## Como reportar

Use o **reporte privado de vulnerabilidades** do GitHub: aba *Security* → *Report a vulnerability*
(<https://github.com/rodrigorjsf/cursor-workflows-starter/security/advisories/new>). Não abra issue pública para
falhas de segurança.

## O que o kit faz na sua máquina

- **As etapas executam tools sem pedir aprovação.** É o padrão das runs locais do Cursor SDK: shell, edição e escrita
  rodam direto, com o seu usuário. O kit limita as tools por etapa (allowlist), mas as etapas que implementam e
  corrigem código recebem todas.
- **Uma etapa já escreveu fora do repositório.** No teste ponta a ponta de 2026-11-11, uma etapa de correção sem
  sandbox editou um arquivo do gerenciador de versões do Node, na pasta pessoal do usuário, para "consertar" o
  ambiente depois de uma falha de teste causada por um shell de login. O arquivo foi revertido. Detalhes em
  [`docs/research/verificacoes-locais.md`](docs/research/verificacoes-locais.md) §9.
  - Desde então, os testes rodam com o ambiente de quem chamou o workflow (`bash -c`), e as etapas que escrevem
    recebem a instrução de não alterar nada fora do repositório. **Essa instrução é só um pedido ao modelo, não uma
    trava.** No reteste, o agente respeitou a instrução e nenhum arquivo fora do repositório mudou.
- **O sandbox do SDK (`sandbox: true`) não foi testado neste kit.** Pela doc do SDK, ele restringe as chamadas de
  shell (escrita só no diretório de trabalho, em temporários e nos caminhos do `sandbox.json`; rede negada fora da
  allowlist), **não restringe leitura**, e a doc não diz se cobre as tools de edição. No Linux exige `bubblewrap`.
- **Com `settingSources` contendo `"project"` (o default), o repositório alvo roda código na sua máquina:** hooks de
  `.cursor/hooks.json` e de `.claude/settings.json` e servidores MCP de `.cursor/mcp.json`. Não use o default em
  repositórios em que você não confia.
- **O `start_workflow` sobe um dashboard local** (um servidor HTTP) quando nada responde na porta dele, a menos que
  `dashboard.autoStart` seja `false` no config global ou `WF_DASH_AUTOSTART=off` esteja no ambiente. Ele escuta só em
  `127.0.0.1`, recusa um `Host` estranho, abre o banco de métricas só para leitura e aceita um único `POST`, o de cancelar
  um run, protegido por token CSRF. Num run cujo processo morreu, esse `POST` chama a API da Cursor com a sua chave para
  cancelar os cloud agents que o run deixou rodando. Detalhes em
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
  `~/.cursor/sdk/auth.json` (permissão 0600). Qualquer etapa de workflow consegue ler esse arquivo, mesmo com o
  sandbox ligado.
- O `implement-issue` bloqueia a entrega (`status: "secret-blocked"`, sem commit, push nem PR) se o diff staged tiver
  um arquivo `auth.json`, `.env` ou `.env.*`, uma credencial num dos formatos que o redator do log conhece (chaves
  `crsr_` e `sk-`, tokens do GitHub, GitLab, AWS, npm, Slack, Google e Stripe, blocos de chave privada), a própria chave salva
  ou o valor de uma variável de ambiente com nome de segredo. Isso fecha o caminho
  "issue com prompt injection → etapa copia a chave → PR público", mas não impede outros vazamentos (por exemplo,
  rede).
- **Revogue a chave no dashboard do Cursor** depois de testar o kit, e imediatamente em caso de suspeita.

## Nunca versione

`.workflows/`, `metrics-export/`, bancos `*.db` (incluindo `~/.cursor-workflows/metrics.db`), `auth.json`,
`CURSOR_API_KEY` e outras chaves, `.env*`, e exports feitos com `--no-anonymize`. O `.gitignore` cobre os arquivos;
variáveis de ambiente e saídas de comando coladas em issues são responsabilidade de quem cola.
