// Seam: the files the repository ships. The repo is a product (runtime package, distributed skills, init templates)
// plus a dev space (maintainer guide, dogfood config, scripts). These tests read the tree the way an installer or an
// agent would and assert the observable shape; none of them look at runtime internals.
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const DISTRIBUTED_SKILLS = ["run-workflow", "cursor-workflow-authoring", "skill-to-workflow"];

test("distributed skills live in the top-level skills folder", () => {
  for (const name of DISTRIBUTED_SKILLS) {
    const skill = join("skills", name, "SKILL.md");
    assert.ok(existsSync(join(ROOT, skill)), `${skill} is missing`);
    assert.match(read(skill), new RegExp(`^---\\nname: ${name}\\n`), `${skill} frontmatter name`);
  }
});

test("this repo's own skill folder links to the distributed skills, with no duplicate copies", () => {
  for (const name of DISTRIBUTED_SKILLS) {
    const link = join(ROOT, ".agents", "skills", name);
    assert.ok(lstatSync(link).isSymbolicLink(), `.agents/skills/${name} must be a symlink`);
    assert.equal(realpathSync(link), realpathSync(join(ROOT, "skills", name)), `.agents/skills/${name} must resolve to skills/${name}`);
  }
  // Every real (non-link) folder under .agents/skills is a dev-only skill: it must not shadow a distributed one.
  for (const entry of readdirSync(join(ROOT, ".agents", "skills"), { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) assert.ok(!DISTRIBUTED_SKILLS.includes(entry.name), `${entry.name} is duplicated as a real folder`);
  }
});

// Portuguese-only letters and function words: a cheap, deterministic proxy for "this text is not in English".
const NOT_ENGLISH = /[ãõçáéíóúâêô]|\b(não|para|você|uma|com os|são|está)\b/i;

test("AGENTS.md is a symlink to CLAUDE.md", () => {
  assert.ok(lstatSync(join(ROOT, "AGENTS.md")).isSymbolicLink(), "AGENTS.md must be a symlink");
  assert.equal(readlinkSync(join(ROOT, "AGENTS.md")), "CLAUDE.md");
  assert.equal(read("AGENTS.md"), read("CLAUDE.md"));
});

test("CLAUDE.md is the English maintainer guide and stays within its stated line budget", () => {
  const guide = read("CLAUDE.md");
  assert.doesNotMatch(guide, NOT_ENGLISH, "CLAUDE.md must be written in English");
  assert.doesNotMatch(guide, /^@AGENTS\.md/m, "AGENTS.md links back to this file: importing it would loop");

  const stated = /line budget[^0-9\n]*(\d+)/i.exec(guide);
  assert.ok(stated, "CLAUDE.md must state its line budget");
  const budget = Number(stated[1]);
  assert.ok(budget <= 120, `the stated budget (${budget}) must not exceed 120 lines`);
  assert.ok(guide.trimEnd().split("\n").length <= budget, `CLAUDE.md has more than its ${budget} lines`);

  assert.match(guide, /contributor section/i, "CLAUDE.md must point to the docs contributor section for detail");
});

test("CLAUDE.md keeps the Agent skills and Applied Learning sections", () => {
  const guide = read("CLAUDE.md");
  for (const heading of ["## Agent skills", "### Issue tracker", "### Triage labels", "### Domain docs", "## Applied Learning"]) {
    assert.ok(guide.split("\n").includes(heading), `missing heading: ${heading}`);
  }
  for (const bullet of [
    "- Windows Chrome → WSL dashboard: use `127.0.0.1:4317`; `localhost` is refused.",
    "- Browser checks: use `chrome-devtools` MCP; `/chrome` fails over Remote Control.",
    "- `tsx -e` rejects top-level await: write a `.mts` file and run it.",
  ]) {
    assert.ok(guide.split("\n").includes(bullet), `Applied Learning bullet lost: ${bullet}`);
  }
});

test("the repo paths the guide names exist", () => {
  // Only the guide itself: the Agent skills section below it may name docs the tracker setup creates later (docs/adr/).
  const guide = read("CLAUDE.md").split("\n## Agent skills")[0]!;
  const named = [...guide.matchAll(/`((?:packages|skills|templates|docs|scripts)\/[^`\s*<>]+)`/g)].map((m) => m[1]!);
  assert.ok(named.length >= 5, "the guide should name the workspace layout");
  for (const path of named) assert.ok(existsSync(join(ROOT, path)), `CLAUDE.md names ${path}, which does not exist`);
});

test("the user-facing rules for target repos are a marked template block", () => {
  const block = read("templates", "agents-md-block.md").trimEnd().split("\n");
  assert.equal(block[0], "<!-- cursor-workflows:begin -->");
  assert.equal(block.at(-1), "<!-- cursor-workflows:end -->");
  assert.equal(block.filter((l) => l.includes("cursor-workflows:begin")).length, 1);
  assert.equal(block.filter((l) => l.includes("cursor-workflows:end")).length, 1);

  const text = block.join("\n");
  assert.match(text, /never print or log the Cursor API key/i);
  assert.match(text, /never start a workflow from inside a workflow step/i);
  assert.match(text, /`\/run-workflow`/);
  assert.match(text, /commits?, pushes? and pull requests?/i);

  assert.doesNotMatch(text, NOT_ENGLISH, "the block is agent-facing text and must be in English");
  // Maintainer-only guidance must not leak into every target repo.
  assert.doesNotMatch(text, /npm (run|test)|fake-sdk|packages\/|CONTRIBUTING|metrics\.db/);
});

/** Every .md under a folder, relative to the repo root. */
function markdownFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? markdownFiles(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : [],
  );
}

/** Prose only: fenced blocks and inline code spans are quoted code, identifiers or runtime messages (Portuguese today). */
const prose = (md: string) => md.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");

test("the distributed skills are written in English", () => {
  const files = markdownFiles("skills");
  assert.ok(files.length >= DISTRIBUTED_SKILLS.length);
  for (const file of files) assert.doesNotMatch(prose(read(file)), NOT_ENGLISH, `${file} must be in English`);
});

test("the distributed skills point at the workspace layout, not at the old repo-root one", () => {
  for (const file of markdownFiles("skills")) {
    const text = read(file);
    assert.doesNotMatch(text, /`(src|workflows|test)\//, `${file} names a path that moved into packages/runtime`);
    for (const [, path] of text.matchAll(/`((?:packages|scripts|docs|skills)\/[^`\s*<>{}]+)`/g)) {
      assert.ok(existsSync(join(ROOT, path!)), `${relative(ROOT, join(ROOT, file))} names ${path}, which does not exist`);
    }
  }
});
