// Seam: the README as a newcomer finds it. A slim hub (the problem, the idea, one overview diagram, a quickstart, a
// "what you get" table, links into the book) in pt-BR, mirrored by README.en.md in English. Whether its links resolve
// is docs-check.test.ts; these tests read what the hub holds and what it must leave to the book.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { markdownFiles, parseMarkdown } from "../scripts/lib/markdown.js";
import { wfCommands } from "./cli-commands.js";

const ROOT = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const HUBS = [
  { file: "README.md", sections: ["O problema", "A ideia", "Começo rápido", "O que você leva", "Para continuar"] },
  { file: "README.en.md", sections: ["The problem", "The idea", "Quick start", "What you get", "Keep reading"] },
];

/** Repo-relative targets a hub links to, without anchors, URLs and the link to the other language's hub. */
function repoLinks(file: string): string[] {
  const targets = parseMarkdown(read(file)).links.map((l) => l.target.split("#")[0]!);
  const own = targets.filter((t) => t !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^README(\.en)?\.md$/.test(t));
  return [...new Set(own)].sort();
}

/** Prose paragraphs (not headings, tables, quotes, lists or code), whitespace-normalised. */
function paragraphs(md: string): string[] {
  return parseMarkdown(md)
    .lines.join("\n")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "" && !/^(#|\||>|[-*]\s|\d+\.\s|<)/.test(block))
    .map((block) => block.replace(/\s+/g, " "));
}

test("each README has one Mermaid overview diagram, the sections in order, and links to the book index", () => {
  for (const hub of HUBS) {
    const doc = parseMarkdown(read(hub.file));
    assert.equal(doc.mermaid.length, 1, `${hub.file}: exactly one Mermaid diagram`);
    assert.deepEqual(
      doc.headings.filter((h) => h.level === 2).map((h) => h.text),
      hub.sections,
      `${hub.file}: sections`,
    );
    assert.ok(
      doc.links.some((l) => l.target === "docs/README.md"),
      `${hub.file}: links to docs/README.md`,
    );
  }
});

test("README.en.md mirrors README.md: the same structure, the same links into the repo, one table of what you get", () => {
  const [pt, en] = HUBS.map((hub) => parseMarkdown(read(hub.file)));
  assert.deepEqual(
    en!.headings.map((h) => h.level),
    pt!.headings.map((h) => h.level),
    "the same heading levels in the same order",
  );
  assert.deepEqual(repoLinks("README.en.md"), repoLinks("README.md"), "the same targets inside the repo");
  assert.equal(
    (read("README.en.md").match(/^```/gm) ?? []).length,
    (read("README.md").match(/^```/gm) ?? []).length,
    "the same number of code blocks",
  );
  for (const hub of HUBS) {
    const section = read(hub.file).split(/^## /m).find((s) => s.startsWith(hub.sections[3]!));
    assert.ok(section, `${hub.file}: the "${hub.sections[3]}" section`);
    assert.ok(/^\|.*\|\s*$/m.test(section), `${hub.file}: "${hub.sections[3]}" is a table`);
  }
});

test("README.md says the book is in Portuguese and README.en.md says so for English readers", () => {
  assert.match(read("README.en.md"), /Brazilian Portuguese/);
  assert.match(read("README.md"), /README\.en\.md/);
});

test("a hub is slim: it stays under 110 lines", () => {
  for (const hub of HUBS) {
    const lines = read(hub.file).trimEnd().split("\n").length;
    assert.ok(lines <= 110, `${hub.file} has ${lines} lines; the depth belongs in the book`);
  }
});

/** Every run of `size` consecutive words of the prose, lower-cased and without markup: a copied sentence leaves a run behind. */
function shingles(text: string, size = 12): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>|]/g, " ")
    .split(/[^\p{L}\p{N}.:/-]+/u)
    .filter(Boolean);
  const runs = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) runs.add(words.slice(i, i + size).join(" "));
  return runs;
}

test("no deep content is duplicated between a README and the book", () => {
  const book = new Set<string>();
  for (const file of markdownFiles(ROOT).filter((f) => f.startsWith("docs/") || f === "SECURITY.md")) {
    for (const run of shingles(paragraphs(read(file)).join("\n\n"))) book.add(run);
  }
  for (const hub of HUBS) {
    const own = shingles(paragraphs(read(hub.file)).join("\n\n"));
    assert.ok(own.size > 0, `${hub.file}: expected prose to compare`);
    const copied = [...own].filter((run) => book.has(run));
    assert.deepEqual(copied.slice(0, 3), [], `${hub.file} repeats text that is in the book (${copied.length} twelve-word runs)`);
  }
});

test("the quickstart only runs commands that exist: the installer it fetches, the wf commands, the npm scripts", () => {
  const scripts = new Set(Object.keys(JSON.parse(read("package.json")).scripts as Record<string, string>));
  const commands = wfCommands();
  const installerHelp = spawnSync("bash", [join(ROOT, "scripts", "install.sh"), "--help"], { encoding: "utf8" }).stdout;
  for (const hub of HUBS) {
    const lines = read(hub.file).match(/^(?:npm run [\w:-]+|wf [a-z]+|bash \S*install\.sh .*)/gm) ?? [];
    assert.ok(lines.length >= 4, `${hub.file}: the quickstart runs something (found ${lines.length} commands)`);
    for (const line of lines) {
      const [first, second, third] = line.split(" ");
      if (first === "npm") assert.ok(scripts.has(third!), `${hub.file}: ${line} is not a script in package.json`);
      else if (first === "wf") assert.ok(commands.includes(second!), `${hub.file}: wf ${second} is not a command of the CLI`);
      else for (const flag of line.match(/ --[a-z-]+/g) ?? []) assert.ok(installerHelp.includes(flag.trim()), `${hub.file}: install.sh --help does not list${flag}`);
    }
    assert.ok(lines.some((l) => l.startsWith("wf init")) && lines.some((l) => l.startsWith("wf doctor")), `${hub.file}: the quickstart sets up a repo and checks it`);
  }
});

test("the quickstart fetches and installs the tag of the package version, the same one the install guide pins", () => {
  const tag = `v${(JSON.parse(read("package.json")) as { version: string }).version}`;
  for (const hub of HUBS) {
    const text = read(hub.file);
    assert.ok(text.includes(`rodrigorjsf/cursor-workflows-starter/${tag}/scripts/install.sh`), `${hub.file}: fetch install.sh at ${tag}`);
    assert.ok(text.includes(`install.sh --tag ${tag}`), `${hub.file}: install ${tag}`);
    assert.ok(parseMarkdown(text).links.some((l) => l.target === "INSTALL-AGENT.md"), `${hub.file}: links to INSTALL-AGENT.md`);
  }
});

test("the depth the README used to carry lives in the book: what the kit does underneath, and the state it keeps", () => {
  const governance = read("docs/operating/01-governanca-e-custos.md");
  assert.match(governance, /^## Transparência: o que o kit faz por baixo$/m);
  assert.match(governance, /info\/exclude/, "the state dir is excluded through .git/info/exclude, not .gitignore");
  assert.match(governance, /`wf\/issue-<n>-<run>`/, "the branch the implement-issue workflow commits to: one per run");
  for (const hub of HUBS) assert.doesNotMatch(read(hub.file), /settingSources|info\/exclude/, `${hub.file} leaves that depth to the book`);
});
