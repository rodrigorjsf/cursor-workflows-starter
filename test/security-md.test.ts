// Seam: SECURITY.md read as text, the way a user finds it. The section on the GitHub token that `wf doctor`'s warning points at is
// there under the heading the doctor names, and says what a leaked token exposes, how to narrow it and which token to use. The scopes
// come from the doctor's own list (`BROAD_SCOPES`), so the text cannot drift from what the doctor warns about. Whether the links
// resolve is docs-check.test.ts; the doctor itself is packages/runtime/test/doctor.process.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseMarkdown } from "../scripts/lib/markdown.js";
import { BROAD_SCOPES, SECURITY_TOKEN_SECTION } from "../packages/runtime/src/github-token-scopes.js";

const SECURITY = readFileSync(join(resolve(import.meta.dirname, ".."), "SECURITY.md"), "utf8");

/** The text of the level-2 section called `title`, up to the next level-2 heading; undefined when there is none. */
function sectionOf(markdown: string, title: string): string | undefined {
  const { headings } = parseMarkdown(markdown);
  const at = headings.findIndex((h) => h.level === 2 && h.text === title);
  if (at === -1) return undefined;
  const next = headings.slice(at + 1).find((h) => h.level <= 2);
  return markdown.split("\n").slice(headings[at]!.line, next ? next.line - 1 : undefined).join("\n");
}

test("SECURITY.md has one section on the GitHub token, under the heading the doctor's warning names", () => {
  assert.equal(SECURITY_TOKEN_SECTION, "O token do GitHub");
  const sections = parseMarkdown(SECURITY).headings.filter((h) => h.level === 2 && h.text === SECURITY_TOKEN_SECTION);
  assert.equal(sections.length, 1, `SECURITY.md needs exactly one "## ${SECURITY_TOKEN_SECTION}" section`);
});

test("the GitHub-token section names every scope the doctor warns about, how to remove them, and the fine-grained token to use instead", () => {
  const section = sectionOf(SECURITY, SECURITY_TOKEN_SECTION);
  assert.ok(section, `SECURITY.md has no "## ${SECURITY_TOKEN_SECTION}" section`);
  for (const scope of BROAD_SCOPES) assert.ok(section.includes(`\`${scope}\``), `the section does not name the scope ${scope}, which \`wf doctor\` warns about`);
  for (const needle of ["wf doctor", "--remove-scopes", "GH_TOKEN", "fine-grained", "Contents", "Pull requests", "Issues", "Metadata", "expiração"]) {
    assert.ok(section.includes(needle), `the section does not mention ${needle}`);
  }
});

// Privacy Mode is the user's setting on their Cursor account: the SDK cannot read it, so SECURITY.md is where a reader learns what it
// changes and what the kit does about it (the install guide asks, the doctor reminds, the book's chapter 5.1 holds the model advice).
test("SECURITY.md has a Privacy Mode section that links Cursor's data-use page, says where to confirm the mode, and points the model advice to the allowedModels cap", () => {
  const section = sectionOf(SECURITY, "Privacy Mode");
  assert.ok(section, 'SECURITY.md has no "## Privacy Mode" section');
  assert.ok(parseMarkdown(SECURITY).links.some((l) => l.target === "https://cursor.com/data-use"), "SECURITY.md does not link https://cursor.com/data-use");
  for (const needle of ["Cursor Settings → General", "wf doctor", "INSTALL-AGENT.md", "allowedModels", "ZDR"]) {
    assert.ok(section.includes(needle), `the Privacy Mode section does not mention ${needle}`);
  }
});
