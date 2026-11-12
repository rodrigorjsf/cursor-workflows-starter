# 2.2 · Configuração inicial

## 1. Autenticação: de quem é o uso?

O SDK procura a chave nesta ordem: opção `apiKey` → variável `CURSOR_API_KEY` → chave salva por
`Cursor.auth.login()` (`~/.cursor/sdk/auth.json`)
([DOC](https://cursor.com/docs/sdk/typescript#cursorauth), acesso em 2026-11-11).

| Cenário | Configuração | Cobrança |
|---|---|---|
| **Desenvolvedor usando pelo chat** (recomendado) | `npm run wf -- login` uma vez por máquina | Conta do próprio usuário. Coerente com o orçamento individual do Enterprise |
| Desenvolvedor sem navegador (SSH, devcontainer) | Gerar uma chave de usuário no dashboard e exportar `CURSOR_API_KEY`, ou `npm run wf -- login` e abrir em outra máquina a URL que ele imprime no stderr. Em sessão SSH o SDK já não abre o navegador; nos outros casos, use `NO_OPEN_BROWSER=1` ([DOC](https://cursor.com/docs/sdk/typescript#cursorauth)). Medido em 2026-11-11 com `NO_OPEN_BROWSER=1 npm run wf -- login`: a URL vai para o stderr, funciona aberta em outro dispositivo e expira em poucos minutos se o login não for concluído ([verificações locais](../research/verificacoes-locais.md) §4) | Conta do usuário |
| CI / GitHub Actions / Automations | Chave de **service account** (Enterprise) como secret `CURSOR_API_KEY` | Pool do time, sem atribuição por pessoa |
| Usuário em mais de um time | Passar `teamId` (o kit ainda não expõe a opção; adicione em `RunOptions` se precisar) | O time indicado |

**O que não funciona:**

- Chaves **Team Admin** ainda não são aceitas pelo SDK: a doc diz "not yet supported", então é um limite atual.
  O SDK aceita chaves de usuário e de service account ([DOC](https://cursor.com/docs/sdk/typescript#authentication)).
- O SDK **não** reaproveita o login da IDE: ele não descobre credenciais de uma instalação local do app Cursor
  ([DOC](https://cursor.com/docs/sdk/typescript#cursorauth)). Não tente ler o token da IDE (Keychain etc.). Não é
  suportado, quebra sem aviso e é ruim para conformidade.
- O login interativo da CLI `agent` também não é reaproveitado, mas a doc do SDK não o cita. Isso decorre da ordem
  acima: o login salvo do SDK só guarda chaves criadas por `Cursor.auth.login()`. Já uma **chave de usuário** em
  `CURSOR_API_KEY` serve para os dois, CLI e SDK ([DOC](https://cursor.com/docs/cli/reference/parameters)).

**Segurança da chave salva:** `~/.cursor/sdk/auth.json` fica em texto puro e a chave vale 90 dias por padrão. Em
máquinas compartilhadas, prefira `CURSOR_API_KEY` vinda de um gerenciador de segredos.

Para passar a chave ao MCP server sem gravar em arquivo, use interpolação no `mcp.json`. O Cursor resolve
`${env:NAME}`, `${userHome}` e `${workspaceFolder}` (a pasta que contém o `.cursor/mcp.json`) nos campos `command`,
`args`, `env`, `url` e `headers` ([DOC](https://cursor.com/docs/mcp)):

```json
{ "mcpServers": { "workflows": { "command": "${workspaceFolder}/node_modules/.bin/tsx", "args": ["${workspaceFolder}/packages/runtime/src/mcp-server.ts"],
  "env": { "CURSOR_API_KEY": "${env:CURSOR_API_KEY}", "WF_CWD": "${workspaceFolder}" } } } }
```

Só adicione essa linha se a variável estiver mesmo definida: interpolada vazia, ela pode encobrir o login salvo.
**Em aberto:** a doc não cobre esse caso. Ela dá a ordem de resolução e as regras de interpolação, mas não diz em
que vira um `${env:...}` não definido nem se uma `CURSOR_API_KEY` vazia conta como definida e passa na frente do
login salvo. Na dúvida, deixe a linha de fora e use `wf login`.

## 2. Modelos

Os IDs dependem do plano e das restrições do admin. Liste com `npm run models` (`wf models`), que mostra `id`,
`displayName`, `aliases` e `params` de cada modelo. O modelo de cada etapa vem do **papel** dela: o `implement-issue`
declara oito (`classify`, `implement.low`, `implement.med`, `implement.high`, `review`, `fix`, `design`, `pr-text`).
Cinco têm um modelo de código, e uma variável `WF_MODEL_*` o troca:

| Variável | Papel | Default do exemplo |
|---|---|---|
| `WF_MODEL_CLASSIFY` | `classify`: classificar a complexidade quando a issue não tem label | `composer-2.5` |
| `WF_MODEL_LOW` (ou `WF_MODEL_IMPLEMENT_LOW`) | `implement.low`: tarefas mecânicas | `composer-2.5` |
| `WF_MODEL_MED` (ou `WF_MODEL_IMPLEMENT_MED`) | `implement.med`: implementação típica | `grok-4.7` |
| `WF_MODEL_HIGH` (ou `WF_MODEL_IMPLEMENT_HIGH`) | `implement.high`: implementação complexa | `grok-4.7` com `reasoning_effort=high` |
| `WF_MODEL_REVIEW` | `review`: code review | `grok-4.7` com `reasoning_effort=high` |

Os defaults são modelos do Cursor (Composer e Grok), que os planos pagos da The X Subscription incluem na franquia
semanal. Eles mudaram depois de um teste num Premium em 2026-11-11
([verificações locais](../research/verificacoes-locais.md) §5–6):

- `auto-low`, que vinha do `dag-task-runner` do cookbook, não existe no catálogo. O Auto é `default` (alias `auto`).
- `composer-2` e `composer-2.5` existem; os aliases `composer` e `composer-latest` apontam para `composer-2.5`.
- `gpt-5.3-codex`, o antigo default de HIGH e REVIEW, falha como run com `status: "error"`, sem exceção: "Codex 5.3
  is not included in your weekly usage Buy credits or switch to a Grok model to continue."

Nos testes, o `composer-2.5` rodou nas sondas e na etapa `implementar` do teste ponta a ponta. O `grok-4.7` rodou
uma vez, sem `params`, como MED na etapa `corrigir-1` desse teste, e essa etapa editou um arquivo fora do
repositório ([5.1 · Segurança](../operating/01-governanca-e-custos.md#segurança); [verificações locais](../research/verificacoes-locais.md)
§9). A variante com `reasoning_effort=high` (HIGH e REVIEW) não foi testada: confira em `npm run models` que o
`grok-4.7` oferece `reasoning_effort` antes de usar esses defaults.

`WF_MODEL_<PAPEL>` com só um ID (`WF_MODEL_REVIEW=grok-5`) troca o ID e **mantém** os `params` do papel; com
colchetes (`grok-5[reasoning_effort=low]`) troca também os `params`, e `grok-5[]` os limpa. Para ir além do ambiente,
o modelo (com `params`), o `timeoutMs`, as tentativas e o teto de tokens de cada papel ficam em arquivos JSON, global
e do repositório: [6.2 · Referência de configuração](../reference/config.md). O `wf config show` mostra o que vale e de
onde veio. Mudança desde a versão anterior: as etapas `fix` (correção) e `design` (plano e desenho) são papéis
próprios e não seguem mais `WF_MODEL_MED`/`WF_MODEL_HIGH`.

> **Validação de modelo:** em runs locais, o SDK confere o ID (ou alias) contra o catálogo da sua conta antes de
> rodar. Se o ID não existir para você, a etapa falha com `ConfigurationError`: `Cannot use this model: <id>.
> Available models: default, grok-4.7, ...` no pacote, medido em 2026-11-11; a doc cita "Bad model name".
> `RunResult.model` devolve o ID **resolvido**: pedido `composer`, volta `composer-2.5` (medido). O engine o grava
> como `resolvedModel` no `step-end`. Com `default` (Auto), volta `default`, e a escolha do Cursor Router não
> aparece. Se uma substituição feita **do lado do servidor** por política do admin apareceria ali não foi testado
> (conta pessoal). Para garantir o modelo, combine com o admin a lista liberada e confira em `npm run models`.

## 3. Teto de custo

| Onde | Como |
|---|---|
| CLI | `--max-cents 200`, `--max-tokens 2000000` |
| MCP / CLI (default) | Variáveis `WF_MAX_CENTS` e `WF_MAX_TOKENS` (nos `mcp.json` do exemplo: `500` e `2000000`) |
| Arquivos de config | `maxTokens`, `maxCents` e `concurrency` por workflow, no arquivo global (`~/.cursor-workflows/config.json`) e no do repositório (`.agents/workflows/config.json`); no global, `caps` que o resto só pode apertar ([6.2](../reference/config.md#tetos)) |
| Chat | `overrides` do `start_workflow` (`maxTokens`, `maxCents`, `maxTokensPerStep`, `concurrency`): só apertam |
| Dentro do workflow | `ctx.budget.remainingCents()`, para rebaixar o modelo antes de estourar. `ctx.budget.spentCents()` dá o custo que o teto conta; `ctx.budget.chargedCents()`, só o cobrado |

Como funciona:

- **O teto não garante um gasto máximo.** Ele é checado **antes** de cada etapa (e de cada nova tentativa).
  Etapas que já começaram não são interrompidas, e uma etapa não tem teto de tokens próprio: só o `timeoutMs` de
  cada envio a limita (o pedido e até `schemaRetries` re-prompts, cada um com o seu). A ultrapassagem pode chegar a **concorrência × uma etapa sem limite** (ex.: 4 etapas em `parallel`).
  Medido em 2026-11-11: com `--max-tokens 300000`, o `implement-issue` gastou 344.376 tokens. A `corrigir-1`
  começou com 74,9 mil gastos e sozinha usou 269 mil ([verificações locais](../research/verificacoes-locais.md) §9).
  Para tetos apertados, use `concurrency` baixa e um `timeoutMs` curto nas etapas que escrevem (o exemplo usa
  30 min; sem valor na etapa, o engine usa 20 min).
- O teto em centavos depende do custo que o `getUsage()` devolve. O Premium testado não devolveu custo nenhum
  (abaixo), e aí só o teto de tokens protege.
- O custo de cada etapa é lido com `agent.getUsage()` ao fim dela, inclusive quando ela falha ou estoura o tempo.
  A doc avisa que o custo pode levar um momento para assentar depois do fim da run, e que `cost` fica ausente até
  lá, em vez de vir 0 ([DOC](https://cursor.com/docs/sdk/typescript#agentgetusage)). O engine tenta ler de novo
  algumas vezes. Se o custo ainda não veio, ele emite um `warning`: o teto em centavos não contou essa tentativa (o
  de tokens, sim). Um custo que chegue depois disso fica de fora da soma.
- Enquanto o uso de agentes locais não estiver liberado na conta, `getUsage()` devolve `403 feature_unavailable`
  ([DOC](https://cursor.com/docs/sdk/typescript#agentgetusage)). Nesse caso, e em qualquer falha do `getUsage()`,
  o engine conta os tokens da tentativa pela soma dos eventos `turn-ended`, e o teto de tokens continua valendo. O
  custo fica desconhecido, e o teto em centavos não conta a tentativa. O `warning` começa com "getUsage() falhou".
  Com `feature_unavailable`, o engine não tenta ler de novo. Turno sem uso reportado, como o de uma run cancelada
  antes de fechar o turno, fica fora da soma ([DOC](https://cursor.com/docs/sdk/typescript#token-usage)).
- Isso acontece em plano pago. Num Premium, em 2026-11-11, toda chamada ao `getUsage()` de agente local deu
  `UnknownAgentError [feature_unavailable] This feature is not available for your account`, também o
  `Agent.getUsage(agentId)` estático depois do descarte ([verificações locais](../research/verificacoes-locais.md)
  §5). Nessa conta, `spentCents` fica em 0 e o `--max-cents` nunca dispara: só o `--max-tokens` protege. O custo
  só sai da estimativa da tabela `pricing` ([5.3 §3](../operating/03-observabilidade.md#3-modelo-de-dados)) e do dashboard de uso
  da conta.
- O teto vale para o run inteiro, não para cada execução. Num resume, o gasto das execuções anteriores (tentativas que
  falharam inclusive) é recomposto do log de eventos do run e conta de novo: `--max-cents` e `--max-tokens` passados ao
  resume são o novo teto **total**. Para estender um run que parou no teto, retome com um teto maior que o gasto
  (`--resume <runId> --max-cents <novo total>`); com o mesmo teto, o resume para no mesmo ponto.
- O teto compara `maxCents` com `spentCents`: a soma, por tentativa, do maior entre `rawCostCents` (custo bruto, sem
  descontos) e `chargedCents` (o cobrado). `chargedCents` sozinho é **0 para uso incluído no plano, BYOK e
  créditos** ([DOC](https://cursor.com/docs/sdk/typescript#agentgetusage)). Antes o teto somava só `chargedCents` e
  nunca disparava em uso incluído no plano. `RunOutcome`, o estado do job e `ctx.budget` também expõem
  `chargedCents` (só o cobrado). **Em aberto:** a doc não diz que `rawCostCents` fica acima de 0 em uso incluído no
  plano; confira no teste de fumaça que `spentCents` sai maior que 0.
- `rawCostCents` é 0 em uso cobrado por request (planos legados e alguns Enterprise por request)
  ([DOC](https://cursor.com/docs/sdk/typescript#agentgetusage),
  [planos legados](https://cursor.com/docs/account/pricing/legacy-cursor-plans)). Aí o teto em centavos fica cego, e
  só `--max-tokens` / `WF_MAX_TOKENS` protege. **Defina sempre os dois tetos.**
- Se o teto de uso do plano estourar no meio, a tabela de erros do SDK o classifica como `RateLimitError`
  ("Usage limit exceeded", causa "monthly usage cap"; na doc Python, "usage limits exceeded")
  ([DOC](https://cursor.com/docs/sdk/typescript#errors)). A mesma classe cobre o limite de rajada ("Rate limit
  exceeded"), e o SDK marca os casos transitórios com `isRetryable: true`. O engine espera e tenta de novo nesses
  casos, e converte o não retentável em falha "Limite de uso do Cursor atingido". Medido em 2026-11-11: a falta de
  franquia para um modelo (`gpt-5.3-codex` num Premium sem crédito pré-pago) veio como run com `status: "error"` e
  mensagem, não como `RateLimitError`. O engine trata isso como falha de run: tenta de novo (`retries`, default 1) e
  depois falha a etapa com a mensagem do SDK. O teto mensal do plano não foi atingido, então o caminho dele segue sem teste
  ([verificações locais](../research/verificacoes-locais.md) §6).
- A doc não liga a nenhuma classe de erro do SDK os limites de gasto do time ou do membro. A service account
  recebe um erro próprio, "Service account spend limit reached", também sem classe de erro do SDK
  ([DOC](https://cursor.com/docs/account/enterprise/service-accounts)).

## 4. Variáveis de ambiente

| Variável | Default | Efeito |
|---|---|---|
| `CURSOR_API_KEY` | — | Chave usada quando não há `apiKey` explícita |
| `WF_CWD` | diretório atual | Repositório onde os agentes trabalham (MCP) |
| `WF_MAX_CENTS` | sem teto | Teto padrão por run, em centavos, comparado com `spentCents` (§3) |
| `WF_MAX_TOKENS` | sem teto | Teto padrão de tokens por run. Defina junto com `WF_MAX_CENTS` (§3) |
| `WORKFLOWS_DIR` | — | Pasta extra de workflows (além de `workflows/` do kit e `.agents/workflows/` do repositório) |
| `WF_MODEL_*` | ver §2 | Modelo de um papel do workflow (`WF_MODEL_<PAPEL>`): `id` mantém os `params`, `id[param=valor]` os troca ([6.2](../reference/config.md#papéis-globs-de-label-e-variáveis)) |
| `WF_HOME` | `~/.cursor-workflows` | Pasta por usuário do kit: `config.json` global, índice de runs, banco de métricas |
| `WF_MCP_SERVER_NAME` | `workflows` | Nome do servidor do kit no `mcp.json` do projeto. Dentro das etapas, o engine registra com esse nome um servidor inline sem tools, que encobre o do arquivo (§5). Mude se o seu `mcp.json` usa outro nome |
| `NO_OPEN_BROWSER` | — | `wf login` imprime a URL no stderr em vez de abrir o navegador |

## 5. Contexto do projeto nos agentes

O engine cria os agentes com `settingSources: ["project", "team", "mdm"]`, o que carrega:

- `AGENTS.md` e `.cursor/rules/**` do repositório;
- skills do projeto (`.agents/skills/` e `.cursor/skills/` como nativas; `.claude/skills/`, `.codex/skills/` como
  compatibilidade), hooks e `.cursor/mcp.json` do projeto;
- regras e hooks do time e hooks Enterprise (MDM).

Medido em 2026-11-11 em runs locais ([verificações locais](../research/verificacoes-locais.md) §7):

| `settingSources` | O que a etapa recebeu |
|---|---|
| com `"project"` | O `AGENTS.md` (palavra marcadora). Os hooks do Cursor em `.cursor/hooks.json` (`beforeShellExecution` e `postToolUse`) rodaram. Os hooks `PreToolUse` do Claude Code em `.claude/settings.json` rodaram e o deny deles (`exit 2`) bloqueou o comando. Os servidores do `.cursor/mcp.json` subiram |
| `["team","mdm"]` | Sem o `AGENTS.md`. Mas o SDK carregou as mesmas 58 skills que com `"project"` |
| `[]` | Nada disso: sem `AGENTS.md`, hooks, MCP do arquivo nem skills |

Com o mesmo prompt e as tools `shell` e `mcp`, a etapa leu 30,4 mil tokens de input com `"project"` e 25,5 mil com
`[]`. A página do SDK só cita MCP e subagents ao falar de `settingSources`; que o resto também é opt-in vem do
pacote e foi confirmado pelo teste. A origem das 58 skills não foi isolada.

Para isolar os agentes das regras do repositório (por exemplo, num repositório não confiável), passe
`settingSources` sem `"project"` em `RunOptions`. Só `[]` corta também as skills, e aí saem os hooks do time e do
MDM.

> **Sandbox (`sandbox: true`):** liga o `local.sandboxOptions.enabled` do SDK. **Não foi testado neste kit.** No
> Linux ele exige `bubblewrap`; sem ele, o SDK lança `ConfigurationError`. Segundo a doc, ele restringe as chamadas
> de shell e os processos que elas disparam: escrita só no cwd, em diretórios temporários e nos caminhos do
> `sandbox.json`; leitura **não** restrita; rede de saída negada, salvo os hosts listados em `.cursor/sandbox.json`
> (ou `~/.cursor/sandbox.json`) ([DOC](https://cursor.com/docs/sdk/typescript#sandbox-options)). A doc não diz que
> ele restringe as tools `edit` e `write`. Não o trate como mitigação comprovada
> ([5.1 · Segurança](../operating/01-governanca-e-custos.md#segurança)).

> **Recursão:** com `"project"`, o SDK sobe os servidores do `.cursor/mcp.json` para a etapa **sem repassar o
> ambiente do processo**. Medido em 2026-11-11: o servidor `workflows` subia com `WF_INSIDE_WORKFLOW` vazio, e a
> etapa via `list_workflows`, `start_workflow`, `wait_workflow` e `get_workflow_status`. A correção: quando a
> etapa carrega camadas de arquivo (`project`, `user`, `plugins` ou `all`), o engine registra um servidor MCP
> inline com o mesmo nome (`workflows`, ou `WF_MCP_SERVER_NAME`). Ele roda `packages/runtime/src/runtime/nested-mcp-guard.mjs` e
> não expõe tools. O inline vence o do arquivo pelo nome, e no reteste a etapa só via `FetchMcpResource` e
> `submit_result`. O servidor do arquivo ainda sobe, mas não expõe nada. O shell da etapa herda
> `WF_INSIDE_WORKFLOW=1` (medido), então o CLI recusa `wf run` e `wf start` dentro dela.
>
> A guarda evita a recursão **acidental**. Ela não é fronteira de segurança: uma etapa com `shell` pode
> contorná-la, por exemplo rodando o CLI sem a variável.

---

[← Anterior: 2.1 · Instalação](01-instalacao.md) · [Índice](../README.md) · [Próximo: 2.3 · Invocação no Cursor IDE (e no Claude Code) →](03-invocacao-no-cursor-ide.md)
