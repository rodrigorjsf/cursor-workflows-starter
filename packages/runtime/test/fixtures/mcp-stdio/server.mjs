// SPDX-License-Identifier: MIT
import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
const text = (value) => ({ content: [{ type: "text", text: String(value) }] });

server.registerTool("echo", { description: "Answers with the text it got.", inputSchema: z.strictObject({ text: z.string() }) }, async ({ text: said }) => text(`echo: ${said}`));

server.registerTool("args", { description: "Answers with the arguments it got, as JSON.", inputSchema: z.looseObject({}) }, async (got) => text(JSON.stringify(got)));

server.registerTool("pid", { description: "Answers with the process id of the server.", inputSchema: z.strictObject({}) }, async () => text(process.pid));

server.registerTool("cwd", { description: "Answers with the working directory of the server.", inputSchema: z.strictObject({}) }, async () => text(process.cwd()));

server.registerTool(
  "env",
  { description: "Answers with the value of an environment variable of the server.", inputSchema: z.strictObject({ name: z.string() }) },
  async ({ name }) => text(process.env[name] ?? "unset"),
);

server.registerTool("fail", { description: "Reports a tool error.", inputSchema: z.strictObject({}) }, async () => ({ isError: true, content: [{ type: "text", text: "the tool failed on purpose" }] }));

server.registerTool(
  "hang",
  { description: "Records its process id in a file, then never answers.", inputSchema: z.strictObject({ marker: z.string() }) },
  async ({ marker }) => {
    writeFileSync(marker, String(process.pid));
    return new Promise(() => {});
  },
);

await server.connect(new StdioServerTransport());
