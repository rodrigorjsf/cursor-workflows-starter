// A process the offline tests start (TSX_TSCONFIG_PATH names their tsconfig.test.json, which maps @cursor/sdk to the fake)
// must not run on the real SDK: it would reach the Cursor API with the user's key. It does when the mapping misses, for
// example under a runtime that ignores TSX_TSCONFIG_PATH. Imported by the CLI and the MCP server before the SDK.
import { basename } from "node:path";

if (basename(process.env.TSX_TSCONFIG_PATH ?? "") === "tsconfig.test.json" && !import.meta.resolve("@cursor/sdk").endsWith("/test/fake-sdk.ts")) {
  process.stderr.write("cursor-workflows: this test process resolved the real @cursor/sdk instead of the fake; refusing to run so no test reaches the Cursor API.\n");
  process.exit(1);
}
export {};
