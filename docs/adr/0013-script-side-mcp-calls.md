# 7.13 · ADR-0013: Script-side MCP calls with `ctx.mcp`

**Status:** accepted, not built yet · decided on 2026-11-19 after the context-parity research of 2026-11-17 (`ai-study-library`, `ai/study/paridade-contexto-workflows`)

## Context

Converting a skill that explores a database (MCP queries, CLIs, `--review` and `--interview` branches) into a workflow
leaves one step to the model that the script already knows how to take: calling a known MCP tool with known arguments.
Today the only way a workflow reaches an MCP server is through an agent step. The step gets `mcpServers`, and the model
decides which tool to call and with which arguments. Listing the tables or describing a schema then costs a whole agent
turn and adds variance to a step that has a fixed answer.

`ctx.exec` already covers the same case for commands: the script runs a known `argv` with no agent and no shell. The
runtime already depends on `@modelcontextprotocol/sdk`, so a client is available without a new dependency.

## Decision

**`ctx.mcp(server, tool, args)` calls one tool of one MCP server from the workflow process, with no agent, and returns
the tool's result.**

- **Inline config only.** `server` is a config the workflow's code declares: a stdio command with its args and env. HTTP
  servers wait until a workflow needs one. The call never resolves a server by name from the repository's `.cursor/mcp.json`: in an untrusted
  repository that file would decide what runs, and it would bypass `caps.allowedSettingSources`, which is the only gate
  over the repository's MCP servers today.
- **Not journaled, like `ctx.exec`.** A resume calls the tool again. When the data has not changed, the prompt of the
  next agent step is the same and that step comes back from the journal; when it has changed, the steps that depend on
  it run again on fresh data.
- **A command in the event log.** The call reuses the `exec-start` and `exec-end` events, with `command: "mcp"` and the
  server and tool in the label, so the run page draws it as it draws a command and the event schema does not change. The
  call's arguments and result are content: same redaction, same cut and same retention as an agent's. A cancelled run closes the client and throws.
- **The choice of tool inside an exploration stays with the model** when the script does not know it. `ctx.mcp` is for
  the calls whose tool and arguments the code already decides.

## Consequences

- The MCP server runs in the workflow's process tree, outside the SDK sandbox, with the same trust as a `ctx.exec`
  command. The person who reviews the workflow sees the command in the code.
- A skill that uses a server configured only in the IDE needs that config copied into the workflow.
- `skill-to-workflow` maps "call this MCP tool with these arguments" to `ctx.mcp` when the skill fixes both, and leaves
  it to an agent step otherwise.

## Considered options

- **Leave every MCP call to the model.** No new API, but every known query pays an agent turn and its variance. This is
  the gap the conversion of an MCP-heavy skill hits first.
- **Resolve servers by name from `.cursor/mcp.json`.** Reuses the IDE's config, but lets the repository decide what the
  workflow process runs, outside the setting-sources cap.
- **New `mcp-start` / `mcp-end` events.** Cleaner meaning (an MCP call is not a process and has no exit code), but
  the run graph, the events reference and the dashboard would all change for the same picture.
- **Journal the result by server, tool and arguments.** Makes resumes stable, but returns stale data and is wrong for
  tools with effects unless each call is marked read-only.

---

[← Anterior: 7.12 · ADR-0012: Delivery modes: the main tree by default, a worktree on request](0012-delivery-modes.md) · [Índice](../README.md) · [Próximo: 8.1 · Cursor SDK como motor de workflows determinísticos: relatório de pesquisa →](../research/relatorio-pesquisa.md)
