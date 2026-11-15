// Seam: SECURITY.md read as text, the way a user finds it. The section on the GitHub token that `wf doctor`'s warning points at is
// there under the heading the doctor names, and says what a leaked token exposes, how to narrow it and which token to use. The scopes
// come from the doctor's own list (`BROAD_SCOPES`), so the text cannot drift from what the doctor warns about. The Privacy Mode section
// links Cursor's data-use page and says what the kit does about a setting it cannot read. Whether the links resolve is
// docs-check.test.ts; the doctor itself is packages/runtime/test/doctor.process.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseMarkdown, sectionOf } from "../scripts/lib/markdown.js";
import { BROAD_SCOPES, SECURITY_TOKEN_SECTION } from "../packages/runtime/src/github-token-scopes.js";

const SECURITY = readFileSync(join(resolve(import.meta.dirname, ".."), "SECURITY.md"), "utf8");

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

// The runtime hardening of issue #70: what SECURITY.md says of each, in the words a reader would search for.
test("SECURITY.md says what the runtime hardening does: the job cap, the scrubbed environment, the snapshot guard, the repository's code, and wf init's symlinks", () => {
  const says = (what: string, ...needles: string[]) => {
    for (const needle of needles) assert.ok(SECURITY.includes(needle), `SECURITY.md does not say ${what}: no "${needle}"`);
  };
  says("how many jobs run at once", "caps.maxRunningJobs", "mesmo workflow", "mesmos args");
  says("that the tests and the setup command do not see the environment's secrets", "`setupCommand`", "`CURSOR_API_KEY`", "`GH_TOKEN`", "KEY", "TOKEN", "SECRET", "PASSWORD");
  says("what is checked before a cloud snapshot is pushed", "`cloud.allowPublicRemote`", "gh repo view", "PUBLIC", "não despublica", "fecha o caminho");
  says("that wf doctor and a run list the code of the repository's settings", ".cursor/hooks.json", ".claude/settings.json", ".cursor/mcp.json", "`wf doctor` avisa", "`warning`");
  says("that wf init stays inside the repository", "link simbólico", "`wf init`", "CWE-59");
});
