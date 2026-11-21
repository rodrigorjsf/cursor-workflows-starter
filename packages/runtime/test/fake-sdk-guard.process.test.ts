// Seam: a test process (fake-sdk.ts, the CLI, the MCP server) whose @cursor/sdk resolves to the real package
// The offline suite must never reach the Cursor API. The fake SDK comes in through tsx's `paths` (tsconfig.test.json); a run
// that misses it (tsx without that tsconfig, another runtime that ignores TSX_TSCONFIG_PATH) loads the real SDK, which takes
// the user's key from CURSOR_API_KEY or ~/.cursor/sdk/auth.json. Both guards refuse to go on instead.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const PACKAGE = join(import.meta.dirname, "..");
const sandbox = mkdtempSync(join(tmpdir(), "wf-fake-sdk-guard-"));
after(() => rmSync(sandbox, { recursive: true, force: true }));

// A tsconfig.test.json that lost its `paths`: what a child sees when the mapping does not apply.
const unmapped = join(sandbox, "tsconfig.test.json");
writeFileSync(unmapped, JSON.stringify({ extends: join(PACKAGE, "tsconfig.json") }));

const run = (args: string[], tsconfig: string) =>
  spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), ...args], {
    cwd: sandbox,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: join(sandbox, "home"), WF_HOME: join(sandbox, "wf"), WF_METRICS: "off", WF_DASH_AUTOSTART: "off", TSX_TSCONFIG_PATH: tsconfig },
  });

test("the fake SDK refuses to load in a process whose @cursor/sdk is the real one", () => {
  const fake = pathToFileURL(join(PACKAGE, "test", "fake-sdk.ts")).href;
  const r = run(["--input-type=module", "-e", `await import(${JSON.stringify(fake)})`], join(PACKAGE, "tsconfig.json"));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /real @cursor\/sdk/);
});

test("the CLI started by a test refuses to run on the real SDK", () => {
  const r = run([join(PACKAGE, "src", "cli.ts"), "list"], unmapped);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /real @cursor\/sdk/);
});

test("the MCP server started by a test refuses to run on the real SDK", () => {
  const r = run([join(PACKAGE, "src", "mcp-server.ts")], unmapped);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /real @cursor\/sdk/);
});

test("with the test tsconfig the CLI runs on the fake", () => {
  const r = run([join(PACKAGE, "src", "cli.ts"), "list"], join(PACKAGE, "tsconfig.test.json"));
  assert.equal(r.status, 0, r.stderr);
});
