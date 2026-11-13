// Seam: the MCP server, as a real child process, asked about a job that is not there. `wait_workflow`,
// `get_workflow_status` and `cancel_workflow` answer `{ error: "job not found" }` flagged as a tool error (`isError`), like
// every other failure of the server, for an unknown id and for one that walks out of the jobs folder.
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
let env: Record<string, string>;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-job-not-found-"));
  repo = join(sandbox, "repo");
  mkdirSync(join(repo, ".workflows", "jobs"), { recursive: true });
  // A record outside the jobs folder, which `../../../planted` would reach.
  writeFileSync(join(sandbox, "planted.json"), JSON.stringify({ jobId: "planted", runId: "proc-12345678", pid: process.pid, heartbeat: new Date().toISOString() }));
  env = {
    ...(getDefaultEnvironment() as Record<string, string>),
    TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"),
    WF_HOME: join(sandbox, "home"),
    WF_METRICS: "off",
    WF_DASH_AUTOSTART: "off", // the tests must not leave a dashboard behind
    WF_CWD: repo,
  };
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

type Reply = { isError?: boolean; content: Array<{ text: string }> };

test("wait_workflow, get_workflow_status and cancel_workflow flag a job that is not there as an error", { timeout: 30_000 }, async () => {
  const client = new Client({ name: "job-not-found-test", version: "0.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", "mcp-server.ts")], cwd: repo, env }));
    for (const jobId of ["nope1234", "../../../planted"]) {
      for (const [name, args] of [["wait_workflow", { jobId, timeoutSec: 1 }], ["get_workflow_status", { jobId }], ["cancel_workflow", { jobId }]] as const) {
        const reply = (await client.callTool({ name, arguments: args })) as Reply;
        assert.equal(reply.isError, true, `${name} ${jobId}: ${reply.content[0]!.text}`);
        assert.deepEqual(JSON.parse(reply.content[0]!.text), { error: "job not found" }, `${name} ${jobId}`);
      }
    }
  } finally {
    await client.close();
  }
});
