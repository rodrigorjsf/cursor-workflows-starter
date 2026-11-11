# Casos da origem

Referência da `/skill-to-workflow` para origens que trazem um destes casos. Leia só a seção do caso. A conversão de
referência, `workflows/implement-issue.ts` (com `workflows/implement-issue/`), tem um exemplo de quase todos.

## Conversa com o usuário

A skill de origem fala com o usuário de três jeitos:

| Na origem | No workflow |
|---|---|
| Pede uma entrada ("qual o ponto fixo?", "onde está a spec?") | `args`, ou um valor que o código deriva (commit base, issue via `gh`) |
| Pede aprovação de um resultado intermediário ("confirme as seams com o usuário") | **Checkpoint** em dois runs do mesmo workflow: receita "Checkpoint em dois runs" de `docs/05-escrevendo-workflows.md` (no `implement-issue`, `seams-proposed` e `approveSeams`) |
| Conversa aberta (entrevista, brainstorming) | Fica como skill; entra no relatório como não convertida |

Um passo que apresenta opções ao usuário e recomenda uma ("compare os desenhos e recomende") vira uma etapa juiz com
schema, e o resultado dela é o que o checkpoint mostra.

## Outra skill citada e arquivos de referência

- **Skill citada por outra** (a `tdd` manda usar o vocabulário da `codebase-design`): a etapa roda sem ela (com
  `settingSources: []`, nenhuma skill entra). Parafraseie o trecho que a etapa usa numa constante importada por
  todo prompt que precisa dele (`DESIGN_VOCABULARY` em `workflows/implement-issue/prompts.ts`).
- **Arquivo de referência ao lado do `SKILL.md`** (`mocking.md`, `DESIGN-IT-TWICE.md`): o trecho que muda o
  comportamento da etapa vira parte da constante dela; o resto fica de fora.
- **Leitura condicional** ("leia o `GLOSSARY.md`, se existir"): o código confere com `existsSync` e lista no prompt
  os caminhos que existem.

## Sub-agents que a skill dispara

Skills como `code-review` (um sub-agent por eixo) e "Design it twice" (três designers com restrições diferentes)
disparam sub-agents em paralelo. No workflow:

- uma etapa por sub-agent em `ctx.parallel`, com o briefing de cada um numa constante e, no prompt, o que a skill
  mandava colar (diff, baseline de smells);
- a entrada que a skill mandava o sub-agent buscar (`git diff` desde a base, a issue) é calculada pelo código e vai
  no prompt; o sub-agent fica com tools só de leitura, sem `shell`;
- o código confere o mínimo de resultados (`design-failed` com menos de 2 desenhos, `review-failed` se um eixo
  falhar);
- a agregação da skill vira código (cada eixo com o seu relatório, lado a lado; receita "Review em eixos") ou uma
  etapa juiz com schema (escolher ou combinar desenhos).

## Skill de terceiros

- Confira a licença da skill e a de quem ela credita (`CREDITS.md` ou `metadata` dela; a `pr` credita a
  `show-me`).
- Parafraseie as instruções nas constantes e cite origem, versão, autor e licença no cabeçalho do módulo de prompts
  e em `CREDITS.md`.
- A skill original fica como está: num cache de plugin, a próxima atualização desfaria qualquer edição.

## Subagent de origem

Além de `name`, `description`, `model` e do corpo como prompt:

- No Cursor, `readonly`/`is_background`. `model: inherit` (o default) usa o modelo do agente pai
  ([DOC](https://cursor.com/docs/subagents#configuration-fields)). Nas runs do SDK, a doc não lista `readonly` nem
  `is_background`, nem em `.cursor/agents/*.md` (só `name`, `description` e `model`) nem no `agents` inline. Por
  isso `readonly: true` vira allowlist de `tools` só de leitura (`["read","grep","glob","ls"]`).
- No Claude Code, `tools`/`disallowedTools`, `permissionMode` (ignorado em subagents de plugin), `skills`,
  `maxTurns`, `isolation: worktree` e `effort`. `model: inherit` usa o modelo da **conversa principal**, que num
  subagent aninhado pode não ser o do pai. Um `model` passado na invocação tem precedência, e com
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` ligado o Claude Code ignora o campo
  ([DOC](https://code.claude.com/docs/en/sub-agents)).
- `model: inherit` vira um tier explícito (regra 4 de `cursor-workflow-authoring`).

| Campo do Claude Code | No workflow |
|---|---|
| `isolation: worktree` | `git worktree add` no código e `cwd` da etapa apontando para ele |
| `maxTurns` | `timeoutMs` e `retries` da etapa (o SDK não expõe teto de turnos) |
| `effort` | `model.params` (ex.: `[{ id: "reasoning_effort", value: "high" }]`), se o modelo oferecer; confira em `npm run models` |
| `tools` / `disallowedTools` | `tools` / `disallowedTools` do SDK (nomes diferentes: `Read`→`read`, `Bash`→`shell`, `Edit`/`Write`→`edit`) |
