// Seam: the installed Cursor SDK as a file tree. The SDK takes the endpoint its API key goes to from the environment
// (CURSOR_BACKEND_URL, CURSOR_WEBSITE_URL) and checks neither the scheme nor the host, so the kit checks both variables itself
// (packages/runtime/src/runtime/cursor-endpoints.ts). A new SDK version may read another variable of that kind, and nothing in the
// kit would say so: this test lists every `process.env.CURSOR_*` the SDK's bundles read and fails when the list is not the one a
// person reviewed, so a bump that adds an endpoint variable fails the suite instead of reaching users unguarded.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { CURSOR_ENDPOINT_PATTERN, CURSOR_ENDPOINT_VARIABLES } from "../packages/runtime/src/runtime/cursor-endpoints.js";

const SDK = resolve(import.meta.dirname, "..", "node_modules", "@cursor", "sdk");

/** The `.js` files under `dir`, recursively: the SDK ships its ESM, CommonJS and bundled builds, in chunks. */
function scripts(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? scripts(path) : entry.name.endsWith(".js") ? [path] : [];
  });
}
const bundles = scripts(join(SDK, "dist")).map((file) => readFileSync(file, "utf8"));

/** The variables the SDK reads that are not an address its API key goes to. Each was read in the SDK's source when 1.3.1 was installed. */
const NOT_AN_ENDPOINT: Readonly<Record<string, string>> = {
  CURSOR_AGENTKIT_VERSION: "a version string",
  CURSOR_API_KEY: "the key itself",
  CURSOR_CLOUD_AGENT_USE_LOCAL_NON_VM: "a mode switch of the cloud agent",
  CURSOR_DATA_DIR: "a directory",
  CURSOR_DISABLE_SPARSE_PLUGIN_CLONES: "a switch",
  CURSOR_FORCED_SHELL_EGRESS: "a switch of the sandbox",
  CURSOR_HOST_APP_NAME: "the name of the app that embeds the SDK",
  CURSOR_REQUEST_ID: "an id",
  CURSOR_RIPGREP_PATH: "a path to a binary",
  CURSOR_SANDBOX_POLICY_DIR: "a directory",
  CURSOR_SDK_CLIENT_LANGUAGE: "a label",
  CURSOR_SDK_DEV_FORCE_NEXT_SMART_MODE_CLASSIFIER_BLOCK_TOKEN: "a development switch",
  CURSOR_SDK_MOCK_PROMPT_TIME: "a test switch",
  CURSOR_SDK_PYTHON_VERSION: "a version string",
  CURSOR_TREE_SITTER_VENDOR_DIR: "a directory",
  CURSOR_WORKLOAD_CGROUP: "a cgroup name",
};

const readByTheSdk = (): string[] => [...new Set(bundles.flatMap((text) => [...text.matchAll(/process\.env\.(CURSOR_[A-Z0-9_]+)/g)].map((m) => m[1]!)))].sort();

test("every CURSOR_* variable the installed SDK reads is either one the kit checks as an endpoint or one a person judged not to be an address", () => {
  const found = readByTheSdk();
  assert.ok(found.includes("CURSOR_API_KEY"), "the scan found the SDK's own variables: the SDK moved, and this test has nothing to look at");
  const known = new Set([...CURSOR_ENDPOINT_VARIABLES, ...Object.keys(NOT_AN_ENDPOINT)]);
  const unreviewed = found.filter((name) => !known.has(name));
  assert.deepEqual(
    unreviewed,
    [],
    "the SDK now reads a variable the kit has not looked at. If it holds an address the SDK sends the API key to, add it to CURSOR_ENDPOINT_VARIABLES in " +
      "packages/runtime/src/runtime/cursor-endpoints.ts (the doctor, the engine and the CLI then refuse a value that is not an https URL on cursor.sh or cursor.com); " +
      "otherwise add it to NOT_AN_ENDPOINT in this test, with what it holds.",
  );
});

test("the variables the kit checks as endpoints, and only those, are read by the SDK: a variable it dropped is noticed too", () => {
  const found = new Set(readByTheSdk());
  for (const name of CURSOR_ENDPOINT_VARIABLES) assert.ok(found.has(name), `${name} is no longer read by the SDK: remove it from CURSOR_ENDPOINT_VARIABLES`);
  for (const name of Object.keys(NOT_AN_ENDPOINT)) assert.ok(!CURSOR_ENDPOINT_VARIABLES.includes(name as never), `${name} is listed as an endpoint and as not one`);
});

test("the endpoints the SDK falls back to when the variables are unset are accepted by the kit's check: it never refuses the SDK's own address", () => {
  const fallbacks = new Set(bundles.flatMap((text) => [...text.matchAll(/process\.env\.CURSOR_(?:BACKEND|WEBSITE)_URL\s*(?:\|\||\?\?)\s*"([^"]+)"/g)].map((m) => m[1]!)));
  assert.ok(fallbacks.size > 0, "no fallback endpoint found in the SDK: the scan has nothing to look at");
  for (const url of fallbacks) assert.match(url, CURSOR_ENDPOINT_PATTERN, `the SDK's own endpoint ${url} would be refused`);
});
