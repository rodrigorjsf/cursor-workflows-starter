# 4.1 · Escrevendo workflows

A referência operacional, que o agente do Cursor também usa, está na skill
[`skills/cursor-workflow-authoring/SKILL.md`](../../skills/cursor-workflow-authoring/SKILL.md). Este
documento explica o *porquê* das regras e traz as receitas, que a skill aponta.

## Princípio

> Se uma decisão pode ser tomada por código, ela **tem** de ser tomada por código.

| Decisão | Por código | Por modelo |
|---|---|---|
| Qual modelo usar | Label da issue, tamanho do diff, `ctx.budget` | Só quando não há sinal objetivo: classificador barato com schema |
| Se uma etapa roda | `if` sobre dados | Nunca |
| Quantas vezes repetir | Laço com teto | Nunca |
| Se passou | Exit code de teste, lint, typecheck | Review como *segunda* camada, nunca a única |
| Efeitos externos (commit, PR) | Sempre | Nunca |

### Efeitos colaterais: o que o código garante e o que é só pedido

| Regra | Onde | Força |
|---|---|---|
| Commit, push e PR feitos pelo código, depois das verificações | Código do workflow | Garantida |
| Trava de segredos antes do commit, do comentário na issue e do corpo do PR | `implement-issue` | Checada por código, só nesses formatos |
| Testes no ambiente de quem chamou (`bash -c`, não `bash -lc`) | `runTests` | Garantida |
| Um comando de teste que o planejador escolheu só roda depois de uma pessoa o ver | `implement-issue` | Garantida |
| Escrever só dentro do repositório (`SCOPE_RULE`) | Instruções das etapas que escrevem | **Só pedido no prompt** |
| Sandbox (`sandbox: true`) | Opção da etapa | Não testado neste kit |

- **Trava de segredos.** Antes do commit, o `implement-issue` desfaz os commits que um agente tenha feito
  (`git reset --soft` para a base, mantendo a árvore) e examina as linhas adicionadas desde a base atrás dos formatos
  de credencial que o redator do log conhece (`CREDENTIAL_FORMATS` em `redaction.ts`: chaves `crsr_` e `sk-`, tokens
  do GitHub, GitLab, AWS, npm, Slack, Google e Stripe, blocos de chave privada; JWTs e `Bearer`, comuns em fixtures, só são
  redigidos), da própria chave salva do SDK (ou a de `CURSOR_API_KEY`) e do valor de variáveis de ambiente com nome de
  segredo, e os arquivos chamados `auth.json`, `.env` ou `.env.*`. As mesmas regras de texto valem para o comentário
  das seams e para o corpo do PR, cuja saída de teste já entra redigida. Cada acerto para o efeito que levaria o texto para fora:
  no comentário, não comenta; no diff, não faz commit, push nem PR; no corpo do PR, o commit local já existe, mas
  não faz push nem PR. Em todos, devolve `status: "secret-blocked"`, com `reason` dizendo só a regra que disparou,
  nunca o trecho. O motivo: um corpo de issue com prompt injection pode
  levar uma etapa a copiar `~/.cursor/sdk/auth.json` para o worktree, e o sandbox não restringe leitura. O review
  de segurança é uma segunda camada, não a única.
- **Regra de escopo.** Medido em 2026-11-11, antes dela: uma etapa de correção editou um arquivo fora do
  repositório para "consertar" o ambiente depois de uma falha causada pelo shell de login dos testes
  ([8.2 §9](../research/verificacoes-locais.md)). A `SCOPE_RULE` reduz a chance, mas nada impede a
  escrita. Ver [5.1 · Segurança](../operating/01-governanca-e-custos.md#segurança).
- **Sandbox.** No Linux exige `bubblewrap` (ou um kernel com Landlock). Medido em 2026-11-14 ([8.2 §16](../research/verificacoes-locais.md)):
  nega a rede salvo os hosts do `sandbox.json`, não deixa o shell escrever fora do cwd (a tool `edit` também não criou o arquivo
  fora dele) e só recusa a leitura do `~/.cursor/sdk/auth.json` com `readBoundary: "workspace"` no `.cursor/sandbox.json` do repositório. A configuração global do instalador o liga em toda etapa
  (`caps.requireSandbox`), então uma etapa que baixa pacotes precisa dos hosts no `.cursor/sandbox.json`
  ([2.2 §5](../usage/02-configuracao-inicial.md#5-contexto-do-projeto-nos-agentes)).
- **`timeoutMs` curto nas etapas que escrevem, e um `maxTokensPerStep` no papel delas.** O teto de tokens da etapa e o do
  run cancelam a etapa no turno que os ultrapassa, mas o SDK só reporta o uso ao fim de cada turno, e o turno é o envio
  inteiro (medido: 1 `turn-ended` numa etapa com 31 tool calls). Por isso o `timeoutMs`, que cada envio (o pedido e cada re-prompt de schema) tem, continua
  sendo o freio do que acontece dentro de um turno ([2.2 §3](../usage/02-configuracao-inicial.md#3-teto-de-custo)).

### Comandos: `ctx.exec`

Todo comando que o workflow roda (testes, `git`, `gh` ou `glab`) passa por `ctx.exec(comando, args, { label, timeoutMs, cwd, env, scrubSecrets, probe, node })`,
nunca por `execFileSync`, `execSync` ou `spawnSync`: uma chamada síncrona congela o processo do job, então o
cancelamento espera atrás dela e nada a interrompe. O `npm test` reprova um arquivo de workflow que faça uma delas.

```ts
const tests = await ctx.exec("bash", ["-c", "npm test"], { label: "testes", cwd: worktree, timeoutMs: 15 * 60_000 });
if (!tests.ok) await ctx.agent(`${FIX_INSTRUCTIONS}\n\n${tests.tail}`, { label: "correção" }); // tests.tail: o fim da saída
```

- Devolve `{ ok, exitCode, timedOut, tail, error? }`. Código diferente de zero, tempo estourado e programa que não inicia
  são **resultados**, não exceções: o código decide o que significam. Um run cancelado mata o comando e lança.
- O comando morre no `timeoutMs` da chamada; sem ele, no `execTimeoutMs` da configuração do workflow
  ([6.2](../reference/config.md)), 10 minutos por padrão. Dê um prazo curto a um comando de rede (`git push`, `gh`, `glab`).
- `scrubSecrets: true` roda o comando sem as variáveis do ambiente do processo cujo nome tem `KEY`, `TOKEN`, `SECRET` ou
  `PASSWORD` (`CURSOR_API_KEY`, `GH_TOKEN`...). Use para um comando que roda código em que o run não confia, como a
  suíte de testes do repositório alvo; o `env` da chamada ainda acrescenta o que você nomear. O padrão é `false`: um
  `git` ou o CLI do forge (`gh` ou `glab`) precisa do token.
- `probe: true` marca um comando cujo código de saída diferente de zero é uma resposta esperada (`git rev-parse --verify`,
  `git diff --quiet`): o `exec-end` leva `probe: true`, e o resultado que o workflow recebe é o mesmo de sempre.
- `node: true` marca um comando que o run desenha como nó, como a suíte de testes: o `exec-start` leva `node: true`.
- A saída vai para o log de eventos enquanto o comando roda, com a redação e a retenção do conteúdo de um agente, e cada
  chamada é um nó do run, ao lado das etapas ([3.1](../internals/01-arquitetura.md#comandos-do-workflow-ctxexec)). `tail`
  é a saída real, sem redação: antes de levá-la a um texto que sai da máquina, passe pela trava de segredos.
- Um resume roda o comando de novo: `exec` não entra no journal. Mantenha os efeitos idempotentes.

#### Comandos do forge: `gh` e `glab`

Quem abre PR, comenta numa issue ou lê uma issue roda o CLI do forge do repositório por `ctx.exec`. O host do `origin`
escolhe o forge: `github.com` é GitHub (`gh`), `gitlab.com` é GitLab (`glab`) e qualquer outro host é o que a chave
`forges` da configuração declara (`{ "git.example.com": "gitlab" }`, que o workflow lê em `ctx.forges`;
[6.2](../reference/config.md)). Os dois CLIs usam o login do usuário (`gh auth login` ou
`glab auth login --hostname <host>`).

| Efeito | GitHub (`gh`) | GitLab (`glab`) |
|---|---|---|
| Ler uma issue | `gh issue view <n> --json number,title,body,labels` | `glab issue view <n> --output json` |
| Comentar numa issue | `gh issue comment <n> --body-file <arquivo>` | `glab api --method POST projects/:fullpath/issues/<n>/notes -F body=@<arquivo>` |
| Abrir o PR | `gh pr create --head <branch> --title <t> --body-file <arquivo>` | `glab mr create --source-branch <branch> --title <t> --description <texto> --yes` |
| Achar o PR de uma branch | `gh pr view <branch> --json url,state` | `glab api --paginate "projects/:fullpath/merge_requests?source_branch=<branch>&order_by=created_at&sort=desc&per_page=100"` |

- O `glab issue note` lê o texto do stdin, que o `ctx.exec` nunca alimenta: o comentário vai pelo `glab api`.
- O `glab mr create` não tem flag de arquivo para o corpo: a descrição é um argumento só (o Linux limita um argumento a
  cerca de 128 KiB, então corte o texto antes), e o `-H` nomeia o repositório de origem, não a branch: use
  `--source-branch`.
- O `glab mr view <branch>` falha quando a branch tem mais de um MR; o `gh pr view <branch>` pega o último. Peça a lista
  ao `glab api` (todas as páginas) e fique com o aberto mais novo, ou com o mais novo. Os estados do MR são `opened`, `locked` (sendo
  mesclado), `merged` e `closed`: `opened` e `locked` contam como aberto.
- O GitLab executa como comando a linha de um corpo de MR ou de uma nota que começa com uma ação rápida (`/close`,
  `/merge`, …), com a conta que publica, e transforma `!12`, `~rótulo` e `%marco` em links e em notas nos outros
  objetos: passe o texto de um modelo por uma neutralização antes de publicar (o `implement-issue` faz isso).
- Uma etapa na nuvem num repositório do GitLab depende do suporte do próprio Cursor ao GitLab; o kit não valida esse
  caminho ([6.2](../reference/config.md)).

### Chamadas MCP do script: `ctx.mcp`

Quando o código já decide a tool e os argumentos (listar as tabelas, descrever um esquema, rodar uma consulta fixa),
`ctx.mcp(servidor, tool, args, { label, phase, timeoutMs })` chama a tool de um servidor MCP sem agente: não custa um
turno de modelo e não tem variância ([ADR-0013](../adr/0013-script-side-mcp-calls.md)). Uma tool que o modelo precisa escolher
continua numa etapa de agente, com `mcpServers` na etapa.

```ts
const servidor = { command: "node", args: ["db-server.mjs"], env: { DB_PATH: "app.sqlite" } };
const tabelas = await ctx.mcp(servidor, "list_tables", {}, { label: "tabelas" });
if (!tabelas.ok) return { status: "failed", reason: tabelas.error };
```

- O `servidor` é uma config stdio escrita no código do workflow (`command`, `args`, `env`). Nunca se resolve por nome a partir
  do `.cursor/mcp.json` do repositório: num repositório em que você não confia, esse arquivo decidiria o que o workflow
  executa. Servidores HTTP ficam de fora até um workflow precisar de um. O servidor sobe no cwd do run, com `HOME`,
  `LOGNAME`, `PATH`, `SHELL`, `TERM` e `USER` do processo mais o `env`, e roda fora do sandbox do SDK, com a confiança de
  um comando de `ctx.exec`. Um servidor configurado só no IDE precisa ter a config copiada para o workflow.
- Devolve `{ ok, text, content, structuredContent?, timedOut, error? }`. Tool com erro, tool desconhecida, servidor que não
  inicia ou que morre e tempo estourado (`timedOut: true`, 10 minutos por padrão no `timeoutMs`, contando a subida do
  servidor) são **resultados** com `ok: false`, não exceções, como no `ctx.exec`. Um run cancelado fecha o cliente, termina o
  processo do servidor e lança `RunCancelledError`.
- A chamada reaproveita os eventos do `ctx.exec`: um `exec-start` e um `exec-end` com `command: "mcp"` e o servidor e a tool
  no `label` (o `label` da chamada o substitui; o padrão é `mcp <comando> <primeiro argumento que não é flag> <tool>`, como `mcp node server.mjs echo`), então o run a desenha como desenha um comando e o esquema de eventos não muda
  ([6.1](../reference/events.md#exec-start)). A tool, os argumentos e o servidor (o comando, os argumentos e só os nomes das
  variáveis de `env`) são um `content` do tipo `tool-call`, e o resultado é `content` do tipo `command-output`, com a redação, o
  corte e a retenção do conteúdo de um agente. O valor de uma chave com nome de segredo em `args` (`apiKey`,
  `db_password`) e o de uma variável com nome de segredo em `env` também são redigidos.
- **Não** entra no journal: o resume chama a tool de novo, e uma tool com efeitos roda duas vezes. A etapa de agente
  seguinte, cujo prompt não mudou, ainda volta do journal.

## Custo

Toda receita abaixo deve passar pelo checklist de custo ([5.2 §6](../operating/02-custos-e-cache.md#6-checklist-de-custo)). As
práticas que mais pesam:

- decidir por código em vez de chamar o modelo;
- `memo: true` em etapas de leitura;
- `settingSources` mínimo por etapa;
- prompt com parte fixa primeiro;
- modelo certo por etapa.

## Paridade com um turno do chat do IDE

Uma etapa recebe só o que está no disco e entra por `settingSources`. A lista que mais se aproxima de um turno do chat do
IDE sobre o mesmo checkout é `["project","user","plugins","mdm"]`. Passe-a na chamada `agent()` ou no papel da etapa
([6.2](../reference/config.md#papéis-globs-de-label-e-variáveis)), e confira que `caps.allowedSettingSources` lista `user` e
`plugins`. Cada camada soma contexto fixo a toda chamada
([5.2 §4.3](../operating/02-custos-e-cache.md#43-contexto-fixo-mínimo-por-etapa)): dê a lista só à etapa que precisa da paridade.

- **`project` lê o checkout, não a sessão do IDE.** O que só existe na janela aberta (um arquivo não salvo, uma regra anexada à
  mão) não chega à etapa.
- **`team` fica de fora da lista.** Ele só sincroniza as skills gerenciadas do time: não busca Team Rules e não tem caminho de
  hooks. A leitura estática do bundle do `@cursor/sdk@1.3.1` diz isso, e a medição de 2026-11-19 ([8.2 §18](../research/verificacoes-locais.md))
  o confirmou numa conta sem time: com `team` na lista, as mesmas regras e skills, o mesmo hook e a mesma marca do `AGENTS.md`. Por isso
  ele também saiu do default do engine.
- **As regras da conta e as do time não têm transporte.** As User Rules da conta e as Team Rules do dashboard não têm campo nem
  busca no SDK. Elas chegam a uma etapa por três caminhos: o `AGENTS.md` do repositório, uma regra `.mdc` em `.cursor/rules/` com
  `alwaysApply: true` (os dois exigem `project`) ou o prompt da etapa. Que uma regra `alwaysApply` chegue a todo turno sem
  interface não foi medido.
- **O corpo de uma skill com `disable-model-invocation: true` nunca vem do catálogo de skills**, e o SDK não tem `/nome` para
  anexá-lo como o IDE faz. Para a etapa receber essas instruções, ponha o corpo no prompt.
- **Etapas na nuvem ignoram a lista local.** A VM carrega as camadas que sempre carrega (`project`, `team` e `plugins`)
  ([6.2 §Etapas na nuvem](../reference/config.md#etapas-na-nuvem)).

## Receitas

### Roteamento por label → modelo

Quando várias labels casam, vale o tier mais alto: a ordem das labels nunca rebaixa uma issue difícil. O mapa fica em
`meta.settings`, para o repositório trocá-lo na configuração (`workflows.<nome>.settings`).

```ts
const RANK = { LOW: 0, MED: 1, HIGH: 2 };
const known = new Map(Object.entries(ctx.settings.labelTiers as Record<string, Tier>).map(([label, t]) => [label.toLowerCase(), t]));
const matched = issue.labels.flatMap((l) => known.get(l.name.toLowerCase()) ?? []); // um Map: uma label "constructor" é só uma label
const tier = matched.sort((a, b) => RANK[b] - RANK[a])[0]
  ?? (await ctx.agent<{ tier: Tier }>(`${CLASSIFY_INSTRUCTIONS}\n\n${issueBlock(issue)}`, {
    label: "classify", model: MODELS.CLASSIFY, tools: [], settingSources: [], memo: true, schema: TIER_SCHEMA,
  })).tier;
await ctx.agent(task, { model: MODELS[tier], cwd: worktree, schema: IMPL_SCHEMA });
```

### Review em eixos

Revisores paralelos, um por eixo (no `implement-issue`: Standards, Spec e Segurança), cada um com o schema das
suas categorias de achado. O código calcula a entrada (diff desde a base), confere que todos rodaram e decide o
que bloqueia e para onde cada achado vai; os relatórios nunca se misturam.

```ts
const diff = diffSinceBase(worktree, baseCommit);                       // calculado pelo código, truncado
const reports = await ctx.parallel(AXES.map((axis) => () =>
  ctx.agent(`${AXIS_INSTRUCTIONS[axis]}\n\n## Rodada ${round}\n\n## Diff\n${diff}`, {
    label: `review:${axis}:${round}`, model: MODELS.REVIEW, cwd: worktree,
    tools: ["read", "grep", "glob", "ls"], settingSources: [], schema: AXIS_SCHEMAS[axis], memo: true,
  })));
if (reports.some((r) => r === null)) return { status: "review-failed" };  // review exigido não vira "sem achados"
const byAxis = Object.fromEntries(AXES.map((a, i) => [a, reports[i]])) as ReviewReports; // um relatório por eixo
const b = blockingOf(byAxis);    // missing/wrong → fatia TDD extra; hard/blocking → refactor; judgement, scope-creep e note → corpo do PR
```

A rodada entra no prompt: sem ela, a rodada 2 de um resume teria a mesma chave de journal da rodada 1 e receberia
a resposta antiga. Depois da correção, só os eixos que bloquearam são revistos.

### Corrigir até passar (com teto)

```ts
let t = await runTests(testCommand, worktree);
for (let round = 1; t.kind === "failed" && round <= 2; round++) {   // timeout ou suíte morta não é falha de código
  await ctx.agent(`${FIX_INSTRUCTIONS}\n\n## Rodada ${round}\n\n## Saída dos testes\n${t.output}`, {
    label: `fix-${round}`, model: MODELS.HIGH, cwd: worktree, schema: IMPL_SCHEMA,
  });
  t = await runTests(testCommand, worktree);
}
if (!t.ok) return { status: t.kind === "failed" ? "tests-failed" : `tests-${t.kind}`, output: t.output };
```

### Fan-out com isolamento

```ts
await ctx.pipeline(files, async (file: string, _item, i) => {
  const wt = createWorktree(`wf/migrate-${file.replace(/[^\w.-]+/g, "-")}`); // git worktree add; caminho derivado do item
  return ctx.agent(`Migre ${file} para TS.`, { cwd: wt, label: file, phase: "Migrar", schema: IMPL_SCHEMA });
}, (r, file) => verify(file, r));                         // verificação por item, sem barreira
```

### Verificação adversarial

```ts
const REFUTE = "Tente REFUTAR a afirmação abaixo. Na dúvida, refuted=true."; // constante: prefixo estável
const votes = await ctx.parallel([0, 1, 2].map((v) => () =>
  ctx.agent(`${REFUTE}\n\n## Afirmação\n${claim}\n\n## Votante ${v}`, {      // o votante no prompt: votos distintos
    label: `v${v}`, model: MODELS.CLASSIFY, tools: ["read", "grep", "glob", "ls"], settingSources: [], schema: VERDICT, memo: true,
  })));
const survives = votes.filter(Boolean).filter((x) => !x!.refuted).length >= 2;
```

### Etapa de leitura barata e reaproveitável

```ts
const PLAN_INSTRUCTIONS = "Leia o código e escreva um plano... Não edite arquivos."; // constante: prefixo estável
const plan = await ctx.agent(`${PLAN_INSTRUCTIONS}\n\n${issueBlock(issue)}`, {
  model: MODELS.MED,
  tools: ["read", "grep", "glob", "ls", "semSearch"], // só leitura, sem "task"
  settingSources: [],                                 // sem AGENTS.md nem skills: liste no prompt os arquivos de contexto que existem
  schema: PLAN_SCHEMA,
  memo: true,                                         // mesmo estado do repo → custo zero no próximo run
});
await ctx.agent(`${CLASSIFY_INSTRUCTIONS}\n\n${text}`, {
  model: MODELS.CLASSIFY, tools: [], settingSources: [], schema: TIER_SCHEMA, memo: true, // [] corta as skills
});
```

### Escalonar o modelo por orçamento

```ts
const model = ctx.budget.remainingCents() < 100 ? MODELS.MED : MODELS.HIGH;
```

`remainingCents()` é o teto em centavos menos `spentCents()`, e `Infinity` sem teto em centavos (`--max-cents`,
`WF_MAX_CENTS` ou `budget.maxCents` do workflow). Onde o custo não chega ao kit (`getUsage()` com
`feature_unavailable`, uso cobrado por request), `remainingCents()` não cai
([2.2 §3](../usage/02-configuracao-inicial.md#3-teto-de-custo)): escalone por `ctx.budget.spentTokens()`.

### Invariantes entre etapas

Uma regra do processo que o modelo policiaria sozinho ("red antes de green", "só toque arquivos de teste", "o teste
é a especificação") vira uma **invariante** que o código confere entre duas etapas. As peças estão em
[`packages/runtime/workflows/implement-issue/tdd.ts`](../../packages/runtime/workflows/implement-issue/tdd.ts):

- **Quem tocou o quê:** `snapshotTree` (uma árvore git do worktree, que enxerga também `git add`, `stash`,
  `commit` e `skip-worktree` feitos pelo agente) antes e depois da etapa, e `changesBetween`, sem detecção de
  renomeação (um arquivo movido aparece como apagado e criado).
- **Estado observável:** o código roda o comando e confere o resultado esperado com `runTests`, que roda por
  `ctx.exec` (um nó de comando no log do run), tem teto de tempo e devolve `kind` (`passed`, `failed`, `timeout`,
  `killed`; esta última é uma suíte morta por um sinal, como o OOM killer, que não é resultado de teste): só `failed`
  vale como red. Ele tira `NODE_TEST_CONTEXT`, que faz um `node --test` aninhado sair com 0 mesmo falhando, e roda o
  comando sem as variáveis de ambiente com `KEY`, `TOKEN`, `SECRET` ou `PASSWORD` no nome (`scrubSecrets` do `ctx.exec`):
  a suíte e o `setupCommand` rodam código do repositório alvo que o agente acabou de escrever, e esse código não herda
  a `CURSOR_API_KEY` nem o `GH_TOKEN`. O `git` e o CLI do forge (`gh` ou `glab`) do workflow não passam por aí e continuam com os tokens.
- **O que fica travado:** nas etapas de código (green, correção, refactor), os arquivos dos globs de teste e a
  configuração do runner (`protectedGlobs`, os scripts do `package.json` e os campos `jest`, `vitest`, `mocha`,
  `ava`, `c8` e `nyc` dele); no green e na correção, também o arquivo do teste da fatia (hash guardado no red). Sem
  essa trava, a etapa green desligaria o teste em vez de implementar. Na etapa red, o código descarta o que a etapa
  mudou fora dos arquivos de teste (`restorePaths`) e confere o red só com o teste: no run real da issue #7, o
  `composer-2.5` implementou junto com o teste nas duas tentativas. Apagar um teste é violação.
- **Violação:** `revertTo` desfaz a etapa. No red e no green, uma nova tentativa leva o problema no prompt e, na
  segunda, o run encerra com um status próprio (`tdd-violation`, `test-not-red`); na correção e no refactor, a
  primeira violação já encerra o run (`tdd-violation`). O resultado traz o motivo em `reason`.
- **Partida:** a invariante vale antes do primeiro item (suíte verde, senão `baseline-red`).

```ts
const before = await snapshotTree(worktree);
await ctx.agent(`${TEST_INSTRUCTIONS}\n\n${sliceBlock}`, { label: `teste-${n}`, cwd: worktree, schema: TEST_SCHEMA });
const changed = await changesBetween(worktree, before, await snapshotTree(worktree));
if (changed.some((c) => !isTestFile(c.path) || c.status === "D")) { await revertTo(worktree, before); /* nova tentativa */ }
const red = await runTests(testCommand, worktree);
if (red.kind === "timeout" || red.kind === "killed") { await revertTo(worktree, before); /* encerra: tests-timeout ou tests-killed */ }
if (red.kind === "passed") { /* o teste não é red: nova tentativa, ou alreadySatisfied com a evidência */ }
```

### Resume com invariantes

O journal devolve o **resultado** de uma etapa, não o efeito dela no disco, e o código entre as etapas roda de
novo sobre o disco como ele está. Uma invariante que compara antes e depois erraria numa etapa reaproveitada, e uma
etapa interrompida deixaria edições pela metade. Por isso o `implement-issue`:

- guarda o progresso por item (e as saídas que viram evidência) em `.workflows/runs/<runId>/tdd-progress.json`,
  fora da árvore versionada (`ProgressStore`), com a chave de cada item derivada do conteúdo, não da posição;
- marca a etapa de escrita em andamento antes de chamá-la e, no resume, volta ao snapshot de antes dela (inclusive os
  arquivos novos que ninguém pôs no índice); uma etapa que falha é desfeita antes de o erro subir, e cada nova
  tentativa dela (`revertOnRetry`) parte do worktree de antes da etapa, não do que a tentativa que falhou deixou;
- conta as quedas do processo no meio de cada etapa de escrita: quando um resume a encontra em andamento, soma uma; passado
  o limite (`maxStepCrashes`), o run encerra com `step-crash-loop` em vez de retomar a etapa de novo. Um cancelamento no
  meio da etapa não é queda e não conta. Vale também para as etapas de correção: a rodada interrompida é refeita com o
  mesmo id, não contada;
- põe um número de sequência no prompt de cada etapa de escrita, para o journal nunca devolver uma escrita antiga;
- guarda os relatórios de review por rodada, para o resume não pedir um review novo sobre um diff diferente;
- reaproveita a branch existente no resume (sem `worktree add -B`, que a zeraria) e roda a suíte de novo antes do
  commit;
- dá a cada run a sua branch (o id do run no nome), registrada no progresso, e a põe em checkout na pasta do usuário (a
  árvore principal, o padrão: parte do HEAD que a pasta tem, e uma árvore suja recusa o início) ou, com `worktree`, num
  worktree do run, que parte da cabeça atual da branch padrão e nunca é reaproveitado por outro run; o lock `issue-<n>` (em
  `.workflows/locks/`) recusa um segundo run na mesma issue, e na árvore principal o lock `main-tree` recusa um segundo run
  no repositório; um resume na árvore principal recusa o que o run não fez e volta à branch do run, e o `wf gc` só apaga a branch
  do run. A issue do próprio repositório do cwd trava `issue-<n>`, com ou sem o arg
  `repo`; o nome só ganha um hash do repositório quando `repo` aponta para outro repositório (comparado pela URL que o
  forge devolve, em minúsculas: `gh repo view --json url` no GitHub, o `web_url` de `glab api projects/<caminho>` no
  GitLab; se o CLI do forge não responde, o hash é do valor de `repo` em minúsculas, mesmo que ele nomeie o
  repositório do cwd, e o run registra isso no log);
- entrega com `git push --force-with-lease=<branch>:<commit que o origin tem>`, só em branch `wf/`, e só quando esse
  commit é de um push do próprio run (o resume refaz o commit depois do PR; o commit de outra pessoa não é
  sobrescrito).

### Checkpoint em dois runs

O runtime não pausa para perguntar. Quando o fluxo precisa da aprovação de um humano no meio (a skill `tdd` manda
combinar as seams antes dos testes), o mesmo workflow roda duas vezes:

1. O run 1 vai até o resultado a aprovar, guarda-o no progresso do run e devolve um status pendente (no
   `implement-issue`, `seams-proposed`) com `runId` e `next`, o comando de retomada. Um resultado com `next` é classificado
   como pendente, seja qual for o status
   ([`packages/runtime/src/runtime/outcome.ts`](../../packages/runtime/src/runtime/outcome.ts)); sem ele, o run contaria como falha
   no custo por entrega.
2. O código publica o resultado onde o humano decide: no `implement-issue`, um comentário na issue com um marcador
   e o `runId` (uma vez por run), o comando pelo CLI (`--resume <runId>`, com os args entre aspas simples
   escapadas) e o caminho pelo chat (`resumeRunId`). O texto passa pela trava de segredos antes.
3. O run 2 é o resume com o arg de aprovação (`approveSeams: true`) e executa **o resultado guardado**, não um
   recalculado: uma issue editada ou um arquivo de contexto novo mudaria o prompt do planejador e o plano. Uma
   edição do humano (`seams: [...]`) refaz a etapa com a edição no prompt. No `implement-issue` essa etapa também
   escolhe o comando de teste, texto de modelo que roda por `bash -c`: com `seams` e sem `testCommand`, o run 2 não o
   executa; para em `test-command-proposed` (também em `PENDING`), com o comando no comentário e um `next` sem `seams`,
   e só o resume com `approveSeams: true` roda o plano guardado. O resultado guardado só é achado com o
   mesmo `runId` e o mesmo repositório, porque o progresso fica em `<cwd>/.workflows/runs/<runId>/`: rode o run 2 do
   mesmo diretório (ou com o mesmo `--cwd`) do run 1. Sem o resultado guardado, o `implement-issue` para com
   `seams-not-proposed` em vez de aprovar um plano que ninguém viu. A decisão também fica na issue: o run 2 posta um
   comentário com o `runId` e as seams (`Seams approved` com as do plano guardado, `Seams replaced` com as de `seams`),
   quem quer que tenha enviado o resume (chat, CLI ou dashboard), uma vez por decisão: o progresso guarda a última, e um
   resume depois de uma queda não a posta de novo (se a queda veio entre o post e a gravação, os comentários da issue dizem que ela já está lá).
   O dashboard toma essa decisão sem o terminal: o painel de seams do Run view retoma o run com `approveSeams: true` ou
   `seams: [...]` ([5.3 §Decidir as seams](../operating/03-observabilidade.md#decidir-as-seams-de-um-run-do-implement-issue)).
4. A skill [`run-workflow`](../../skills/run-workflow/SKILL.md) trata qualquer resultado com `next`: mostra o
   resultado, pergunta ao usuário e relança só com a aprovação dele.

Um questionário finito segue o mesmo formato, sem seams a aprovar. O exemplo
[`explore-db`](../../skills/cursor-workflow-authoring/examples/explore-db/explore-db.ts), no modo `interview`, propõe as perguntas
numa etapa com schema, devolve `questions-proposed` com `runId`, as perguntas e `next`, e o resume com `answers` busca a etapa do
questionário no journal e escreve o relatório que as respostas pedem. Ele mora na pasta da skill `cursor-workflow-authoring`, roda
offline em `npm test` contra um servidor MCP falso (`node:sqlite` em memória) e não é um workflow embutido: não aparece em
`list_workflows`.

## Escrevendo bons prompts de etapa

- **Autocontidos:** a etapa não vê o histórico do chat nem as etapas anteriores. Passe no prompt tudo o que ela
  precisa, inclusive os resultados de etapas anteriores.
- **Uma responsabilidade por etapa.** "Planeje" e "implemente" são duas etapas. Isso ajuda os modelos pequenos.
- **Diga o alvo, e a trava junto dele:** "altere só arquivos de teste", "o workflow faz o commit: não rode git".
  Uma proibição sozinha lembra o modelo do comportamento proibido; o código confere o que importa (receita
  "Invariantes entre etapas").
- **Schema enxuto:** só os campos que o código vai ler.

## Testando

1. Crie `packages/runtime/test/<nome>.test.ts`. O `packages/runtime/tsconfig.test.json` troca `@cursor/sdk` por `packages/runtime/test/fake-sdk.ts`.
   O teste importa os controles do fake (`script`, `calls`...) de `./fake-sdk.js`. O fake é conferido contra o SDK de verdade: o
   `npm run typecheck` compila `packages/runtime/test/fake-sdk.conformance.ts` sem a troca, e cada membro do SDK que o runtime
   usa (`Agent.create`, `Cursor.auth.login`, as classes de erro...) tem de caber na assinatura real. Um fake que perde ou muda
   um membro, ou uma versão do SDK que o move, reprova o typecheck. Um membro novo do SDK entra no fake e nesse arquivo juntos.
2. No fake, `script.push(fn)` define o comportamento de cada `send()`:
   - `() => ({ result: "texto" })` simula texto livre;
   - `(o) => { o.local.customTools.submit_result.execute(obj, {}); return {}; }` simula saída estruturada;
   - `() => ({ status: "error" })` simula uma falha;
   - `() => ({ hang: true })` simula uma run que não termina (para testar `timeoutMs`).
   `stats` (concorrência, descarte, leituras de custo), `calls` (as opções de cada `Agent.create`) e `costConfig`
   (custo ausente, `getUsage()` com `feature_unavailable`, conta sem acesso) estão comentados em
   [`packages/runtime/test/fake-sdk.ts`](../../packages/runtime/test/fake-sdk.ts).
3. A cobertura exigida (ramos, `status` de retorno, invariantes, resume) é a de "Antes de entregar" da skill
   [`cursor-workflow-authoring`](../../skills/cursor-workflow-authoring/SKILL.md).
4. Para fluxos com `ctx.parallel`, `gh`, `glab` ou `git`, copie o arnês de
   [`packages/runtime/test/implement-issue.fixture.ts`](../../packages/runtime/test/implement-issue.fixture.ts):
   - um despachante por `label` no fake SDK, porque com `ctx.parallel` a ordem dos `send()` varia e a fila
     `script` segue a ordem;
   - `gh` ou `glab` falso no `PATH`, o do forge do workflow (script Node com estado em JSON; o
     `implement-issue.fixture.ts` traz os dois);
   - repositório git temporário com `user.name` e `user.email` configurados e um repositório bare como `origin`;
   - o comando de teste real do projeto (`node --test`), que o workflow roda por `runTests`;
   - `process.env.WF_METRICS = "off"` no topo (ou `metricsDb: false` no `runWorkflow`), para o teste não gravar no
     banco do usuário (`~/.cursor-workflows/metrics.db`);
   - em `labelOf`, o prefixo `implement-issue:` trocado pelo nome do seu workflow (o nome do agente é
     `<workflow>:<label>`).
5. Para cada defeito que um review encontrar, escreva o teste que o reproduz antes da correção e confirme que ele
   falha no código antigo ([`packages/runtime/test/implement-issue.hardening.test.ts`](../../packages/runtime/test/implement-issue.hardening.test.ts)).
6. Para esperar algo que acontece em segundo plano (um evento no log, um processo que sai, um arquivo), use `waitFor`
   de [`packages/runtime/test/wait-for.ts`](../../packages/runtime/test/wait-for.ts): ele consulta a condição até um
   prazo. Não durma um tempo fixo antes de um `assert`: o teste passa numa máquina ociosa e falha numa carregada, e
   [`test/fixed-waits.test.ts`](../../test/fixed-waits.test.ts) recusa. Uma espera fixa só fica quando o próprio tempo
   é o que se testa (nada pode acontecer na janela, um relógio precisa envelhecer), com `// fixed-wait-ok: <motivo>`
   na linha da espera.

```bash
npm test && npm run typecheck
npm run wf -- run <nome> --args '{...}' --max-cents 100 --max-tokens 2000000   # primeiro run real: --cwd e critério de pronto em "Antes de entregar" da skill
```

---

[← Anterior: 3.1 · Arquitetura](../internals/01-arquitetura.md) · [Índice](../README.md) · [Próximo: 4.2 · Convertendo skills e subagents em workflows →](02-convertendo-skills-e-subagents.md)
