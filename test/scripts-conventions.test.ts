// Seam: the scripts the repo ships under scripts/. Each is a repeatable procedure for maintainers and agents, so each
// says what it does (WHAT), why it exists (WHY), when to run it (WHEN) and how (HOW) in a header, and the maintainer
// scripts chapter of the book lists it in a table. Both are read from the files, the way an agent would find them.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS_CHAPTER = "docs/contributing/04-scripts-do-mantenedor.md";

/** Every script under scripts/, as a posix path relative to the repo root. READMEs are documentation, not scripts. */
function scripts(dir = "scripts"): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const path = posix.join(dir, e.name);
    if (e.isDirectory()) return scripts(path);
    return /\.(sh|ts|mjs|js)$/.test(e.name) ? [path] : [];
  });
}

/** The header is the run of comment lines at the top (after a shebang): `# WHAT: ...` or `// WHAT: ...`, with continuations. */
function header(file: string): Map<string, string> {
  const fields = new Map<string, string>();
  let current: string | undefined;
  for (const line of readFileSync(join(ROOT, file), "utf8").split("\n")) {
    if (line.startsWith("#!")) continue;
    const comment = /^(?:#|\/\/)\s?(.*)$/.exec(line);
    if (!comment) break;
    const labelled = /^(WHAT|WHY|WHEN|HOW):\s*(.*)$/.exec(comment[1]!);
    if (labelled) {
      current = labelled[1]!;
      fields.set(current, labelled[2]!);
    } else if (current) {
      fields.set(current, `${fields.get(current)} ${comment[1]!.trim()}`.trim());
    }
  }
  return fields;
}

test("the repo ships scripts to document", () => {
  assert.ok(scripts().length >= 7, `found ${scripts().join(", ")}`);
});

test("every script opens with a WHAT/WHY/WHEN/HOW header", () => {
  for (const file of scripts()) {
    const fields = header(file);
    for (const label of ["WHAT", "WHY", "WHEN", "HOW"]) {
      assert.ok((fields.get(label) ?? "").length >= 10, `${file} needs a "${label}:" line in its opening comment`);
    }
  }
});

test("every script except the shared modules in scripts/lib is listed in the maintainer scripts table", () => {
  const chapter = readFileSync(join(ROOT, SCRIPTS_CHAPTER), "utf8");
  const rows = chapter.split("\n").filter((line) => line.startsWith("|"));
  for (const file of scripts().filter((f) => !f.startsWith("scripts/lib/"))) {
    assert.ok(
      rows.some((row) => row.includes(`\`${file}\``)),
      `${SCRIPTS_CHAPTER} has no table row for \`${file}\``,
    );
  }
});
