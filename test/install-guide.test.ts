// Seam: the install guide as an agent finds it. INSTALL-AGENT.md is public and pinned to a release tag; an agent runs
// its commands with no other document. These tests read the guide and check it against the files and the commands it
// names: the pinned tag is the package's version, the installer and the commands exist, the skills and caps it lists
// are the ones the kit ships.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { markdownFiles, parseMarkdown } from "../scripts/lib/markdown.js";
import { wfCommands } from "./cli-commands.js";

const ROOT = resolve(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const GUIDE = read("INSTALL-AGENT.md");
const TAG = `v${(JSON.parse(read("package.json")) as { version: string }).version}`;

const NOT_ENGLISH = /[ãõçáéíóúâêô]|\b(não|para|você|uma|com os|são|está)\b/i;
/** Prose only: fenced blocks and inline code spans quote commands and the runtime's Portuguese messages. */
const prose = (md: string) => md.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");

test("the guide is in English and links to no other document: an agent needs nothing else", () => {
  assert.doesNotMatch(prose(GUIDE), NOT_ENGLISH);
  const doc = parseMarkdown(GUIDE);
  const relative = doc.links.map((l) => l.target).filter((t) => !/^[a-z][a-z0-9+.-]*:/i.test(t));
  assert.deepEqual(relative, [], "a relative link would send the agent to a file it may not have");
  assert.doesNotMatch(GUIDE.replace(/https?:\/\/\S+/g, ""), /(^|[^\w/.-])docs\//m, "no path into the repo's docs");
});

test("the guide is pinned to the tag of the package version, in every command that fetches or installs the kit", () => {
  const tags = new Set(GUIDE.match(/\bv\d+\.\d+\.\d+(?:-[\w.]+)?\b/g));
  assert.deepEqual([...tags], [TAG], "one tag in the whole guide, the package's version: bump the guide with the version");
  assert.ok(GUIDE.includes(`raw.githubusercontent.com/rodrigorjsf/cursor-workflows-starter/${TAG}/scripts/install.sh`), "the installer is fetched from the tag, not from a branch");
  assert.ok(GUIDE.includes(`install.sh --tag ${TAG}`), "the installer is told to install that tag");
  assert.doesNotMatch(GUIDE, /\/(main|master|HEAD)\//, "no branch in a fetched URL");
});

test("the installer the guide fetches exists in the repo and takes the flags the guide uses", () => {
  assert.ok(existsSync(join(ROOT, "scripts", "install.sh")));
  const help = spawnSync("bash", [join(ROOT, "scripts", "install.sh"), "--help"], { encoding: "utf8" }).stdout;
  for (const flag of new Set(GUIDE.match(/install\.sh (--[a-z-]+)/g)?.map((m) => m.split(" ")[1]))) assert.ok(help.includes(flag!), `install.sh --help does not list ${flag}`);
});

test("the guide runs install, login check, init, doctor, in that order, and every wf command in it exists", () => {
  const sections = GUIDE.split(/^## /m).slice(1);
  const steps = [
    [/^\d+\. Install the kit/, "install.sh --tag"],
    [/^\d+\. Log in/, "wf whoami"],
    [/^\d+\. Set up the repo/, "wf init"],
    [/^\d+\. Run the doctor/, "wf doctor"],
  ] as const;
  const positions = steps.map(([heading, command]) => {
    const at = sections.findIndex((s) => heading.test(s));
    assert.notEqual(at, -1, `no section ${heading}`);
    assert.ok(sections[at]!.includes(command), `section ${heading} never runs ${command}`);
    return at;
  });
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));

  const commands = wfCommands();
  const named = new Set([...GUIDE.matchAll(/`wf ([a-z]+)\b/g), ...GUIDE.matchAll(/^wf ([a-z]+)\b/gm)].map((m) => m[1]!));
  assert.ok(named.size >= 4);
  for (const command of named) assert.ok(commands.includes(command), `the guide names wf ${command}, which the CLI does not have`);
});

test("the setup skill only names wf commands that exist", () => {
  const commands = wfCommands();
  const text = ["SKILL.md", "references/config.md", "references/validate.md"].map((f) => read("skills", "cursor-workflows-setup", f)).join("\n");
  for (const m of text.matchAll(/`wf ([a-z]+)\b/g)) assert.ok(commands.includes(m[1]!), `the setup skill names wf ${m[1]}, which the CLI does not have`);
});

test("the guide lists the skills the kit ships and the default caps the installer writes", () => {
  const shipped = readdirSync(join(ROOT, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  for (const skill of shipped) assert.ok(GUIDE.includes(`\`${skill}\``), `the guide does not list the skill ${skill}`);

  const { caps } = JSON.parse(read("templates", "global-config.json")) as { caps: Record<string, number> };
  const grouped = (n: number) => n.toLocaleString("en-US");
  const flat = GUIDE.replace(/\s+/g, " ");
  for (const text of [`${grouped(caps.maxTokens!)} tokens`, `${caps.maxCents} cents`, `${grouped(caps.maxTokensPerStep!)} tokens per step`, `concurrency ${caps.maxConcurrency}`]) {
    assert.ok(flat.includes(text), `the guide's default caps drifted from templates/global-config.json: missing "${text}"`);
  }
});

test("the default global config the installer copies is the first example of the shipped schema", () => {
  const schema = JSON.parse(read("packages", "runtime", "schema", "config.schema.json")) as { examples: unknown[] };
  assert.deepEqual(JSON.parse(read("templates", "global-config.json")), schema.examples[0]);
});

test("every document that tells a reader to fetch or install a tag names the package version's tag", () => {
  const pins = /(?:cursor-workflows-starter\/(v\d[\w.-]*)\/|install\.sh --tag (v\d[\w.-]*))/g; // a real version: the placeholder vX.Y.Z is exempt
  const found: string[] = [];
  for (const file of markdownFiles(ROOT)) {
    for (const m of read(file).matchAll(pins)) {
      found.push(file);
      assert.equal(m[1] ?? m[2], TAG, `${file} pins ${m[1] ?? m[2]}, the package is ${TAG}`);
    }
  }
  for (const expected of ["INSTALL-AGENT.md", "README.md", "README.en.md", "docs/usage/01-instalacao.md"]) assert.ok(found.includes(expected), `${expected} no longer pins a tag`);
});

test("every pointer the kit writes into a repo or a config pins the package version's tag, not a branch", () => {
  const files = [
    ["templates", "agents-md-block.md"],
    ["templates", "global-config.json"],
    ["packages", "runtime", "schema", "config.schema.json"],
    ["packages", "runtime", "src", "init.ts"],
    ["packages", "runtime", "src", "doctor.ts"],
  ];
  for (const parts of files) {
    const text = read(...parts);
    assert.doesNotMatch(text, /cursor-workflows-starter\/(blob\/)?(main|master|HEAD)\//, `${parts.join("/")} points at a branch`);
  }
  assert.ok(read("templates", "agents-md-block.md").includes(`cursor-workflows-starter/blob/${TAG}/INSTALL-AGENT.md`), "the AGENTS.md block links the guide at the tag");
  assert.equal(
    (JSON.parse(read("templates", "global-config.json")) as { $schema: string }).$schema,
    `https://raw.githubusercontent.com/rodrigorjsf/cursor-workflows-starter/${TAG}/packages/runtime/schema/config.schema.json`,
  );
});

test("the installer clones the same repository the runtime links to, so one rename cannot leave either behind", async () => {
  const { KIT_REPO, kitFileUrl } = await import("../packages/runtime/src/kit-version.js");
  const installer = /default_repo="([^"]+)"/.exec(read("scripts", "install.sh"))?.[1];
  assert.equal(installer, `https://github.com/${KIT_REPO}.git`);
  assert.equal(kitFileUrl("INSTALL-AGENT.md", "0.3.0"), `https://github.com/${KIT_REPO}/blob/v0.3.0/INSTALL-AGENT.md`);
  assert.equal(kitFileUrl("a/b.json", "0.3.0", "raw"), `https://raw.githubusercontent.com/${KIT_REPO}/v0.3.0/a/b.json`);
});
