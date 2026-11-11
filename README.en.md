# Cursor Workflows Starter Kit (English summary)

> **The documentation is in Brazilian Portuguese.** This page is a short summary; the full guides are under
> [`docs/`](docs/) and the main page is [README.md](README.md).

A starter kit for **deterministic agent workflows** on the [Cursor SDK](https://cursor.com/docs/sdk/typescript)
(`@cursor/sdk`). A workflow is a TypeScript file in which **code** decides the order of steps, branches, loops, the
model of each step, when to review and when to stop. Each step is a small Cursor agent with a schema-validated
output. Workflows run from the **Cursor IDE chat** (through an MCP server), from the **terminal** and from **CI**
(through a CLI). The idea mirrors Claude Code's *dynamic workflows* (`agent`, `parallel`, `pipeline`, `phase`),
which Cursor does not ship natively.

## Status: pre-release 0.1.0 (2026-11-11)

Verified against the real API in one environment: the **Premium** plan of The X Subscription, `@cursor/sdk@1.3.1`,
Linux x64 (WSL2). Evidence: [`docs/research/verificacoes-locais.md`](docs/research/verificacoes-locais.md).

- On the **Free** plan the SDK does not run at all (`plan_required` on `Agent.create`). Other plans were not tested.
- **Measured:** login without a local browser, model catalog, structured output, what `settingSources` loads
  (`AGENTS.md`, Cursor and Claude Code hooks, `.cursor/mcp.json`), the recursion guard, prompt cache between agents,
  token types, localhost-only dashboard, and Claude Code listing the MCP tools.
- **End to end:** only the **LOW** path of the previous `implement-issue` (implement → tests → commit → PR → resume
  without repeating), run from the tree published as 0.1.0. The current flow (TDD slice by slice and a three-axis
  review on every tier; plan and seams checkpoint on MED and HIGH) has not run against the real API yet.
- **Cost:** on the tested account the SDK's `getUsage()` returns `feature_unavailable` for local agents, so the kit
  cannot read the real cost: the cents cap is blind and only the token cap protects you.
- **Incident:** in an earlier test an unsandboxed step edited a file outside the repository. It was fixed and
  re-tested; read [SECURITY.md](SECURITY.md) before use.
- **Pending:** Cursor IDE (MCP, skills, `/run-workflow`), sandbox, MED/HIGH paths, team/MDM hooks, admin policies,
  macOS and Windows.

## Quick start

Requires Node 22.13+, a paid Cursor plan, `git` and an authenticated `gh`.

```bash
npm ci
npm test && npm run typecheck
npm run wf -- login     # browser login; usage bills YOUR account (NO_OPEN_BROWSER=1 prints the URL)
npm run models          # model IDs available to you
npm run wf -- run implement-issue --cwd /path/to/test-repo --args '{"issue":1}' --max-cents 100 --max-tokens 300000
npm run stats && npm run dash   # local SQLite metrics and a dashboard on http://127.0.0.1:4317
```

## License

MIT for this repository's code and docs. `@cursor/sdk` is proprietary (Anysphere, Inc.), installed from npm, and its
use is subject to [Cursor's Terms of Service](https://cursor.com/terms-of-service). Provenance:
[PROVENANCE.md](PROVENANCE.md). Changes: [CHANGELOG.md](CHANGELOG.md).
