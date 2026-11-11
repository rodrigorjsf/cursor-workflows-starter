---
name: Bug
about: Algo do kit não funcionou como a documentação diz
labels: bug
---

> **Antes de colar qualquer coisa:** nunca inclua `~/.cursor/sdk/auth.json`, `CURSOR_API_KEY` ou outra chave, a saída
> de `wf whoami`, o banco `metrics.db` nem exports feitos com `--no-anonymize`. Corte os logs de `.workflows/` para a
> etapa que falhou. Falhas de segurança vão pelo reporte privado (veja [SECURITY.md](../../SECURITY.md)).

**O que aconteceu e o que você esperava**

**Como reproduzir** (comando exato, sem segredos)

**Ambiente**

- Plano do Cursor (ex.: Free, Plus, Premium, Teams, Enterprise):
- Modelo(s) usado(s) e saída relevante de `npm run models`:
- Versão do `@cursor/sdk` (`npm ls @cursor/sdk`) e do Node (`node -v`):
- Sistema operacional:
- Invocação: CLI, Cursor IDE (MCP) ou Claude Code (MCP):

**Erro ou evento** (por exemplo o `step-end` com `errorKind`, sem prompts nem chaves)
