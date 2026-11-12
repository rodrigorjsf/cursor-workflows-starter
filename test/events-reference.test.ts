// Seam 3, the docs: the events reference page is generated from the event interfaces, and `npm test` fails when the
// committed page drifts from them. Regenerate with `npm run docs:events`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkDocs } from "../scripts/check-docs.js";
import { EVENTS_PAGE, EVENTS_SOURCE, generateEventsReference } from "../scripts/events-reference.js";

const source = readFileSync(EVENTS_SOURCE, "utf8");

test("the committed events reference page matches the event type", () => {
  assert.equal(readFileSync(EVENTS_PAGE, "utf8"), generateEventsReference(source), "docs/reference/events.md is out of date: run `npm run docs:events`");
});

test("the page documents every event type, its fields and their comments", () => {
  const page = generateEventsReference(source);
  for (const type of ["log", "phase", "run-start", "run-end", "group-start", "group-end", "step-start", "turn", "content", "step-end", "metric", "warning"]) {
    assert.match(page, new RegExp(`^### \`${type}\``, "m"), `section of ${type}`);
  }
  assert.match(page, /\| `stepId` \| `string` \| sim \|/, "a required field of the step position");
  assert.match(page, /\| `parentId` \| `string \\\| null` \| sim \|/, "a union type keeps its pipe escaped inside the table");
  assert.match(page, /\| `jobId` \| `string` \| não \| O job \(`wf start`, `start_workflow`\) que iniciou esta execução\./, "an optional field carries its comment");
  assert.match(page, /### `step-start`[\s\S]*\[`EventBase`\]\(#eventbase\)[\s\S]*\[`StepRef`\]\(#stepref\)/, "a step event says it also has the common and the position fields");
});

test("a change to the event type makes the committed page stale", () => {
  const changed = source.replace('type: "log";', 'type: "log";\n  /** Gravidade. */\n  level?: "info" | "warn";');
  assert.notEqual(changed, source, "the fixture edit applied");
  const page = generateEventsReference(changed);
  assert.match(page, /\| `level` \| `"info" \\\| "warn"` \| não \| Gravidade\. \|/);
  assert.notEqual(page, readFileSync(EVENTS_PAGE, "utf8"), "the committed page no longer matches: the docs check would fail");
});

test("the page's footer comes from the book index: moving the page in the index changes its number and footer, no constant to update", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-events-footer-"));
  try {
    const book: Record<string, string> = {
      "docs/README.md": [
        "# Book",
        "",
        "### Parte 1 · Um",
        "",
        "- [1.1 · Primeiro](one/01-primeiro.md): x",
        "",
        "### Parte 2 · Dois",
        "",
        "- [2.1 · Referência de eventos](reference/events.md): x",
        "- [2.2 · Terceiro](reference/02-terceiro.md): x",
        "",
      ].join("\n"),
      "docs/one/01-primeiro.md": "# 1.1 · Primeiro\n",
      "docs/reference/events.md": "# 2.1 · Referência de eventos\n",
      "docs/reference/02-terceiro.md": "# 2.2 · Terceiro\n",
    };
    for (const [path, content] of Object.entries(book)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const lastLine = (page: string) => page.trimEnd().split("\n").at(-1);
    const first = generateEventsReference(source, root);
    assert.equal(first.split("\n")[0], "# 2.1 · Referência de eventos", "the H1 is the index label");
    assert.equal(lastLine(first), "[← Anterior: 1.1 · Primeiro](../one/01-primeiro.md) · [Índice](../README.md) · [Próximo: 2.2 · Terceiro →](02-terceiro.md)");

    // the page moves to the end of the part: the footer follows without touching the generator
    writeFileSync(
      join(root, "docs/README.md"),
      book["docs/README.md"]!.replace("- [2.1 · Referência de eventos](reference/events.md): x\n- [2.2 · Terceiro](reference/02-terceiro.md): x", "- [2.1 · Terceiro](reference/02-terceiro.md): x\n- [2.2 · Referência de eventos](reference/events.md): x"),
    );
    const moved = generateEventsReference(source, root);
    assert.equal(moved.split("\n")[0], "# 2.2 · Referência de eventos");
    assert.equal(lastLine(moved), "[← Anterior: 2.1 · Terceiro](02-terceiro.md) · [Índice](../README.md)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the page refuses to be generated when the book index does not list it", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-events-footer-"));
  try {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/README.md"), "# Book\n\n### Parte 1 · Um\n\n- [1.1 · Primeiro](one/01-primeiro.md): x\n");
    mkdirSync(join(root, "docs/one"), { recursive: true });
    writeFileSync(join(root, "docs/one/01-primeiro.md"), "# 1.1 · Primeiro\n");
    assert.throws(() => generateEventsReference(source, root), /docs\/reference\/events\.md.*not listed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the page the generator writes passes the docs check, also next to a chapter the check does not count", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-events-footer-"));
  try {
    const files: Record<string, string> = {
      "docs/README.md": ["# Book", "", "### Parte 1 · Um", "", "- [1.1 · Referência de eventos](reference/events.md): x", "- [1.2 · Atalho](reference/02-atalho.md): x", ""].join("\n"),
      "docs/other.md": "# Other\n",
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    // a listed chapter that is a symbolic link: the docs check does not read links, so it is not the page's next chapter
    mkdirSync(join(root, "docs/reference"), { recursive: true });
    symlinkSync(join(root, "docs/other.md"), join(root, "docs/reference/02-atalho.md"));
    writeFileSync(join(root, "docs/reference/events.md"), generateEventsReference(source, root));

    const footerProblems = checkDocs(root).problems.filter((problem) => problem.startsWith("docs/reference/events.md") && /footer/.test(problem));
    assert.deepEqual(footerProblems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
