// Seam: the texts a reader or an agent learns the supported forges from. GitHub (`gh`) and GitLab (`glab`) are both
// supported (ADR-0009): the skills show the two CLIs side by side for issue, comment and PR effects, and a fake `glab`
// for tests; the README, the install, invocation, observability and authoring chapters name both CLIs and the `forges`
// config key; no surface teaches `gh` as the only forge CLI. These tests read the shipped Markdown; the book's own
// checks (links, footers, generated references) are docs-check.test.ts and config-reference.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { markdownFiles, parseMarkdown } from "../scripts/lib/markdown.js";

const ROOT = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** The two skills that carry the authoring references: each holds its own copy, and the copies stay byte-identical. */
const AUTHORING_SKILLS = ["cursor-workflow-authoring", "skill-to-workflow"];
const reference = (skill: string, file: string) => read(join("skills", skill, "references", file));

/** The text under the first heading that matches `title`, up to the next heading of the same or a higher level. */
function section(md: string, title: RegExp): string {
  const lines = md.split("\n");
  const start = lines.findIndex((line) => /^#{1,6} /.test(line) && title.test(line));
  assert.notEqual(start, -1, `no heading matches ${title}`);
  const level = lines[start]!.match(/^#+/)![0].length;
  const end = lines.findIndex((line, i) => i > start && /^#{1,6} /.test(line) && line.match(/^#+/)![0].length <= level);
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

test("the authoring references show gh and glab side by side for the issue, comment and PR effects", () => {
  for (const skill of AUTHORING_SKILLS) {
    const forge = section(reference(skill, "runtime-api.md"), /Forge commands/);
    const rows = forge.split("\n").filter((line) => line.startsWith("|"));
    for (const [effect, gh, glab] of [
      ["read an issue", "gh issue view", "glab issue view"],
      ["comment on an issue", "gh issue comment", "glab api"],
      ["open a PR", "gh pr create", "glab mr create"],
      ["find the PR of a branch", "gh pr view", "glab api"],
    ] as const) {
      const row = rows.find((r) => r.toLowerCase().includes(effect.toLowerCase()));
      assert.ok(row, `${skill}: no row for "${effect}" in the forge table`);
      assert.ok(row.includes(`\`${gh}`), `${skill}: the "${effect}" row does not show ${gh}`);
      assert.ok(row.includes(`\`${glab}`), `${skill}: the "${effect}" row does not show ${glab}`);
    }
    assert.match(forge, /forges/, `${skill}: the forge table does not say how the forge is chosen (the \`forges\` key)`);
  }
});

test("the rules of the authoring references name glab where they name gh, and the GitLab quick actions", () => {
  for (const skill of AUTHORING_SKILLS) {
    const rules = section(reference(skill, "rules.md"), /The nine rules/).replace(/\n {3}/g, " ");
    const rule = (n: number) => rules.split("\n").find((line) => line.startsWith(`${n}. `)) ?? "";
    assert.match(rule(6), /`glab`/, `${skill}: rule 6 names no glab`);
    assert.match(rule(6), /quick action/i, `${skill}: rule 6 says nothing of the GitLab quick actions in model text`);
    assert.match(rule(8), /glab mr list[^.]*glab mr create/, `${skill}: rule 8 shows no glab check before glab mr create`);
  }
});

test("the testing references put a fake glab beside the fake gh, and a throwaway GitLab project beside the GitHub one", () => {
  for (const skill of AUTHORING_SKILLS) {
    const testing = reference(skill, "testing.md");
    assert.match(testing, /A fake `gh` or `glab` on `PATH`/, `${skill}: no fake glab on the PATH`);
    assert.match(testing, /glab repo create/, `${skill}: no throwaway GitLab project`);
    assert.match(testing, /`forges`/, `${skill}: a self-managed throwaway host is not tied to the \`forges\` key`);
  }
});

test("the authoring references say a GitLab cloud step rests on Cursor's own support, which the kit does not validate", () => {
  for (const skill of AUTHORING_SKILLS) {
    const locations = section(reference(skill, "runtime-api.md"), /Locations/);
    assert.match(locations, /GitLab/, `${skill}: the locations section says nothing of GitLab`);
    assert.match(locations, /does not validate/, `${skill}: it does not say the kit leaves GitLab cloud steps unvalidated`);
  }
});

test("the README, the install, invocation, observability and authoring chapters name gh, glab and the forges key", () => {
  for (const file of [
    "README.md",
    "README.en.md",
    "docs/usage/01-instalacao.md",
    "docs/usage/03-invocacao-no-cursor-ide.md",
    "docs/operating/03-observabilidade.md",
    "docs/authoring/01-escrevendo-workflows.md",
  ]) {
    const text = read(file);
    for (const needle of ["`gh`", "`glab`", "`forges`"]) assert.ok(text.includes(needle), `${file} never names ${needle}`);
  }
});

test("the install guide and the setup skill tell a GitLab user to log in per host", () => {
  for (const file of ["INSTALL-AGENT.md", "skills/cursor-workflows-setup/SKILL.md"]) {
    assert.match(read(file), /glab auth login --hostname <host>/, `${file}: no per-host glab login`);
  }
});

test("the config reference documents forges, and the cloud section says GitLab cloud steps are not validated", () => {
  const config = read("docs/reference/config.md");
  assert.match(config, /^\| `forges` \|/m, "docs/reference/config.md has no forges row");
  const cloud = section(config, /Etapas na nuvem/);
  assert.match(cloud, /GitLab/, "the cloud section says nothing of GitLab");
  assert.match(cloud, /não valida/, "the cloud section does not say the kit leaves GitLab cloud steps unvalidated");
});

/** Paragraphs, list items and table rows of a Markdown file, fenced code left out; each one is the unit a reader takes in at once. */
function blocks(md: string): string[] {
  const found: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) found.push(current.join(" "));
    current = [];
  };
  for (const line of parseMarkdown(md).lines) {
    if (line.trim() === "") flush();
    else if (line.startsWith("|")) {
      flush();
      found.push(line);
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      flush();
      current.push(line);
    } else current.push(line);
  }
  flush();
  return found;
}

/** What a reader or an agent takes as the kit's guidance: the skills, the book chapters about using it, the READMEs, the install guide and the templates. */
function guidance(): string[] {
  const books = ["usage", "internals", "authoring", "operating", "reference", "vision"].map((part) => `docs/${part}/`);
  return markdownFiles(ROOT).filter(
    (file) => file.startsWith("skills/") || file.startsWith("templates/") || books.some((dir) => file.startsWith(dir)) || ["README.md", "README.en.md", "INSTALL-AGENT.md"].includes(file),
  );
}

test("no guidance names gh as the forge CLI without glab beside it", () => {
  // The ADRs, the research reports and the contributor chapters keep their history or talk about this repo's own GitHub hosting: they are not scanned.
  // A block that says GitHub (the validation wizard creates its sandbox there) is scoped to it on purpose and needs no `glab`.
  const ghAsForgeCli = /`gh(?=[ `])/;
  const lonely = guidance().flatMap((file) =>
    blocks(read(file))
      .filter((block) => ghAsForgeCli.test(block) && !/`glab/.test(block) && !/\bGitHub\b/.test(block))
      .map((block) => `${file}: ${block.slice(0, 140)}`),
  );
  assert.deepEqual(lonely, [], "name `glab` next to `gh`, or say \"the forge's CLI\"");
});
