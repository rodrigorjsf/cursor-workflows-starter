// WHAT: Checks the repo's Markdown: every relative link and anchor resolves, and the docs book is consistent (every
//   chapter is in the index docs/README.md, its H1 matches the index entry, and it ends with the previous/next footer).
// WHY: docs drift silently (a moved file, a renamed heading, a chapter nobody linked); a failing check is the only thing
//   that catches it.
// WHEN: always, through `npm test` (test/docs-check.test.ts runs it on this repo); run it alone after editing docs.
// HOW: `npm run docs:check`, or `tsx scripts/check-docs.ts [--root <dir>]`. Prints one `file:line: problem` per line
//   and exits 1 when there is any; exits 0 and prints a summary otherwise.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { isEntryPoint, rootFromArgs } from "./lib/cli.js";
import { anchorsOf, markdownFiles, parseMarkdown, type ParsedMarkdown } from "./lib/markdown.js";

export interface DocsReport {
  problems: string[];
  files: number;
  chapters: number;
}

const INDEX = "docs/README.md";
/** Folders under docs/ that are tooling config, not chapters of the book. */
const NOT_BOOK = ["docs/agents/"];

/** One chapter line of the index: `- [1.2 · Title](usage/02-title.md): description`, under `### Parte 1 · ...`. */
interface Entry {
  label: string;
  file: string;
  line: number;
}

export function checkDocs(root: string): DocsReport {
  const problems: string[] = [];
  const files = markdownFiles(root);
  const parsed = new Map<string, ParsedMarkdown>();
  const parse = (file: string): ParsedMarkdown => {
    let doc = parsed.get(file);
    if (!doc) parsed.set(file, (doc = parseMarkdown(readFileSync(join(root, file), "utf8"))));
    return doc;
  };

  for (const file of files) checkLinks(root, file, parse, problems);
  const chapters = checkBook(root, files, parse, problems);
  return { problems, files: files.length, chapters };
}

/** The book: the index lists every chapter in reading order, and each chapter agrees with its index entry. Returns the chapter count. */
function checkBook(root: string, files: string[], parse: (file: string) => ParsedMarkdown, problems: string[]): number {
  const bookFiles = files.filter((f) => f.startsWith("docs/") && f !== INDEX && !NOT_BOOK.some((dir) => f.startsWith(dir)));
  if (!files.includes(INDEX)) {
    if (bookFiles.length > 0) problems.push(`${INDEX}: the book index is missing, but docs/ holds ${bookFiles.length} chapter file(s)`);
    return 0;
  }

  const entries = indexEntries(parse(INDEX), problems);
  const listed = new Set(entries.map((e) => e.file));
  for (const file of bookFiles) if (!listed.has(file)) problems.push(`${file}: not listed in the book index (${INDEX})`);

  const chapters = entries.filter((e) => files.includes(e.file)); // a missing target is already a broken link
  chapters.forEach((chapter, i) => {
    const h1 = parse(chapter.file).headings.find((h) => h.level === 1);
    if (h1?.text !== chapter.label) {
      problems.push(`${chapter.file}:${h1?.line ?? 1}: heading ${h1 ? `"${h1.text}"` : "(none)"} must equal its index entry "${chapter.label}"`);
    }
    checkFooter(root, chapter, chapters[i - 1], chapters[i + 1], problems);
  });
  return chapters.length;
}

/** The `### Parte N · Title` sections of the index and the chapters listed in each, numbered N.position. */
function indexEntries(index: ParsedMarkdown, problems: string[]): Entry[] {
  const entries: Entry[] = [];
  const sections = index.headings.filter((h) => h.level <= 3);
  let lastPart = 0;
  sections.forEach((heading, s) => {
    const part = /^Parte (\d+) · /.exec(heading.text);
    if (!part || heading.level !== 3) return;
    const number = Number(part[1]);
    if (number <= lastPart) problems.push(`${INDEX}:${heading.line}: "${heading.text}" must come after part ${lastPart}`);
    lastPart = number;

    const end = sections[s + 1]?.line ?? index.lines.length + 1;
    let position = 0;
    for (let line = heading.line + 1; line < end; line++) {
      const item = /^\s*[-*]\s+\[([^\]]+)\]\(([^)\s#]+)(?:#[^)\s]*)?\)/.exec(index.lines[line - 1] ?? "");
      if (!item) continue;
      position++;
      const label = item[1]!;
      if (!label.startsWith(`${number}.${position} · `)) {
        problems.push(`${INDEX}:${line}: "${label}" must start with "${number}.${position} · " (part ${number}, chapter ${position})`);
      }
      entries.push({ label, file: posix.normalize(posix.join("docs", item[2]!)), line });
    }
  });
  return entries;
}

/** A chapter ends with a `---` rule and one line: previous chapter, index, next chapter, in index order. */
function checkFooter(root: string, chapter: Entry, previous: Entry | undefined, next: Entry | undefined, problems: string[]): void {
  const from = posix.dirname(chapter.file);
  const link = (text: string, target: string) => `[${text}](${posix.relative(from, target)})`;
  const expected = [
    previous ? link(`← Anterior: ${previous.label}`, previous.file) : undefined,
    link("Índice", INDEX),
    next ? link(`Próximo: ${next.label} →`, next.file) : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

  const lines = readFileSync(join(root, chapter.file), "utf8").split("\n");
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  // blank line, rule, blank line, footer: a rule glued to the text above would render as a heading, not a rule
  const [gap, rule, space, footer] = lines.slice(-4);
  if (lines.length < 4 || gap !== "" || rule !== "---" || space !== "" || footer !== expected) {
    problems.push(`${chapter.file}:${lines.length}: wrong or missing footer; the file must end with a blank line, a "---" rule, a blank line and:\n    ${expected}`);
  }
}

/** Every relative link of `file` points at something that exists, and its `#anchor` at a heading of the target. */
function checkLinks(root: string, file: string, parse: (file: string) => ParsedMarkdown, problems: string[]): void {
  for (const link of parse(file).links) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link.target)) continue; // https:, mailto:, ...
    const [pathPart = "", anchor] = splitTarget(link.target);
    const target = pathPart === "" ? file : posix.normalize(pathPart.startsWith("/") ? pathPart.slice(1) : posix.join(posix.dirname(file), pathPart));
    const absolute = resolve(root, target);
    if (target.startsWith("..") || !existsSync(absolute)) {
      problems.push(`${file}:${link.line}: broken link to ${link.target} (${target} does not exist)`);
      continue;
    }
    if (anchor !== undefined && anchor !== "" && target.endsWith(".md") && statSync(absolute).isFile()) {
      if (!anchorsOf(parse(target)).has(anchor)) problems.push(`${file}:${link.line}: broken anchor #${anchor} in ${target}`);
    }
  }
}

/** `a/b.md#frag?x` -> ["a/b.md", "frag"]. Percent-escapes are decoded. */
function splitTarget(target: string): [string, string | undefined] {
  const [beforeQuery = ""] = target.split("?");
  const hash = beforeQuery.indexOf("#");
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  return hash === -1 ? [decode(beforeQuery), undefined] : [decode(beforeQuery.slice(0, hash)), decode(beforeQuery.slice(hash + 1))];
}

function main(argv: string[]): number {
  const report = checkDocs(rootFromArgs(argv));
  if (report.problems.length > 0) {
    console.error(report.problems.join("\n"));
    console.error(`docs check failed: ${report.problems.length} problem(s) in ${report.files} Markdown file(s)`);
    return 1;
  }
  console.log(`docs check ok: ${report.files} Markdown file(s), ${report.chapters} book chapter(s)`);
  return 0;
}

if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
