# Instruções para agentes neste repositório

Este repositório é um runtime de **workflows determinísticos** sobre o Cursor SDK (`@cursor/sdk`). Os workflows
ficam em `workflows/*.ts` (do kit) e `.agents/workflows/*.ts` (do repositório). São invocados pelo MCP server
`workflows` (`src/mcp-server.ts`) ou pelo CLI (`npm run wf -- ...`).

Leem este arquivo:

- o Cursor;
  - no IDE, o agente também lê o `CLAUDE.md` ([release notes 3.26](https://cursor.com/docs/release-notes)) e vê a
    linha `@AGENTS.md`; a doc não diz se o Cursor resolve imports com `@`;
- os agentes das etapas dos workflows (via `settingSources: ["project"]`);
- o Codex;
- o Claude Code, via `CLAUDE.md` → `@AGENTS.md`.

## Ao trabalhar no código

- Antes de criar ou editar um workflow, carregue a skill `cursor-workflow-authoring` (`.agents/skills/cursor-workflow-authoring/`).
- Para converter skills e subagents existentes, use `/skill-to-workflow`.
- Depois de qualquer mudança, rode `npm run typecheck` e `npm test`. Os testes são offline e usam `test/fake-sdk.ts`.
- `@cursor/sdk` está fixado. Ao atualizar, confira os `.d.ts` de `node_modules/@cursor/sdk/dist/esm/` e rode os
  testes de novo.

## Regras

- Nunca imprima nem registre a API key do Cursor (`~/.cursor/sdk/auth.json`, `CURSOR_API_KEY`, `SdkLoginResult.apiKey`).
- Dentro de uma etapa de workflow, não inicie outro workflow. O runtime barra o caminho acidental: nas etapas, o
  servidor MCP `workflows` é trocado por um sem tools, e o CLI recusa `run`/`start` (`WF_INSIDE_WORKFLOW`). Não é
  barreira de segurança: um comando de shell pode contorná-la. Não tente.
- Ao rodar um workflow pelo chat, use `/run-workflow`: dispare e acompanhe, sem refazer etapas nem editar arquivos
  enquanto o job roda.
- Commit, push e PR são feitos pelo código do workflow, não por você.
- Testes contra a API real: prefira os modelos incluídos no plano (`composer-2.5`, Grok, `default`). Modelos que
  consomem cota paga são permitidos quando o teste precisar deles. Sempre com `--max-tokens` e `--max-cents`.
  Política completa em `CONTRIBUTING.md`.
- Métricas ficam em `~/.cursor-workflows/metrics.db` (`npm run stats`, `npm run dash`). Não envie o banco nem um
  export feito com `--no-anonymize` para fora da máquina do usuário.
