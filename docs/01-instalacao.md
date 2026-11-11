# 01 · Instalação

## 1. Requisitos

| Item | Versão | Por quê |
|---|---|---|
| Node.js | **≥ 22.13** | Exigência do `@cursor/sdk` (`engines.node`; [DOC](https://cursor.com/docs/sdk/typescript#runtime-support), acesso em 2026-11-11) |
| Sistema | Testado só em Linux x64 (WSL2). macOS (arm64/x64), Linux arm64 e Windows x64 têm binários do SDK, mas o kit não foi testado neles. No Windows nativo, o `implement-issue` precisa de `bash` (roda os testes com `bash -c`) | O SDK traz binários por plataforma como dependências opcionais (`@cursor/sdk-<os>-<arch>`). Ambiente dos testes: [verificações locais](research/verificacoes-locais.md) §1 |
| Conta Cursor | Plano pago com acesso ao SDK. Testado: Premium da The X Subscription | Medido em 2026-11-11 ([verificações locais](research/verificacoes-locais.md) §4–5): no Free o SDK não funciona. O `Agent.create` local falha com `UnknownAgentError` `plan_required` (403, `GET /v1/models` na validação local do modelo), e `wf whoami` e `wf models` também. O engine encerra o run na primeira tentativa (`AccountAccessError`). No Premium, funciona. O plano legado Start não inclui o SDK ([DOC](https://cursor.com/docs/account/pricing/legacy-cursor-plans)); o Plus não foi testado |
| Cursor IDE | Atual | Para usar pelo chat (MCP e skills). Terminal e CI não precisam da IDE |
| `git` | qualquer recente | O workflow de exemplo cria worktrees e commits |
| `gh` (GitHub CLI) | autenticado (`gh auth login`) | O exemplo lê a issue e, opcionalmente, abre o PR |

> **Não** use `npm install --omit=optional`: isso remove o binário de plataforma do SDK e do `esbuild` (usado
> pelo `tsx`).

## 2. Dependências

| Pacote | Uso |
|---|---|
| `@cursor/sdk` (fixado em `1.3.1`) | Criar agentes, enviar prompts, consultar custo. **Fixe a versão** e atualize de forma deliberada. O npm publica `1.3.1` (2026-11-03; ver [verificações locais](research/verificacoes-locais.md)), mas as notas de versão do SDK listam `1.0.40` como a mais recente, sem data ([DOC](https://cursor.com/docs/release-notes/sdk)). Nenhuma página da doc chama o SDK de beta ou de GA |
| `@modelcontextprotocol/sdk` | MCP server (stdio) para o Cursor IDE |
| `ajv` | Validação de JSON Schema da saída estruturada |
| `tsx` | Roda os `.ts` direto, sem build. O `mcp.json` aponta para `node_modules/.bin/tsx` (sem `npx`, para não baixar nada na hora) |
| `zod` | Peer dependency do `@cursor/sdk` |
| `typescript`, `@types/node` (dev) | Typecheck |

## 3. Instalar

```bash
git clone <seu-fork-deste-kit> cursor-workflows && cd cursor-workflows
npm ci              # usa o package-lock.json versionado
npm run typecheck     # deve terminar sem erros
npm test              # testes offline do engine (sem rede, sem conta)
```

## 4. Login e modelos

```bash
npm run wf -- login     # abre o navegador e grava uma chave de usuário (90 dias por padrão) em ~/.cursor/sdk/auth.json
npm run wf -- whoami    # confirma a conta
npm run models          # = wf models: id, displayName, aliases e params de cada modelo liberado pelo plano e pelo admin
```

Sem navegador local (SSH, WSL sem navegador), rode `NO_OPEN_BROWSER=1 npm run wf -- login`: a URL vai para o stderr
e pode ser aberta em outro dispositivo. Gere a URL só quando for concluir o login: ela expira em poucos minutos
(medido em 2026-11-11, [verificações locais](research/verificacoes-locais.md) §4).

`whoami` é o primeiro teste do plano. No Free, o login funciona, mas `whoami` já responde
`[plan_required] Cloud Agent is not available for free users. Please upgrade to Pro.`, e `models` dá o mesmo erro
(medido em 2026-11-11).

Ajuste os IDs do mapa de modelos em `workflows/implement-issue.ts` ou nas variáveis `WF_MODEL_*`
([02 · Configuração](02-configuracao-inicial.md)).

## 5. Teste de fumaça real

Primeiro contato com a API. Use um teto baixo para limitar o custo:

```bash
# Repositório de teste com uma issue simples rotulada "complexity:low"
npm run wf -- run implement-issue --cwd /caminho/do/repo-de-teste --args '{"issue":1}' --max-cents 50 --max-tokens 2000000
```

Passe sempre os dois tetos: em uso cobrado por request, o teto em centavos fica cego
([02 §3](02-configuracao-inicial.md#3-teto-de-custo)).

O que conferir:

1. No stderr aparecem eventos `step-start`/`step-end` com o modelo pedido em cada etapa. O `step-end` traz também
   `resolvedModel`, o ID que o Cursor resolveu: o alias `composer` vira `composer-2.5`, mas `default` (o Auto)
   continua `default` (medido em 2026-11-11).
2. Nenhuma etapa falhou com `ConfigurationError` (o pacote mostra `Cannot use this model: <id>. Available
   models: ...`; a doc cita "Bad model name"). Se falhar, o ID não está liberado para a sua conta: ajuste
   os `WF_MODEL_*` com o que aparece em `npm run models`. Outra falha possível é uma run com `status: "error"` e a
   mensagem "... is not included in your weekly usage": o modelo está no catálogo, mas o plano não o cobre sem
   crédito pré-pago. Foi o caso de `gpt-5.3-codex` num Premium em 2026-11-11. Troque por um modelo do Cursor.
3. A saída final tem `status: "finished"`, `spentCents` (o custo que o teto conta) e `chargedCents` (só o cobrado,
   que pode ser 0). Se `spentCents` vier 0, o teto em centavos não protege a sua conta. Se o stderr também trouxer
   o aviso `getUsage() falhou (...)` (provavelmente `403 feature_unavailable`), o custo ficou desconhecido e só o
   teto de tokens protege. Ele conta pelos eventos `turn-ended`: confira que `spentTokens` saiu maior que 0.
   Isso não é hipótese: num Premium, em 2026-11-11, toda chamada ao `getUsage()` deu `feature_unavailable`
   ([verificações locais](research/verificacoes-locais.md) §5). Com isso, `spentCents` fica em 0 e o
   `--max-cents` não dispara. Veja [02 §3](02-configuracao-inicial.md#3-teto-de-custo).
4. Em `/caminho/do/repo-de-teste/.workflows/worktrees/` existe a branch `wf/issue-1` com o commit.
5. Rodando de novo com `--resume <runId>`, as etapas de agente concluídas aparecem como "(cache)", e o commit
   não é repetido. Exceção esperada: as etapas `corrigir-N` embutem a saída dos testes no prompt, e essa saída
   costuma mudar (tempos de execução), então elas rodam de novo se os testes falharem outra vez.

Se algo divergir, anote em um issue do seu fork. Os pontos marcados "a validar" em
[`research/relatorio-pesquisa.md` §8](research/relatorio-pesquisa.md#8-o-que-foi-refutado-e-o-que-segue-incerto)
são os candidatos mais prováveis.

## 6. Habilitar no Cursor IDE

1. Abra o repositório no Cursor.
2. Habilite o servidor `workflows`, que vem de `.cursor/mcp.json`, em **Customize**, na barra lateral
   ([DOC](https://cursor.com/docs/mcp)). No Enterprise, o admin pode limitar quais servidores MCP os membros rodam:
   a MCP Allowlist aprova servidores stdio por padrão de comando, e um servidor fora dos padrões só roda se o admin
   permitir MCPs configurados pelo próprio usuário ([DOC](https://cursor.com/docs/mcp)). Com a Team list ligada, a
   IDE e a CLI bloqueiam o servidor que não está na lista ([DOC](https://cursor.com/docs/release-notes)). Então um
   membro pode precisar que o admin libere o servidor antes.
3. Confira o Node que a IDE usa. O Cursor sobe o servidor com o `node` do PATH do próprio processo (o `tsx` do
   `mcp.json` começa com `#!/usr/bin/env node`), e um gerenciador de versões (mise, nvm) ativado pelo perfil do
   shell pode não valer ali. Rode `node -v` nesse ambiente. Abaixo do Node 22.13, o CLI e o MCP server saem com uma
   mensagem clara, com a versão encontrada; no Cursor, ela aparece em **Output → MCP Logs**
   ([DOC](https://cursor.com/docs/mcp)).
4. Confira que as skills `/run-workflow`, `/workflow-authoring` e `/skill-to-workflow` aparecem no chat ao digitar
   `/`. Elas ficam em `.agents/skills/`, que o Cursor lê nativamente.
5. No chat: `/run-workflow implement-issue 1`.

## 7. Habilitar no Claude Code (opcional)

1. `.mcp.json` na raiz já registra o mesmo servidor `workflows`. Aprove-o quando o Claude Code perguntar. Antes da
   aprovação, `claude mcp list` mostra `workflows: node_modules/.bin/tsx src/mcp-server.ts - ⏸ Pending approval`
   (verificado em 2026-11-11). Em `claude -p`, no Agent SDK e em sessões na nuvem fora de um projeto, o Claude Code carrega os
   servidores do `.mcp.json` sem perguntar ([DOC](https://code.claude.com/docs/en/mcp)); num `claude -p` em 2026-11-11 as
   quatro tools apareceram como `mcp__workflows__*` e o `CLAUDE.md` → `@AGENTS.md` foi lido
   ([verificações §10](research/verificacoes-locais.md)).
2. O Claude Code não lê nada sob `.agents/`. Para ter as skills lá também, rode `scripts/link-claude-skills.sh`,
   que cria links em `.claude/skills/`. O Cursor também lê `.claude/skills/`, então a mesma skill pode aparecer
   duas vezes no Cursor.
3. `CLAUDE.md` importa `AGENTS.md` (`@AGENTS.md`), então as instruções do repositório são as mesmas nos dois.
4. Como no Cursor, o Claude Code sobe o servidor com o `node` do PATH do próprio processo, e o mise ou o nvm podem
   não estar ativos ali. Rode `node -v` no ambiente que inicia o `claude`. Abaixo do Node 22.13, o servidor sai
   com uma mensagem clara, e `claude mcp list` mostra `✘ Failed to connect`
   ([DOC](https://code.claude.com/docs/en/mcp)).

Para usar os workflows **em outros repositórios** sem copiar o kit para dentro deles, veja
[04 · Invocação](04-invocacao-no-cursor-ide.md#usar-o-kit-em-outros-repositórios).
