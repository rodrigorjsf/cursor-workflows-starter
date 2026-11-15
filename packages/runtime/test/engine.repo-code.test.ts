// Seam: the engine, run with the fake Cursor SDK in a temporary repository, and the event log it writes. A step that loads the
// project's settings (the default `settingSources`) runs the hooks and MCP servers the repository declares, on this machine: the run
// says so in one `warning` event at its start, listing the commands, so the person watching it can stop it. It says nothing when
// the repository declares none, or when the global caps keep the project's settings out of every step.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { calls, script } from "./fake-sdk.js";
import { runWorkflow } from "../src/runtime/engine.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { defineWorkflow } from "../src/runtime/workflow.js";
import { clearConfig, writeGlobalConfig } from "./config-fixtures.js";

let cwd = "";
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "wf-repo-code-"));
});
afterEach(() => {
  clearConfig(cwd);
  rmSync(cwd, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
});

const put = (file: string, content: unknown) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), JSON.stringify(content));
};
const withCode = () => {
  put(".cursor/hooks.json", { version: 1, hooks: { beforeShellExecution: [{ command: "./hooks/audit.sh" }] } });
  put(".claude/settings.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "make notify" }] }] } });
  put(".cursor/mcp.json", { mcpServers: { workflows: { command: "tsx", args: ["mcp-server.ts"] }, docs: { command: "npx", args: ["-y", "docs-server"] } } });
};
const wf = defineWorkflow({ meta: { name: "plain", description: "one step" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent("hello", { label: "hello" }) });
const warningsOf = async (): Promise<string[]> => {
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.status, "finished", r.error);
  return readEventLog(eventLogPath(cwd, r.runId)).events.flatMap((e) => (e.type === "warning" ? [e.message] : []));
};

test("a run that loads the project's settings warns once at its start, listing the hook and MCP server commands, and the kit's own server is not among them", async () => {
  withCode();
  script.push(() => ({ result: "ok" }));
  const warnings = (await warningsOf()).filter((m) => m.includes("run code on this machine"));
  assert.equal(warnings.length, 1, warnings.join("\n"));
  const [warning] = warnings;
  for (const listed of [".cursor/hooks.json (beforeShellExecution): ./hooks/audit.sh", ".claude/settings.json (Stop): make notify", '.cursor/mcp.json (MCP server "docs"): npx -y docs-server']) {
    assert.ok(warning!.includes(listed), `${listed} is not in: ${warning}`);
  }
  assert.ok(!warning!.includes("mcp-server.ts"), warning);
  assert.match(warning!, /^the project's settings of this repository run code on this machine/);
});

test("the warning is the first thing the run says: before any step", async () => {
  withCode();
  script.push(() => ({ result: "ok" }));
  const r = await runWorkflow(wf, {}, { cwd });
  const events = readEventLog(eventLogPath(cwd, r.runId)).events;
  const at = events.findIndex((e) => e.type === "warning" && e.message.includes("run code on this machine"));
  assert.ok(at > 0 && events[at - 1]!.type === "run-start", events.map((e) => e.type).join());
  assert.ok(events.findIndex((e) => e.type === "step-start") > at);
});

test("no warning when the repository declares no hook and no server but the kit's, or when the global caps allow no project settings", async () => {
  script.push(() => ({ result: "ok" }));
  put(".cursor/mcp.json", { mcpServers: { workflows: { command: "tsx", args: ["mcp-server.ts"] } } });
  assert.deepEqual((await warningsOf()).filter((m) => m.includes("run code")), []);

  withCode();
  writeGlobalConfig({ caps: { allowedSettingSources: ["user", "team", "mdm", "plugins"] } });
  script.push(() => ({ result: "ok" }));
  assert.deepEqual((await warningsOf()).filter((m) => m.includes("run code")), []);
});
