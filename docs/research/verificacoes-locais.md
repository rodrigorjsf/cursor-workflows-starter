# Verificações locais (2026-11-11)

Registro das verificações feitas numa sessão local (WSL2) depois que o kit saiu de uma sessão na nuvem que não
tinha acesso a cursor.com, ao fórum, a uma conta Cursor nem ao Cursor IDE. Cada linha diz o que foi checado, como,
o resultado, a evidência e o que mudou no kit.

**Resultados:** ✅ confirmado · ❌ refutado · ◐ parcial · ❔ inconclusivo · ⏭ não executado

## 1. Ambiente

| Item | Método | Resultado | Evidência | Ação tomada |
|---|---|---|---|---|
| Node.js | `node -v` (default do mise) e `mise exec node@22.23.4 -- node -v` | ❌ default 22.11.0 < 22.13; ✅ 22.23.4 instalado à parte | `v22.11.0` / `v22.23.4`; o npm do 22.11.0 falha com erro do cjs loader | Tudo roda com `mise exec node@22.23.4`; default global intacto |
| npm | `npm -v` sob o Node 22.23.4 | ✅ | `10.9.9` | — |
| git / gh | `git --version`, `gh auth status` | ✅ | `git 2.43.0`; gh logado, escopos `repo`, `workflow` | — |
| CLI do Cursor (`cursor`, `agent`) | `which cursor agent cursor-agent` | ⏭ ausente no PATH do WSL | sem saída | Não é dependência do kit |
| Cursor IDE | `~/.cursor-server/bin/<hash>/product.json` (Remote-WSL) | ✅ | Cursor 3.22.12, commit `3a92974…`, build 2026-09-26 | Registrado para as verificações da IDE |
| Sistema de arquivos | `df -T` na raiz do repositório | ✅ ext4 (não `/mnt/c`) | `/dev/sdd ext4` | WAL do SQLite ok |
| Fim de linha | `git ls-files --eol` + `file` | ⚠ `core.autocrlf=true` global faz `git archive`/checkout gerar CRLF; o índice está em LF | 43 arquivos `i/lf w/crlf` | Cópia refeita com `-c core.autocrlf=false`; o repositório publicado leva `.gitattributes` com `eol=lf` (o `scripts/link-claude-skills.sh` quebra com CRLF) |

## 2. Instalação limpa

Cópia extraída com `git -c core.autocrlf=false archive HEAD:ai/study/cursor-agent-sdk-workflows/starter-kit`
do ai-study-library em `81d7356` (conteúdo do kit idêntico a `a69f2a2`: `git diff --stat a69f2a2 HEAD -- <kit>`
vazio).

| Item | Método | Resultado | Evidência | Ação tomada |
|---|---|---|---|---|
| `npm ci` | Node 22.23.4 | ✅ | binários `@cursor/sdk-linux-x64` e `@esbuild/linux-x64` presentes em `node_modules` | — |
| `npm run typecheck` | `tsc --noEmit` | ✅ | sem erros | — |
| `npm test` | 21 testes offline | ✅ | `# pass 21`, `# fail 0` | — |
| `npm audit` | após `npm ci` | ❌ 1 alta | `zod <4.6.6`: GHSA-mrhx-c7xc-m3w5 (memória esgotada ao validar coleções grandes); `zod@3.25.76` direto | `zod` → `^4.6.7` (peers de `@cursor/sdk@1.3.1` e `@modelcontextprotocol/sdk@1.32.2` aceitam `^4`); `npm audit`: 0; typecheck, testes e MCP por stdio ok |
| Versão do `@cursor/sdk` | `npm view @cursor/sdk version time` | ✅ 1.3.1 ainda é a última | `1.3.1` publicada em 2026-11-03T23:02Z | Mantida fixada |
| MCP server por stdio | `initialize`, `tools/list`, `tools/call list_workflows` | ✅ | 4 tools; `implement-issue` listado | `serverInfo.version` estava fixo em `0.2.0`; agora vem do `package.json` |

## 3. Correções feitas antes de qualquer teste pago

| Item | Método | Resultado | Evidência | Ação tomada |
|---|---|---|---|---|
| Teto `--max-cents` com uso incluído no plano | leitura de `src/runtime/engine.ts` (`chargeUsage`) e de `usage-types.d.ts` do SDK | ❌ o teto somava só `chargedCents`, que é 0 para uso incluído no plano, BYOK e créditos: nunca disparava | `UsageCost.chargedCents`: "0 for plan-included, BYOK, and credit-grant usage"; `rawCostCents`: "0 for request-priced usage" | Teste primeiro (3 testes novos, vermelhos), depois `spentCents` = Σ max(bruto, cobrado) por tentativa, `chargedCents` separado no resultado, aviso quando o custo ainda não chegou. 24 testes passam. O teto de tokens continua sendo a garantia que vale sempre |

## 4. Fase 2, Bloco 1: conta Free pessoal (2026-11-11)

**Ambiente:** plano Free (conta pessoal nova) · `@cursor/sdk@1.3.1` · modelo pedido `composer-2.5` (nenhuma inferência
rodou) · `settingSources`: padrão do `probe-sdk.ts` (`[]`) · Linux x64 (WSL2).

Conta Free nova, login pelo SDK (`wf login`, `Cursor.auth.login()` com `NO_OPEN_BROWSER=1`). Nenhuma inferência
rodou: custo zero.

| Item | Método | Resultado | Evidência | Ação tomada |
|---|---|---|---|---|
| Login do SDK sem navegador local | `NO_OPEN_BROWSER=1 npm run wf -- login`; URL aberta em outro dispositivo | ✅ | A URL vai para o stderr; a chave vale 90 dias (`expiresAt` 2027-02-09); `~/.cursor/sdk` 0700 e `auth.json` 0600; a saída não contém a chave | — |
| Janela do login | duas URLs abertas sem conclusão | ⚠ expira em poucos minutos | "Login failed or timed out. Please try again." | Docs: gerar a URL só quando a pessoa estiver pronta |
| `wf whoami` (`Cursor.me()`) no Free | CLI | ❌ | `[plan_required] Cloud Agent is not available for free users. Please upgrade to Pro.` | Registrado; o erro vem da API, não do kit |
| `npm run models` | CLI | ❌ bug do kit | `tsx -e` com `await` no topo: "Top-level await is currently not supported with the \"cjs\" output format" | Novo comando `wf models`; `npm run models` aponta para ele |
| `Cursor.models.list()` no Free | `wf models` | ❌ | mesmo `plan_required` | — |
| Agente **local** no Free (`composer-2.5`, sem tools) | `scripts/probe-sdk.ts --mode smoke` | ❌ o SDK exige plano pago já no `Agent.create` | `UnknownAgentError`, `code: plan_required`, `status: 403`, `endpoint: GET /v1/models`, `operation: Agent.create`, `isRetryable: false`. A validação local do modelo consulta o catálogo, que é bloqueado no Free | Afirmação C18 confirmada pelo teste (a doc não fala do Free). Engine: `plan_required` agora encerra o run na primeira tentativa, inclusive dentro de `parallel` (teste novo; 26 testes) |
| ID de modelo inválido | `--mode invalid-model` | ⏭ inconclusivo no Free | o mesmo `plan_required` acontece antes de o ID ser checado | Fica para uma conta paga |

## 5. Fase 2, Bloco 1 repetido no plano Premium (The X Subscription, 2026-11-11)

**Ambiente:** Premium da The X Subscription · `@cursor/sdk@1.3.1` · `composer-2.5` e um ID inexistente ·
`settingSources`: padrão do `probe-sdk.ts` (`[]`) · Linux x64 (WSL2).

| Item | Método | Resultado | Evidência | Ação tomada |
|---|---|---|---|---|
| `wf whoami` | CLI | ✅ | `apiKeyName: "Cursor SDK login (<host>)"` + e-mail; nada além disso é impresso | — |
| `wf models` | CLI | ✅ 48 modelos | `default` (alias `auto`), `composer-2.5` (aliases `composer-latest`, `composer`, `composer-2-5`), `composer-2`, `grok-4.7`, `gpt-5.3-codex` (aliases `codex-latest`, `codex`, `codex-5.3`), `claude-haiku-5-5`… **`auto-low` não existe** | Defaults de `WF_MODEL_*` revistos (§6) |
| ID inválido | `probe-sdk.ts --mode invalid-model` | ✅ | `ConfigurationError` no `Agent.create`: "Cannot use this model: wf-probe-modelo-inexistente. Available models: default, grok-4.7, …", `isRetryable: false` | — |
| `send` mínimo | `probe-sdk.ts --mode smoke --model composer-2.5` | ✅ | `status: finished`, `result: "OK"`, 4,3 s; deltas: 1 `step-completed`, 1 `turn-ended`; `RunResult.model = {id: "composer-2.5"}` | — |
| `inputTokens` inclui o cache? (C45) | `RunResult.usage` e `turn-ended` do mesmo send | ✅ **inclui**: `totalTokens` 3377 = `inputTokens` 3345 + `outputTokens` 32; `cacheReadTokens` 384 está contido no input | doc Python (`python.md:697`) confirmada; a fórmula da doc TS (`typescript.md:649`) não bate com o dado | Fórmulas do kit corrigidas (§6) |
| `agent.getUsage()` em agente local | releitura a 0, 5, 15 e 30 s | ❌ | `UnknownAgentError` `[feature_unavailable] This feature is not available for your account` em todas | O engine já usa os tokens dos `turn-ended` (correção anterior); custo do Cursor indisponível nesta conta |
| `Agent.getUsage(agentId)` estático após o descarte | idem | ❌ | mesmo `feature_unavailable` | `wf metrics reconcile` não funciona enquanto a conta não tiver o recurso; custo só por estimativa (tabela `pricing`) |

## 6. Fase 2, Bloco 3: sondas de granularidade, modelo resolvido e modelos de terceiros

**Ambiente:** Premium da The X Subscription · `@cursor/sdk@1.3.1` · `composer-2.5`, `composer`, `default` e
`gpt-5.3-codex` · `settingSources`: padrão do `probe-sdk.ts` (`[]`) · Linux x64 (WSL2).

| Item | Método | Resultado | Evidência | Ação tomada |
|---|---|---|---|---|
| Granularidade dos eventos | `probe-sdk.ts --mode read` (`composer-2.5`, lê 4 arquivos) | ✅ medido | 1 `send` → 4 `tool-call-started`, 4 `tool-call-completed`, 1 `tool-requests-listed`, 2 `thinking-completed`, **1** `step-completed`, 1 `turn-ended` | `avg_prompt_per_step` não é contexto por chamada: um passo agrupou 4 tools e 2 chamadas ao modelo. Comentários do schema e doc 09 corrigidos |
| `turn-ended` × `RunResult.usage` | mesmo run | ✅ iguais | `{input 11260, output 256, cacheRead 4480, cacheWrite 0}` nos dois; `totalTokens` 11516 = input + output | Fórmulas: `prompt_tokens` = input; `cacheHitRatio` = cacheRead / input; reserva de tokens = input + output; estimativa cobra o input sem cache pela tarifa de input (testes novos) |
| `RunResult.model` com alias (C09) | `--mode smoke --model composer` | ✅ **devolve o ID resolvido** | pedido `composer` → `RunResult.model = {id: "composer-2.5"}` | O `step-end` passa a trazer `resolvedModel`. A lição "RunResult.model ecoa o pedido" estava errada |
| `RunResult.model` com Auto | `--model default` | ⚠ | devolve `{id: "default"}`: a rota do Cursor Router não aparece | Documentado |
| Modelo de terceiros no Premium | `--model gpt-5.3-codex` | ❌ sem crédito pré-pago | run com `status: "error"` (não exceção): "Codex 5.3 is not included in your weekly usage Buy credits or switch to a Grok model to continue." | Defaults viram modelos do Cursor: `composer-2.5` (CLASSIFY, LOW), `grok-4.7` (MED), `grok-4.7` com `reasoning_effort=high` (HIGH, REVIEW) |
| Erro de uso/franquia: exceção ou `status: "error"`? (C17) | mesmo run | ◐ | a falta de franquia para o modelo veio como `status: "error"` com mensagem, não como `RateLimitError` | O engine trata como falha de run (com uma nova tentativa). O teto mensal do plano não foi atingido, então segue sem teste |

## 7. Fase 2, Blocos 4 e 5: saída estruturada, contexto do projeto e guarda contra recursão

**Ambiente:** Premium da The X Subscription · `@cursor/sdk@1.3.1` · `composer-2.5` · `settingSources`
`["project","team","mdm"]`, `["team","mdm"]` e `[]` · Linux x64 (WSL2). As 58 skills contadas abaixo vieram da
máquina do autor; a origem delas não foi isolada.

Workflows de verificação em `.agents/workflows/` de um repositório de teste local (o carregamento dessa pasta pelo
`wf list --cwd` foi confirmado: os 3 aparecem ao lado do `implement-issue`). Modelo `composer-2.5`.

| Item | Método | Resultado | Evidência | Ação tomada |
|---|---|---|---|---|
| `submit_result` aparece e é chamado | etapa com `schema` e `tools: ["read"]` | ✅ | `{name: "wf-probe-repo", version: "1.2.3"}`; tool calls `read: 1, mcp: 1` | — |
| JSON inválido volta para correção | schema com `minItems: 3`; prompt manda enviar 1 item primeiro | ✅ dentro do mesmo turno | `mcp: 2` (1ª chamada recusada pelo Ajv, 2ª com 3 arquivos); `schemaReprompts: 0` | — |
| Re-prompt do engine (run termina sem `submit_result`) | prompt pede só texto, sem tools | ⏭ não exercitado | o modelo chamou `submit_result` mesmo assim (a instrução de schema do engine prevaleceu) | Coberto só pelos testes offline |
| `AgentBusyError` | 3 etapas com schema | ✅ nenhum | — | — |
| `AGENTS.md` nas runs locais | palavra marcadora no `AGENTS.md`; `settingSources` `["project","team","mdm"]` × `[]` | ✅ **opt-in** | `ORNITORRINCO-42` com `project`; `NENHUMA` com `[]` e com `["team","mdm"]` | Doc confirmada do lado do pacote; a página do SDK só cita MCP e subagents |
| Hooks do Cursor (`.cursor/hooks.json`) | `beforeShellExecution` e `postToolUse` gravando num log | ✅ só com `project` | log com `beforeShellExecution "echo hook-ok"` e `postToolUse` para `Shell` e `MCP:submit_result`; nada com `[]` | — |
| Hook `PreToolUse` do Claude Code (`.claude/settings.json`) | `matcher: "*"`, `exit 2` para comandos com a palavra marcada | ✅ dispara e **bloqueia** com `project` | o agente recebeu "bloqueado pelo hook PreToolUse do Claude Code"; nomes vistos pelo hook: `Shell`, `MCP:submit_result`; com `[]` o comando rodou | Paridade documentada: hooks do Claude Code valem nas etapas do kit |
| `.cursor/mcp.json` do projeto | servidor `workflows` com log de spawn | ✅ só com `project` | 1 spawn por etapa com `project`; nenhum com `[]` | — |
| Guarda contra recursão (`WF_INSIDE_WORKFLOW`) | `mcpTools` listadas pela etapa | ❌ → ✅ após correção | antes: a etapa via `list_workflows`, `start_workflow`, `wait_workflow`, `get_workflow_status`, e o servidor subia com `WF_INSIDE_WORKFLOW` vazio (o SDK não repassa o ambiente aos servidores do arquivo). Depois: só `FetchMcpResource` e `submit_result` | Engine registra um MCP inline `workflows` sem tools (`src/runtime/nested-mcp-guard.mjs`), que vence o do arquivo pelo nome; teste novo. O servidor do arquivo ainda sobe, sem expor tools |
| `WF_INSIDE_WORKFLOW` no shell da etapa | `echo inside=$WF_INSIDE_WORKFLOW` | ✅ | `inside=1`: a guarda do CLI (`wf run/start`) vale | — |
| Contexto fixo por camada | `RulesService` no log do SDK e `inputTokens` | ⚠ medido | com `project` ou só `["team","mdm"]`: `ruleCount 58, skillCount 58`; com `[]`: nenhuma skill. Mesmo prompt com `shell`+`mcp`: 30,4 mil tokens de input com `project` × 25,5 mil com `[]` | Doc 08: `["team","mdm"]` não corta as skills; só `[]` corta (e então hooks do time e MDM também saem) |

## 8. Fase 2, Bloco 6: cache de prompt entre agentes irmãos

**Ambiente:** Premium da The X Subscription · `@cursor/sdk@1.3.1` · `composer-2.5` · `settingSources: []` · Linux
x64 (WSL2).

Mesmo prompt e mesmas opções (`composer-2.5`, `tools: ["read"]`, `settingSources: []`), lendo 3 arquivos: duas etapas
em `ctx.parallel` e duas em sequência. Cada etapa é um agente novo.

| Etapa | `inputTokens` | `cacheReadTokens` | Leitura |
|---|---|---|---|
| `par-1` | 11.287 | 4.160 | só o prefixo fixo |
| `par-2` (terminou 1,2 s depois) | 11.287 | 8.064 | prefixo fixo + o trecho com os arquivos, gravado pela irmã |
| `seq-1` | 11.287 | 4.160 | só o prefixo fixo |
| `seq-2` (começou depois do fim de `seq-1`) | 11.287 | 4.160 | não reaproveitou o trecho com os arquivos |

| Item | Método | Resultado | Evidência | Ação tomada |
|---|---|---|---|---|
| Agentes irmãos compartilham prefixo? (C43) | tabela acima | ◐ parcial e sem garantia | o prefixo fixo (~4,2 mil tokens) veio do cache em todo agente novo; o trecho variável foi reaproveitado uma vez em paralelo e nenhuma vez em sequência; `cacheHitRatio` do run 0,455 | O kit continua sem prometer economia entre agentes e mede; doc 08 recebe os números |
| Custo dos Blocos 4 a 6 | `SELECT SUM(cost_cents) FROM v_attempts` em `~/tmp/wf-verify.db` | estimativa | 9,01 ¢ pela tabela `pricing` (preço de lista do Composer 2.5; `cost_source = estimate` em todas, porque `getUsage()` dá `feature_unavailable`); as sondas fora do banco somam ≈ 0,82 ¢ | Uso do Composer no Premium sai da franquia semanal; o valor cobrado de fato só aparece no dashboard da conta |

## 9. Fase 2, Bloco 7: ponta a ponta (`implement-issue` no repositório `wf-sandbox`)

**Ambiente:** Premium da The X Subscription · `@cursor/sdk@1.3.1` · `composer-2.5` (`implementar`, LOW) e
`grok-4.7` sem `params` (`corrigir-1`, MED) · `settingSources`: default do engine (`["project","team","mdm"]`) ·
Linux x64 (WSL2).

Repositório: [rodrigorjsf/wf-sandbox](https://github.com/rodrigorjsf/wf-sandbox) (público, descartável; recrie um igual com
[`scripts/verify/setup-sandbox-repo.sh`](../../scripts/verify/setup-sandbox-repo.sh)). Primeiro run: issue #1 "Add subtract(a, b) to src/math.js", rótulo `complexity:low`; `--args '{"issue":1,"testCommand":"npm test","openPr":true}'`, `--max-tokens 300000`, `--max-cents 50`.

| Item | Método | Resultado | Evidência | Ação tomada |
|---|---|---|---|---|
| Roteamento por rótulo | log do run | ✅ | `Issue #1 → tier LOW (modelo composer-2.5)`; `tier_source = label`; sem etapa de classificação nem de plano | — |
| Etapa `implementar` | `composer-2.5`, todas as tools | ✅ | 74.903 tokens; `read 3, edit 2, shell 3`; o diff final só toca `src/math.js` e `test/math.test.js` | — |
| Testes pelo código do workflow | `runTests` | ❌ falha de **ambiente** | `bash -lc` carrega o perfil de login, que põe `~/.local/bin` na frente do PATH e troca o npm do `mise exec` (22.23.4) pelo do Node 22.11, que está quebrado | `runTests` passa a usar `bash -c` e herdar o ambiente de quem chamou (teste novo em `test/implement-issue.test.ts`) |
| Etapa `corrigir-1` | `grok-4.7` | ⚠ **editou um arquivo fora do repositório** | 269.473 tokens (`read 11, shell 5, glob 5, grep 2, edit 1`); o agente alterou `~/.local/share/mise/installs/node/22.11.0/bin/npm` (wrapper do mise) para resolver o symlink, e os testes passaram. Cópias das duas versões guardadas | Prova concreta do risco descrito no doc 07: etapas locais com `shell`/`edit` e sem sandbox escrevem em qualquer lugar. O arquivo foi revertido para o original do mise (idêntico ao do Node 22.23.4) a pedido do dono da máquina. No kit: `runTests` sem shell de login e regra de escopo nas instruções das etapas que escrevem (teste novo). A regra é só um pedido no prompt; o risco ficou registrado em docs 07 (Segurança). O sandbox do SDK exige `bubblewrap` no Linux (ausente nesta máquina) e a doc só fala em restringir chamadas de shell: fica opcional, com teste pendente (§12) |
| Commit, push e PR | código do workflow | ✅ | branch `wf/issue-1`, commit `6ef5b48`, PR #2 | — |
| Teto de tokens | `--max-tokens 300000` | ⚠ excedido por uma etapa | 344.376 tokens: o teto é checado antes de cada tentativa, e a `corrigir-1` sozinha gastou 269 mil | Docs 02 §3, 03 e 07: o teto não garante gasto máximo; uma etapa não tem teto de tokens próprio, só o `timeoutMs` de cada envio, e a recomendação é um `timeoutMs` curto nas etapas que escrevem |
| Resume sem repetir | `--resume implement-issue-97f23b02` | ✅ | 0 tokens; `implementar` veio do journal; testes passaram; mesmo commit `6ef5b48`; continua 1 PR | — |
| `npm run stats` | banco `~/tmp/wf-verify.db` | ✅ | 5 runs, 618.261 tokens, 35,33 ¢ estimados (`implement-issue` 26,33 ¢, dos quais 24,30 ¢ da `corrigir-1` em `grok-4.7`) | — |
| `wf metrics reconcile` | idem | ❌ esperado | `{"updated": 0, "failed": 13}`: `Agent.getUsage(agentId)` dá `feature_unavailable` nesta conta | Documentado |

### Reteste sobre a árvore publicada

Depois de todas as correções de código, o mesmo caminho rodou de novo, a partir da árvore montada para publicação
(`npm ci` feito nela), com uma issue nova a cada vez. Antes de cada run foi criado um arquivo marcador; depois,
`find "$HOME" -newer <marcador>` (sem as pastas de trabalho, caches e estado do Cursor e do Claude) procurou arquivos
alterados fora do repositório.

| Item | Método | Resultado | Evidência | Ação tomada |
|---|---|---|---|---|
| Issue #3 "Add multiply(a, b)", código do commit `ea49e05` | `--max-tokens 200000`, `--max-cents 30` | ✅ | [PR #4](https://github.com/rodrigorjsf/wf-sandbox/pull/4); `implementar` com 85.078 tokens; testes do workflow (`bash -c`) passaram de primeira (`fix_rounds 0`); **nenhum arquivo alterado fora do repositório**. O shell do agente carrega o perfil de login e achou o npm quebrado; o agente relatou o problema e rodou `node --test`, sem mexer no ambiente | Depois deste run, a regra de escopo entrou também na correção de review (`8ec5890`), o que pediu um novo reteste |
| Issue #5 "Add max(a, b)", **código publicado** (`8ec5890`) | idem | ✅ | [PR #6](https://github.com/rodrigorjsf/wf-sandbox/pull/6); `implementar` com 75.820 tokens; `fix_rounds 0`; nenhum arquivo alterado fora do repositório; o agente de novo relatou o npm quebrado do shell dele sem corrigir o ambiente | — |
| Resume dos dois retestes | `--resume <runId>` | ✅ | 0 tokens; `implementar` veio do journal; mesmos commits (`d3890ed`, `e55db58`); continua um PR por issue | — |
| Custo acumulado das Fases 1 e 2 | `SELECT ROUND(SUM(cost_cents),2) FROM v_attempts` em `~/tmp/wf-verify.db` | estimativa | 39,64 ¢ por preço de lista (779.159 tokens; `cost_source = estimate`, porque `getUsage()` dá `feature_unavailable`), mais ≈ 0,82 ¢ das sondas fora do banco | O valor cobrado de fato só aparece no dashboard de uso da conta (Composer e Grok saem da franquia semanal do Premium) |

## 10. Fase 2, Blocos 9 e 10: Claude Code e dashboard

**Ambiente:** nenhuma inferência do Cursor · Claude Code com `claude -p --model haiku` · MCP server do kit sobre
`@cursor/sdk@1.3.1` · `settingSources`: não se aplica (nenhuma etapa rodou) · Linux x64 (WSL2).

| Item | Método | Resultado | Evidência | Ação tomada |
|---|---|---|---|---|
| Claude Code vê o servidor do `.mcp.json` | `claude mcp list` no diretório do kit | ✅ pede aprovação | `workflows: node_modules/.bin/tsx src/mcp-server.ts - ⏸ Pending approval` | — |
| Tools MCP no Claude Code | `claude -p --model haiku --settings '{"enableAllProjectMcpServers": true}'` | ✅ | `mcp__workflows__get_workflow_status`, `list_workflows`, `start_workflow`, `wait_workflow` | — |
| `CLAUDE.md` → `@AGENTS.md` | mesma execução | ✅ | o agente citou o título "Instruções para agentes neste repositório" | — |
| Dashboard escuta só em localhost | `ss -ltnp` | ✅ | `127.0.0.1:4317` | — |
| `Host` estranho | `curl -H 'Host: evil.example'` | ✅ | 403 (localhost e 127.0.0.1: 200) | — |
| CORS | cabeçalhos da resposta | ✅ | nenhum `Access-Control-*` | — |
| Acesso pelo IP do WSL | `curl http://<ip-do-wsl>:4317` | ✅ recusado | sem conexão | — |
| Navegador do Windows | `.wslconfig` | ⏭ pendente (precisa de alguém na máquina) | `networkingMode=nat` (o localhost do WSL é encaminhado ao Windows por padrão) | Fica na lista de pendências (§12) |

## 11. Fase 1: as 74 afirmações conferidas na documentação ao vivo (2026-11-11)

Em 2026-11-11, as páginas foram baixadas pelos endpoints de markdown cru (`cursor.com/docs/<p>.md`,
`cursor.com/help/<p>.md`, `code.claude.com/docs/en/<p>.md`), e os tópicos do fórum por `forum.cursor.com/raw/<id>`.
Um verificador por lote de afirmações procurou texto que as contradissesse, e um cético independente refez cada
veredito que muda um documento. Um crítico de completude acrescentou X01–X12. Cada trecho citado foi conferido com
`grep -F` no arquivo baixado: todos estão lá, e um trecho do X10 está numa linha diferente da citada. Cada linha
traz no máximo uma citação curta; o resto é paráfrase. Os relatos do fórum aparecem só parafraseados, com o link
do tópico.

**Contagem:** 27 ✅ · 38 ◐ · 3 ❌ · 6 ❔.

"l." é a linha no arquivo baixado em 2026-11-11; a página ao vivo pode mudar. Quando um teste deste arquivo resolveu
o que a doc deixou em aberto ou contradisse, o Resultado traz a nota `teste:` (ou `npm:`) com a seção. "Ação tomada"
aponta onde o texto corrigido está agora: docs do kit (`docs 0N`), relatório de pesquisa (`relatório §`) ou skills.

| Item | Método | Resultado | Evidência | Ação tomada |
|---|---|---|---|---|
| C01: Runs locais do SDK seguem regras de plano, pools e Privacy Mode do IDE | doc ao vivo | ✅ | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 54: `same pricing, request pools, and Privacy Mode rules as runs from the IDE and Cloud Agents` · [account/pricing/legacy-cursor-plans](https://cursor.com/docs/account/pricing/legacy-cursor-plans) l. 64: o plano legado Start não inclui o Cursor SDK | mantido, agora com [DOC]; redação ajustada (cobrança, não o que o plano inclui): docs 07 (Orçamento); relatório §5 |
| C02: Uso do SDK tem tag SDK; chave de usuário cobra o usuário, service account o time | doc ao vivo | ✅ | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 54: o uso aparece sob a tag SDK · [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 56: `Service account API keys bill to the team that owns the service account. User API keys bill to that user's plan.` | mantido, agora com [DOC] (+ filtro SDK nas páginas de Usage): docs 07 (Orçamento); relatório §5 |
| C03: Uso com chave de usuário do SDK entra no limite em dólares do membro | doc ao vivo | ❔ | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 56: `User API keys bill to that user's plan.` · [account/teams/pricing](https://cursor.com/docs/account/teams/pricing) l. 80: limite mensal por membro, sem citar o SDK | mantido como pergunta aberta; pergunta para os admins: docs 07 (Orçamento, Checklist); relatório §5 e §8 item 1 |
| C04: Chaves Team Admin não são aceitas pelo SDK | doc ao vivo | ✅ | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 43: `Team Admin API keys are not yet supported.` | mantido, agora com [DOC], como limite atual: docs 02 §1; docs 07 (Orçamento) |
| C05: Auto: US$ 1,25/M input e cache write, 0,25/M cache read, 6,00/M output | doc ao vivo | ❌ | [models-and-pricing](https://cursor.com/docs/models-and-pricing) l. 161: `Auto has three modes: Cost, Balance, and Intelligence.` · [models-and-pricing](https://cursor.com/docs/models-and-pricing) l. 163: o modo Cost (o Auto clássico) cobra como request de modelo do Cursor | tabela de preço fixo retirada; modos Cost, Balance e Intelligence e a divergência entre páginas: docs 08 §1; relatório §5.1 e §8 |
| C06: Em Teams/Enterprise, terceiros pagam Cursor Token Rate; isento se cache read < US$ 0,10/M | doc ao vivo | ✅ | [models-and-pricing](https://cursor.com/docs/models-and-pricing) l. 151: `eligible third-party model requests include a Cursor Token Rate of $0.25 per million tokens` · [models-and-pricing](https://cursor.com/docs/models-and-pricing) l. 157: isenção só com cache read estritamente abaixo de US$ 0,10/M em toda faixa de preço | mantido, agora com [DOC]; precisado (estritamente, toda faixa; Cursor, modo Cost e BYOK isentos): docs 08 §1; relatório §5 |
| C07: Haiku 5.5 no Cursor: 0,10/0,50 até 100k, 0,50/2,50 acima, como na API | doc ao vivo | ◐ | [models/claude-haiku-5-5](https://cursor.com/docs/models/claude-haiku-5-5) l. 26: `Requests up to 100k input tokens bill at $0.10/M input and $0.50/M output.` · [models-and-pricing](https://cursor.com/docs/models-and-pricing) l. 56: cobra o preço de lista da API do modelo desde a primeira request | tabela completa e efeito do plano; igualdade com a API da Anthropic fica em aberto: docs 09 §2 (Faixas de preço); relatório §5.2 |
| C08: Subagent do IDE com modelo bloqueado troca em silêncio; no SDK, ID fora do catálogo falha | doc ao vivo | ◐; teste: `ConfigurationError` «Cannot use this model» (§5) | [subagents](https://cursor.com/docs/subagents) l. 173: `Cursor falls back to a compatible model.` · [release-notes](https://cursor.com/docs/release-notes) l. 110: o resultado do subagent diz em que modelo ele rodou | fallback não é silencioso para o agente pai; no SDK, `ConfigurationError` (a doc cita «Bad model name»): relatório §5 e §8; docs 02 §2; docs 07 (Políticas de admin) |
| C09: Política de modelo do admin: SDK falha ou troca em silêncio; `RunResult.model` ecoa o pedido | doc ao vivo | ◐; teste: devolve o ID resolvido (§6) | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 2242: política do admin que bloqueia o pedido é causa de `ConfigurationError` · [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 706: `run.model`/`result.model` refletem a seleção que a run de fato usou | docs 02 §2; docs 07 (Políticas de admin); docs 03 (O que não garante); relatório §5; troca por política: pergunta para os admins (relatório §8 item 4) |
| C10: Timeout de chamada de tool MCP no Cursor IDE não é documentado | doc ao vivo | ❔ | [mcp](https://cursor.com/docs/mcp) l. 388: `The tool call is marked as failed` · [release-notes/sdk](https://cursor.com/docs/release-notes/sdk) l. 21: os 60 s fixos eram da conexão de MCP stdio em agentes locais do SDK | mantido como pergunta aberta: docs 04 §1; relatório §4 e §8 item 2 |
| C11: Hooks de `.cursor/hooks.json` e do Claude Code rodam no SDK local com `project` | doc ao vivo | ◐; teste: ✅ (§7) | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 1808: hooks locais: `.cursor/hooks.json` do `local.cwd` ou `~/.cursor/hooks.json`, sem citar `settingSources` · [release-notes/sdk](https://cursor.com/docs/release-notes/sdk) l. 8: `Claude Code hooks that deny a tool call now block it in local agents.` | doc não liga hooks a `settingSources`; o teste mostrou que só rodam com `project`: docs 02 §5; docs 04 (Paridade); relatório §6; `~/.claude/settings.json`, `team` e `mdm` em aberto (relatório §8 item 3) |
| C12: Cursor carrega hooks do Claude Code, com `loop_limit` `null` em vez de 5 | doc ao vivo | ✅ | [hooks](https://cursor.com/docs/hooks) l. 18: `Cursor supports loading hooks from third-party tools like Claude Code.` · [hooks](https://cursor.com/docs/hooks) l. 714: `loop_limit`: default 5 nos hooks do Cursor, `null` nos do Claude Code | mantido, agora com [DOC]: relatório §2.3 e §6; docs 04 (Paridade) |
| C13: Em cloud agents, `sessionStart`, `sessionEnd` e hooks de MCP não disparam | doc ao vivo | ◐ | [hooks](https://cursor.com/docs/hooks) l. 90: `beforeMCPExecution`/`afterMCPExecution` adiados em cloud agents · [hooks](https://cursor.com/docs/hooks) l. 104: em workers self-hosted (Pools, My Machines), `sessionStart` e `sessionEnd` disparam | restrito a cloud agents hospedados pelo Cursor; workers self-hosted e MCP HTTP: relatório §6; docs 04 §4 |
| C14: Release note: deny de `PreToolUse` do Claude Code bloqueia agentes locais do SDK | doc ao vivo | ✅; teste: ✅ (§7) | [release-notes/sdk](https://cursor.com/docs/release-notes/sdk) l. 8: `Claude Code hooks that deny a tool call now block it in local agents.` · [release-notes/sdk](https://cursor.com/docs/release-notes/sdk) l. 8: antes da 1.0.40, o agente local ignorava o deny e rodava a tool | redação: bloqueia a tool call, não o agente; só local: relatório §6; docs 04 (Paridade) |
| C15: Doc só cita rate limit por time e minuto; sem limite de agentes por usuário | doc ao vivo | ◐ | [account/teams/admin-api](https://cursor.com/docs/account/teams/admin-api) l. 66: `Rate limited to 20 requests per minute per team.` · [cloud-agent/api/endpoints](https://cursor.com/docs/cloud-agent/api/endpoints) l. 412: só uma run ativa por agente | «por time, por minuto» só na Admin API; outros limites listados; visão geral da API não conferida: relatório §3 e §8 item 5 |
| C16: Não documentado se o Cursor deduplica skill em `.agents/skills/` e `.claude/skills/` | doc ao vivo | ❔ | [skills](https://cursor.com/docs/skills) l. 78: também carrega `.claude/skills/` e `.codex/skills/` por compatibilidade · [subagents](https://cursor.com/docs/subagents) l. 92: precedência só documentada para subagents (`.cursor/` vence) | mantido como pergunta aberta: docs 04 (Onde cada harness procura); docs 01 §7; relatório §8 item 6 |
| C17: Teto de uso da conta chega como `RateLimitError` (429), não como run com erro | doc ao vivo | ◐; teste: ◐ (§6) | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 2241: `Burst limit or monthly usage cap.` · [account/enterprise/service-accounts](https://cursor.com/docs/account/enterprise/service-accounts) l. 97: acima do teto, as requests da service account são bloqueadas com o erro «Service account spend limit reached» | sem «429»; tratar os dois caminhos: docs 02 §3; docs 03 (Ciclo de uma etapa, passo 9); relatório §5 e §8 item 7 |
| C18: SDK exige plano pago; no Free, run local falha com `plan_required` | doc ao vivo | ◐; teste: ✅ (§4) | [account/pricing/legacy-cursor-plans](https://cursor.com/docs/account/pricing/legacy-cursor-plans) l. 68: Pro, Pro+ e Ultra (legados) incluem o Cursor SDK · [account/pricing/legacy-cursor-plans](https://cursor.com/docs/account/pricing/legacy-cursor-plans) l. 64: Start, plano pago legado, não inclui o SDK | Free medido; Start sem SDK; Plus não testado: docs 01 §1; docs 07 (Orçamento); relatório §5 |
| C19: Políticas de admin para MCP, rede e tools valem nas runs locais do SDK | doc ao vivo | ◐ | [release-notes/sdk](https://cursor.com/docs/release-notes/sdk) l. 71: denylist de comandos do admin vale nas runs locais (SDK 1.0.27) · [release-notes](https://cursor.com/docs/release-notes) l. 650: `Cloud Agents follow your team's plugin and MCP allowlist.` | só denylist de comandos e bloqueio por `ConfigurationError` documentados; MCP e rede: pergunta para os admins: docs 07 (Políticas de admin); relatório §5 |
| C20: SDK TS exige Node ≥ 22.13; versão 1.3.1 de 2026-11-03; beta desde 2026-04-29 | doc ao vivo | ◐; npm: 1.3.1 de 2026-11-03 (§2) | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 78: `The SDK requires Node.js 22.13 or later.` · [release-notes/sdk](https://cursor.com/docs/release-notes/sdk) l. 5: a entrada mais nova das notas do SDK é a 1.0.40, sem data | versão creditada ao npm; «beta desde 2026-04-29» sem fonte: relatório §2.1; docs 01 §1–2 |
| C21: SDK Python: sync e async, mesmo commit do TS, wheel embute a bridge | doc ao vivo | ◐ | [release-notes/sdk](https://cursor.com/docs/release-notes/sdk) l. 88: `ship from the same release and share a version number` · [sdk/bridge](https://cursor.com/docs/sdk/bridge) l. 63: a wheel traz o binário; `cursor-sdk-bridge` fica no `PATH` | «mesmo commit» virou «mesma release desde a 1.0.24»: relatório §2.1 |
| C22: A bridge `cursor/sdk-bridge` é servidor Connect/gRPC local que expõe `sdk.v1` | doc ao vivo | ◐ | [sdk/bridge](https://cursor.com/docs/sdk/bridge) l. 38: `Classic gRPC over HTTP/2 will not connect.` · [sdk/bridge](https://cursor.com/docs/sdk/bridge) l. 36: porta loopback HTTP/1.1 servindo `sdk.v1` | não é gRPC: Connect/protobuf sobre HTTP/1.1: relatório §2.1 e §8 |
| C23: `local` roda o loop na máquina; `cloud` em VM, pool ou My Machines; inferência na Cursor | doc ao vivo | ✅ | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 2101: `cloud` usa VMs da Cursor; `pool` e `machine` vão a workers self-hosted · [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 31: `All inference goes through Cursor's hosted models` | mantido, agora com [DOC]: relatório §2.1 |
| C24: `ModelSelection` em create, send e subagents inline; `Cursor.models.list()` lista os modelos | doc ao vivo | ✅; teste: ✅ 48 modelos (§5) | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 770: `model` por send sobrepõe `agent.model` e fica valendo · [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 305: `Cursor.models.list()` lista os modelos da conta e do time da chave | mantido, agora com [DOC] (`maxMode` só nas notas do SDK): relatório §2.2 |
| C25: `settingSources` aceita project…all; contexto do projeto é opt-in no local | doc ao vivo | ◐; teste: ✅ (§7) | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 2200: cloud sempre carrega `project`/`team`/`plugins` e ignora o campo · [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 1546: sem `local.settingSources`, só MCP inline; nada sobre `AGENTS.md`, regras ou skills | a doc só liga `settingSources` a MCP e subagents; o resto, confirmado por teste: relatório §2.2; docs 02 §5 |
| C26: SDK sem saída estruturada: `result` é string; `outputSchema` é só descritivo | doc ao vivo | ◐ | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 569: texto final em `result.result`, como string · [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 1777: `Results are not validated against it.` | «não documentada» em vez de «não existe»: relatório §2.2 e §3 |
| C27: `RateLimitError` (429), `ConfigurationError` e `AuthenticationError` (401): o que cada um cobre | doc ao vivo | ◐; teste: ID inválido → `ConfigurationError` (§5) | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 2241: `Burst limit or monthly usage cap.` · [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 2230: só um `status?: number` genérico, com o status HTTP quando houver | sem «429» e «401»: relatório §2.2 e §8 |
| C28: `Cursor.auth.login()` cria chave de 90 dias em `~/.cursor/sdk/auth.json`; ordem de resolução | doc ao vivo | ✅; teste: ✅ 90 dias (§4) | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 1334: login no navegador cria chave de usuário (90 dias) em `~/.cursor/sdk/auth.json` · [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 1364: ordem: `apiKey`, `CURSOR_API_KEY`, login salvo | mantido, agora com [DOC]: docs 02 §1; relatório §5 |
| C29: O SDK não reaproveita o login da IDE nem o da CLI `agent` | doc ao vivo | ◐ | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 2336: `The SDK doesn't auto-discover credentials from a local Cursor app installation.` · [cli/reference/parameters](https://cursor.com/docs/cli/reference/parameters) l. 10: a CLI também aceita `CURSOR_API_KEY` | IDE com [DOC]; CLI por dedução da ordem de resolução; a mesma chave serve aos dois: docs 02 §1; docs 07 (Orçamento); relatório §5 |
| C30: Service accounts (Enterprise) servem a CI, cobram o time e perdem a atribuição | doc ao vivo | ◐ | [account/enterprise/service-accounts](https://cursor.com/docs/account/enterprise/service-accounts) l. 24: `Service accounts consume usage from your team's usage pool, just like human users.` · [account/enterprise/service-accounts](https://cursor.com/docs/account/enterprise/service-accounts) l. 14: liga as runs de cloud agent ao serviço ou sistema que as iniciou | uso atribuído à service account (`serviceAccountId`), não «perda»: docs 07 (Orçamento); relatório §5 |
| C31: CLI headless: `agent -p --model X --output-format stream-json --force`, e flag `-w` | doc ao vivo | ✅ | [cli/headless](https://cursor.com/docs/cli/headless) l. 103: `agent -p --force --output-format stream-json --stream-partial-output` · [cli/reference/parameters](https://cursor.com/docs/cli/reference/parameters) l. 28: `-w, --worktree [name]` roda num worktree novo | mantido, agora com [DOC]: relatório §2.3 |
| C32: Comandos no shell do agente do Cursor estouram em ~300 s | doc ao vivo | ❔ | [release-notes](https://cursor.com/docs/release-notes) l. 2495: cita «the full timeout», sem dar o valor | mantido como pergunta aberta: docs 04 §2; relatório §4 e §8 item 8 |
| C33: Cloud Agents API `/v1`; Automations por cron, webhook, GitHub, Linear; cobra como cloud agent | doc ao vivo | ✅ | [cloud-agent/api/endpoints](https://cursor.com/docs/cloud-agent/api/endpoints) l. 5: `The Cloud Agents API v1 is in public beta.` · [cloud-agent/automations](https://cursor.com/docs/cloud-agent/automations) l. 31: Automations criam cloud agents e são cobradas como uso de cloud agent | mantido, agora com [DOC]: relatório §2.3 |
| C34: `@cursor/bdk`: agents-as-code «por trás do Bugbot», para bots implantados | doc ao vivo | ◐ | [agent-sdk](https://cursor.com/docs/agent-sdk) l. 53: o pacote agora é `@grok/agent-sdk`; antes, `@cursor/bdk` · [agent-sdk](https://cursor.com/docs/agent-sdk) l. 4: `that powers Bugbot, Security Review, Approval Bot, and Rollouts.` | novo nome; usa o harness que move o Bugbot; atua por Slack, PRs e Cursor: relatório §2.3 |
| C35: Subagents em `.cursor/agents/`, `.claude/agents/` e `.codex/agents/`; não há `.agents/agents/` | doc ao vivo | ✅ | [subagents](https://cursor.com/docs/subagents) l. 85: subagents de projeto em `.cursor/agents/` · [subagents](https://cursor.com/docs/subagents) l. 86: `.claude/agents/` por compatibilidade com o Claude | mantido, agora com [DOC]: docs 04 (Onde cada harness procura); relatório §6 |
| C36: Skills de `.agents/skills/`, `~/.agents/skills/`, `.cursor/skills/`; `.claude/` e `.codex/` por compat. | doc ao vivo | ✅ | [skills](https://cursor.com/docs/skills) l. 65: `.agents/skills/` é pasta de skills de projeto · [skills](https://cursor.com/docs/skills) l. 78: `For compatibility, Cursor also loads skills from Claude and Codex directories` | mantido, agora com [DOC] (`~/.agents/skills/` não vai a Cloud Agents): docs 04 (Onde cada harness procura); relatório §6 |
| C37: Skill com `disable-model-invocation: true` só roda via `/nome` | doc ao vivo | ✅ | [skills](https://cursor.com/docs/skills) l. 175: `The agent will not automatically apply it based on context.` | mantido, agora com [DOC]: docs 04 §3; relatório §4 |
| C38: MCP local: send → create → plugins → projeto → usuário; cloud usa os do time | doc ao vivo | ◐; teste: ✅ inline vence o do arquivo (§7) | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 1540: o `mcpServers` do send substitui os do create (não mescla) · [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 1546: sem `local.settingSources`, só servidores inline | primeiro nome vence, send substitui, `settingSources`, cloud via cursor.com/agents: relatório §6 |
| C39: `mcp.json` interpola `${workspaceFolder}`, `${userHome}` e `${env:VAR}` | doc ao vivo | ✅ | [mcp](https://cursor.com/docs/mcp) l. 208: `${workspaceFolder}` = a pasta que contém o `.cursor/mcp.json` · [mcp](https://cursor.com/docs/mcp) l. 202: resolve em `command`, `args`, `env`, `url` e `headers` | mantido, agora com [DOC]: docs 02 §1; docs 04 (Outros repositórios) |
| C40: `CURSOR_API_KEY` vazia (`${env:...}` indefinido) pode encobrir o login salvo | doc ao vivo | ❔ | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 1364: dá a ordem de resolução; nada sobre valor vazio | mantido como pergunta aberta: docs 02 §1 |
| C41: 60 subagents de usuário somam ~10 mil tokens por chat (11,4k → 1,4k) | doc ao vivo + fórum | ✅ | [fórum 162001](https://forum.cursor.com/t/162001) l. 20: o relato mede 11,4 mil tokens no início de um chat novo com subagents custom · [fórum 162001](https://forum.cursor.com/t/162001) l. 70: resposta: nome e descrição de cada subagent custom entram na tool Task | mantido, agora com [FÓRUM]: docs 08 §4.3; relatório §5.1 |
| C42: A tool Task lista todos os subagents; cada um soma ao contexto fixo | doc ao vivo + fórum | ◐ | [fórum 162001](https://forum.cursor.com/t/162001) l. 72: resposta no tópico: o catálogo de subagents não tem orçamento nem corte, e o contexto cresce com o número de subagents · [subagents](https://cursor.com/docs/subagents) l. 125: `Short description shown in Task tool hints.` | só subagents custom; fonte é o fórum; `explore` e `browser` sem fonte: docs 08 §4.3 e §5; relatório §5.1 |
| C43: No Cursor, agentes irmãos não compartilham prefixo em cache; cada um grava o bloco | doc ao vivo + fórum | ◐; teste: ◐ (§8) | [fórum 173200](https://forum.cursor.com/t/173200) l. 66: resposta no tópico: os workers de um Project não compartilham cache de prompt, e cada um paga a gravação do contexto inicial · [fórum 151439](https://forum.cursor.com/t/151439) l. 290: chat novo no IDE leu do cache um prefixo gravado por outros chats | restrito a workers de um Project; números medidos: docs 08 §2 e §4.7; relatório §3 |
| C44: Cache read «absurdo» em conversas longas: cada turno relê o histórico | doc ao vivo + fórum | ◐ | [fórum 151439](https://forum.cursor.com/t/151439) l. 272: resposta no tópico: uma mensagem costuma disparar várias chamadas ao modelo · [fórum 173469](https://forum.cursor.com/t/173469) l. 62: resposta no tópico: cada chamada ao modelo relê a conversa do cache | a cada chamada ao modelo, não só a cada turno; também em chat novo: docs 08 §4.5 |
| C45: A doc do SDK não diz se `inputTokens` inclui o cache | doc ao vivo | ❌; teste: input inclui o cache (§5) | [sdk/python](https://cursor.com/docs/sdk/python) l. 697: Python: cache read e write já fazem parte de `input_tokens` · [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 649: TypeScript: `totalTokens` = input + output + cacheRead + cacheWrite | fórmulas do kit pelo dado medido (`cacheHitRatio` = cacheRead ÷ input): docs 08 §3; docs 09 §2; relatório §5.2 |
| C46: Com sandbox, escrita só no cwd e rede só pela allowlist do `.cursor/sandbox.json` | doc ao vivo | ◐; teste: ⏭ sem `bubblewrap` (§9, §12) | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 1819: escrita em `local.cwd`, temporários e caminhos do `sandbox.json` · [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 1819: `Reads are not restricted to the workspace.` | + temporários e `~/.cursor/sandbox.json`; leitura livre; desligado por padrão: docs 07 (Segurança) |
| C47: Hooks de Enterprise (MDM), Team, projeto e usuário; deny de qualquer fonte vence | doc ao vivo | ✅ | [hooks](https://cursor.com/docs/hooks) l. 631: deny de qualquer fonte vence ask e allow · [hooks](https://cursor.com/docs/hooks) l. 653: `Priority order (highest to lowest): Enterprise → Team → Project → User` | mantido, agora com [DOC] (+ plugins depois; Team só no Enterprise): docs 07 (Políticas de admin); relatório §5 |
| C48: Hook `beforeMCPExecution` audita ou bloqueia tools MCP, com `failClosed: true` | doc ao vivo | ✅ | [hooks](https://cursor.com/docs/hooks) l. 1062: `failClosed: true` recomendado para `beforeMCPExecution` de segurança · [hooks](https://cursor.com/docs/hooks) l. 810: hooks do dashboard não aceitam `failClosed` | mantido, agora com [DOC] (+ dashboard sem `failClosed`; não roda em cloud): docs 04 §4; docs 07 (Checklist) |
| C49: `stop`/`subagentStop` com `followup_message` continuam sozinhos até `loop_limit` (5) | doc ao vivo | ✅ | [hooks](https://cursor.com/docs/hooks) l. 1335: `Cursor will automatically submit it as the next user message.` · [hooks](https://cursor.com/docs/hooks) l. 1336: o limite padrão é de 5 follow-ups automáticos por script | mantido, agora com [DOC]: relatório §2.3 |
| C50: O SDK aceita `teamId` para quem está em mais de um time | doc ao vivo | ✅ | [release-notes/sdk](https://cursor.com/docs/release-notes/sdk) l. 7: passe `teamId` no `Agent.create`; não fica salvo; só TypeScript | mantido, agora com [DOC]: docs 02 §1 |
| C51: Cursor lê `AGENTS.md` na raiz; no SDK local, só com `project` | doc ao vivo | ◐; teste: ✅ (§7) | [rules](https://cursor.com/docs/rules) l. 321: `Cursor supports AGENTS.md in the project root and subdirectories.` · [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 1386: `AGENTS.md` entra no scan do workspace, sem ligação com `settingSources` | subpastas também; SDK: confirmado por teste: docs 04 (Onde cada harness procura); docs 02 §5; relatório §6 |
| C52: Frontmatter de subagent do Cursor: `name`, `description`, `model`, `readonly`, `is_background` | doc ao vivo | ✅ | [subagents](https://cursor.com/docs/subagents) l. 126: `model`: `inherit` ou um ID; default `inherit` · [subagents](https://cursor.com/docs/subagents) l. 136: `Uses the same model as the parent agent. This is the default.` | mantido, agora com [DOC] (no SDK só `name`, `description`, `model`): skill `skill-to-workflow` (passo 1) |
| C53: Runs locais rodam tools sem aprovação; custom tools nunca pedem aprovação | doc ao vivo | ✅; teste: ✅ etapa editou fora do repositório (§9) | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 1840: `By default a local agent runs every tool call without restriction` · [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 1694: custom tools pulam a aprovação; deny e sandbox ainda valem | mantido, agora com [DOC] (+ deny e sandbox valem para custom tools): docs 07 (Segurança); docs 03 (O que não garante); relatório §3 |
| K01: Claude Code não lê nada sob `.agents/` (nem `.agents/skills/`) | doc ao vivo | ✅ | [claude-code/memory](https://code.claude.com/docs/en/memory) l. 381: «Not read»: nada sob um diretório `.agents/` · [claude-code/skills](https://code.claude.com/docs/en/skills) l. 177: skills de projeto vêm de `.claude/skills/` | mantido, agora com [DOC]: docs 04 (Onde cada harness procura); docs 01 §7; relatório §6 |
| K02: Claude Code lê `AGENTS.md` só sem `CLAUDE.md`; `@AGENTS.md` o importa | doc ao vivo | ◐; teste: ✅ import (§10) | [claude-code/memory](https://code.claude.com/docs/en/memory) l. 371: por padrão, lê `AGENTS.md` só sem `CLAUDE.md` na pasta ou acima · [claude-code/memory](https://code.claude.com/docs/en/memory) l. 394: o modo `claude-md-and-agents-md` lê os dois | + `.claude/CLAUDE.md`, `CLAUDE.local.md`, v2.1.277+ e modos: docs 04 (Onde cada harness procura); relatório §6 |
| K03: MCP do `.mcp.json` exige aprovação no Claude Code antes do primeiro uso | doc ao vivo | ◐; teste: ✅ `Pending approval` (§10) | [claude-code/mcp](https://code.claude.com/docs/en/mcp) l. 803: pede aprovação em sessões interativas · [claude-code/mcp](https://code.claude.com/docs/en/mcp) l. 805: `it loads project-scoped servers without asking` | docs 01 §7 e 04 (Paridade): aprovação na sessão interativa; em `claude -p`, Agent SDK e nuvem fora de projeto o servidor carrega sem perguntar |
| K04: Workflows do Claude Code: irmãos iguais compartilham prefixo; stagger; TTL 5 min ou 1 h | doc ao vivo | ◐ | [claude-code/workflows](https://code.claude.com/docs/en/workflows) l. 340: mesmo prefixo exige mesmo modelo, esforço, tipo de agente, tools, schema e cwd · [claude-code/workflows](https://code.claude.com/docs/en/workflows) l. 342: 5 min por padrão; 1 h com `subagentPromptCacheTtl` | condições completas, stagger e variáveis de TTL: docs 08 §2; relatório §3 |
| K05: Workflows do Claude Code: 16 agentes simultâneos, 1.000 por run; pastas; retomáveis | doc ao vivo | ◐ | [claude-code/workflows](https://code.claude.com/docs/en/workflows) l. 355: `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` de 1 a 256 (v2.1.269+) · [claude-code/workflows](https://code.claude.com/docs/en/workflows) l. 391: numa sessão nova, o workflow recomeça | 16 ajustável; plugin vira `/<plugin>:<nome>`; resume só na mesma sessão: relatório §1.1 e §3 |
| K06: Claude Code: regra `Workflow(<nome>)` e hook `PreToolUse` liberam workflows; agentes seguem permissões | doc ao vivo | ✅ | [claude-code/workflows](https://code.claude.com/docs/en/workflows) l. 182: allow rule `Workflow` ou `Workflow(<name>)` · [claude-code/workflows](https://code.claude.com/docs/en/workflows) l. 190: os subagents do workflow usam as suas regras de permissão | mantido, agora com [DOC]: relatório §3 e §6 |
| K07: `/workflows` mostra tokens por agente; histórico entre runs exige telemetria externa | doc ao vivo | ◐ | [claude-code/workflows](https://code.claude.com/docs/en/workflows) l. 443: `/workflows` mostra o uso de tokens de cada agente durante o run · [claude-code/monitoring-usage](https://code.claude.com/docs/en/monitoring-usage) l. 612: OTel: filtrar por `workflow.run_id` reconstrói um run | «exige» marcado como inferência [I]; traços locais citados: relatório §5.2 |
| K08: Skills do Claude Code aceitam `disable-model-invocation: true` (só `/nome`) | doc ao vivo | ✅ | [claude-code/skills](https://code.claude.com/docs/en/skills) l. 402: `true` impede o Claude de carregar a skill sozinho; uso por `/name` | mantido, agora com [DOC]: docs 04 (Paridade) |
| K09: Subagents do Claude Code: `tools`, `permissionMode`, `isolation`, `effort`…; `inherit` = pai | doc ao vivo | ◐ | [claude-code/sub-agents](https://code.claude.com/docs/en/sub-agents) l. 353: `inherit` usa o modelo da conversa principal · [claude-code/sub-agents](https://code.claude.com/docs/en/sub-agents) l. 234: subagents de plugin não aceitam `hooks`, `mcpServers` nem `permissionMode` | `inherit` = conversa principal; `permissionMode` ignorado em plugin: skill `skill-to-workflow` (passo 1) |
| X01: `chargedCents` é 0 no uso incluído no plano; o custo assenta depois da run | doc ao vivo | ✅; teste: ⏭ `feature_unavailable` (§5) | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 1277: `cost` fica ausente até assentar; `chargedCents` 0 para plano, BYOK e créditos · [release-notes/sdk](https://cursor.com/docs/release-notes/sdk) l. 84: `settles shortly after a run ends` | mantido, agora com [DOC] (+ BYOK e créditos; `cost` ausente, não 0): docs 02 §3; docs 09 §2; docs 07 (Controles) |
| X02: `rawCostCents` segue acima de 0 no plano incluído e é o sinal principal em todo plano | doc ao vivo | ◐; teste: ⏭ `feature_unavailable` (§5) | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 1258: `rawCostCents`: custo sem desconto; 0 em uso cobrado por request · [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 1225: `Usage for local agents is rolling out gradually and is enabled per account.` | «acima de 0 no plano» marcado como [I]; cego em request: docs 09 §2; docs 07 (Controles); docs 02 §3 |
| X03: Sem residência total: com pools ou My Machines, orquestração e inferência ficam na Cursor | doc ao vivo | ◐ | [help/security-and-privacy/privacy](https://cursor.com/help/security-and-privacy/privacy) l. 82: `tool execution stays on your machine and the agent loop stays in Cursor's cloud` · [enterprise/privacy-and-data-governance](https://cursor.com/docs/enterprise/privacy-and-data-governance) l. 123: residência de dados só nos EUA, para clientes Enterprise, habilitada por time | + residência só nos EUA, Enterprise, por time, com exceções: docs 07 (Políticas de admin); relatório §5 |
| X04: Membro não admin habilita o MCP stdio do projeto em Settings → MCP | doc ao vivo | ◐ | [mcp](https://cursor.com/docs/mcp) l. 290: liga e desliga servidores em Customize, na barra lateral · [mcp](https://cursor.com/docs/mcp) l. 265: `Enterprise admins can control which MCP servers users may run from the Cursor dashboard.` | Customize, não Settings; no Enterprise, pergunta para os admins: README; docs 01 §6; docs 04 (Outros repositórios) |
| X05: No IDE, shell pede aprovação conforme o modo; chamadas MCP (polling) não | doc ao vivo | ◐ | [mcp](https://cursor.com/docs/mcp) l. 300: `follows the same Run Modes as terminal commands` · [agent/security](https://cursor.com/docs/agent/security) l. 21: depois de aprovada a conexão MCP, cada tool call ainda pede aprovação individual | MCP segue o Run Mode; allowlist para `wait_workflow`: docs 04 §1; skill `run-workflow` (passo 3); relatório §4 |
| X06: Cursor (IDE e SDK local) não lê `CLAUDE.md`; só `AGENTS.md` e `.cursor/rules` | doc ao vivo | ❌ | [release-notes](https://cursor.com/docs/release-notes) l. 247: 3.26: `CLAUDE.md` igual ao `AGENTS.md` chega uma vez só · [release-notes](https://cursor.com/docs/release-notes) l. 655: `agents no longer get duplicate AGENTS.md or CLAUDE.md instructions` | IDE e cloud leem `CLAUDE.md`; SDK local em aberto: docs 04 (Onde cada harness procura, Paridade); relatório §6 e §8 |
| X07: No Claude Code, `agent()` com subagent que falha devolve `null`, sem erro | doc ao vivo | ◐ | [claude-code/workflows](https://code.claude.com/docs/en/workflows) l. 305: `null` só se parado no meio ou com erro de API irrecuperável · [claude-code/workflows](https://code.claude.com/docs/en/workflows) l. 421: travou nas 6 tentativas: a chamada falha com erro | relatório §1.1 e docs 03 (Diferenças deliberadas): `null` só ao interromper ou em erro de API irrecuperável; as outras falhas lançam erro |
| X08: O Claude Code injeta o `CLAUDE.md` em todo subagent do workflow | doc ao vivo | ◐ | [claude-code/sub-agents](https://code.claude.com/docs/en/sub-agents) l. 1107: `The built-in Explore and Plan agents skip this.` · [claude-code/env-vars](https://code.claude.com/docs/en/env-vars) l. 245: `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` desliga o `CLAUDE.md` | exceções Explore, Plan e `omitClaudeMd`: relatório §3 e §6 |
| X09: No IDE, toda descrição de skill fica no contexto; o corpo só carrega no uso | doc ao vivo | ◐ | [agent/prompting](https://cursor.com/docs/agent/prompting) l. 51: descrições de skills injetadas no contexto do sistema · [skills](https://cursor.com/docs/skills) l. 184: `only surfaced to the agent when it is reading or editing matching files` | exceções (`paths`, `disable-model-invocation`, Custom Mode); corpo do `SKILL.md` sem confirmação: docs 08 §5 |
| X10: `subagentStart` libera ou nega subagent; `sessionStart`/`postToolUse` injetam `additional_context` | doc ao vivo | ✅ | [hooks](https://cursor.com/docs/hooks) l. 972: `Can allow or deny subagent creation.` · [hooks](https://cursor.com/docs/hooks) l. 934: `additional_context` do `postToolUse` entra depois do resultado da tool | mantido, agora com [DOC]: relatório §2.3 |
| X11: Execuções headless `agent -p` iniciadas quase juntas falham (relatos) | doc ao vivo | ❔ | nenhum trecho: a doc e os tópicos do fórum baixados não tratam disso | mantido como pergunta aberta: docs 04 §2 |
| X12: `auto-low`, `composer-2` e `gpt-5.3-codex` (do `dag-task-runner`) são IDs válidos no SDK | doc ao vivo | ◐; teste: `auto-low` não existe; `gpt-5.3-codex` exige crédito (§5–6) | [sdk/typescript](https://cursor.com/docs/sdk/typescript) l. 248: `Composer 2 is retired.` · [models-and-pricing](https://cursor.com/docs/models-and-pricing) l. 107: `gpt-5.3-codex` oculto por padrão; só a variante `-high` é citada | defaults trocados por `composer-2.5` e `grok-4.7`, IDs via `wf models`: docs 02 §2; relatório §2.3 e §8 |

### O que mais mudou

- **C05 ❌:** o Auto não tem preço fixo por token; a tabela US$ 1,25 / 0,25 / 6,00 saiu, e o custo depende do modo
  (Cost, Balance, Intelligence) e do modelo roteado (docs 08 §1).
- **X06 ❌:** o Cursor lê `CLAUDE.md` como instrução de projeto no IDE e em cloud agents; para runs locais do SDK, a
  doc não diz (docs 04).
- **C45 ❌:** a doc trata do assunto, mas se contradiz: a de Python põe o cache dentro de `inputTokens`, e a fórmula
  de `totalTokens` da de TypeScript o soma à parte; o teste deu razão à de Python (§5), e as fórmulas do kit seguem
  o dado.
- **C25, C51, C11 ◐:** a doc liga `settingSources` só a MCP e subagents; que `AGENTS.md` e os hooks também
  são opt-in veio do teste (§7).
- **C08, C09, X12 ◐:** ID fora do catálogo falha com `ConfigurationError`, `RunResult.model` traz o ID resolvido
  (§5–6), e os defaults do kit trocaram `auto-low` e `gpt-5.3-codex` por `composer-2.5` e `grok-4.7`.
- **X05 ◐:** no IDE, chamadas MCP seguem o Run Mode, como o shell; sem allowlist, cada `wait_workflow` pode pedir
  aprovação (docs 04 §1).

## 12. Não executado (pendências)

O que ficou sem teste nesta sessão. Cada linha diz por que e como testar.

| Item | Por quê | Como testar |
|---|---|---|
| Cursor IDE: ligar o MCP em **Customize**, listar as skills ao digitar `/`, rodar `/run-workflow` no chat; `wait_workflow` × timeout de tool MCP | Exige alguém na IDE; a doc não dá o timeout de uma tool MCP no IDE (C10) | Abrir o repositório no Cursor, habilitar `workflows`, conferir as três skills e rodar `/run-workflow implement-issue <n>`; anotar se alguma chamada `wait_workflow` (50 s) falha por timeout |
| Dashboard aberto no navegador do Windows | Exige alguém na máquina; com `networkingMode=nat`, o localhost do WSL é encaminhado ao Windows (§10) | `npm run dash` no WSL, abrir `http://localhost:4317` no navegador do Windows e conferir que o IP do WSL continua recusado |
| `scripts/link-claude-skills.sh` e skill duplicada no Cursor | A doc não diz se o Cursor deduplica `.agents/skills/` e `.claude/skills/` (C16) | Rodar o script, reabrir o Cursor e contar quantas vezes cada skill aparece ao digitar `/` |
| Sandbox (`sandbox: true`) | Sem `bubblewrap` nesta máquina; sem ele, o SDK lança `ConfigurationError` (§9, C46) | Instalar `bubblewrap`, ligar `sandbox: true` numa etapa e conferir no shell: escrita fora do cwd recusada, leitura fora do cwd liberada, rede negada sem `.cursor/sandbox.json`; conferir também se `edit` e `write` fora do cwd passam |
| Caminhos MED e HIGH do `implement-issue` (etapa de plano, review, laço de correção do review) e `grok-4.7` com `reasoning_effort=high` | O teste ponta a ponta usou uma issue `complexity:low` (§9) | `scripts/verify/setup-sandbox-repo.sh` com o rótulo trocado para `complexity:medium` e `complexity:high` (ou um diff acima de 300 linhas), com tetos baixos e `timeoutMs` curto |
| Re-prompt de schema do engine | O modelo sempre chamou `submit_result`, até num prompt que pedia só texto (§7) | Modelo e prompt que terminem sem chamar a tool; conferir `schemaReprompts` maior que 0 no `step-end`. Hoje, coberto só pelos testes offline |
| Hooks de `team` e `mdm`, e hooks do `~/.claude/settings.json`, nas etapas | Conta pessoal, sem time; o teste só cobriu os hooks do projeto (§7, C11) | Numa conta de time, um hook do dashboard que grave log; um `PreToolUse` com `exit 2` em `~/.claude/settings.json`; rodar `verify-context` |
| Política de modelo do admin, limite em dólares por membro e chaves Team Admin | Sem acesso de admin (C03, C04, C09) | Com o admin: bloquear um modelo do mapa e ver se a etapa falha com `ConfigurationError` ou se `resolvedModel` muda; rodar um workflow com a chave de um membro e conferir o limite no dashboard; tentar uma chave Team Admin e registrar o erro |
| Erro do teto mensal de uso | O teto não foi atingido (§6, C17) | Numa conta com teto baixo (por exemplo, service account com limite de gasto), rodar até estourar e registrar se vem `RateLimitError` ou run com `status: "error"` |
| Faixa de contexto do Haiku 5.5 (acima de 100 mil tokens de input) | Modelo de terceiro exige crédito pré-pago no Premium (§6, C07) | Com crédito, uma etapa `claude-haiku-5-5` com mais de 100 mil tokens de input; conferir o custo no dashboard |
| macOS e Windows nativo | Só Linux x64 (WSL2) foi testado (§1) | `npm ci`, `npm test` e o teste de fumaça (docs 01 §5) em cada sistema; no Windows nativo, com `bash` no PATH |
| Concorrência e rate limit acima de 2 agentes em paralelo | O máximo medido foi 2 etapas em `ctx.parallel` (§8); a doc não dá limite de agentes por usuário (C15) | `concurrency` 4, 8 e 16 com etapas curtas; registrar `RateLimitError`, `AgentBusyError` e tempo por etapa |
