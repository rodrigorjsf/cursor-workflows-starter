@AGENTS.md

## Agent skills

### Issue tracker

GitHub Issues on rodrigorjsf/cursor-workflows-starter via the `gh` CLI; specs are parent issues, tickets are sub-issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles under their default label names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Applied Learning

When something fails repeatedly, when User has to re-explain, or when a workaround is found for a platform/tool limitation, add a one-line bullet here. Keep each bullet under 15 words. No explanations. Only add things that will save time in future sessions.

- Windows Chrome → WSL dashboard: use `127.0.0.1:4317`; `localhost` is refused.
- Browser checks: use `chrome-devtools` MCP; `/chrome` fails over Remote Control.
- `tsx -e` rejects top-level await: write a `.mts` file and run it.
