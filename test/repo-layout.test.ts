// Seam: the files the repository ships. The repo is a product (runtime package, distributed skills, init templates)
// plus a dev space (maintainer guide, dogfood config, scripts). These tests read the tree the way an installer or an
// agent would and assert the observable shape; none of them look at runtime internals.
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
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
