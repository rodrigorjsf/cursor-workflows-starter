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

**B. Install the kit once and point each repository at it.** In the target repository create `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "workflows": {
      "command": "${userHome}/tools/cursor-workflows/node_modules/.bin/tsx",
      "args": ["${userHome}/tools/cursor-workflows/packages/runtime/src/mcp-server.ts"],
      "env": { "WF_CWD": "${workspaceFolder}", "WF_MAX_CENTS": "500", "WF_MAX_TOKENS": "2000000" }
    }
  }
}
```

- `WF_MAX_CENTS` and `WF_MAX_TOKENS` are the run caps. Always set both (runtime-api.md, "Caps").
- `${workspaceFolder}` is the folder that holds the `.cursor/mcp.json`; in a global `~/.cursor/mcp.json` it does not
  point at the open project, so use the project's `mcp.json`.
- Claude Code: replicate the server in the repository's `.mcp.json` with absolute paths. In an interactive session it
  asks approval for that server first.
- Copy the `run-workflow` skill folder into the target repository (or link it globally). In Cursor, enable the server
  under **Customize** in the sidebar if it does not show in the chat. An Enterprise admin can limit which MCP servers
  members run.

## Writing a workflow for form B

A repository workflow imports the runtime by no relative path: write it as a plain object,
`export default { meta, defaults, budget, async run(ctx) { ... } }`. Type-only imports (`import type ...`) are erased by
`tsx` and do no harm. For typecheck and tests, develop the workflow inside the kit and copy it to the repository's
`.agents/workflows/`, replacing `defineWorkflow({...})` and the relative runtime import with the plain object (the same
object).
