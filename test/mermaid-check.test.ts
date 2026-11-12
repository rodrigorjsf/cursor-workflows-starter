// Seam: the Mermaid gate, run as a process (`scripts/check-mermaid.ts --root <dir>`). The real renderer
// (@mermaid-js/mermaid-cli, a headless Chromium) runs only in GitHub Actions, so these tests swap it, through
// MERMAID_CLI, for a stub that rejects a block containing the word BROKEN. What they pin down is the gate itself:
// which blocks it finds, that it renders every one, and that it fails with the file and line of a bad block.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { ROOT } from "./mcp-support.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "wf-mermaid-check-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/**
 * A stand-in for `mmdc`: `--version` succeeds, and `-i <in> -o <out> -p <puppeteer config>` fails on a diagram that
 * contains BROKEN. Each call appends "version" or "render" to the file in STUB_LOG, when set.
 */
function stubRenderer(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-mermaid-stub-"));
  dirs.push(dir);
  const stub = join(dir, "stub-mmdc.mjs");
  writeFileSync(
    stub,
    [
      'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
      "const arg = (flag) => process.argv[process.argv.indexOf(flag) + 1];",
      'const log = (what) => process.env.STUB_LOG && appendFileSync(process.env.STUB_LOG, what + "\\n");',
      'if (process.argv.includes("--version")) { log("version"); console.log("stub 0.0.0"); process.exit(0); }',
      'log("render");',
      'const source = readFileSync(arg("-i"), "utf8");',
      'if (source.includes("BROKEN")) { console.error("Parse error on line 2: unexpected BROKEN"); process.exit(1); }',
      'writeFileSync(arg("-o"), "<svg/>");',
    ].join("\n"),
  );
  return `${process.execPath} ${stub}`;
}

function run(root: string, args: string[] = [], renderer = stubRenderer(), env: Record<string, string> = {}): { status: number | null; out: string } {
  const r = spawnSync(join(ROOT, "node_modules", ".bin", "tsx"), [join(ROOT, "scripts", "check-mermaid.ts"), "--root", root, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, MERMAID_CLI: renderer, ...env },
  });
  assert.equal(r.error, undefined, String(r.error));
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const DOC = [
  "# Doc",
  "",
  "```mermaid",
  "flowchart LR",
  "  A --> B",
  "```",
  "",
  "Not diagrams: `inline mermaid`, and a fence of another language:",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "~~~mermaid",
  "stateDiagram-v2",
  "  [*] --> a",
  "~~~",
  "",
].join("\n");

test("--list names every Mermaid block of every Markdown file with its line and diagram type", () => {
  const { status, out } = run(repo({ "README.md": DOC, "docs/a.md": "```mermaid\n%% a comment\nsequenceDiagram\n  A->>B: hi\n```\n", "docs/none.md": "# No diagrams\n" }), ["--list"]);
  assert.equal(status, 0, out);
  assert.deepEqual(out.trim().split("\n").sort(), ["README.md:14: stateDiagram-v2", "README.md:3: flowchart", "docs/a.md:1: sequenceDiagram"]);
});

test("every block is rendered, and a repo whose diagrams all render passes", () => {
  const { status, out } = run(repo({ "README.md": DOC }));
  assert.equal(status, 0, out);
  assert.match(out, /2 Mermaid block\(s\)/);
});

test("the renderer is started once, before the blocks, so a cold download is not billed to the first block", () => {
  const log = join(mkdtempSync(join(tmpdir(), "wf-mermaid-log-")), "calls");
  dirs.push(join(log, ".."));
  const { status, out } = run(repo({ "README.md": DOC }), [], stubRenderer(), { STUB_LOG: log });
  assert.equal(status, 0, out);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["version", "render", "render"]);
});

test("a block the renderer rejects fails the gate with its file and line, and the other blocks are still checked", () => {
  const root = repo({
    "README.md": DOC,
    "docs/one.md": "# One\n\n```mermaid\nflowchart LR\n  BROKEN --> x\n```\n",
    "docs/two.md": "```mermaid\nflowchart LR\n  BROKEN2 --> y BROKEN\n```\n",
  });
  const { status, out } = run(root);
  assert.equal(status, 1, out);
  assert.match(out, /docs\/one\.md:3: .*Parse error on line 2/);
  assert.match(out, /docs\/two\.md:1: .*Parse error on line 2/);
  assert.doesNotMatch(out, /README\.md:\d+: .*Parse error/);
});

test("a renderer that cannot start fails the gate instead of passing silently", () => {
  const { status, out } = run(repo({ "README.md": DOC }), [], "this-renderer-does-not-exist");
  assert.equal(status, 1, out);
  assert.match(out, /could not run .*this-renderer-does-not-exist/);
});

test("the CI workflow runs the gate in its own job", () => {
  const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /^ {2}mermaid:\n/m, "ci.yml needs a `mermaid` job");
  assert.match(ci, /npm run docs:mermaid/, "the mermaid job must run `npm run docs:mermaid`");
});

test("this repo's own diagrams are found by the gate", () => {
  const { status, out } = run(ROOT, ["--list"]);
  assert.equal(status, 0, out);
  assert.match(out, /docs\/usage\/03-invocacao-no-cursor-ide\.md:\d+: flowchart/);
  assert.match(out, /docs\/contributing\/03-diagramas\.md:\d+: stateDiagram-v2/);
});
