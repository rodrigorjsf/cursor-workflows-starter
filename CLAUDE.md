# cursor-workflows-starter: maintainer guide

Canonical guide for agents and humans working on this repo. `AGENTS.md` is a symlink to this file, so Cursor, Codex
and Claude Code read the same text. Line budget: 100 lines. It is loaded into every agent's context, so keep it short.
Detail lives in the contributor section of the docs book (`CONTRIBUTING.md` until the book lands).

## What this repo is

A runtime for **deterministic workflows** on the Cursor SDK (`@cursor/sdk`), as npm workspaces:

- `packages/runtime/`: the product. Engine, CLI (`src/cli.ts`), MCP server (`src/mcp-server.ts`), built-in
  workflows (`workflows/`) and their offline tests (`test/`).
- `packages/dashboard/`: the local dashboard (`npm run dash`), its own package so its web dependencies (React, React
  Flow, elkjs, esbuild) never enter the runtime. Server in `src/`, browser code bundled by the server when it starts.
- `skills/`: the skills distributed to users. `.agents/skills/` symlinks to them for dogfooding; never copy them.
- `templates/`: files the kit's setup writes: the `AGENTS.md` rules block (`templates/agents-md-block.md`) that `wf init`
  (`packages/runtime/src/init.ts`) appends to a target repo, and the default global config
  (`templates/global-config.json`) that the installer copies for the user.
- Install: `scripts/install.sh` (clones a tag into `~/.cursor-workflows/kit`, `--dev` links a working copy) and
  `wf upgrade` (`packages/runtime/src/upgrade.ts`). `INSTALL-AGENT.md` is the public guide, pinned to the tag of the
  package version: bump it with the version (`npm test` fails otherwise).
- The repo root is the dev space: this guide, the dogfood MCP config (`.mcp.json`, `.cursor/mcp.json`), `docs/`,
  `scripts/`, repo-level tests (`test/`).

The runtime resolves its own assets relative to its install location, never the repo root. The only repo it runs in
is the target repo (the cwd). Keep it that way. One exception, for tools beside it: the `observe` entry point finds
runs of every repo through the global runs index (ADR-0002), reads their logs, and cancels their jobs.

Workflows live in `packages/runtime/workflows/*.ts` (built in) and `.agents/workflows/*.ts` (per repo). The MCP server
`workflows` or the CLI (`npm run wf -- ...`) runs them. Step agents read this file too (`settingSources: ["project"]`).

## Working on the code

- Before creating or editing a workflow, load the `cursor-workflow-authoring` skill
  (`skills/cursor-workflow-authoring/`).
- To convert existing skills and subagents, use `/skill-to-workflow`.
- After any change run `npm run typecheck` and `npm test`. Tests are offline and use `packages/runtime/test/fake-sdk.ts`.
- `@cursor/sdk` is pinned. When upgrading, check the `.d.ts` files in `node_modules/@cursor/sdk/dist/esm/` and rerun
  the tests.
- Keep distributed skills, templates and other agent-facing text in English. The docs book and README are pt-BR.

## Skills

- A skill is self-contained: every instruction lives in its own folder (`SKILL.md` plus `references/`), and nothing
  points at a document outside that folder. Reference two skills share is copied into both; `npm test` keeps the copies
  identical.
- Create and update every skill with `/mattpocock-skills:writing-for-agents`.

## Rules

- Never print or log the Cursor API key (`~/.cursor/sdk/auth.json`, `CURSOR_API_KEY`, `SdkLoginResult.apiKey`).
- Inside a workflow step, do not start another workflow. The runtime blocks the accidental path: in steps the
  `workflows` MCP server is swapped for one with no tools, and the CLI refuses `run`/`start` (`WF_INSIDE_WORKFLOW`).
  It is not a security barrier: a shell command can bypass it. Do not try.
- Before running a workflow from the chat, load the `run-workflow` skill (`skills/run-workflow/`): start, follow and
  report, without redoing steps or editing files while the job runs.
- Commit, push and PR are done by the workflow code, not by you.
- Tests against the real API: prefer the models included in the plan (`composer-2.5`, Grok, `default`). Models that
  use paid quota are allowed when the test needs them. Always pass `--max-tokens` and `--max-cents`. Full policy in
  `CONTRIBUTING.md`.
- Metrics live in `~/.cursor-workflows/metrics.db` (`npm run stats`, `npm run dash`). Never send the database, or an
  export made with `--no-anonymize`, off the user's machine.

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
