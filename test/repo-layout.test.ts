// Seam: the files the repository ships. The repo is a product (runtime package, distributed skills, init templates)
// plus a dev space (maintainer guide, dogfood config, scripts). These tests read the tree the way an installer or an
// agent would and assert the observable shape; none of them look at runtime internals.
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { builtinModules } from "node:module";
import { test } from "node:test";
import ts from "@typescript/typescript6";

const ROOT = resolve(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const DISTRIBUTED_SKILLS = ["run-workflow", "cursor-workflow-authoring", "skill-to-workflow", "cursor-workflows-setup"];

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
  assert.match(guide, /\/mattpocock-skills:writing-for-agents/, "CLAUDE.md must say skills are created and updated with writing-for-agents");
  assert.match(guide, /`CODING_STANDARDS\.md`.*reviewing code/, "CLAUDE.md must point reviewers at CODING_STANDARDS.md");
});

test("CODING_STANDARDS.md states that every skill is self-contained, the rule the maintainer guide moved there", () => {
  const standards = read("CODING_STANDARDS.md");
  assert.match(standards, /each skill is self-contained/i, "CODING_STANDARDS.md must state that every skill is self-contained");
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
  return filesUnder(dir, /\.md$/);
}

function filesUnder(dir: string, extension: RegExp): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" ? [] : filesUnder(join(dir, e.name), extension)) : extension.test(e.name) ? [join(dir, e.name)] : [],
  );
}

/** Prose only: fenced blocks and inline code spans are quoted code, identifiers or runtime messages. */
const prose = (md: string) => md.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");

test("the distributed skills are written in English", () => {
  const files = markdownFiles("skills");
  assert.ok(files.length >= DISTRIBUTED_SKILLS.length);
  for (const file of files) assert.doesNotMatch(prose(read(file)), NOT_ENGLISH, `${file} must be in English`);
});

/** Markdown links `[text](target)` whose target is a relative file (no URL, no bare #anchor), without the #anchor. */
function relativeLinks(md: string): string[] {
  return [...md.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((m) => m[1]!.split("#")[0]!)
    .filter((target) => target !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(target));
}

test("each distributed skill is self-contained: its instructions live in its own folder", () => {
  for (const name of DISTRIBUTED_SKILLS) {
    for (const file of markdownFiles(join("skills", name))) {
      const text = read(file).replace(/https?:\/\/\S+/g, "");
      assert.doesNotMatch(text, /(^|[^\w/.-])(docs|scripts)\//m, `${file} points at a document or script outside its folder`);
      // A URL into the kit's own repository is a pointer to a document outside the folder too, one that moves with `main`.
      assert.doesNotMatch(read(file), /rodrigorjsf\/cursor-workflows-starter/, `${file} links into the kit's repository`);
      for (const target of relativeLinks(read(file))) {
        const resolved = resolve(ROOT, dirname(file), target);
        assert.ok(resolved.startsWith(join(ROOT, "skills", name) + "/"), `${file} links to ${target}, outside the skill folder`);
        assert.ok(existsSync(resolved), `${file} links to ${target}, which does not exist`);
      }
    }
  }
});

test("every reference file of a skill is linked from its SKILL.md", () => {
  for (const name of DISTRIBUTED_SKILLS) {
    const referencesDir = join("skills", name, "references");
    if (!existsSync(join(ROOT, referencesDir))) continue;
    const skill = read("skills", name, "SKILL.md");
    for (const file of markdownFiles(referencesDir)) {
      assert.ok(skill.includes(`(${relative(join("skills", name), file)})`), `${file} is not linked from skills/${name}/SKILL.md`);
    }
  }
});

test("the setup skill covers init, doctor, upgrade, validate and config, and each is a section the agent can pick", () => {
  const skill = read("skills", "cursor-workflows-setup", "SKILL.md");
  for (const command of ["wf init", "wf doctor", "wf upgrade", "wf config show"]) assert.ok(skill.includes(`\`${command}`), `the setup skill never runs \`${command}\``);
  const sections = skill.split("\n").filter((line) => line.startsWith("## "));
  for (const topic of [/init/i, /check/i, /upgrade/i, /validate/i, /config/i]) assert.ok(sections.some((s) => topic.test(s)), `no section for ${topic}`);
  // The two long procedures live in references, linked from the section that needs them.
  assert.match(skill, /\]\(references\/validate\.md\)/);
  assert.match(skill, /\]\(references\/config\.md\)/);
});

test("the setup skill's config reference names every key the config schema accepts, and points at the schema the kit ships", () => {
  const reference = read("skills", "cursor-workflows-setup", "references", "config.md");
  const schema = JSON.parse(read("packages", "runtime", "schema", "config.schema.json"));
  const keys = (properties: Record<string, unknown>) => Object.keys(properties).filter((key) => !key.startsWith("$"));
  const groups: Record<string, string[]> = { "top level": keys(schema.properties) };
  for (const [name, definition] of Object.entries<{ properties?: Record<string, unknown> }>(schema.definitions)) {
    if (definition.properties) groups[name] = keys(definition.properties);
  }
  // A key counts as named only inside a code span, never in the prose between two spans.
  const spans = [...reference.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  for (const [group, names] of Object.entries(groups)) {
    for (const key of names) assert.ok(spans.some((span) => new RegExp(`\\b${key}\\b`).test(span)), `config.md never names ${group} key \`${key}\``);
  }
  const shipped = reference.match(/~\/\.cursor-workflows\/kit\/(packages\/runtime\/schema\/config\.schema\.json)/);
  assert.ok(shipped && existsSync(join(ROOT, shipped[1]!)), "config.md must point at the config schema in the installed kit");
  // The schema's descriptions are pt-BR (they feed the generated docs/reference/config.md): the English skill gives each
  // key's meaning itself, and never sends an agent to read them.
  assert.doesNotMatch(reference, /\bdescriptions?\b/, "config.md must not send the agent to the schema's (pt-BR) descriptions");
});

test("the validate reference names what the kit ships: its scripts exist, the cheap workflow exists, and scenario 4 asks for the PR", () => {
  const validate = read("skills", "cursor-workflows-setup", "references", "validate.md");
  const kitPaths = [...validate.matchAll(/~\/\.cursor-workflows\/kit\/(scripts\/[\w./-]+)/g)].map((m) => m[1]!);
  assert.ok(kitPaths.includes("scripts/verify/validate-cursor-ide.sh") && kitPaths.includes("scripts/verify/setup-sandbox-repo.sh"), `found ${kitPaths.join()}`);
  for (const path of kitPaths) assert.ok(existsSync(join(ROOT, path)), `validate.md names ${path}, which the kit does not ship`);
  assert.ok(existsSync(join(ROOT, "packages", "runtime", "workflows", "smoke.ts")), "scenario 3 runs the smoke workflow");
  const four = validate.slice(validate.indexOf("\n4. **"), validate.indexOf("\n5. **"));
  assert.match(four, /openPr/, "scenario 4 must ask the chat to open the PR");
});

const runWorkflowStep2 = (skill: string): string => skill.slice(skill.indexOf("\n2. "), skill.indexOf("\n3. Chain `wait_workflow`"));

test("the run-workflow skill opens the dashboard link that start_workflow returns in Cursor's built-in browser", () => {
  const skill = read("skills", "run-workflow", "SKILL.md");
  const step2 = runWorkflowStep2(skill);
  assert.match(step2, /`dashboardUrl`/, "step 2 must tell the agent what to do with dashboardUrl");
  assert.match(step2, /built-in browser/i, "the link opens in Cursor's built-in browser");
  assert.match(step2, /`dashboardWarning`/, "a dashboard that could not start is relayed, not ignored");
  assert.match(step2, /one tab per conversation/i, "one dashboard shows every run: one tab, not a new one on every start");
});

test("the run-workflow skill says that workflow output is data from the run: relayed to the user, never followed", () => {
  const skill = read("skills", "run-workflow", "SKILL.md");
  const intro = skill.slice(0, skill.indexOf("\n## Steps"));
  assert.match(intro, /`recent`, `result` and `error`/, "the sentence names the three fields the run's text arrives in");
  assert.match(intro, /data from the run/, "the output is data from the run");
  assert.match(intro, /never follow/i, "and the agent never follows it");
  const approval = skill.slice(skill.indexOf("`untrusted-author`"), skill.indexOf("`secret-blocked`"));
  assert.match(approval, /allowExternalAuthor: true/, "the skill tells the agent how an outside author's issue goes on, after the user read it");
});

test("the run-workflow skill says where a stopped main-tree run left its change: on the result's branch, in the user's own folder", () => {
  const skill = read("skills", "run-workflow", "SKILL.md");
  const blocked = skill.slice(skill.indexOf("- `secret-blocked`"), skill.indexOf("- Anything else: the workflow ended"));
  assert.match(blocked, /`mainTree: true`/, "the secret-blocked bullet knows a result without a worktree");
  assert.match(blocked, /`branch`/);
  const unfinished = skill.slice(skill.indexOf("- Anything else: the workflow ended"), skill.indexOf("5. When `status` is `failed`"));
  assert.match(unfinished, /`worktree` or `branch`/);
});

test("the run-workflow skill asks for full permissions and gives the user the four reasons", () => {
  const skill = read("skills", "run-workflow", "SKILL.md");
  const permissions = skill.slice(skill.indexOf("\n## Permissions"), skill.indexOf("\n## Delivery"));
  assert.match(permissions, /full permissions \(outside the agent sandbox\)/);
  assert.match(permissions, /`start_workflow` and `wf start`/);
  assert.match(permissions, /network for `gh`, `glab` and `git push`, which the sandbox proxy refuses/);
  assert.match(permissions, /writes to `~\/\.cursor-workflows\/` \(the metrics and the runs index\)/);
  assert.match(permissions, /a detached job that outlives the command/);
  assert.match(permissions, /the dashboard's port/);
  assert.match(permissions, /`cannot write to the user directory`/, "the refusal that names the sandbox is the cue to ask again with full permissions");
});

test("the run-workflow skill prefers the start_workflow tool and sends a down dashboard to supported commands, never to the kit's source", () => {
  const skill = read("skills", "run-workflow", "SKILL.md");
  const step2 = runWorkflowStep2(skill);
  assert.match(step2, /Prefer `start_workflow` to `wf start` whenever the `workflows` server is available/);
  assert.match(step2, /wf config set dashboard\.autoStart true/, "a dashboard that stays down for lack of auto-start is turned on by a supported command");
  assert.match(step2, /next `start_workflow` or `wf start` starts it/);
  assert.doesNotMatch(skill, /npm run dash|packages\/dashboard|~\/\.cursor-workflows\/kit/, "the skill names no path of the kit's source for the dashboard");
  assert.match(step2, /never (?:start it from|read) the kit/i, "the agent is told to stay out of the kit's source");
});

test("the run-workflow skill's argument-hint shows the workflow, its args and both delivery shortcuts", () => {
  const skill = read("skills", "run-workflow", "SKILL.md");
  const frontmatter = skill.slice(0, skill.indexOf("\n---", 4));
  assert.match(frontmatter, /^argument-hint: <workflow> <args> \[--worktree\] \[--no-pr\]$/m);
  const step1 = skill.slice(skill.indexOf("\n1. Build `name` and `args`"), skill.indexOf("\n2. "));
  assert.match(step1, /`--worktree`.*`worktree: true`/s, "a shortcut in the request becomes its arg");
  assert.match(step1, /`--no-pr`.*`openPr: false`/s);
});

test("the run-workflow skill covers the main-tree notice, the worktree window in Cursor (the path elsewhere) and the PR or MR link", () => {
  const skill = read("skills", "run-workflow", "SKILL.md");
  const delivery = skill.slice(skill.indexOf("\n## Delivery"), skill.indexOf("\n## Steps"));
  assert.match(delivery, /main tree/i);
  assert.match(delivery, /the tree belongs to the workflow until the job ends/);
  assert.match(delivery, /`cursor --new-window <worktree>`/, "in Cursor the worktree opens in a new window through the cursor CLI");
  assert.match(delivery, /Claude Code, Codex\), give the user the path/, "where no window can open, the user gets the path");
  assert.match(delivery, /`prUrl`/, "the PR or MR link is relayed from the result");
  assert.match(delivery, /MR/);
  const done = skill.slice(skill.indexOf("   - `done`:"), skill.indexOf("   - A result with `next`"));
  assert.match(done, /`prUrl`/, "the final message of a delivered run starts from the link");
  const refused = skill.slice(skill.indexOf("   - `dirty-tree`"), skill.indexOf("   - Anything else: the workflow ended"));
  assert.match(refused, /`main-tree-busy`/);
  assert.match(refused, /`files`/);
  assert.match(refused, /`--worktree`/);
});

test("reference files two skills share stay identical", () => {
  const authoring = join("skills", "cursor-workflow-authoring", "references");
  const conversion = join("skills", "skill-to-workflow", "references");
  const shared = ["runtime-api.md", "rules.md", "recipes.md", "cost.md", "observability.md", "testing.md", "target-repos.md"];
  for (const file of shared) assert.equal(read(conversion, file), read(authoring, file), `${file} drifted: copy it from ${authoring} to ${conversion}`);
});

const SHIPPED_TEXT = [
  ...readdirSync(ROOT).filter((name) => name.endsWith(".md") && name !== "CHANGELOG.md"),
  ...filesUnder("docs", /\.md$/),
  ...filesUnder("skills", /\.md$/),
  ...filesUnder("templates", /\.md$/),
  ...filesUnder("scripts", /\.(ts|sh|md)$/),
  ...filesUnder("packages/runtime/src", /\.(ts|mjs)$/),
  ...filesUnder("packages/runtime/workflows", /\.ts$/),
];

const TEAM_AS_RULES_OR_HOOKS = [
  /regras(?:\/| e )hooks do time/i,
  /hooks (?:do|de) time (?:e|ou) (?:do )?MDM/i,
  /hooks do projeto, do time e MDM/i,
  /hooks de `team` e `mdm`/i,
  /carrega `team` e `mdm` por padrão/i,
  /\bteam,? (?:or|and) MDM hooks\b/i,
];

test("no doc, skill or source file says the team setting source loads team rules or team hooks", () => {
  const offenders = SHIPPED_TEXT.flatMap((file) => {
    const text = read(file).replace(/\s+/g, " ");
    return TEAM_AS_RULES_OR_HOOKS.flatMap((pattern) => (pattern.test(text) ? [`${file}: ${pattern}`] : []));
  });
  assert.deepEqual(offenders, [], "team only drives the managed-skill sync of @cursor/sdk 1.3.1: describe it that way");
});

const DATED_MEASUREMENTS = join("docs", "research", "verificacoes-locais.md");
const DROPPED_DEFAULT = /\[\s*"project",\s*"team",\s*"mdm"\s*\]/;

test("no doc, skill, script or source file names project, team and mdm as the engine default, which dropped team on 2026-11-19", () => {
  const offenders = SHIPPED_TEXT.filter((file) => file !== DATED_MEASUREMENTS && DROPPED_DEFAULT.test(read(file)));
  assert.deepEqual(offenders, [], 'the engine default is ["project","mdm"]: only the dated measurement chapter may name the older list');
});

test("the authoring book and the authoring skill give the settingSources list closest to an IDE turn and the three routes account and team rules take", () => {
  const book = read("docs", "authoring", "01-escrevendo-workflows.md");
  const skill = filesUnder("skills/cursor-workflow-authoring", /\.md$/).map((file) => read(file)).join("\n");
  const expected: Array<[string, string]> = [
    ['["project","user","plugins","mdm"]', "the list closest to an IDE turn"],
    ["AGENTS.md", "route one for account and team rules"],
    ["alwaysApply: true", "route two for account and team rules"],
    ["disable-model-invocation", "that a manual-only skill body never loads through the catalog"],
  ];
  const managedSkills = { book: "skills gerenciadas", skill: "managed skills" };
  for (const [name, text] of [["book", book], ["skill", skill]] as const) {
    for (const [needle, what] of expected) assert.ok(text.includes(needle), `the ${name} lacks ${needle}: it gives ${what}`);
    assert.ok(text.includes(managedSkills[name]), `the ${name} does not say team syncs ${managedSkills[name]}`);
  }
});

/** The version of the package at `...p` (the repo root when empty). */
const version = (...p: string[]): string => JSON.parse(read(...p, "package.json")).version;

test("the runtime package and the repo carry the same version", () => {
  assert.equal(version("packages", "runtime"), version(), "the MCP server reports the runtime package's version: bump both together");
  assert.equal(version("packages", "dashboard"), version(), "the workspace packages are released together: bump them together");
});

test("the changelog has a dated section for the package version, so a bump never ships without its release notes", () => {
  const heading = new RegExp(`^## ${version().replaceAll(".", "\\.")} \\([^)]+, \\d{4}-\\d{2}-\\d{2}\\)$`, "m");
  assert.match(read("CHANGELOG.md"), heading, `CHANGELOG.md has no "## ${version()} (pré-release, YYYY-MM-DD)" section: rename "Não lançado" to it when the version is bumped`);
});

test("the dashboard is its own workspace package: its dependencies never enter the runtime, and it reaches the runtime through one entry point", () => {
  const manifest = (...p: string[]) => JSON.parse(read(...p, "package.json"));
  const runtime = manifest("packages", "runtime");
  const dashboard = manifest("packages", "dashboard");
  assert.equal(dashboard.name, "@cursor-workflows/dashboard");
  assert.ok(manifest().workspaces.includes("packages/*"));
  // The web app's libraries (React, React Flow, elkjs) and esbuild, which bundles them when the dashboard starts: they live here and nowhere else.
  const webApp = ["@xyflow/react", "elkjs", "esbuild", "react", "react-dom"];
  assert.deepEqual(Object.keys(dashboard.dependencies).sort(), ["@cursor-workflows/runtime", ...webApp].sort(), "the dashboard ships the runtime and its web app's libraries, and nothing else");
  for (const name of webApp) assert.equal(name in runtime.dependencies, false, `${name} must not enter the runtime`);
  assert.equal(Object.keys(runtime.dependencies).some((name) => name.startsWith("@cursor-workflows/")), false, "the runtime depends on no workspace package");
  assert.deepEqual(Object.keys(runtime.exports).sort(), ["./observe", "./package.json"], "the runtime's only public entry points");

  // Whatever the dashboard imports from the runtime goes through that entry point, never a path into its sources.
  const sources = readdirSync(join(ROOT, "packages", "dashboard", "src")).filter((f) => f.endsWith(".ts"));
  assert.ok(sources.length >= 3);
  for (const file of sources) {
    const text = read("packages", "dashboard", "src", file);
    assert.doesNotMatch(text, /from "(\.\.\/)+runtime\/|from "@cursor-workflows\/runtime\/(?!observe")/, `${file} reaches into the runtime's sources`);
  }
  // The dashboard's tests go through HTTP and the fake SDK. One contract test runs the real engine to check that the graph the
  // Run view derives is the structure the engine writes; it is the only test that reaches into the runtime's sources.
  const reaching = readdirSync(join(ROOT, "packages", "dashboard", "test")).filter((f) => /from "(\.\.\/)+runtime\/src\//.test(read("packages", "dashboard", "test", f)));
  assert.deepEqual(reaching, ["engine-log.test.ts"], "a dashboard test reaches into the runtime's sources: only the engine contract test may");
  // The web app runs in the browser: it reads the API, never the runtime.
  const ui = join("packages", "dashboard", "run-view");
  const uiSources = readdirSync(join(ROOT, ui)).filter((f) => /\.tsx?$/.test(f));
  assert.ok(uiSources.length >= 5);
  for (const file of uiSources) assert.doesNotMatch(read(ui, file), /@cursor-workflows\/runtime|from "(\.\.\/)+runtime\/|from "node:/, `${file} runs in the browser and must not import the runtime or Node`);
});

/**
 * Lines of a browser file under `dir` that load server code at run time: a value import (or a side-effect import) of
 * `node:*` or a bare built-in, of the runtime package, or of a relative path that leaves the browser folders. Only
 * `import type` is erased: with `verbatimModuleSyntax` (which esbuild reads from the tsconfig), `import { type X }` still
 * loads the module for its side effects.
 */
function serverValueImports(dir: string, file: string, text: string): number[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const browser = ["app", "run-view"].map((d) => join(ROOT, "packages", "dashboard", d) + "/");
  const isServer = (spec: string) =>
    spec.startsWith("node:") ||
    builtinModules.includes(spec.split("/")[0]!) ||
    spec.startsWith("@cursor-workflows/runtime") ||
    (spec.startsWith(".") && !browser.some((b) => resolve(dir, spec).startsWith(b)));
  const found: number[] = [];
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) && !ts.isExportDeclaration(s)) continue;
    if (!s.moduleSpecifier || !ts.isStringLiteral(s.moduleSpecifier) || !isServer(s.moduleSpecifier.text)) continue;
    const typeOnly = ts.isExportDeclaration(s) ? s.isTypeOnly : !!s.importClause?.isTypeOnly;
    if (!typeOnly) found.push(sf.getLineAndCharacterOfPosition(s.getStart(sf)).line + 1);
  }
  return found;
}

test("the browser import check fires on a value import of server code and passes type-only imports and the browser folders", () => {
  const app = join(ROOT, "packages", "dashboard", "app");
  const offender = [
    'import { RunSummary } from "@cursor-workflows/runtime/observe";',
    'import { readFileSync } from "node:fs";',
    'import { boardOf } from "../src/board.js";',
    'import "../src/server.js";',
    'import { type Board } from "../src/board.js";',
  ].join("\n");
  assert.deepEqual(serverValueImports(app, "Offender.tsx", offender), [1, 2, 3, 4, 5]);
  const legit = [
    'import type { RunSummary } from "@cursor-workflows/runtime/observe";',
    'import type { Board } from "../src/board.js";',
    'import { formatCount } from "./format.js";',
    'import { runApiPath } from "../run-view/location.js";',
    'import "./tokens.css";',
  ].join("\n");
  assert.deepEqual(serverValueImports(app, "Legit.tsx", legit), []);
});

test("the app page imports server code as types only: esbuild bundles it for the browser", () => {
  const app = join(ROOT, "packages", "dashboard", "app");
  const sources = readdirSync(app).filter((f) => /\.tsx?$/.test(f));
  assert.ok(sources.length >= 5);
  const offenders = sources.flatMap((f) => serverValueImports(app, f, read("packages", "dashboard", "app", f)).map((line) => `app/${f}:${line}`));
  assert.deepEqual(offenders, [], "import runtime and server modules with `import type`; the browser bundle cannot load them");
});
