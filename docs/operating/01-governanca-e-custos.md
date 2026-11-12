# 5.1 · Governança e custos (Cursor Teams/Enterprise)

## Orçamento por usuário

| Pergunta | Resposta (nov/2026) | Confiança |
|---|---|---|
| O workflow pode rodar com a conta do próprio usuário? | Sim: `wf login` (browser) cria uma chave de usuário de 90 dias por padrão | Alta (pacote do SDK) |
| Que plano dá acesso ao SDK? | Um plano pago. No Free, o `Agent.create` local, `Cursor.me()` e `Cursor.models.list()` falham com `UnknownAgentError` `plan_required` (403); o kit encerra o run na primeira tentativa. No Premium da The X Subscription, funciona. O plano legado Start não inclui o SDK; o Plus não foi testado | Alta para Free e Premium: medido em 2026-11-11 ([8.2 §4–5](../research/verificacoes-locais.md)). [DOC] para Start ([planos legados](https://cursor.com/docs/account/pricing/legacy-cursor-plans)) |
| Pode reaproveitar o login da IDE sem novo login? | **Não.** O SDK não descobre credenciais de uma instalação local do Cursor. O login interativo da CLI (`agent login`) também fica de fora, pela ordem de resolução da chave, embora a doc do SDK não o cite. Já uma mesma chave de usuário em `CURSOR_API_KEY` serve à CLI e ao SDK | Alta [DOC] para a IDE ([SDK TypeScript](https://cursor.com/docs/sdk/typescript#cursorauth)); para a CLI, decorre da ordem de resolução ([2.2 §1](../usage/02-configuracao-inicial.md#1-autenticação-de-quem-é-o-uso)) |
| De quem é a cobrança? | "Service account API keys bill to the team that owns the service account. User API keys bill to that user's plan." O gasto aparece com a tag SDK no dashboard de uso do time, e as páginas de Usage do time e da organização têm a opção SDK no filtro de cliente | Alta [DOC]: [SDK TypeScript](https://cursor.com/docs/sdk/typescript#usage-and-billing) (acesso em 2026-11-11), [release notes](https://cursor.com/docs/release-notes) |
| O uso segue as mesmas regras de preço, pools e Privacy Mode do IDE? | Sim: "SDK runs follow the same pricing, request pools, and Privacy Mode rules as runs from the IDE and Cloud Agents." Vale para preço e cobrança, não para o que o plano inclui: o plano legado Start inclui o IDE, mas não o Cursor SDK | Alta [DOC]: [SDK TypeScript](https://cursor.com/docs/sdk/typescript#usage-and-billing), [planos legados](https://cursor.com/docs/account/pricing/legacy-cursor-plans) |
| Entra no **limite individual em dólares** do membro? | A doc não diz. Ela confirma que a chave de usuário cobra o plano do usuário e que o admin define um limite mensal por membro (default do time e override por membro), mas nenhuma página liga o uso do SDK a esse limite | Em aberto: a doc não cobre ([SDK TypeScript](https://cursor.com/docs/sdk/typescript#usage-and-billing), [preços de Teams](https://cursor.com/docs/account/teams/pricing)). Valide com o admin |
| Service account debita de quem? | Do time: consome o pool de uso do time. O uso fica atribuído à própria service account (`serviceAccountId` e `serviceAccountName` nos eventos de uso), não a uma pessoa. Só no Enterprise, feita para automação e CI/CD, com teto de gasto próprio | Alta [DOC]: [Service accounts](https://cursor.com/docs/account/enterprise/service-accounts), [Admin API](https://cursor.com/docs/account/teams/admin-api) |
| Chave Team Admin funciona? | Ainda não: "Team Admin API keys are not yet supported." O SDK aceita chaves de usuário e de service account | Alta [DOC]: [SDK TypeScript](https://cursor.com/docs/sdk/typescript#authentication) |

**Como validar:** rode um workflow pequeno com a chave de um usuário de teste e confira no dashboard do time se o
gasto aparece no membro, com a tag SDK, e se o limite por membro é respeitado.

## Controles de custo no kit

Para as práticas de implementação (cache, contexto, prompts, memo), veja
[5.2 · Custos, cache e boas práticas](02-custos-e-cache.md). Os controles abaixo são os de governança.

1. **Teto por run:** `--max-cents`, `--max-tokens`, `WF_MAX_CENTS` ou `WF_MAX_TOKENS`. Não é garantia de gasto
   máximo. O teto de tokens do run e o da etapa (`maxTokensPerStep`) são checados a cada turno, durante a etapa: passar
   de um deles cancela o run do agente na hora (a tentativa falha como `budget`, sem nova tentativa), e a
   ultrapassagem é de no máximo um turno por etapa ativa. Um turno do SDK pode ser o laço inteiro do agente, então
   `timeoutMs` curto nas etapas que escrevem continua valendo. Medido em 2026-11-11, antes do teto ao vivo: 344 mil
   tokens com `--max-tokens 300000` ([8.2 §9](../research/verificacoes-locais.md); ver
   [2.2 §3](../usage/02-configuracao-inicial.md#3-teto-de-custo)). O teto em centavos é checado antes de cada tentativa e compara `maxCents` com `spentCents`: a soma, por tentativa, do maior entre `rawCostCents` (custo bruto)
   e `chargedCents` (cobrado). Ele depende do custo do `getUsage()`, que o Premium testado não devolveu. Defina
   sempre os dois tetos (ver a nota abaixo).
2. **Modelo por etapa:** a maior parte das etapas roda em modelos baratos. Use o modelo caro só para
   planejamento difícil e review.
3. **Review condicional:** o review só roda quando o tier ou o tamanho do diff justificam.
4. **Laços com teto:** nenhum "repita até passar" sem limite.
5. **Concorrência baixa** (default 4): N agentes em paralelo custam ~N vezes os tokens.
6. **Resume:** relançar não paga de novo as etapas já concluídas, e o gasto do run acumula entre resumes (tentativas
   que falharam inclusive): o teto de um resume é o novo teto total, e o orçamento nunca recomeça do zero.
7. **Visibilidade:** `spentCents` e `usage` (tokens por tipo e `cacheHitRatio`) no resultado; `chargedCents` e
   `usage` por etapa nos eventos. `spentCents` é o custo que o teto usa; `chargedCents` (só o cobrado) também
   aparece no resultado (`RunOutcome`), no estado do job e em `ctx.budget`.
8. **Memo entre runs:** etapas de leitura repetidas sobre o mesmo estado do repositório não custam nada.
9. **Histórico e dashboard:**
   - banco SQLite por usuário com o custo bruto do Cursor (`rawCostCents`, "undiscounted model token cost"). A
     doc diz que o cobrado é 0 para uso incluído no plano, BYOK e créditos, mas não afirma que o bruto continua
     acima de 0 nesses casos [I]. O bruto é 0 em uso cobrado por request (planos legados e alguns Enterprise
     por request) ([DOC](https://cursor.com/docs/sdk/typescript#agentgetusage));
   - custo por entrega e faixa de contexto × custo;
   - export anonimizado para consolidar no time ([5.3](03-observabilidade.md)).

> **Teto em centavos e tipo de cobrança.** `chargedCents` é 0 para uso incluído no plano, BYOK e créditos
> ([DOC](https://cursor.com/docs/sdk/typescript#agentgetusage)). Por isso o teto soma o maior entre bruto e
> cobrado. Antes ele somava só o cobrado e nunca disparava em uso incluído no plano. Agora protege esse uso
> desde que o bruto venha acima de 0 nesses casos, o que a doc não garante [I]. Limites que continuam:
>
> - Uso cobrado por request (planos legados e alguns Enterprise por request) reporta `rawCostCents = 0` [DOC].
>   Aí o teto em centavos fica cego, e só `--max-tokens` / `WF_MAX_TOKENS` protege.
> - O custo pode demorar a assentar depois do fim da run [DOC]. Se o Cursor ainda não reportou o custo de uma
>   tentativa, o engine emite um aviso: o teto em centavos não contou essa tentativa (o de tokens, sim).
> - Enquanto o uso de agentes locais não estiver liberado na conta, `getUsage()` devolve `403 feature_unavailable`
>   [DOC]. Nesse caso o engine conta os tokens da tentativa pelos eventos `turn-ended`, e o teto de tokens vale.
>   O custo fica desconhecido, e o teto em centavos não conta a tentativa. Isso aconteceu em plano pago: num
>   Premium, em 2026-11-11, toda chamada deu `feature_unavailable`, inclusive o `Agent.getUsage(agentId)` estático
>   ([8.2 §5](../research/verificacoes-locais.md)). Nessa conta `spentCents` fica em 0, o teto em
>   centavos nunca dispara, e o custo só sai da estimativa da tabela `pricing` e do dashboard de uso.
>
> Defina sempre os dois tetos.

## Segurança

| Risco | Fato | Mitigação no kit / recomendação |
|---|---|---|
| Tools sem aprovação | Runs locais do SDK executam shell, edit e write sem pedir aprovação, e as custom tools nunca pedem aprovação interativa; regras de deny e o sandbox ainda valem para elas ([DOC](https://cursor.com/docs/sdk/typescript#custom-tools)) | Allowlist de `tools` por etapa: no exemplo, classificar e planejar só leem. Implementar e corrigir recebem todas as tools, shell incluído, porque precisam rodar testes. O sandbox (`sandbox: true`) **não foi testado neste kit** e não é mitigação comprovada. Ele vem desligado por padrão e, no Linux, exige `bubblewrap` (sem ele, o SDK lança `ConfigurationError`). Segundo a doc, restringe as chamadas de shell e os processos que elas disparam: escrita só no cwd, em diretórios temporários e nos caminhos liberados no `sandbox.json`; leitura **não** restrita; rede de saída negada, salvo os hosts listados em `.cursor/sandbox.json` do workspace ou em `~/.cursor/sandbox.json` ([DOC](https://cursor.com/docs/sdk/typescript#sandbox-options)). A doc não diz que ele restringe as tools `edit` e `write`. Testes que baixam pacotes podem falhar |
| Etapa que escreve fora do repositório (medido) | No teste ponta a ponta de 2026-11-11, a `corrigir-1` (`grok-4.7`, todas as tools, sem sandbox) editou um arquivo fora do repositório: o wrapper `npm` de um gerenciador de versões, na home do usuário, para "consertar" o ambiente. A falha de teste vinha do shell de login que rodava os testes. O arquivo foi revertido ([8.2 §9](../research/verificacoes-locais.md)) | Os testes rodam com `bash -c`, no ambiente de quem chamou. As instruções das etapas que escrevem levam a `SCOPE_RULE` ("altere apenas arquivos dentro deste repositório..."). A regra é **só um pedido no prompt**, não uma barreira: nada no kit impede a escrita fora do repositório. Onde isso importa, rode o workflow numa máquina ou container descartável |
| Segredo no commit | Issues LOW e MED com diff de até 300 linhas pulam o review. Um corpo de issue com prompt injection pode levar uma etapa a copiar `~/.cursor/sdk/auth.json` para o worktree, e o sandbox não restringe leitura | Antes do commit, o `implement-issue` examina as linhas adicionadas no diff staged (`git diff --cached`) atrás de formatos de segredo (chaves `crsr_`, chaves `sk-`, a própria chave salva do SDK ou a de `CURSOR_API_KEY`) e os arquivos staged chamados `auth.json`, `.env` ou `.env.*`. Num acerto, não faz commit, push nem PR e devolve `status: "secret-blocked"`, com `reason` dizendo só a regra que disparou, nunca o trecho encontrado. O worktree fica para inspeção: apague o arquivo e trate a chave como exposta |
| Repositório não confiável | `settingSources: ["project"]` carrega regras e hooks do repositório. Medido em 2026-11-11: com `"project"`, a etapa roda os hooks de `.cursor/hooks.json` e os `PreToolUse` de `.claude/settings.json` (comandos do repositório na sua máquina) e sobe os servidores do `.cursor/mcp.json`; com `[]`, nada disso ([8.2 §7](../research/verificacoes-locais.md)) | Para repositórios de terceiros, remova `"project"` em `engine.ts` |
| Chave em disco | `~/.cursor/sdk/auth.json` em texto puro, 90 dias por padrão | Em máquinas compartilhadas, use `CURSOR_API_KEY` vinda de um gerenciador de segredos |
| Efeitos externos | Commit, push e PR | Feitos só pelo código, depois das verificações e da varredura de segredos; push e PR só com `openPr: true` |
| Prompt injection via issue | O corpo da issue entra no prompt de classificar, planejar e implementar | Classificar e planejar não têm `shell` nem `edit`. **Implementar tem**, então um corpo de issue malicioso pode induzir comandos e leituras fora do repositório. Restrinja quem pode rotular issues para o workflow. O review com lente de segurança só roda em HIGH ou com diff acima de 300 linhas, e a varredura de segredos antes do commit (linha "Segredo no commit") cobre só o que iria para o commit. O sandbox não foi testado e não restringe leitura. Revisores têm `shell` para ler o `git diff`; troque por um diff passado no prompt se quiser tirar o shell deles |
| Workflow disparando workflow | As etapas carregam o `.cursor/mcp.json` do projeto, e o SDK sobe esses servidores sem repassar o ambiente do processo. Medido em 2026-11-11: antes da correção, a etapa via `start_workflow`, e o servidor recebia `WF_INSIDE_WORKFLOW` vazio | Nas etapas, o engine registra um MCP inline `workflows` (ou `WF_MCP_SERVER_NAME`) sem tools, que vence o do arquivo pelo nome; no reteste, a etapa só via `FetchMcpResource` e `submit_result`. O shell da etapa herda `WF_INSIDE_WORKFLOW=1`, e o CLI recusa `run`/`start`. Isso evita a recursão acidental, mas não é fronteira de segurança: uma etapa com `shell` pode contornar a guarda, por exemplo rodando o CLI sem a variável |
| Vazamento da chave | `wf login` gera uma chave | O CLI imprime só e-mail e validade, nunca a chave |

## Transparência: o que o kit faz por baixo

O que o kit grava e dispara na sua máquina, além do que a tabela de segurança acima já cobre (tools sem aprovação, escrita
fora do repositório) e do que o [2.2 §5](../usage/02-configuracao-inicial.md#5-contexto-do-projeto-nos-agentes) diz sobre o
contexto que as etapas carregam (`settingSources`):

- **Cada etapa cria um agente local** do Cursor SDK na sua máquina. A inferência roda nos servidores da Cursor e é
  cobrada na conta da chave usada.
- **O estado fica em `.workflows/`** (journal, log de eventos, jobs, logs, worktrees) do repositório onde o workflow roda.
  O runtime o adiciona ao `info/exclude` do git (`.git/info/exclude`, ou o caminho que o git indicar quando `.git` é um
  arquivo, como num worktree ligado), sem mexer no `.gitignore` do repositório.
- **Cada run grava métricas** (tokens, custo, modelo, passos, resultado) em `~/.cursor-workflows/metrics.db`. Os prompts
  ficam só como hash. Desligue com `WF_METRICS=off` (ver [5.3](03-observabilidade.md)).
- **Commit, push, PR e comentário na issue são feitos pelo código do workflow**, com `git` e `gh`. O `implement-issue`
  sempre faz o commit local numa branch só do run, `wf/issue-<n>-<run>`; push e PR, só com `openPr: true`. O push é um
  `--force-with-lease`, restrito às branches `wf/`: um resume depois do PR refaz o commit e entrega por cima, mas só
  sobre commits que o próprio run empurrou. Commit de outra pessoa na branch dá `status: "push-refused"` e não é
  sobrescrito. Em issues MED e HIGH, o primeiro
  run comenta as seams propostas na issue, com ou sem `openPr`.
- **O worktree e as branches de um run ficam até o `wf gc`.** Cada run do `implement-issue` deixa o seu worktree
  (`.workflows/worktrees/`), a branch local e, se empurrou, a branch no origin. `wf gc` remove os de um run cujo PR foi
  mergeado ou fechado e os de um run que falhou há mais de `gcFailedAfterDays` dias (padrão 14, em
  `workflows.implement-issue.settings`); `wf gc --dry-run` só mostra o plano. Ele nunca toca num run que um processo
  está executando, numa branch fora de `wf/` nem num commit do origin que o run não empurrou, e não apaga o PR de ninguém:
  a branch do origin de um run que falhou, com o PR ainda aberto, fica. Uma branch `wf/` do origin que nenhum run deste
  repositório possui (feita em outro clone) só sai se o PR dela foi mergeado ou fechado. O log e o journal do run em
  `.workflows/runs/` ficam.
- **Uma guarda evita que uma etapa dispare outro workflow por acidente**; ela não é uma fronteira de segurança
  (ver acima, "Workflow disparando workflow").

## Políticas de admin que se aplicam

- **Hooks Enterprise (MDM) e Team** (dashboard): o engine carrega `team` e `mdm` por padrão
  (`settingSources: ["project","team","mdm"]`). Um deny em qualquer fonte vence ask e allow
  ([DOC](https://cursor.com/docs/hooks#configuration)). Hooks Team só existem no Enterprise, e hooks de plugins
  entram depois das quatro fontes (Enterprise, Team, projeto, usuário). Exemplos úteis do cookbook: auditoria em
  JSONL, bloqueio de prompts com segredos e bloqueio de modelos por origem do repositório. Nas runs locais,
  hooks de projeto, inclusive um deny de `PreToolUse` do Claude Code, valeram com `"project"` (medido em
  2026-11-11); os de `team` e `mdm` não foram testados (conta pessoal). `settingSources: []` desliga também
  esses hooks.
- **Políticas de MCP, rede e tools do admin:** só parte está documentada para runs locais do SDK. A denylist de
  comandos do admin vale: comandos de shell que casam com ela são rejeitados antes de rodar, inclusive nos
  caminhos sem aprovação (SDK 1.0.27, [DOC](https://cursor.com/docs/release-notes/sdk)). Uma política do admin
  também pode bloquear o pedido com `ConfigurationError` ([DOC](https://cursor.com/docs/sdk/typescript#errors)).
  A allowlist de MCP e as regras de rede do admin só aparecem na doc para Cloud Agents e IDE/CLI; para runs
  locais do SDK, a doc não diz. Teste com o admin antes de contar com elas. O sandbox do SDK (`sandbox: true`)
  não substitui essas políticas: não foi testado neste kit, exige `bubblewrap` no Linux e, segundo a doc, só
  restringe chamadas de shell e processos que elas disparam, sem restringir leitura (ver [Segurança](#segurança)).
- **Restrições de modelo:** um `model.id` inválido ou bloqueado por política do admin gera `ConfigurationError`
  (a doc dá "Bad model name" como mensagem típica; o pacote mostra "Cannot use this model"), e a etapa falha. Não
  é exclusivo de runs locais. Confira o ID com `Cursor.models.list()`: o catálogo é por conta e por time
  ([DOC](https://cursor.com/docs/sdk/typescript#errors)). Nenhuma página documenta substituição silenciosa de um
  modelo pedido explicitamente em runs do SDK. Já as seleções do Router/Auto pulam modelos bloqueados e caem numa
  alternativa da allowlist, por design ([DOC](https://cursor.com/help/models-and-usage/available-models)).
  `RunResult.model` traz o ID resolvido (alias `composer` → `composer-2.5`, medido em 2026-11-11), e o kit o
  registra como `resolvedModel` no `step-end`. Com `default` (Auto), volta `default`, sem a escolha do Router. Se
  uma substituição feita do lado do servidor por política do admin apareceria ali não foi testado (conta pessoal).
  Onde o modelo for requisito de conformidade, garanta a configuração com o admin, porque o kit não garante
  detectar a substituição.
- **Privacy Mode:** as runs do SDK seguem as mesmas regras de Privacy Mode do IDE e dos Cloud Agents
  ([DOC](https://cursor.com/docs/sdk/typescript#usage-and-billing)).
- **Self-hosted** (pools, My Machines): checkout e execução das tools ficam na sua infraestrutura, mas o loop do
  agente fica na nuvem da Cursor ([DOC](https://cursor.com/help/security-and-privacy/privacy)). As requisições
  passam pelos servidores da Cursor ([DOC](https://cursor.com/help/models-and-usage/api-keys)) e seguem para
  modelos da Cursor ou de provedores como OpenAI, Anthropic e Google. Self-hosting não mantém tudo no seu
  ambiente.
- **Residência de dados:** só nos EUA, no Enterprise, habilitada por time (inferência, processamento e
  armazenamento nos EUA, Cloud Agents incluídos). Há exceções listadas: SSO, BYOK, modelos custom, MCPs, Bugbot,
  links compartilhados e agentes disparados por Slack ou web. EU/EEA e APAC ainda não estão disponíveis
  ([DOC](https://cursor.com/docs/enterprise/privacy-and-data-governance)).

## Checklist de adoção no time

- [ ] Admin confirma a atribuição de custo por membro para chaves de usuário do SDK e se o limite por membro vale
  para esse uso (a doc não cobre).
- [ ] Admin libera os modelos do mapa de tiers, e eles aparecem em `npm run models` para um membro comum.
- [ ] Tetos padrão `WF_MAX_CENTS` e `WF_MAX_TOKENS` definidos no `mcp.json` do kit. Só o de tokens protege uso
  cobrado por request.
- [ ] Hook de auditoria (`beforeMCPExecution` em `start_workflow`) ativo, se o time exigir, com `failClosed: true`
  para que um crash ou timeout do hook bloqueie a chamada. Hooks do dashboard (Team) não aceitam `failClosed`
  ([DOC](https://cursor.com/docs/hooks)).
- [ ] No Claude Code, o equivalente: hook `PreToolUse` com `matcher: "mcp__workflows__start_workflow"` (o nome
  segue o do servidor no `.mcp.json`) e `"onFailure": "block"` (v2.1.295+), para que uma falha do hook bloqueie a
  chamada ([DOC](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails)).
- [ ] Sandbox (`sandbox: true`) testado no ambiente do time antes de contar com ele: exige `bubblewrap` no Linux,
  não foi testado neste kit e, segundo a doc, não restringe leitura.
- [ ] Service account (só Enterprise) criada para uso em CI.
- [ ] Teste de fumaça ([2.1 §5](../usage/01-instalacao.md#5-teste-de-fumaça-real)) executado com sucesso.

---

[← Anterior: 4.2 · Convertendo skills e subagents em workflows](../authoring/02-convertendo-skills-e-subagents.md) · [Índice](../README.md) · [Próximo: 5.2 · Custos, cache e boas práticas →](02-custos-e-cache.md)
