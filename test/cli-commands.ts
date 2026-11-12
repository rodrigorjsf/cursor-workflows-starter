// The commands the `wf` CLI answers to, read the way a user would: from the usage line it prints when run with none.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

export function wfCommands(): string[] {
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(ROOT, "packages", "runtime", "src", "cli.ts")], { encoding: "utf8" });
  const usage = /usage: wf <([^>]+)>/.exec(r.stderr);
  assert.ok(usage, `wf prints its usage: ${r.stderr}`);
  return usage[1]!.split("|");
}
