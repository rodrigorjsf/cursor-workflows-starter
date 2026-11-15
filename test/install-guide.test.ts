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
/** Prose only: fenced blocks and inline code spans quote commands and the runtime's messages. */
const prose = (md: string) => md.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");

test("the guide is in English and links to no other document: an agent needs nothing else", () => {
  assert.doesNotMatch(prose(GUIDE), NOT_ENGLISH);
  // The kit prints English (packages/runtime/test/messages-english.test.ts), and the guide quotes it as printed.
  assert.doesNotMatch(GUIDE, /\b(Portuguese|pt-BR)\b/i, "the kit's messages are English: the guide must not say otherwise");
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

test("the guide runs install, login check, Privacy Mode confirmation, init, doctor, in that order, and every wf command in it exists", () => {
  const sections = GUIDE.split(/^## /m).slice(1);
  const steps = [
    [/^\d+\. Install the kit/, "install.sh --tag"],
    [/^\d+\. Log in/, "wf whoami"],
    [/^\d+\. Confirm Privacy Mode/, "Privacy Mode"],
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

test("the repo setup step relays wf init's Claude Code note: the setup skill that also says so comes in only after the install", () => {
  const step = GUIDE.split(/^## /m).find((section) => /^\d+\. Set up the repo/.test(section));
  assert.ok(step, "no section 'Set up the repo'");
  assert.ok(step.includes("`wf init: Claude Code reads"), "the step names the note by the prefix wf init prints");
  assert.match(step, /\bstderr\b/, "the step says the note comes on stderr");
  assert.match(step.replace(/\s+/g, " "), /Done when[^.]*relayed/, "relaying the note is part of the step's Done when");
});

// The SDK exposes no way to read Privacy Mode (`Cursor.me()` has no such field), so the guide cannot check it: the user confirms it.
test("between the login and the repo setup, the guide has the user confirm Privacy Mode, says where, and goes no further until they answer", () => {
  const sections = GUIDE.split(/^## /m).slice(1);
  const login = sections.findIndex((s) => /^\d+\. Log in/.test(s));
  const setup = sections.findIndex((s) => /^\d+\. Set up the repo/.test(s));
  assert.ok(login !== -1 && setup > login, "the guide has a login section before the repo setup");
  const between = sections.slice(login + 1, setup);
  assert.ok(between.some((s) => s.includes("Privacy Mode")), "no section between the login and the repo setup mentions Privacy Mode");
  assert.ok(!sections.slice(0, login + 1).concat(sections.slice(setup)).some((s) => /^\d+\. Confirm Privacy Mode/.test(s)), "the confirmation is one step, between the login and the repo setup");
  const step = between.find((s) => /^\d+\. Confirm Privacy Mode/.test(s));
  assert.ok(step, "the step between the login and the repo setup is titled 'Confirm Privacy Mode'");
  const flat = step.replace(/\s+/g, " ");
  assert.match(flat, /Cursor Settings → General/, "the step says where an individual account finds the setting");
  assert.match(flat, /team admin/, "the step says a team admin can enforce the setting");
  assert.match(flat, /Ask the user to confirm that Privacy Mode is on/, "the agent asks: it cannot read the setting");
  assert.match(flat, /Do not (?:go on|continue)[^.]*until/, "the step does not go on before the user answers");
  assert.match(flat, /Done when the user has answered/, "the answer is the step's Done when");
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

test("the default global config turns the SDK sandbox on for every step, because a capped probe measured it (issue #62), and the guide says the installer does", () => {
  const { caps } = JSON.parse(read("templates", "global-config.json")) as { caps: { requireSandbox?: boolean } };
  assert.equal(caps.requireSandbox, true);
  assert.ok(GUIDE.replace(/\s+/g, " ").includes("`requireSandbox: true`"), "the guide does not say the installer writes requireSandbox: true");
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

test("no tag fetch of the installer or of wf upgrade forces over a moved tag, and both ask the releases API whether the release is immutable", () => {
  for (const parts of [["scripts", "install.sh"], ["packages", "runtime", "src", "upgrade.ts"]]) {
    const file = parts.join("/");
    const lines = read(...parts).split("\n").filter((line) => !/^\s*(#|\/\/|\*|\/\*)/.test(line));
    const tagFetches = lines.filter((line) => /\bfetch\b/.test(line) && /--tags\b/.test(line));
    assert.ok(tagFetches.length > 0, `${file} no longer fetches the tags: this check has nothing to look at`);
    for (const line of tagFetches) assert.doesNotMatch(line, /--force|\s-f\b|\+refs\/tags/, `${file} forces a tag fetch, which accepts a moved tag silently: ${line.trim()}`);
    const text = lines.join("\n");
    assert.match(text, /releases\/tags\//, `${file} never asks the releases API about the tag`);
    assert.match(text, /\bimmutable\b/, `${file} never tests the release's immutable field`);
  }
});

test("the guide quotes the start of the Privacy Mode reminder the doctor's passing login check prints, word for word", () => {
  const quoted = "Privacy Mode cannot be read through the SDK";
  assert.ok(GUIDE.includes(`\`${quoted}\``), `INSTALL-AGENT.md no longer quotes \`${quoted}\``);
  assert.ok(read("packages", "runtime", "src", "doctor.ts").includes(`${quoted}: confirm it is on in Cursor Settings > General`), `the doctor no longer starts its reminder with "${quoted}"`);
});

test("the installer and wf upgrade say the same four things about a tag, and the guide quotes only words both say", () => {
  const installer = read("scripts", "install.sh");
  const upgrade = read("packages", "runtime", "src", "upgrade.ts");
  const fragments = ["moved upstream since this kit fetched it", "is not immutable", "has no release for tag", "could not read the release of"];
  for (const fragment of fragments) {
    assert.ok(installer.includes(fragment), `scripts/install.sh no longer says "${fragment}"`);
    assert.ok(upgrade.includes(fragment), `packages/runtime/src/upgrade.ts no longer says "${fragment}"`);
  }
  // What the guide tells an agent to look for in a tag error must be said by the code, word for word.
  for (const quoted of ["moved upstream", "is not immutable", "has no release for tag", "could not read the release of"]) {
    assert.ok(GUIDE.includes(`\`${quoted}\``), `INSTALL-AGENT.md no longer quotes \`${quoted}\``);
    assert.ok(fragments.some((fragment) => fragment.startsWith(quoted)), `\`${quoted}\` is not the start of a message the code prints`);
  }
});
