// How an IDE launches the kit's MCP server: the `workflows` entry of the repo's `.cursor/mcp.json` (Cursor) or `.mcp.json`
// (Claude Code), with the variables the IDE substitutes. `wf doctor` runs exactly that command, so what it finds is what the
// IDE would find.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The repo files that can register the server, relative to the repo, in the order the doctor reports them. */
export const MCP_CONFIG_FILES = [".cursor/mcp.json", ".mcp.json"];

export interface McpLaunch {
  /** The config file the entry came from, relative to the repo. */
  file: string;
  /** The command as a process would run it: variables substituted, a relative path resolved against the repo. */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** The repo: where the IDE runs the command. */
  cwd: string;
}

export interface McpLaunches {
  launches: McpLaunch[];
  /** Config files that exist but cannot start the server (not JSON, no `workflows` entry). A file that is absent is not a problem. */
  problems: string[];
}

/** `${userHome}`, `${workspaceFolder}` (Cursor), `${env:NAME}` and `${NAME}` (Claude Code); one that resolves to nothing stays as written. */
function substitute(text: string, cwd: string): string {
  return text.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    if (name === "userHome") return homedir();
    if (name === "workspaceFolder") return cwd;
    return process.env[name.startsWith("env:") ? name.slice(4) : name] ?? whole;
  });
}

export function readMcpLaunches(cwd: string): McpLaunches {
  const launches: McpLaunch[] = [];
  const problems: string[] = [];
  for (const file of MCP_CONFIG_FILES) {
    const path = join(cwd, file);
    if (!existsSync(path)) continue;
    let entry: { command?: unknown; args?: unknown; env?: unknown } | undefined;
    try {
      entry = (JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: { workflows?: typeof entry } }).mcpServers?.workflows;
    } catch (err) {
      problems.push(`${file}: JSON inválido (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (typeof entry?.command !== "string") {
      problems.push(`${file}: não tem o servidor "workflows" em mcpServers`);
      continue;
    }
    const command = substitute(entry.command, cwd);
    launches.push({
      file,
      command: command.includes("/") ? resolve(cwd, command) : command,
      args: Array.isArray(entry.args) ? entry.args.map((a) => substitute(String(a), cwd)) : [],
      env: Object.fromEntries(Object.entries((entry.env ?? {}) as Record<string, unknown>).map(([k, v]) => [k, substitute(String(v), cwd)])),
      cwd,
    });
  }
  return { launches, problems };
}
