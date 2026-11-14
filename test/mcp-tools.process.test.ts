// Seam: the MCP server over stdio, as a real child process driven by an MCP client (`test/mcp-support.ts`). It is built on
// `McpServer.registerTool`: the SDK checks each call against the tool's input schema before the handler runs and reports a
// failure as a tool error. These tests pin what the chat sees: the five tools and their required properties, a call that
// breaks the schema or names no tool, the arguments the handlers still check themselves (the move refuses nothing there),
// and the guard that keeps a workflow step from starting workflows. Offline: the fake Cursor SDK replaces `@cursor/sdk`.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import semver from "semver";
import { FAKE_SDK_TSCONFIG, MCP_TOOLS, ROOT, withMcpServer } from "./mcp-support.js";

const RUNTIME_SRC = join(ROOT, "packages", "runtime", "src");

let sandbox: string;
before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-mcp-tools-"));
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

/** An empty repository for one test, so that a job folder in it can only come from that test. */
const freshRepo = () => mkdtempSync(join(sandbox, "repo-"));

const serverParams = (script: string, repo: string, extraEnv: Record<string, string> = {}) => ({
  command: process.execPath,
  args: ["--import", import.meta.resolve("tsx"), script],
  cwd: repo,
  env: {
    ...getDefaultEnvironment(),
    TSX_TSCONFIG_PATH: FAKE_SDK_TSCONFIG,
    WF_HOME: join(sandbox, "home"),
    WF_METRICS: "off",
    WF_DASH_AUTOSTART: "off", // the tests must not leave a dashboard behind
    WF_CWD: repo,
    ...extraEnv,
  },
});
const mcpServer = (repo: string, extraEnv?: Record<string, string>) => serverParams(join(RUNTIME_SRC, "mcp-server.ts"), repo, extraEnv);

interface Reply {
  isError?: boolean;
  content: Array<{ text: string }>;
}

/** The properties each tool lists and requires. A literal, not read back from the server's own schemas. */
const TOOLS: Record<string, { properties: string[]; required: string[] }> = {
  cancel_workflow: { properties: ["jobId"], required: ["jobId"] },
  get_workflow_status: { properties: ["jobId"], required: ["jobId"] },
  list_workflows: { properties: [], required: [] },
  start_workflow: { properties: ["args", "name", "overrides", "resumeRunId"], required: ["name"] },
  wait_workflow: { properties: ["jobId", "timeoutSec"], required: ["jobId"] },
};

test("tools/list names the five tools, each with the properties it lists and requires, and a description", async () => {
  const listed = await withMcpServer(mcpServer(freshRepo()), async (client) => (await client.listTools()).tools);
  assert.deepEqual(listed.map((t) => t.name).sort(), MCP_TOOLS);
  for (const tool of listed) {
    const schema = tool.inputSchema as { type: string; properties?: Record<string, unknown>; required?: string[] };
    assert.equal(schema.type, "object", tool.name);
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), TOOLS[tool.name]!.properties, `${tool.name}: properties`);
    assert.deepEqual([...(schema.required ?? [])].sort(), TOOLS[tool.name]!.required, `${tool.name}: required`);
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a description the model can act on`);
  }
});

test("tools/list keeps what the model is told about the values: workflow names, the wait's bounds, the limit overrides", async () => {
  const listed = await withMcpServer(mcpServer(freshRepo()), async (client) => (await client.listTools()).tools);
  const props = (name: string) => (listed.find((t) => t.name === name)!.inputSchema as { properties: Record<string, any> }).properties;
  assert.equal(props("start_workflow").name.type, "string");
  assert.ok((props("start_workflow").name.enum as string[]).includes("smoke"), "the built-in workflows are the choices");
  assert.equal(props("start_workflow").args.type, "object");
  assert.equal(props("start_workflow").resumeRunId.type, "string");
  assert.equal(props("start_workflow").overrides.additionalProperties, false);
  assert.deepEqual(Object.keys(props("start_workflow").overrides.properties).sort(), ["concurrency", "maxCents", "maxTokens", "maxTokensPerStep"]);
  assert.deepEqual(
    [props("wait_workflow").timeoutSec.type, props("wait_workflow").timeoutSec.minimum, props("wait_workflow").timeoutSec.maximum],
    ["number", 1, 50],
  );
  assert.match(listed.find((t) => t.name === "start_workflow")!.description!, /Available: .*smoke/);
});

test("a call that breaks an input schema is a tool error that names the property, and nothing starts", async () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["get_workflow_status", {}, "jobId"],
    ["wait_workflow", { timeoutSec: 1 }, "jobId"],
    ["cancel_workflow", {}, "jobId"],
    ["start_workflow", {}, "name"],
    ["get_workflow_status", { jobId: 7 }, "jobId"],
    ["start_workflow", { name: 7 }, "name"],
  ];
  const repo = freshRepo();
  await withMcpServer(mcpServer(repo), async (client) => {
    for (const [name, args, property] of cases) {
      const reply = (await client.callTool({ name, arguments: args })) as Reply;
      const label = `${name} ${JSON.stringify(args)}: ${reply.content[0]!.text}`;
      assert.equal(reply.isError, true, label);
      assert.match(reply.content[0]!.text, new RegExp(`Input validation error: Invalid arguments for tool ${name}\\b.*\\b${property}\\b`, "s"), label);
    }
  });
  assert.equal(existsSync(join(repo, ".workflows", "jobs")), false, "a refused call creates no job");
});

test("a call to a tool that is not registered is a tool error that names the tool", async () => {
  await withMcpServer(mcpServer(freshRepo()), async (client) => {
    const reply = (await client.callTool({ name: "no_such_tool", arguments: {} })) as Reply;
    assert.equal(reply.isError, true, reply.content[0]!.text);
    assert.match(reply.content[0]!.text, /Tool no_such_tool not found/);
  });
});

test("a value the handler checks itself reaches the handler: the schema adds no refusal (a numeric string, null and a wait outside 1..50 still count)", async () => {
  await withMcpServer(mcpServer(freshRepo()), async (client) => {
    for (const timeoutSec of ["30", null, 999, 0]) {
      const reply = (await client.callTool({ name: "wait_workflow", arguments: { jobId: "nope1234", timeoutSec } })) as Reply;
      assert.equal(reply.isError, true, String(timeoutSec));
      assert.deepEqual(JSON.parse(reply.content[0]!.text), { error: "job not found" }, `timeoutSec ${JSON.stringify(timeoutSec)}`);
    }
    const unknown = (await client.callTool({ name: "start_workflow", arguments: { name: "no-such-workflow", args: null, resumeRunId: null } })) as Reply;
    assert.equal(unknown.isError, true);
    assert.deepEqual(JSON.parse(unknown.content[0]!.text), { error: "unknown workflow: no-such-workflow" });
  });
});

test("inside a workflow step the server lists no tool and answers every call with the refusal, flagged as an error", async () => {
  const refusal = { error: "workflows cannot be started from inside a workflow step" };
  const repo = freshRepo();
  await withMcpServer(mcpServer(repo, { WF_INSIDE_WORKFLOW: "1" }), async (client) => {
    assert.deepEqual((await client.listTools()).tools, []);
    for (const [name, args] of [["start_workflow", { name: "smoke" }], ["list_workflows", {}], ["get_workflow_status", { jobId: "x" }], ["anything_else", {}]] as const) {
      const reply = (await client.callTool({ name, arguments: args })) as Reply;
      assert.equal(reply.isError, true, name);
      assert.deepEqual(JSON.parse(reply.content[0]!.text), refusal, name);
    }
  });
  assert.equal(existsSync(join(repo, ".workflows", "jobs")), false, "the refusal starts no job");
});

test("the guard server that replaces `workflows` in a step lists no tool", async () => {
  const tools = await withMcpServer(serverParams(join(RUNTIME_SRC, "runtime", "nested-mcp-guard.mjs"), freshRepo()), async (client) => (await client.listTools()).tools);
  assert.deepEqual(tools, []);
});

test("no source file of the runtime builds the SDK's deprecated low-level Server", () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.(ts|mjs|js)$/.test(e.name) ? [join(dir, e.name)] : []));
  const offenders = sources(RUNTIME_SRC).filter((file) => /@modelcontextprotocol\/sdk\/server\/index\.js/.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders, [], "use McpServer from @modelcontextprotocol/sdk/server/mcp.js");
});

test("the runtime's SDK range starts at the version whose McpServer the server relies on: input checked into an isError reply, and no tool listed when none is registered", () => {
  const range = JSON.parse(readFileSync(join(ROOT, "packages", "runtime", "package.json"), "utf8")).dependencies["@modelcontextprotocol/sdk"] as string;
  assert.ok(semver.gte(semver.minVersion(range)!, "1.32.2"), `${range} admits an SDK that does not do that (measured: 1.32.1 answers "Method not found" to tools/list for a server with no tool registered, as does 1.23.0; before 1.23.0 there is no zod 4)`);
});
