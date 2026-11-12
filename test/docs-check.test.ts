// Seam: the docs check, run as a process (`scripts/check-docs.ts --root <dir>`) against small throwaway books.
// Observable behaviour only: the exit code and the lines it prints. The last test runs it on this repo's own docs, so
// `npm test` fails when the book drifts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { ROOT } from "./mcp-support.js";

const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

type Files = Record<string, string>;

/** Writes `files` (path relative to the root -> content) into a fresh temp repo and returns its path. */
function repo(files: Files): string {
  const root = mkdtempSync(join(tmpdir(), "wf-docs-check-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function check(root: string): { ok: boolean; out: string } {
  const r = spawnSync(join(ROOT, "node_modules", ".bin", "tsx"), [join(ROOT, "scripts", "check-docs.ts"), "--root", root], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(r.error, undefined, String(r.error));
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

/** Passes when the check rejects the repo and the output names the expected problem. */
function assertRejected(root: string, expected: RegExp): void {
  const { ok, out } = check(root);
  assert.equal(ok, false, `the check should fail:\n${out}`);
  assert.match(out, expected);
}

test("links: a relative link to a file that exists passes", () => {
  const { ok, out } = check(repo({ "README.md": "# Hi\n\nSee [the guide](notes/guide.md).\n", "notes/guide.md": "# Guide\n" }));
  assert.equal(ok, true, out);
});

test("links: a relative link to a missing file fails and names the file, the line and the target", () => {
  assertRejected(repo({ "README.md": "# Hi\n\nSee [the guide](notes/missing.md).\n" }), /README\.md:3: .*notes\/missing\.md/);
});

test("links: images, links to folders and external URLs are handled, and code is not read as links", () => {
  const root = repo({
    "README.md": [
      "# Hi",
      "",
      "![shot](img/shot.png) [folder](img/) [web](https://example.com/a(b)) [mail](mailto:a@b.c)",
      "",
      "Inline `[nope](nope.md)` and a fence:",
      "",
      "```md",
      "[nope](nope.md)",
      "# not a heading",
      "```",
      "",
    ].join("\n"),
    "img/shot.png": "png",
  });
  const { ok, out } = check(root);
  assert.equal(ok, true, out);
});

test("anchors: a link to a heading follows GitHub's ids (accents, punctuation, repeats, same-file links)", () => {
  const root = repo({
    "README.md": [
      "# Hi",
      "",
      "[a](notes/guide.md#3-teto-de-custo) [b](notes/guide.md#segurança) [c](notes/guide.md#seguran%C3%A7a) [d](notes/guide.md#faq-1) [e](#hi)",
      "[f](notes/guide.md#code-e-link) [g](notes/guide.md#explicit-id)",
      "",
    ].join("\n"),
    "notes/guide.md": [
      "# Guide",
      "",
      "## 3. Teto de custo",
      "## Segurança",
      "## FAQ",
      "## FAQ",
      "## `code` e [link](guide.md)",
      '<a id="explicit-id"></a>',
      "",
      "```md",
      "## Not a heading",
      "```",
      "",
    ].join("\n"),
  });
  const { ok, out } = check(root);
  assert.equal(ok, true, out);
});

test("anchors: a link to a heading that does not exist fails and names the file, the line and the anchor", () => {
  assertRejected(
    repo({ "README.md": "# Hi\n\n[x](notes/guide.md#nope)\n\n[y](#also-nope)\n", "notes/guide.md": "# Guide\n" }),
    /README\.md:3: .*#nope[\s\S]*README\.md:5: .*#also-nope/,
  );
});

test("anchors: headings inside a code fence are not anchors", () => {
  assertRejected(repo({ "README.md": "# Hi\n\n[x](#fenced)\n\n```md\n## Fenced\n```\n" }), /README\.md:3: .*#fenced/);
});

// ---- the book: docs/README.md is the index; every other chapter is listed in it and ends with a footer ----

const INDEX = [
  "# Livro",
  "",
  "## Partes e capítulos",
  "",
  "### Parte 1 · Uso",
  "",
  "- [1.1 · Um](usage/01-um.md): primeiro",
  "- [1.2 · Dois](usage/02-dois.md): segundo",
  "",
  "### Parte 2 · Internos",
  "",
  "- [2.1 · Três](internals/01-tres.md): terceiro",
  "",
  "### Parte 3 · Referência",
  "",
  "_Em preparação._",
  "",
].join("\n");

/** A chapter body: the H1, one line of text and the footer, written out by hand (not derived from the check's rules). */
const chapter = (title: string, footer: string) => `# ${title}\n\nTexto.\n\n---\n\n${footer}\n`;

const GOOD_BOOK: Files = {
  "docs/README.md": INDEX,
  "docs/usage/01-um.md": chapter("1.1 · Um", "[Índice](../README.md) · [Próximo: 1.2 · Dois →](02-dois.md)"),
  "docs/usage/02-dois.md": chapter(
    "1.2 · Dois",
    "[← Anterior: 1.1 · Um](01-um.md) · [Índice](../README.md) · [Próximo: 2.1 · Três →](../internals/01-tres.md)",
  ),
  "docs/internals/01-tres.md": chapter("2.1 · Três", "[← Anterior: 1.2 · Dois](../usage/02-dois.md) · [Índice](../README.md)"),
  "docs/agents/setup.md": "# Not part of the book: no footer, not listed\n",
};

test("book: an index, chapters in reading order with matching footers, an empty part and docs/agents pass", () => {
  const { ok, out } = check(repo(GOOD_BOOK));
  assert.equal(ok, true, out);
});

test("book: a chapter missing from the index fails and names the file", () => {
  assertRejected(
    repo({ ...GOOD_BOOK, "docs/usage/03-extra.md": chapter("1.3 · Extra", "[← Anterior: 1.2 · Dois](02-dois.md) · [Índice](../README.md)") }),
    /docs\/usage\/03-extra\.md: .*not listed in the book index/,
  );
});

test("book: a chapter without a footer fails", () => {
  assertRejected(repo({ ...GOOD_BOOK, "docs/usage/02-dois.md": "# 1.2 · Dois\n\nTexto.\n" }), /docs\/usage\/02-dois\.md:.*footer/);
});

test("book: a footer whose link goes to the wrong chapter fails and shows the expected footer", () => {
  assertRejected(
    repo({
      ...GOOD_BOOK,
      "docs/usage/01-um.md": chapter("1.1 · Um", "[Índice](../README.md) · [Próximo: 2.1 · Três →](../internals/01-tres.md)"),
    }),
    /docs\/usage\/01-um\.md:.*footer[\s\S]*\[Próximo: 1\.2 · Dois →\]\(02-dois\.md\)/,
  );
});

test("book: reordering the index makes the footers fail until they follow the new order", () => {
  const swapped = INDEX.replace("- [1.1 · Um](usage/01-um.md): primeiro\n- [1.2 · Dois](usage/02-dois.md): segundo", "- [1.1 · Dois](usage/02-dois.md): segundo\n- [1.2 · Um](usage/01-um.md): primeiro");
  assertRejected(repo({ ...GOOD_BOOK, "docs/README.md": swapped }), /footer/);
});

test("book: an index entry that is not numbered part.position in reading order fails", () => {
  assertRejected(repo({ ...GOOD_BOOK, "docs/README.md": INDEX.replace("[1.2 · Dois]", "[1.5 · Dois]") }), /docs\/README\.md:\d+: .*1\.5 · Dois.*1\.2/);
});

test("book: a chapter whose H1 differs from its index entry fails", () => {
  assertRejected(repo({ ...GOOD_BOOK, "docs/usage/01-um.md": chapter("1.9 · Um", "[Índice](../README.md) · [Próximo: 1.2 · Dois →](02-dois.md)") }), /docs\/usage\/01-um\.md:1: .*1\.9 · Um.*1\.1 · Um/);
});

test("book: chapters without an index fail", () => {
  const { "docs/README.md": _index, ...withoutIndex } = GOOD_BOOK;
  assertRejected(repo(withoutIndex), /docs\/README\.md.*missing/);
});

test("this repo's own docs pass the check", () => {
  const { ok, out } = check(ROOT);
  assert.equal(ok, true, out);
});
