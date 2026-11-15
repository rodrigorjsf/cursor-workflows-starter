// Seam: the `wf` CLI and the MCP server as they print, at stdout. The SDK writes INFO logs through console.log (measured on
// 2026-11-11: "LocalCursorRulesService load completed"). In the CLI they dirtied the JSON on stdout; in the MCP server, stdout
// is the JSON-RPC channel, so `console-to-stderr` diverts them and has to load before any other module.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");

test("console-to-stderr: console.log, info e debug vão para o stderr; o stdout fica limpo", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-console-"));
  const file = join(dir, "p.mts");
  writeFileSync(file, `await import(${JSON.stringify(join(root, "src", "console-to-stderr.ts"))});\nconsole.log("L"); console.info("I"); console.debug("D");\n`);
  try {
    // tsx is hoisted to the workspace root's node_modules, so load it by module resolution, not by a path under the package.
    const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), file], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /L\n[\s\S]*I\n[\s\S]*D\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI e servidor MCP carregam o desvio antes de qualquer outro módulo", () => {
  for (const f of ["src/cli.ts", "src/mcp-server.ts"]) {
    const firstImport = readFileSync(join(root, f), "utf8").split("\n").find((l) => l.startsWith("import "));
    assert.match(firstImport ?? "", /^import "\.\/console-to-stderr\.js";/, f);
  }
});
