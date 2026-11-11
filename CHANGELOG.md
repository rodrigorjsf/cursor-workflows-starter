# Changelog

## Não publicado (0.2.0)

### Mudado

- **`implement-issue` segue as skills `tdd`, `codebase-design`, `code-review` e `pr`** de
  [mattpocock/skills](https://github.com/mattpocock/skills) 1.3.1 (MIT; créditos em [`CREDITS.md`](CREDITS.md)):
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
- **`approveSeams` sem plano proposto** no progresso do run (outro `runId` ou outro `--cwd`) para com
  `seams-not-proposed`, em vez de aprovar um plano recalculado que ninguém viu.
- **Teto padrão por workflow:** `budget` na definição vale quando o run não informa `--max-tokens`/`--max-cents`;
  o `implement-issue` declara 3 milhões de tokens.

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
