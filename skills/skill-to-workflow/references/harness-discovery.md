# Where each harness looks for each thing

The kit uses `.agents/` as a neutral place and keeps only what is specific to a harness in `.cursor/` and `.claude/`.
Use this table for the inventory column "Harnesses that discover it today" and for the report's parity item.

| Artifact | `.agents/` | `.cursor/` | `.claude/` | `.codex/` |
|---|---|---|---|---|
| Skills: Cursor IDE | ✅ native (`.agents/skills/`, `~/.agents/skills/`) | ✅ native | ✅ compat. | ✅ compat. |
| Skills: Cursor SDK runs (`settingSources: ["project"]`) | ✅ first-party | ✅ | ✅ third-party | ✅ third-party |
| Skills: Claude Code | ❌ reads nothing under `.agents/` | ❌ | ✅ | ❌ |
| Subagents: Cursor | ❌ undocumented | ✅ | ✅ compat. | ✅ compat. |
| Subagents: Claude Code | ❌ | ❌ | ✅ | ❌ |
| Instructions | `AGENTS.md` at the root (Cursor also accepts it in subfolders): read by Cursor and by SDK runs; Claude Code by default reads it only **when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists** in the folder or above, or through `@AGENTS.md` | `.cursor/rules/` | `CLAUDE.md` (the Cursor IDE agent also reads it) | — |
| MCP | — | `.cursor/mcp.json` | `.mcp.json` (root) | — |
| Workflows of this kit | `.agents/workflows/` (read by the runtime) | — | — | — |

Consequences:

- **Skills in `.agents/skills/`** work in the Cursor IDE, in workflow steps and in Codex. For Claude Code, link each
  skill folder into `.claude/skills/` (`ln -s ../../.agents/skills/<name> .claude/skills/<name>`). Cursor also reads
  `.claude/skills/`, and its docs state no precedence or deduplication rule for skills, so a linked skill may show up
  twice in Cursor: link only when the team uses Claude Code in the repository.
- **Instructions** live in `AGENTS.md`; a `CLAUDE.md` that holds only `@AGENTS.md` (or an `AGENTS.md` symlinked to
  `CLAUDE.md`) gives Claude Code the same text.
- **Subagents** stay in `.cursor/agents/` or `.claude/agents/`; no `.agents/agents/` is documented. In a converted
  workflow, subagents become steps (`ctx.agent`) or inline `agents`, so they stop depending on the folder.

## Cursor × Claude Code parity

| Axis | Cursor | Claude Code |
|---|---|---|
| Where to register the MCP server | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` | `.mcp.json` (project) or `claude mcp add`. In an interactive session the `.mcp.json` server asks for approval first (`claude mcp list` shows `⏸ Pending approval`); with `claude -p`, the Agent SDK and cloud sessions outside a project it loads without asking |
| Fire lock | Approval of `start_workflow` by the Run Mode (outside the allowlist) | The permission prompt of `mcp__workflows__start_workflow` (outside `permissions.allow`); a `PreToolUse` hook with `matcher: "mcp__workflows__start_workflow"` can audit or block it |
| Native workflow | **None**; the kit fills the gap | The `Workflow` tool, `/deep-research`, `.claude/workflows/` |
| How context reaches step agents | `settingSources: ["project","team","mdm"]` loads `AGENTS.md`, `.cursor/rules`, skills, hooks and the project MCP; `AGENTS.md` arrives only with `"project"` and is opt-in | The step agents are Cursor's even when Claude Code fires the workflow; whether local SDK runs read `CLAUDE.md` is undocumented, so keep the rules in `AGENTS.md` |
| Hooks that reach steps | Project, team and MDM hooks (through `settingSources`). With `"project"`, `.cursor/hooks.json` hooks ran, and a `PreToolUse` hook in the project's `.claude/settings.json` that exits 2 blocked the command; with `[]` none ran | Same hooks run in the steps; warn the user that their `PreToolUse` hooks apply there |
| Who pays | The Cursor key used by the runtime | The same: Claude Code's model only pays for the firing and the polling |

To use Claude Code's own runtime instead of this kit, write the flow as a Claude Code workflow
(`.claude/workflows/<name>.js`). The `meta` + `agent/parallel/pipeline/phase` structure is nearly the same: swap
`ctx.agent` for `agent`, and pass `git`/`gh` to an agent step, because Claude Code's sandbox has no shell.
