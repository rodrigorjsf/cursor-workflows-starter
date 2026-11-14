// The environment variable that marks a process as running inside a workflow step. The engine sets it (the shell of the steps
// inherits it) and every surface that starts a run refuses when it is set: the CLI, the MCP server and the dashboard's Start
// action. The MCP servers a step loads from the project's `.cursor/mcp.json` do not inherit it (measured), so the engine
// registers an inline guard for them instead (`nestedGuard` in engine.ts). It is an accident guard, not a security barrier. A
// module of its own, so a process that only checks it (the dashboard) does not import the engine, and with it the Cursor SDK.

/** Set to `"1"` in a process that runs inside a workflow step. */
export const INSIDE_WORKFLOW_ENV = "WF_INSIDE_WORKFLOW";
