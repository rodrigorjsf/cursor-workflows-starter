// Seam: the process. The dogfood MCP configs of this repo (Claude Code `.mcp.json`, Cursor `.cursor/mcp.json`) are
// launched exactly as the IDE launches them, and an MCP client talks to the server over stdio. Offline: the fake
// Cursor SDK replaces `@cursor/sdk` through TSX_TSCONFIG_PATH.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = resolve(import.meta.dirname, "..");
const RUNTIME_PACKAGE = "@cursor-workflows/runtime";

/** Name of the package.json closest to `file`, walking up the directory tree. */
function owningPackage(file: string): string | undefined {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, "utf8")).name;
  }
  return undefined;
}

type ServerConfig = { command: string; args: string[]; env?: Record<string, string> };

for (const file of [".mcp.json", ".cursor/mcp.json"]) {
  test(`${file}: the configured server is the runtime package and answers tools/list`, async () => {
    const config = JSON.parse(readFileSync(join(ROOT, file), "utf8")).mcpServers.workflows as ServerConfig;
    // Cursor resolves ${workspaceFolder}; Claude Code starts the command in the project root.
    const resolveVars = (s: string) => s.replaceAll("${workspaceFolder}", ROOT);
    const args = config.args.map(resolveVars);

    assert.equal(owningPackage(resolve(ROOT, args[0]!)), RUNTIME_PACKAGE, "the entry point belongs to the runtime package");

    const client = new Client({ name: "dogfood-test", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: resolve(ROOT, resolveVars(config.command)),
      args,
      cwd: ROOT,
      env: {
        ...getDefaultEnvironment(),
        ...Object.fromEntries(Object.entries(config.env ?? {}).map(([k, v]) => [k, resolveVars(v)])),
        TSX_TSCONFIG_PATH: join(ROOT, "packages", "runtime", "tsconfig.test.json"),
      },
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        ["get_workflow_status", "list_workflows", "start_workflow", "wait_workflow"],
      );
    } finally {
      await client.close();
    }
  });
}
