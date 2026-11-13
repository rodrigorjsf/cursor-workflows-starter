// Seam: HTTP, and the bundle step. The dashboard is one React app, bundled with esbuild when the dashboard starts, cached by
// content hash and served from the dashboard itself: nothing is fetched from another origin. The UI's behaviour is checked in
// a real browser (see the ticket's validation notes); these tests cover what is served and how it is cached.
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { FILES, buildWeb } from "../src/web-bundle.js";
import { type DashboardServer, startDashboard } from "../src/server.js";
import { type Sandbox, http, sandbox } from "./support.js";

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A copy of the dashboard's page sources (`app/` and `run-view/`) under `dir`. */
function copySources(dir: string): string {
  for (const tree of ["app", "run-view"]) cpSync(join(PACKAGE, tree), join(dir, tree), { recursive: true });
  return dir;
}

let box: Sandbox;
let dash: DashboardServer | undefined;
beforeEach(() => {
  box = sandbox();
});
afterEach(async () => {
  await dash?.close();
  dash = undefined;
  box.dispose();
});

const cacheDir = () => join(box.home, "dashboard-cache");

test("the home page is the app shell: one script and one stylesheet, both served by the dashboard, under a content security policy with no inline code", async () => {
  dash = await startDashboard({ port: 0 });
  const page = await http(dash.url, "/");
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-type"]), /^text\/html/);
  assert.match(page.text, /<div id="root"><\/div>/);

  const scripts = [...page.text.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]!);
  const styles = [...page.text.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]!);
  assert.match(page.text, /<link rel="icon" href="data:,">/, "an icon of its own, so the browser does not ask for /favicon.ico");
  assert.equal(scripts.length, 1);
  assert.equal(styles.length, 1);
  for (const asset of [...scripts, ...styles]) assert.match(asset, /^\/assets\/app\.[0-9a-f]{16}\.(js|css)$/, "a path on this server, named after the content hash");
  assert.doesNotMatch(page.text, /<script(?![^>]*\bsrc=)/i, "no inline script");
  assert.doesNotMatch(page.text, /https?:\/\//, "no address on another origin");

  const csp = String(page.headers["content-security-policy"]);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/, "strict: nothing inline, nothing remote");
});

test("the assets are served with the hash in their name, cached for good, as the right types", async () => {
  dash = await startDashboard({ port: 0 });
  const page = (await http(dash.url, "/")).text;
  const js = /src="([^"]+\.js)"/.exec(page)![1]!;
  const css = /href="([^"]+\.css)"/.exec(page)![1]!;

  const script = await http(dash.url, js);
  assert.equal(script.status, 200);
  assert.match(String(script.headers["content-type"]), /^text\/javascript/);
  assert.equal(script.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(script.headers["x-content-type-options"], "nosniff");
  assert.ok(script.text.length > 50_000, "React and the app are in it: nothing is loaded from elsewhere");
  for (const menu of ["Runs", "Board", "Metrics"]) assert.ok(script.text.includes(`"${menu}"`), `the ${menu} menu is in the bundle`);

  const style = await http(dash.url, css);
  assert.equal(style.status, 200);
  assert.match(String(style.headers["content-type"]), /^text\/css/);
  assert.equal(style.headers["cache-control"], "public, max-age=31536000, immutable");

  assert.equal((await http(dash.url, js, { method: "HEAD" })).status, 200);
  assert.equal((await http(dash.url, js, { host: "evil.example" })).status, 403, "the Host check covers the assets too");
});

test("only the two assets of the build are served: not another hash, not a path into the sources", async () => {
  dash = await startDashboard({ port: 0 });
  for (const path of ["/assets/app.0000000000000000.js", "/assets/app.js", "/assets/", "/assets", "/assets/../src/server.ts", "/assets/%2e%2e/src/server.ts", "/ui/main.tsx", "/assets/app.0000000000000000.js.map"]) {
    assert.equal((await http(dash.url, path)).status, 404, path);
  }
});

test("the build is cached by content hash: a second start with the same sources and versions serves the same files without building again", async () => {
  dash = await startDashboard({ port: 0 });
  const first = (await http(dash.url, "/")).text;
  const hash = /app\.([0-9a-f]{16})\.js/.exec(first)![1]!;
  const built = join(cacheDir(), hash, "app.js");
  assert.ok(existsSync(built), "the build is on disk under its hash");
  const before = statSync(built).mtimeMs;
  await dash.close();

  await new Promise((r) => setTimeout(r, 30)); // fixed-wait-ok: a rebuild would show in the modification time
  dash = await startDashboard({ port: 0 });
  assert.equal((await http(dash.url, "/")).text, first);
  assert.equal(statSync(built).mtimeMs, before, "not written again");
});

test("the Run view page is built with the app when the dashboard starts, and cached on disk under the same hash", async () => {
  dash = await startDashboard({ port: 0 });
  const hash = /app\.([0-9a-f]{16})\.js/.exec((await http(dash.url, "/")).text)![1]!;
  for (const file of ["app.js", "app.css", "run.js", "run.css"]) assert.ok(existsSync(join(cacheDir(), hash, file)), `${file} is built before any page asks for it`);
  const page = (await http(dash.url, "/runs/smoke-1")).text;
  assert.match(page, new RegExp(`src="/assets/run\\.${hash}\\.js"`));
  assert.match(page, new RegExp(`href="/assets/run\\.${hash}\\.css"`));
  const built = statSync(join(cacheDir(), hash, "run.js")).mtimeMs;
  await dash.close();

  await new Promise((r) => setTimeout(r, 30)); // fixed-wait-ok: a rebuild would show in the modification time
  dash = await startDashboard({ port: 0 });
  assert.equal((await http(dash.url, "/runs/smoke-1")).text, page);
  assert.equal(statSync(join(cacheDir(), hash, "run.js")).mtimeMs, built, "a restart reads the Run view from the cache");
});

test("a change to the sources makes a new hash, builds it, and drops the old build", async () => {
  const root = copySources(box.repo("ui-copy"));
  const cache = cacheDir();

  const first = await buildWeb({ root, cacheDir: cache });
  assert.match(first.hash, /^[0-9a-f]{16}$/);
  assert.deepEqual(readdirSync(cache), [first.hash]);

  for (const changed of [join(root, "app", "styles.css"), join(root, "run-view", "run-view.css")]) {
    const before = (await buildWeb({ root, cacheDir: cache })).hash;
    writeFileSync(changed, `${readFileSync(changed, "utf8")}\n/* changed */\n`);
    const after = await buildWeb({ root, cacheDir: cache });
    assert.notEqual(after.hash, before, `a change to ${changed} is a new build`);
    assert.deepEqual(readdirSync(cache), [after.hash], "only the current build is kept");
  }
  const second = await buildWeb({ root, cacheDir: cache });
  const again = await buildWeb({ root, cacheDir: cache });
  assert.equal(again.hash, second.hash, "the same sources give the same hash");
  assert.deepEqual(again, second);
});

test("a cache entry that is incomplete is built again, not served", async () => {
  const cache = cacheDir();
  const good = await buildWeb({ cacheDir: cache });
  rmSync(join(cache, good.hash, "run.css"));
  const rebuilt = await buildWeb({ cacheDir: cache });
  assert.deepEqual(rebuilt, good);
  for (const file of FILES) assert.ok(existsSync(join(cache, good.hash, file)), file);
});

test("two dashboards that start together both end with a whole build, and leave no temporary directory behind", async () => {
  const cache = cacheDir();
  const [a, b] = await Promise.all([buildWeb({ cacheDir: cache }), buildWeb({ cacheDir: cache })]);
  assert.deepEqual(a, b);
  assert.deepEqual(readdirSync(cache), [a.hash]);
});

test("a source that does not build stops the dashboard from starting, with the reason", async () => {
  const root = copySources(box.repo("ui-broken"));
  writeFileSync(join(root, "app", "main.tsx"), "import './nowhere';\nconst = ;\n");
  await assert.rejects(buildWeb({ root, cacheDir: cacheDir() }), /main\.tsx/);
  assert.equal(existsSync(cacheDir()) ? readdirSync(cacheDir()).length : 0, 0, "nothing half-built is left");
});
