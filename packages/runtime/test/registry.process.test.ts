// Seam 2, the process: one broken workflow file in the target repo must not take the MCP server down. The server starts,
// still serves the good workflows, and reports the broken file in list_workflows.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const PACKAGE = join(import.meta.dirname, "..");
let sandbox: string;
let repo: string;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-registry-process-"));
  repo = join(sandbox, "repo");
  const dir = join(repo, ".agents", "workflows");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(sandbox, "home"));
  writeFileSync(join(dir, "good.mjs"), `export default { meta: { name: "good", description: "fine" }, async run() { return "ok"; } };\n`);
  writeFileSync(join(dir, "broken.mjs"), `export default {{ this is not javascript\n`);
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

test("a broken workflow file is reported in list_workflows, and the server still starts and serves the others", async () => {
  const env = { ...getDefaultEnvironment(), WF_HOME: join(sandbox, "home"), TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"), WF_METRICS: "off", WF_CWD: repo };
  const client = new Client({ name: "registry-process-test", version: "0.0.0" });
  try {
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", "mcp-server.ts")], cwd: repo, env, stderr: "ignore" }),
    );
    const listed = await client.callTool({ name: "list_workflows", arguments: {} });
    const entries = JSON.parse((listed.content as Array<{ text: string }>)[0]!.text) as Array<{ name?: string; file?: string; error?: string }>;
    assert.ok(entries.some((e) => e.name === "good"), "the good workflow is still listed");
    const broken = entries.find((e) => e.file?.endsWith("broken.mjs"));
    assert.ok(broken, "the broken file is reported");
    assert.ok(broken.error && broken.error.length > 0, "with the load error");
  } finally {
    await client.close();
  }
});
