// Shared by the process-seam tests of this folder: start an MCP server over stdio and talk to it with a real client.
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type StdioServerParameters, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const ROOT = resolve(import.meta.dirname, "..");

/** Offline runs: tsx swaps `@cursor/sdk` for the fake through this tsconfig. */
export const FAKE_SDK_TSCONFIG = join(ROOT, "packages", "runtime", "tsconfig.test.json");

/** The tools the `workflows` MCP server exposes. */
export const MCP_TOOLS = ["get_workflow_status", "list_workflows", "start_workflow", "wait_workflow"];

/** Connects a client to the server described by `params`, runs `use`, and always closes the connection. */
export async function withMcpServer<T>(params: StdioServerParameters, use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "repo-test", version: "0.0.0" });
  try {
    await client.connect(new StdioClientTransport(params));
    return await use(client);
  } finally {
    await client.close();
  }
}
