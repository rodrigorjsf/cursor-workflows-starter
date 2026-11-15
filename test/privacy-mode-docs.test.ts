// Seam: chapter 5.1 of the book (governance and costs) read as text, the way a team admin reads it. Privacy Mode is the user's setting on
// their Cursor account and the SDK cannot read it, so the chapter is where a reader learns what the mode off allows, what the kit does
// about it (it asks and reminds; it cannot check) and which models to list in `caps.allowedModels` when retention matters. Whether the
// links resolve is docs-check.test.ts; the install guide's step is install-guide.test.ts; the doctor's reminder is
// packages/runtime/test/doctor.process.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { sectionOf } from "../scripts/lib/markdown.js";

const CHAPTER = readFileSync(join(resolve(import.meta.dirname, ".."), "docs", "operating", "01-governanca-e-custos.md"), "utf8");

/** The list item of `section` that opens with `opening`, with its continuation lines, as one line of text. */
function itemOf(section: string, opening: string): string | undefined {
  const lines = section.split("\n");
  const start = lines.findIndex((line) => line.startsWith(opening));
  if (start === -1) return undefined;
  const end = lines.findIndex((line, i) => i > start && !line.startsWith("  ") && line.trim() !== "");
  return lines.slice(start, end === -1 ? undefined : end).join(" ").replace(/\s+/g, " ");
}

test("the governance chapter says what Privacy Mode off allows, that the kit cannot read the mode, and which models to list in allowedModels when retention matters", () => {
  const section = sectionOf(CHAPTER, "Políticas de admin que se aplicam");
  assert.ok(section, 'the chapter has no "## Políticas de admin que se aplicam" section');
  const item = itemOf(section, "- **Privacy Mode:**");
  assert.ok(item, "the section has no item that opens with **Privacy Mode:**");
  const expected: Array<[string, string]> = [
    ["https://cursor.com/data-use", "cites Cursor's data-use page"],
    ["guardar", "says what the mode off allows (storing)"],
    ["treinar", "says what the mode off allows (training)"],
    ["Cursor Settings → General", "says where an individual account finds the setting"],
    ["não consegue", "says the kit cannot read the mode"],
    ["INSTALL-AGENT.md", "names the install step that asks"],
    ["`wf doctor`", "names the doctor's reminder"],
    ["`caps.allowedModels`", "gives the model advice through the cap"],
    ["ZDR", "says the listed models are zero-data-retention ones"],
    ["chave de API própria", "says an own API key falls outside the guarantee"],
  ];
  for (const [needle, what] of expected) assert.ok(item.includes(needle), `the Privacy Mode item does not mention ${needle}: it ${what}`);
});

test("the team adoption checklist asks for Privacy Mode to be confirmed and for allowedModels to list only zero-data-retention models when retention matters", () => {
  const checklist = sectionOf(CHAPTER, "Checklist de adoção no time");
  assert.ok(checklist, 'the chapter has no "## Checklist de adoção no time" section');
  const item = itemOf(checklist, "- [ ] Privacy Mode");
  assert.ok(item, "the checklist has no item that opens with Privacy Mode");
  for (const needle of ["`caps.allowedModels`", "ZDR"]) assert.ok(item.includes(needle), `the checklist item does not mention ${needle}`);
});
