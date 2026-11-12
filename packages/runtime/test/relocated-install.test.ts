// Seam: the process. The runtime resolves its own assets (built-in workflows, package.json) relative to its install
// location, never the repo root; the only repo it reads is the target repo it is pointed at (cwd). The package is
// copied to a directory with no repo around it and the MCP server is started from there against another directory.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const PACKAGE = join(import.meta.dirname, "..");

/** The nearest node_modules (hoisted by the workspace) that holds the runtime's dependencies. */
function dependenciesDir(): string {
  for (let dir = PACKAGE; dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", "tsx"))) return join(dir, "node_modules");
  }
  throw new Error("node_modules not found: run `npm ci` first");
}

let sandbox: string;
let kit: string;
let targetRepo: string;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-relocated-"));
  kit = join(sandbox, "kit");
  targetRepo = join(sandbox, "target-repo");
  mkdirSync(kit);
  for (const entry of ["src", "workflows", "tsconfig.json", "tsconfig.test.json"]) cpSync(join(PACKAGE, entry), join(kit, entry), { recursive: true });
  mkdirSync(join(kit, "test"));
  cpSync(join(PACKAGE, "test", "fake-sdk.ts"), join(kit, "test", "fake-sdk.ts"));
  const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8"));
  writeFileSync(join(kit, "package.json"), JSON.stringify({ ...manifest, version: "9.9.9-relocated" }));
  symlinkSync(dependenciesDir(), join(kit, "node_modules"));

  mkdirSync(join(targetRepo, ".agents", "workflows"), { recursive: true });
  writeFileSync(join(targetRepo, ".agents", "workflows", "repo-local.mjs"), 'export default { meta: { name: "repo-local", description: "workflow of the target repo" } };\n');
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

test("a relocated install serves its own built-in workflows and version, plus those of the target repo cwd", async () => {
  const client = new Client({ name: "relocated-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: join(kit, "node_modules", ".bin", "tsx"),
    args: [join(kit, "src", "mcp-server.ts")],
    cwd: targetRepo,
    env: { ...getDefaultEnvironment(), TSX_TSCONFIG_PATH: join(kit, "tsconfig.test.json"), WF_METRICS: "off" },
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, "9.9.9-relocated");

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["get_workflow_status", "list_workflows", "start_workflow", "wait_workflow"]);

    const listed = await client.callTool({ name: "list_workflows", arguments: {} });
    const names = (JSON.parse((listed.content as Array<{ text: string }>)[0]!.text) as Array<{ name: string }>).map((w) => w.name);
    assert.ok(names.includes("implement-issue"), `built-in workflow missing from ${names}`);
    assert.ok(names.includes("repo-local"), `target repo workflow missing from ${names}`);
  } finally {
    await client.close();
  }
});
