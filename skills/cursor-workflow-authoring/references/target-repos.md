# Where a workflow lives, and using the kit in other repositories

## Locations

- **Built in:** `packages/runtime/workflows/<name>.ts` in the kit. The runtime loads every `.ts`, `.js` and `.mjs` at
  the first level of the folder, so helper modules go in a `<name>/` subfolder.
- **Repository:** `.agents/workflows/<name>.ts` in the target repository. The runtime loads this folder too, and on a
  repeated name the repository wins. `.agents/` is a neutral place: Cursor, Claude Code and Codex all fire the same
  workflows through the MCP server.

## Two ways to use the kit in another repository

**A. Copy the kit into the repository** (simplest). The workflows live in the kit's `workflows/` folder, versioned with
the code.

**B. Install the kit once and point each repository at it.** The kit lives at `~/.cursor-workflows/kit`, installed once per
machine by its installer (a missing kit is installed with the install guide, `INSTALL-AGENT.md`, in the kit's GitHub
repository). In the target repository run `wf init`: it writes the `workflows` server into `.cursor/mcp.json` (through `${userHome}`) and `.mcp.json` (through
`${HOME}`), a repo config at `.agents/workflows/config.json`, a `.workflows/` line in `.gitignore` and a marked rules
block in `AGENTS.md`. It prints the diff and never commits.

- The run caps are config, not environment: the global file `~/.cursor-workflows/config.json` holds the hard caps, and
  the repo config can only tighten them (runtime-api.md, "Caps").
- `${workspaceFolder}` is the folder that holds the `.cursor/mcp.json`; in a global `~/.cursor/mcp.json` it does not
  point at the open project, so use the project's `mcp.json`. `wf init` writes `WF_CWD` for that reason.
- Claude Code asks approval for the `.mcp.json` server in an interactive session.
- The kit's skills (`run-workflow`, `cursor-workflow-authoring`, `skill-to-workflow`, `cursor-workflows-setup`) are
  linked globally into `~/.claude/skills/`, which Cursor and Claude Code both read: nothing to copy into the repository.
  In Cursor, enable the server under **Customize** in the sidebar if it does not show in the chat. An Enterprise admin
  can limit which MCP servers members run.

## Writing a workflow for form B

A repository workflow imports the runtime by no relative path: write it as a plain object,
`export default { meta, defaults, budget, async run(ctx) { ... } }`. Type-only imports (`import type ...`) are erased by
`tsx` and do no harm. For typecheck and tests, develop the workflow inside the kit and copy it to the repository's
`.agents/workflows/`, replacing `defineWorkflow({...})` and the relative runtime import with the plain object (the same
object).
