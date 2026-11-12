// WHAT: Shared Markdown helpers for the maintainer scripts: list the repo's .md files and read links, headings and
//   Mermaid blocks from one while ignoring fenced code and inline code.
// WHY: scripts/check-docs.ts and scripts/check-mermaid.ts both need the same fence-aware reading; one copy keeps them
//   agreeing on what counts as a link, a heading or a diagram.
// WHEN: imported by those scripts; not run on its own.
// HOW: `import { markdownFiles, parseMarkdown } from "./lib/markdown.js"`.
import { readdirSync } from "node:fs";
import { join, posix } from "node:path";

/** Folders that never hold documentation we own: dependencies, VCS data, run state, test scratch and handoffs. */
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".workflows", ".codegraph", ".handoffs", ".tmp", "metrics-export"]);

/** Every `.md` file under `root` as a posix path relative to it, sorted. Symbolic links are not followed or listed. */
export function markdownFiles(root: string, dir = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...markdownFiles(root, path));
    } else if (entry.name.endsWith(".md")) {
      found.push(path);
    }
  }
  return found.sort();
}

export interface Heading {
  level: number;
  /** The heading as rendered: markup removed. */
  text: string;
  line: number;
}

export interface MarkdownLink {
  /** The raw target as written: `path`, `path#anchor`, `#anchor` or a URL. */
  target: string;
  line: number;
}

export interface MermaidBlock {
  /** Line of the opening fence. */
  line: number;
  source: string;
}

export interface ParsedMarkdown {
  headings: Heading[];
  links: MarkdownLink[];
  /** Explicit anchors: `id="..."` and `<a name="...">`. */
  htmlAnchors: string[];
  mermaid: MermaidBlock[];
  /** The text with fenced code removed, line for line. */
  lines: string[];
}

/** A code fence opens with 3+ backticks (info string without backticks) or 3+ tildes. */
const OPEN_FENCE = /^ {0,3}(?:(`{3,})([^`]*)|(~{3,})(.*))$/;
/** A line that starts a block other than a paragraph: it cannot be the text of a setext heading. */
const NOT_PARAGRAPH_TEXT = /^ {0,3}(#{1,6}(\s|$)|>|[-*+]\s|\d+[.)]\s|\|)/;

export function parseMarkdown(md: string): ParsedMarkdown {
  const rawLines = md.split("\n");
  const lines: string[] = [];
  const mermaid: MermaidBlock[] = [];
  let fence: { marker: string; language: string; line: number; body: string[] } | undefined;
  // YAML front matter (skills, Claude Code rules) is metadata, not Markdown: GitHub shows it as a table.
  const frontMatterEnd = rawLines[0] === "---" ? rawLines.indexOf("---", 1) : -1;
  rawLines.forEach((raw, i) => {
    if (i <= frontMatterEnd) {
      lines.push("");
      return;
    }
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(raw);
      if (close && close[1]!.startsWith(fence.marker[0]!) && close[1]!.length >= fence.marker.length) {
        if (fence.language === "mermaid") mermaid.push({ line: fence.line, source: fence.body.join("\n") });
        fence = undefined;
      } else {
        fence.body.push(raw);
      }
      lines.push("");
      return;
    }
    const open = OPEN_FENCE.exec(raw);
    if (open) {
      const info = (open[2] ?? open[4] ?? "").trim();
      fence = { marker: (open[1] ?? open[3])!, language: (info.split(/\s+/)[0] ?? "").toLowerCase(), line: i + 1, body: [] };
      lines.push("");
      return;
    }
    lines.push(raw);
  });

  const text = maskInlineCode(lines.join("\n"));
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (offset: number) => {
    let line = 0;
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= offset) line++;
    return line + 1;
  };

  // Headings keep their inline code: `## \`foo\` flag` is the anchor "foo-flag".
  const headings: Heading[] = [];
  lines.forEach((line, i) => {
    const atx = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (atx) {
      headings.push({ level: atx[1]!.length, text: renderedText(atx[2]!), line: i + 1 });
      return;
    }
    const underline = /^ {0,3}(=+|-+)\s*$/.exec(line);
    const above = lines[i - 1];
    if (underline && above?.trim() && !NOT_PARAGRAPH_TEXT.test(above)) {
      headings.push({ level: underline[1]!.startsWith("=") ? 1 : 2, text: renderedText(above), line: i });
    }
  });

  const links: MarkdownLink[] = [];
  const linkPattern =
    /!?\[(?:[^[\]]|\[[^\]]*\])*\]\(\s*(<[^>\n]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g;
  for (const m of text.matchAll(linkPattern)) {
    links.push({ target: m[1]!.replace(/^<|>$/g, ""), line: lineOf(m.index) });
  }
  // Reference definitions (`[ref]: target "title"`); footnotes (`[^1]: text`) are not links.
  text.split("\n").forEach((line, i) => {
    const definition = /^ {0,3}\[(?!\^)[^\]]+\]:[ \t]*(<[^>\n]*>|\S+)/.exec(line);
    if (definition) links.push({ target: definition[1]!.replace(/^<|>$/g, ""), line: i + 1 });
  });

  const htmlAnchors = [...text.matchAll(/\bid="([^"]+)"|<a\s[^>]*\bname="([^"]+)"/g)].map((m) => m[1] ?? m[2]!);
  return { headings, links, htmlAnchors, mermaid, lines };
}

/** Replaces inline code spans with spaces (newlines kept) so their content is never read as a link or a heading. */
function maskInlineCode(text: string): string {
  // A code span never crosses a blank line: a lone backtick must not swallow the paragraphs after it.
  return text.replace(/(`+)(?!`)((?:(?!\n[ \t]*\n)[\s\S])*?[^`])\1(?!`)/g, (span) => span.replace(/[^\n]/g, " "));
}

/** A heading's visible text: links keep their text, code spans their content, emphasis and tags disappear. */
function renderedText(markup: string): string {
  return markup
    .replace(/!?\[((?:[^[\]]|\[[^\]]*\])*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*~]/g, "")
    .replace(/(^|[^\p{L}\p{N}])_+([^_]+?)_+(?![\p{L}\p{N}])/gu, "$1$2") // _emphasis_, but not snake_case
    .trim();
}

/** GitHub's heading id: lowercase, punctuation dropped, spaces to hyphens. Repeats get -1, -2... (see `anchorsOf`). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, "")
    .replace(/ /g, "-");
}

/** Every anchor a link may use to reach this document: heading ids (with GitHub's repeat suffixes) and HTML ids. */
export function anchorsOf(parsed: ParsedMarkdown): Set<string> {
  const anchors = new Set(parsed.htmlAnchors);
  const seen = new Map<string, number>();
  for (const heading of parsed.headings) {
    const base = slugify(heading.text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}
