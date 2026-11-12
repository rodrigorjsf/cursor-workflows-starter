// Shared by the process tests that need a kit of another version: a copy of this checkout's runtime package (plus the
// templates) laid out like an installed kit, so the CLI and the MCP server run from it and read its own package.json.
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE = join(import.meta.dirname, "..");
const KIT_ROOT = join(PACKAGE, "..", "..");

/** Copies the kit to `dir` (which must not exist) and sets its version to `version`. Its `node_modules` is this checkout's. */
export function copyKit(dir: string, version: string): string {
  const runtime = join(dir, "packages", "runtime");
  for (const entry of ["src", "workflows", "schema", "tsconfig.json", "tsconfig.test.json"]) cpSync(join(PACKAGE, entry), join(runtime, entry), { recursive: true });
  mkdirSync(join(runtime, "test"));
  cpSync(join(PACKAGE, "test", "fake-sdk.ts"), join(runtime, "test", "fake-sdk.ts"));
  cpSync(join(KIT_ROOT, "templates"), join(dir, "templates"), { recursive: true });
  writeFileSync(join(runtime, "package.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")), version }));
  symlinkSync(join(KIT_ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}
