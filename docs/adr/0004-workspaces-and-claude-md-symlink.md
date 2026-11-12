# 7.4 · ADR-0004: npm workspaces and a canonical CLAUDE.md

**Status:** accepted · decided in [spec #2](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/2)

## Context

The repository mixed the product with the work of developing it. The root `AGENTS.md` joined guidance for developing this
repo with the rules every repo that uses the kit must follow. The skills the kit distributes lived in the same folder as
this repo's own skills, so a maintainer's skill could ship by accident. A later dashboard would bring React dependencies
that the runtime must never install. And three readers (Claude Code, Cursor, Codex) look for different guide files.

## Decision

**The repository is npm workspaces plus a dev space, and one maintainer guide is shared by every reader through a symlink.**

- **The runtime is its own package**, `packages/runtime/` (`@cursor-workflows/runtime`): the engine, the run store, the
  config resolver, the backends, the CLI, the MCP server, the built-in workflows and the config JSON Schema. The dashboard
  is its own package, `packages/dashboard/` (`@cursor-workflows/dashboard`), so its dependencies never enter the runtime. It
  reaches the runtime through one entry point only, `@cursor-workflows/runtime/observe`.
- **Distributed assets have their own folders:** `skills/` for the skills the kit ships (`.agents/skills/` symlinks to them
  so the repo dogfoods the real files) and `templates/` for what `wf init` writes into a target repo. Distributed skills
  are self-contained: nothing in a skill points outside its folder.
- **The repo root is the dev space:** the maintainer guide, dev-only skills, the dogfood MCP config, `docs/`, `scripts/`
  and repo-level tests.
- **The runtime resolves its own assets relative to its install location**, never the repo root. The only repo it reads is
  the target repo it runs in.
- **`CLAUDE.md` is the canonical maintainer guide and `AGENTS.md` is a symlink to it.** The guide is in English and has a
  line budget (100 lines), because it is loaded into every agent's context, including the agents of every dogfood step.
  Path-scoped detail goes in `.claude/rules/`. Anything Cursor and Codex must also follow lives in the book's contributor
  section, with a one-line pointer from `CLAUDE.md`.
- **Language follows the reader.** Distributed skills, templates and agent-facing text are in English. The book and the
  README are in pt-BR, with `README.en.md` as an English hub.

## Consequences

- Nothing from the dev space can leak into a target repo: the runtime does not see the repo root, and a test copies the
  package outside the repo and runs it from there.
- Per the Cursor docs that spec #2 relied on (the 3.26 [release notes](https://cursor.com/docs/release-notes) add `CLAUDE.md`),
  Cursor reads both `AGENTS.md` and `CLAUDE.md` and deduplicates identical content, so the symlink costs no extra context.
  Claude Code reads `CLAUDE.md`, and Codex reads `AGENTS.md`. One file serves all three, without an `@` import whose
  support in Cursor the docs do not state.
- `CLAUDE.md` is the real file because the maintainer works in Claude Code, whose conventions (the Applied Learning
  section, path-scoped rules) target that name.
- A symlink needs OS support. Windows is out of scope: its behaviour with the `AGENTS.md` symlink is not tested.
- A budget forces detail out of the guide and into the book. When the guide needs a rule, the rule's home is the book and
  the guide links to it.
- Shared skill references are copies, because a skill cannot point outside its folder; a test fails when two copies drift.

## Considered options

- **A flat repository** (the state before): product and dev concerns leak into each other.
- **`AGENTS.md` canonical, `CLAUDE.md` holding `@AGENTS.md`:** it relies on every reader resolving the import. The docs state
  it for Claude Code but not for Cursor.
- **Two independent guide files:** they would drift, and every dogfood step would pay for both.
- **Publishing the runtime as an npm package now:** not needed to ship the kit, and it is recorded as a separate evolution
  issue.

---

[← Anterior: 7.3 · ADR-0003: Runs are detached processes](0003-detached-jobs.md) · [Índice](../README.md) · [Próximo: 7.5 · ADR-0005: The cloud backend and the location cap →](0005-cloud-backend-and-location-cap.md)
