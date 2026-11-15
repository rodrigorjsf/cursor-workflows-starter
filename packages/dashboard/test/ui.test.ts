// Seam: HTTP. The Run view is a page the dashboard serves, with a script and a style it builds itself when it starts: the tests
// ask the server for them the way a browser does and look at what comes back. Nothing here runs the page: that is the
// browser validation (the `chrome-devtools` MCP), because this repo has no DOM to run it in.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import ts from "@typescript/typescript6";
import { type DashboardServer, startDashboard } from "../src/server.js";
import { PACKAGE } from "./render.js";
import { http, sandbox, type Sandbox } from "./support.js";

let box: Sandbox;
let dash: DashboardServer;
beforeEach(async () => {
  box = sandbox();
  dash = await startDashboard({ port: 0 });
});
afterEach(async () => {
  await dash.close();
  box.dispose();
});

/** The scripts and styles a page names, as the paths the browser would ask for. */
const assetsOf = (html: string) => ({
  scripts: [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]!),
  styles: [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]!),
});

test("GET /runs/:runId is the Run view page: HTML with one script and one style of its own, and nothing inline or from another site", async () => {
  const page = await http(dash.url, "/runs/smoke-aaaa0001");

  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-type"]), /^text\/html/);
  assert.equal(page.headers["cache-control"], "no-store", "the page names assets by hash: it must be fetched again to see a new build");
  const { scripts, styles } = assetsOf(page.text);
  assert.equal(scripts.length, 1);
  assert.equal(styles.length, 1);
  for (const path of [...scripts, ...styles]) assert.match(path, /^\/assets\/[\w.-]+$/, "same origin, under /assets/");
  assert.doesNotMatch(page.text.replace(/<script[^>]*\ssrc="[^"]*"[^>]*><\/script>/g, ""), /<script/i, "no inline script");
  assert.doesNotMatch(page.text, /https?:\/\//, "no link to another site");
  assert.match(page.text, /<title>[^<]*smoke-aaaa0001/, "the tab says which run it shows");
});

test("the page is sent with a content security policy that allows only this origin's scripts and connections", async () => {
  const policy = String((await http(dash.url, "/runs/smoke-aaaa0001")).headers["content-security-policy"]);
  const directive = (name: string) => policy.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));

  assert.equal(directive("default-src"), "default-src 'none'");
  assert.equal(directive("script-src"), "script-src 'self'");
  assert.equal(directive("connect-src"), "connect-src 'self'", "the event stream and the API, from this origin only");
  assert.equal(directive("frame-ancestors"), "frame-ancestors 'none'");
  assert.doesNotMatch(policy, /unsafe-eval|https?:|\*/);
});

test("the script and the style are built once, named by the build's content hash, served for a year and never revalidated", async () => {
  const first = assetsOf((await http(dash.url, "/runs/a")).text);
  const second = assetsOf((await http(dash.url, "/runs/b")).text);
  assert.deepEqual(second, first, "one build serves every run");

  for (const [path, type] of [[first.scripts[0]!, /^text\/javascript/], [first.styles[0]!, /^text\/css/]] as const) {
    const asset = await http(dash.url, path);
    assert.equal(asset.status, 200, path);
    assert.match(String(asset.headers["content-type"]), type);
    assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(asset.headers["x-content-type-options"], "nosniff");
    assert.match(path, /^\/assets\/run\.[0-9a-f]{16}\.(js|css)$/, "named after the build's content hash");
  }
});

test("the script is a module that parses, and neither file loads anything from another site", async () => {
  const { scripts, styles } = assetsOf((await http(dash.url, "/runs/smoke-aaaa0001")).text);
  const script = await http(dash.url, scripts[0]!);
  const style = await http(dash.url, styles[0]!);

  const dir = mkdtempSync(join(tmpdir(), "wf-ui-"));
  try {
    writeFileSync(join(dir, "run.mjs"), script.text);
    execFileSync(process.execPath, ["--check", join(dir, "run.mjs")]); // throws on a syntax error
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.doesNotMatch(script.text, /\bimport\s*\(?\s*["']https?:|fetch\(["']https?:|XMLHttpRequest|importScripts/, "the script makes no request to another site");
  assert.doesNotMatch(style.text, /@import|url\(\s*["']?(https?:)?\/\//, "the style fetches nothing from another site");
});

test("only the files of the build are served under /assets/: anything else is a 404", async () => {
  await http(dash.url, "/runs/a"); // builds
  for (const path of ["/assets/nope.js", "/assets/", "/assets/..%2Fserver.ts", "/assets/%2e%2e/%2e%2e/package.json", "/assets/run.tsx", "/assets/%E0%A4%A"]) {
    assert.equal((await http(dash.url, path)).status, 404, path);
  }
});

test("the page and its assets keep the Host check and the read-only methods", async () => {
  const { scripts } = assetsOf((await http(dash.url, "/runs/a")).text);
  for (const path of ["/runs/a", scripts[0]!]) {
    assert.equal((await http(dash.url, path, { host: "evil.example" })).status, 403, path);
    assert.equal((await http(dash.url, path, { method: "POST" })).status, 405, path);
    assert.equal((await http(dash.url, path, { method: "HEAD" })).status, 200, path);
  }
});

// ── A page that fails shows why, instead of going blank ──────────────────────────────────────────────────────────────────────
// Nothing runs the page here, so these two read the entry files of the pages as the TypeScript parser does: the root each mounts is wrapped in
// the error boundary, and `createRoot` gets an `onUncaughtError`, for what a boundary cannot catch (an error in the boundary itself).

/** The entry file of each page, relative to the package. */
const ENTRIES = ["app/main.tsx", "run-view/run-page.tsx"];

/** What a page's entry file mounts: the tag of the element handed to `.render(...)`, and the properties of the options handed to `createRoot(..., options)`. */
function mountOf(entry: string): { rendered: string | undefined; rootOptions: string[] } {
  const sf = ts.createSourceFile(entry, readFileSync(join(PACKAGE, entry), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let rendered: string | undefined;
  let rootOptions: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createRoot") {
      const options = node.arguments[1];
      if (options && ts.isObjectLiteralExpression(options)) rootOptions = options.properties.flatMap((p) => (p.name && ts.isIdentifier(p.name) ? [p.name.text] : []));
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "render") {
      const element = node.arguments[0];
      if (element && ts.isJsxElement(element)) rendered = element.openingElement.tagName.getText(sf);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { rendered, rootOptions };
}

test("both pages mount their root inside the error boundary, with an onUncaughtError for what the boundary cannot catch", () => {
  for (const entry of ENTRIES) {
    const { rendered, rootOptions } = mountOf(entry);
    assert.equal(rendered, "ErrorBoundary", `${entry}: the root is not wrapped in <ErrorBoundary>`);
    assert.ok(rootOptions.includes("onUncaughtError"), `${entry}: createRoot has no onUncaughtError (it has: ${rootOptions.join(", ") || "no options"})`);
  }
});
