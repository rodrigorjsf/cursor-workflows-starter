# 2.1 · Instalação

## 1. Requisitos

| Item | Versão | Por quê |
|---|---|---|
| Node.js | **≥ 22.13** | Exigência do `@cursor/sdk` (`engines.node`; [DOC](https://cursor.com/docs/sdk/typescript#runtime-support), acesso em 2026-11-11) |
| Sistema | Testado só em Linux x64 (WSL2). macOS (arm64/x64), Linux arm64 e Windows x64 têm binários do SDK, mas o kit não foi testado neles. No Windows nativo, o `implement-issue` precisa de `bash` (roda os testes com `bash -c`) | O SDK traz binários por plataforma como dependências opcionais (`@cursor/sdk-<os>-<arch>`). Ambiente dos testes: [8.2 §1](../research/verificacoes-locais.md) |
| Conta Cursor | Plano pago com acesso ao SDK. Testado: Premium da The X Subscription | Medido em 2026-11-11 ([8.2 §4–5](../research/verificacoes-locais.md)): no Free o SDK não funciona. O `Agent.create` local falha com `UnknownAgentError` `plan_required` (403, `GET /v1/models` na validação local do modelo), e `wf whoami` e `wf models` também. O engine encerra o run na primeira tentativa (`AccountAccessError`). No Premium, funciona. O plano legado Start não inclui o SDK ([DOC](https://cursor.com/docs/account/pricing/legacy-cursor-plans)); o Plus não foi testado |
| Cursor IDE | Atual | Para usar pelo chat (MCP e skills). Terminal e CI não precisam da IDE |
| `git` | qualquer recente | O workflow de exemplo cria worktrees e commits |
| `gh` (GitHub CLI) | autenticado (`gh auth login`) | O exemplo lê a issue e, opcionalmente, abre o PR |

> **Não** use `npm install --omit=optional`: isso remove o binário de plataforma do SDK e do `esbuild` (usado
> pelo `tsx`).

## 2. Dependências

| Pacote | Uso |
|---|---|
| `@cursor/sdk` (fixado em `1.3.1`) | Criar agentes, enviar prompts, consultar custo. **Fixe a versão** e atualize de forma deliberada. O npm publica `1.3.1` (2026-11-03; ver [8.2](../research/verificacoes-locais.md)), mas as notas de versão do SDK listam `1.0.40` como a mais recente, sem data ([DOC](https://cursor.com/docs/release-notes/sdk)). Nenhuma página da doc chama o SDK de beta ou de GA |
| `@modelcontextprotocol/sdk` | MCP server (stdio) para o Cursor IDE |
| `ajv` | Validação de JSON Schema da saída estruturada |
| `tsx` | Roda os `.ts` direto, sem build. O `mcp.json` aponta para `node_modules/.bin/tsx` (sem `npx`, para não baixar nada na hora) |
| `zod` | Peer dependency do `@cursor/sdk` |
| `typescript`, `@types/node` (dev) | Typecheck |

## 3. Instalar

O kit se instala **uma vez por máquina**, numa tag de lançamento, em `~/.cursor-workflows/kit`. Cada repositório que o
usa recebe depois os próprios arquivos, do `wf init` ([2.3](03-invocacao-no-cursor-ide.md#usar-o-kit-em-outros-repositórios)).

### Pelo agente (recomendado)

Aponte qualquer agente de código para o guia, fixado numa tag:
`https://raw.githubusercontent.com/rodrigorjsf/cursor-workflows-starter/v0.3.0/INSTALL-AGENT.md`. Ele checa a máquina,
instala o kit, confere o login, roda o `wf init` no repositório atual e termina no `wf doctor`. O guia é público, está
em inglês (texto escrito para agentes) e não depende de nenhum outro documento. A tag que ele traz é sempre a versão do
pacote: o `npm test` reprova se os dois divergirem, então uma versão nova só sai com o guia apontando para ela.

### Pelo instalador

```bash
curl -fsSL https://raw.githubusercontent.com/rodrigorjsf/cursor-workflows-starter/v0.3.0/scripts/install.sh -o /tmp/wf-install.sh
bash /tmp/wf-install.sh --tag v0.3.0
```

Baixar o script para um arquivo, em vez de passá-lo direto ao `bash`, deixa você lê-lo antes de rodar. O instalador:

| Passo | Resultado |
|---|---|
| Kit | Clona o repositório na tag em `~/.cursor-workflows/kit` (`WF_HOME` muda a pasta `~/.cursor-workflows`). Se já há um clone, busca as tags da origem dele e o move para a tag (um `--repo` dado de novo troca essa origem antes) |
| Node | Para antes de instalar qualquer coisa se o `node` do PATH for mais antigo que o `engines.node` do kit (22.13), dizendo as duas versões |
| Dependências | `npm ci` na pasta do kit: a árvore exata do `package-lock.json` |
| Comando `wf` | Escreve `~/.local/bin/wf`, um script que roda o CLI do kit instalado. Se a pasta não está no PATH, o instalador avisa e diz como corrigir (bash ou zsh: `export PATH` no `~/.profile`; fish: `fish_add_path`). Um `wf` que não é dele fica como está, com aviso |
| Skills | Liga cada skill do kit (`run-workflow`, `cursor-workflow-authoring`, `skill-to-workflow`, `cursor-workflows-setup`) em `~/.claude/skills/`, com links simbólicos para `~/.cursor-workflows/kit/skills/`. O Claude Code lê essa pasta, e o Cursor também (compatibilidade). Uma pasta ou um link de mesmo nome que seja seu fica como está, com aviso |
| Configuração global | Escreve `~/.cursor-workflows/config.json` com os tetos padrão **se o arquivo não existir**: 3.000.000 de tokens e 500 centavos por run, 600.000 tokens por etapa, simultaneidade 4, todos os modelos, todas as camadas de configuração menos `all`, só etapas locais ([6.2](../reference/config.md)). Um arquivo seu nunca é reescrito |

Rodar de novo é seguro: o instalador refaz o que falta e não muda o que já está certo. Cada skill ligada passa pelo local
fixo do kit, então o link continua valendo quando o kit troca de uma tag para outra.

### Atualizar: `wf upgrade`

```bash
wf upgrade
```

Busca as tags do repositório de origem, escolhe a mais nova (só versões `vX.Y.Z`; pré-lançamentos não contam), faz o
checkout dela e roda o `install.sh --refresh` **dessa tag**, que reinstala as dependências e refaz o comando, os links
das skills (uma skill nova ganha link, e o link de uma skill que saiu é removido) e a configuração padrão, sem tocar em
arquivo seu. O stdout é `{ "upgraded", "from", "to", "tag" }`; o andamento vai para o stderr. Já na versão mais nova, ele
só diz isso. Depois de atualizar, rode `wf doctor` em cada repositório: um kit fora da faixa `kit` do repositório é recusado
([2.3](03-invocacao-no-cursor-ide.md#conferindo-o-ambiente-wf-doctor)).

Ele recusa o que não é um kit instalado: um kit em modo de desenvolvimento (abaixo), um `wf` que roda de outra pasta, e a
falta de rede (o kit continua na versão em que estava). Se o instalador falhar depois do checkout, a mensagem diz o
comando para terminar: `bash ~/.cursor-workflows/kit/scripts/install.sh --refresh`.

### Modo de desenvolvimento

Quem mexe no próprio kit instala o clone em vez de uma tag:

```bash
git clone <seu-fork-deste-kit> cursor-workflows && cd cursor-workflows
npm ci                    # usa o package-lock.json versionado
npm run typecheck         # deve terminar sem erros
npm test                  # testes offline do engine (sem rede, sem conta)
scripts/install.sh --dev  # ~/.cursor-workflows/kit passa a ser um link para este clone
```

Com `--dev`, o comando `wf`, o servidor MCP dos repositórios e as skills globais rodam o seu código. O instalador usa
`npm install` só se faltar o `node_modules` (o `npm ci` esvaziaria o seu). O `wf upgrade` recusa essa instalação, e o
instalador não troca um modo pelo outro: para passar de uma tag para o modo de desenvolvimento, mova `~/.cursor-workflows/kit`
para trás (e o inverso vale também).

## 4. Login e modelos

```bash
wf login     # abre o navegador e grava uma chave de usuário (90 dias por padrão) em ~/.cursor/sdk/auth.json
wf whoami    # confirma a conta
wf models    # id, displayName, aliases e params de cada modelo liberado pelo plano e pelo admin
```

Sem navegador local (SSH, WSL sem navegador), rode `NO_OPEN_BROWSER=1 wf login`: a URL vai para o stderr
e pode ser aberta em outro dispositivo. Gere a URL só quando for concluir o login: ela expira em poucos minutos
(medido em 2026-11-11, [8.2 §4](../research/verificacoes-locais.md)).

`whoami` é o primeiro teste do plano. No Free, o login funciona, mas `whoami` já responde
`[plan_required] Cloud Agent is not available for free users. Please upgrade to Pro.`, e `models` dá o mesmo erro
(medido em 2026-11-11).

Ajuste os modelos de cada papel na configuração JSON ou nas variáveis `WF_MODEL_*`
([2.2 · Configuração](02-configuracao-inicial.md), [6.2](../reference/config.md)); os defaults estão em `meta.roles` de
`packages/runtime/workflows/implement-issue.ts`.

## 5. Teste de fumaça real

Primeiro contato com a API. Comece pelo `smoke`, o workflow mais barato do kit: uma etapa estruturada num modelo
incluído no plano, com teto baixo de tokens ([2.3](03-invocacao-no-cursor-ide.md#validar-no-cursor-ide) traz o custo
medido).

```bash
wf run smoke --cwd /caminho/do/repo-de-teste
```

Se o `smoke` terminar, o login, o modelo e a saída estruturada funcionam. O teste ponta a ponta abaixo custa muito
mais; use um teto baixo para limitar o custo:

```bash
# Repositório de teste com uma issue simples rotulada "complexity:low"
wf run implement-issue --cwd /caminho/do/repo-de-teste --args '{"issue":1}' --max-cents 50 --max-tokens 2000000
```

Passe sempre os dois tetos: em uso cobrado por request, o teto em centavos fica cego
([2.2 §3](02-configuracao-inicial.md#3-teto-de-custo)).

O que conferir:

1. No stderr aparecem eventos `step-start`/`step-end` com o modelo pedido em cada etapa. O `step-end` traz também
   `resolvedModel`, o ID que o Cursor resolveu: o alias `composer` vira `composer-2.5`, mas `default` (o Auto)
   continua `default` (medido em 2026-11-11).
2. Nenhuma etapa falhou com `ConfigurationError` (o pacote mostra `Cannot use this model: <id>. Available
   models: ...`; a doc cita "Bad model name"). Se falhar, o ID não está liberado para a sua conta: ajuste
   os `WF_MODEL_*` com o que aparece em `wf models`. Outra falha possível é uma run com `status: "error"` e a
   mensagem "... is not included in your weekly usage": o modelo está no catálogo, mas o plano não o cobre sem
   crédito pré-pago. Foi o caso de `gpt-5.3-codex` num Premium em 2026-11-11. Troque por um modelo do Cursor.
3. A saída final tem `status: "finished"`, `spentCents` (o custo que o teto conta) e `chargedCents` (só o cobrado,
   que pode ser 0). Se `spentCents` vier 0, o teto em centavos não protege a sua conta. Se o stderr também trouxer
   o aviso `getUsage() falhou (...)` (provavelmente `403 feature_unavailable`), o custo ficou desconhecido e só o
   teto de tokens protege. Ele conta pelos eventos `turn-ended`: confira que `spentTokens` saiu maior que 0.
   Isso não é hipótese: num Premium, em 2026-11-11, toda chamada ao `getUsage()` deu `feature_unavailable`
   ([8.2 §5](../research/verificacoes-locais.md)). Com isso, `spentCents` fica em 0 e o
   `--max-cents` não dispara. Veja [2.2 §3](02-configuracao-inicial.md#3-teto-de-custo).
4. Em `/caminho/do/repo-de-teste/.workflows/worktrees/` existe a branch `wf/issue-1` com o commit.
5. Rodando de novo com `--resume <runId>`, as etapas de agente concluídas aparecem como "(cache)", e o commit
   não é repetido. Exceção esperada: as etapas `corrigir-N` embutem a saída dos testes no prompt, e essa saída
   costuma mudar (tempos de execução), então elas rodam de novo se os testes falharem outra vez.

Se algo divergir, anote em um issue do seu fork. Os pontos marcados "a validar" em
[8.1 §8](../research/relatorio-pesquisa.md#8-o-que-foi-refutado-e-o-que-segue-incerto)
são os candidatos mais prováveis.

## 6. Habilitar no Cursor IDE

1. Abra no Cursor o repositório em que você rodou o `wf init` (ou este, de desenvolvimento).
2. Habilite o servidor `workflows`, que vem de `.cursor/mcp.json`, em **Customize**, na barra lateral
   ([DOC](https://cursor.com/docs/mcp)). No Enterprise, o admin pode limitar quais servidores MCP os membros rodam:
   a MCP Allowlist aprova servidores stdio por padrão de comando, e um servidor fora dos padrões só roda se o admin
   permitir MCPs configurados pelo próprio usuário ([DOC](https://cursor.com/docs/mcp)). Com a Team list ligada, a
   IDE e a CLI bloqueiam o servidor que não está na lista ([DOC](https://cursor.com/docs/release-notes)). Então um
   membro pode precisar que o admin libere o servidor antes.
3. Rode o `wf doctor` num terminal aberto pelo próprio IDE: ele confere o Node que o IDE usa, as dependências, o login, os
   modelos, o `gh`, o servidor MCP e a configuração ([2.3](03-invocacao-no-cursor-ide.md#conferindo-o-ambiente-wf-doctor)).
   Sobre o Node: confira o que a IDE usa. O Cursor sobe o servidor com o `node` do PATH do próprio processo (o `tsx` do
   `mcp.json` começa com `#!/usr/bin/env node`), e um gerenciador de versões (mise, nvm) ativado pelo perfil do
   shell pode não valer ali. Rode `node -v` nesse ambiente. Abaixo do Node 22.13, o CLI e o MCP server saem com uma
   mensagem clara, com a versão encontrada; no Cursor, ela aparece em **Output → MCP Logs**
   ([DOC](https://cursor.com/docs/mcp)).
4. Confira que as skills `/run-workflow`, `/cursor-workflow-authoring`, `/skill-to-workflow` e `/cursor-workflows-setup`
   aparecem no chat ao digitar `/`. O instalador as liga em `~/.claude/skills/`, que o Cursor lê por compatibilidade
   (a doc de skills do Cursor também cita `~/.agents/skills/` e `~/.cursor/skills/`;
   [DOC](https://cursor.com/docs/skills)). Neste repositório, de desenvolvimento, elas chegam por `.agents/skills/`,
   que o Cursor lê nativamente.
5. No chat: `/run-workflow implement-issue 1`.

## 7. Habilitar no Claude Code (opcional)

1. `.mcp.json` na raiz já registra o mesmo servidor `workflows`. Aprove-o quando o Claude Code perguntar. Antes da
   aprovação, `claude mcp list` mostra `workflows: node_modules/.bin/tsx packages/runtime/src/mcp-server.ts - ⏸ Pending approval`
   (verificado em 2026-11-11). Em `claude -p`, no Agent SDK e em sessões na nuvem fora de um projeto, o Claude Code carrega os
   servidores do `.mcp.json` sem perguntar ([DOC](https://code.claude.com/docs/en/mcp)); num `claude -p` em 2026-11-11 as
   quatro tools apareceram como `mcp__workflows__*` e o `CLAUDE.md` (na época, só `@AGENTS.md`) foi lido
   ([8.2 §10](../research/verificacoes-locais.md)).
2. O Claude Code não lê nada sob `.agents/`. Em qualquer repositório, as skills do kit chegam a ele pelos links do
   instalador em `~/.claude/skills/`. Só neste repositório, de desenvolvimento, que guarda as skills em
   `.agents/skills/`, rode `scripts/link-claude-skills.sh`, que cria links em `.claude/skills/`. O Cursor também lê `.claude/skills/`, então a mesma skill pode aparecer
   duas vezes no Cursor. A skill de autoria se chama `cursor-workflow-authoring` porque o Claude Code tem uma
   skill embutida `workflow-authoring` (a da ferramenta Workflow dele), e uma skill de projeto com o mesmo nome
   substituiria a embutida ([DOC](https://code.claude.com/docs/en/skills)).
3. `AGENTS.md` é um link simbólico para o `CLAUDE.md`, então as instruções do repositório são as mesmas nos dois.
4. Como no Cursor, o Claude Code sobe o servidor com o `node` do PATH do próprio processo, e o mise ou o nvm podem
   não estar ativos ali. Rode `node -v` no ambiente que inicia o `claude`. Abaixo do Node 22.13, o servidor sai
   com uma mensagem clara, e `claude mcp list` mostra `✘ Failed to connect`
   ([DOC](https://code.claude.com/docs/en/mcp)).

Para usar os workflows **em outros repositórios** sem copiar o kit para dentro deles, veja
[2.3 · Invocação](03-invocacao-no-cursor-ide.md#usar-o-kit-em-outros-repositórios).

---

[← Anterior: 1.3 · Conceitos](../vision/03-conceitos.md) · [Índice](../README.md) · [Próximo: 2.2 · Configuração inicial →](02-configuracao-inicial.md)
