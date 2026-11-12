# 7.1 · ADR-0001: Layered config with hard caps

**Status:** accepted · decided in [spec #2](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/2)

## Context

Models, token and cent budgets, timeouts and retries were hardcoded in each workflow or passed as ad-hoc `WF_*`
environment variables. Workflows had no repo-level or user-level config file. In a company, nothing protected the
spending caps from a pull request that edits the repo's configuration, and nothing stopped the chat agent from asking
for a bigger budget than its owner meant to allow.

## Decision

Behaviour is configured in JSON, in two files, and the user's file holds the only authority over spending and reach.

- **Global**, `~/.cursor-workflows/config.json`: hard **caps** (tokens per run, tokens per step, cents per run, allowed
  models, allowed setting sources, allowed step locations, concurrency) and preferences. It is the machine owner's file.
- **Repo**, `.agents/workflows/config.json`: **preferences** per workflow and, inside a workflow, per named **role**
  (model with params, timeouts, retries, schema retries, per-step token cap, setting sources), with label globs as a
  fallback for steps outside any role. It also declares the kit's compatible semver range. It holds no caps of its own.
- **Precedence:** code defaults < global < repo < env < flag/MCP. The global caps then **clamp** the result: numbers
  take the minimum, allowlists intersect.
- **Only tighten.** A repo file or an MCP override that tries to loosen a cap is reported as a violation and has no
  effect. The chat agent can ask for a tighter budget for one run and cannot loosen anything.
- **Absent inherits, `null` disables.** An absent key inherits the next layer down; an explicit `null` means "no cap".
  Zero is never read as unset.
- **Roles are a public contract.** A workflow declares its roles in its metadata, and a config key that names a role the
  workflow did not declare is an error. `WF_MODEL_*` variables keep working as shortcuts for roles, model params included.
- **Validated and recorded.** A JSON Schema shipped with the kit validates both files (Ajv; errors name the field path).
  The config is re-read on every `start_workflow`. Each run records the effective config and the source of every value.
- **Default caps the installer writes:** 3,000,000 tokens per run; 600,000 tokens per step; 500 cents per run; all
  setting sources except `"all"`; concurrency 4; all models allowed; local location only.

## Consequences

- A pull request cannot raise spend, allow the `"all"` setting source, enable cloud steps or loosen sandboxing: those
  are caps, and a repo file only tightens them.
- "Why did this run use that model or that cap?" has an answer in the run's first event, not in someone's memory.
- The role names of a workflow become API: renaming one breaks every config that mentions it, and that failure is loud
  on purpose.
- There are two files and a precedence chain to learn. The cost is paid back by `wf config show`, which prints the
  effective config and its provenance for the current repo.
- A cap that is a bare `null` is a decision to remove protection; it is allowed in the global file and visible in the
  provenance, not forbidden.

## Considered options

- **Environment variables only** (the status quo): not shareable, not validated, not visible to a reader of the repo.
- **One config file in the repo:** a pull request could edit the caps along with the preferences, which is the problem
  to solve.
- **Defaults in each workflow's code:** it ties tuning to a code change and cannot express a machine-wide limit.
- **An organisation layer above the user** (managed by MDM or an admin): a real need for some teams, left out until one
  asks for it. The clamp step would take one more input, and nothing else changes.

---

[← Anterior: 6.1 · Referência de eventos](../reference/events.md) · [Índice](../README.md) · [Próximo: 7.2 · ADR-0002: The event log is the source of truth →](0002-event-log-source-of-truth.md)
