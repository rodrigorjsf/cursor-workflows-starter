// Shared by the process-seam tests of this folder: start an MCP server over stdio and talk to it with a real client.
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type StdioServerParameters, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const ROOT = resolve(import.meta.dirname, "..");

/** Offline runs: tsx swaps `@cursor/sdk` for the fake through this tsconfig. */
export const FAKE_SDK_TSCONFIG = join(ROOT, "packages", "runtime", "tsconfig.test.json");

/** The tools the `workflows` MCP server exposes. */
export const MCP_TOOLS = ["cancel_workflow", "get_workflow_status", "list_workflows", "start_workflow", "wait_workflow"];

export async function withMcpServer<T>(params: StdioServerParameters, use: (client: Client, serverPid: number) => Promise<T>): Promise<T> {
  const client = new Client({ name: "repo-test", version: "0.0.0" });
  try {
    const transport = new StdioClientTransport(params);
    await client.connect(transport);
    return await use(client, transport.pid!);
  } finally {
    await client.close();
  }
}

export function nodeChildrenOf(pid: number): string[] {
  const table = spawnSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" }).stdout.trim().split("\n");
  return table.map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)(.*)$/.exec(line)).flatMap((m) => (m && Number(m[2]) === pid && basename(m[3]!) === "node" ? [`${m[3]}${m[4]}`] : []));
}
