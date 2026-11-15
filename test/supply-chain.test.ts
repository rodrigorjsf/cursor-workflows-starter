// Seam: the repository's supply-chain configuration, read as text the way a reviewer or a runner reads it: `.npmrc`,
// `scripts/install.sh`, `.github/workflows/*.yml`, `.github/dependabot.yml` and the `test` script of each manifest. Each
// check enforces one rule that CODING_STANDARDS.md names under Dependencies and CI: a compromised dependency or action
// gets no install-time code, no stored token and no time to wait for, and a test that hangs does not hold a runner for
// hours. A check is a predicate over one file's text: a sample test proves it fires on an offender and stays silent on
// the legitimate case, and a second test runs it over the files the rule governs. No YAML parser is a dependency, so the
// workflow and Dependabot checks read the indentation the repo's own files use; a layout they do not know passes.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const WORKFLOWS = existsSync(join(ROOT, ".github", "workflows"))
  ? readdirSync(join(ROOT, ".github", "workflows"))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => `.github/workflows/${name}`)
  : [];
const MANIFESTS = ["package.json", "packages/runtime/package.json", "packages/dashboard/package.json"];

// --- .npmrc ----------------------------------------------------------------------------------------------------------

/** The settings an `.npmrc` states, as written: `key=value` lines, comments and blanks skipped. */
function npmrcSettings(text: string): Map<string, string> {
  const settings = new Map<string, string>();
  for (const line of text.split("\n")) {
    const setting = /^\s*([\w.@/-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (setting && !/^\s*[#;]/.test(line)) settings.set(setting[1]!, setting[2]!);
  }
  return settings;
}

/** The settings the kit's `.npmrc` must state, with the value, that the file does not state. */
const missingNpmrc = (text: string) =>
  Object.entries({ "ignore-scripts": "true", "engine-strict": "true" }).flatMap(([key, value]) =>
    npmrcSettings(text).get(key) === value ? [] : [`${key}=${value}`],
  );

test("the .npmrc check fires on a missing or switched-off setting and passes the two the kit needs", () => {
  assert.deepEqual(missingNpmrc(""), ["ignore-scripts=true", "engine-strict=true"]);
  assert.deepEqual(missingNpmrc("ignore-scripts=false\nengine-strict=true\n"), ["ignore-scripts=true"]);
  assert.deepEqual(missingNpmrc("# ignore-scripts=true\nengine-strict = true\n"), ["ignore-scripts=true"]);
  assert.deepEqual(missingNpmrc("ignore-scripts=true\nengine-strict=true\n"), []);
});

test("the repository .npmrc turns dependency install scripts off and makes engines binding", () => {
  assert.ok(existsSync(join(ROOT, ".npmrc")), "commit a .npmrc at the repo root");
  assert.deepEqual(missingNpmrc(read(".npmrc")), [], "state each of these in .npmrc");
});

// --- install commands ------------------------------------------------------------------------------------------------

/** One logical line of code: where it starts (1-based) and its text, continuation lines joined. */
interface CodeLine {
  line: number;
  code: string;
}

/** Code lines of a shell script or workflow: comment lines dropped, a trailing backslash joined to the next line. */
function codeLines(text: string): CodeLine[] {
  const out: CodeLine[] = [];
  let pending: CodeLine | undefined;
  text.split("\n").forEach((raw, i) => {
    if (!pending && /^\s*#/.test(raw)) return;
    const code = raw.replace(/\\$/, " ");
    pending = pending ? { line: pending.line, code: pending.code + code } : { line: i + 1, code };
    if (!raw.endsWith("\\")) {
      out.push(pending);
      pending = undefined;
    }
  });
  if (pending) out.push(pending);
  return out;
}

/** Lines of 1-based numbers where `npm ci`, `npm install`, `npm i` or `npm add` runs without `--ignore-scripts` before the command ends. */
const installsWithScripts = (text: string) =>
  codeLines(text).flatMap(({ line, code }) =>
    [...code.matchAll(/\bnpm\s+(?:ci|install|i|add)\b([^&|;)]*)/g)].some((install) => !/(^|\s)--ignore-scripts(\s|$)/.test(install[1]!)) ? [line] : [],
  );

test("the install check fires on an npm install that may run scripts, and reads a command continued over lines", () => {
  assert.deepEqual(installsWithScripts("      - run: npm ci\n"), [1]);
  assert.deepEqual(installsWithScripts('  (cd "$kit" && npm install --no-audit --no-fund)\n'), [1]);
  assert.deepEqual(installsWithScripts("npm ci --ignore-scripts --no-audit && npm run check --ignore-scripts\n"), []);
  assert.deepEqual(installsWithScripts("npm ci && npm i --ignore-scripts\n"), [1]);
  assert.deepEqual(installsWithScripts("          npm install --no-save --prefix \"$dir\" \\\n            pkg@1 --ignore-scripts\n"), []);
  assert.deepEqual(installsWithScripts("          npm install --no-save --prefix \"$dir\" \\\n            pkg@1\n"), [1]);
  assert.deepEqual(installsWithScripts("# npm ci runs scripts\nnpm run check\n"), []);
});

test("every npm install of the installer and of the CI workflows leaves dependency scripts off", () => {
  const governed = ["scripts/install.sh", ...WORKFLOWS];
  assert.ok(governed.length >= 2, `found ${governed.join(", ")}`);
  for (const path of governed) assert.deepEqual(installsWithScripts(read(path)), [], `${path}: add --ignore-scripts to the npm install on these lines`);
});

// --- Dependabot ------------------------------------------------------------------------------------------------------

/** What `.github/dependabot.yml` says about each ecosystem it updates: its name and the `cooldown` days written under `cooldown:`. */
function dependabotEcosystems(text: string): { ecosystem: string; defaultDays?: number; majorDays?: number }[] {
  return text
    .split(/^(?=\s*-\s*package-ecosystem:)/m)
    .slice(1)
    .map((block) => {
      const lines = block.split("\n");
      const indentOf = (l: string) => l.length - l.trimStart().length;
      const at = lines.findIndex((l) => /^\s+cooldown:\s*$/.test(l));
      const under = at === -1 ? [] : lines.slice(at + 1).filter((l, i, rest) => rest.slice(0, i + 1).every((m) => m.trim() === "" || indentOf(m) > indentOf(lines[at]!)));
      const days = (key: string) => {
        const found = under.map((l) => new RegExp(`^\\s+${key}:\\s*(\\d+)\\s*$`).exec(l)).find(Boolean);
        return found ? Number(found[1]) : undefined;
      };
      const defaultDays = days("default-days");
      const majorDays = days("semver-major-days");
      return {
        ecosystem: /package-ecosystem:\s*["']?([\w-]+)/.exec(block)![1]!,
        ...(defaultDays === undefined ? {} : { defaultDays }),
        ...(majorDays === undefined ? {} : { majorDays }),
      };
    });
}

test("the Dependabot reader pairs each ecosystem with the cooldown days written under it", () => {
  const text = [
    "version: 2",
    "updates:",
    '  - package-ecosystem: "npm"',
    '    directory: "/"',
    "    cooldown:",
    "      default-days: 7",
    "      semver-major-days: 14",
    "  - package-ecosystem: github-actions",
    "    default-days: 30",
    "",
  ].join("\n");
  assert.deepEqual(dependabotEcosystems(text), [{ ecosystem: "npm", defaultDays: 7, majorDays: 14 }, { ecosystem: "github-actions" }]);
  // Dependabot reads the days only from under `cooldown:`: a key beside it, or under another key, sets nothing.
  const misplaced = ["updates:", "  - package-ecosystem: npm", "    cooldown:", "      semver-major-days: 14", "    default-days: 7", "    schedule:", "      default-days: 9", ""].join("\n");
  assert.deepEqual(dependabotEcosystems(misplaced), [{ ecosystem: "npm", majorDays: 14 }]);
});

test("Dependabot updates npm and github-actions, and waits at least a week before it proposes a new version", () => {
  assert.ok(existsSync(join(ROOT, ".github", "dependabot.yml")), "commit .github/dependabot.yml");
  const ecosystems = dependabotEcosystems(read(".github/dependabot.yml"));
  for (const wanted of ["npm", "github-actions"]) {
    const found = ecosystems.filter((e) => e.ecosystem === wanted);
    assert.equal(found.length, 1, `.github/dependabot.yml needs exactly one ${wanted} entry`);
    assert.ok((found[0]!.defaultDays ?? 0) >= 7, `${wanted} needs cooldown.default-days of at least 7`);
  }
  // GitHub's reference lists github-actions as not supporting the semver-* cooldown keys, so only npm sets one.
  assert.ok((ecosystems.find((e) => e.ecosystem === "npm")!.majorDays ?? 0) >= 14, "npm needs cooldown.semver-major-days of at least 14");
});

// --- Workflows -------------------------------------------------------------------------------------------------------

/** Lines with a `uses:` that is not pinned to a 40-character commit SHA followed by a `# v<version>` comment. */
const unpinnedUses = (text: string) =>
  text.split("\n").flatMap((l, i) => (/^\s*(?:-\s*)?uses:/.test(l) && !/^\s*(?:-\s*)?uses:\s*\S+@[0-9a-f]{40}\s+#\s*v\d\S*\s*$/.test(l) ? [i + 1] : []));

test("the action pin check fires on a tag, a branch, a short SHA and a SHA without its version, and passes the full form", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(unpinnedUses("      - uses: actions/checkout@v4\n      - uses: actions/checkout@main\n"), [1, 2]);
  assert.deepEqual(unpinnedUses(`      - uses: actions/checkout@${"a".repeat(39)} # v4.4.0\n      - uses: actions/checkout@${sha}\n`), [1, 2]);
  assert.deepEqual(unpinnedUses(`      - uses: actions/checkout@${sha} # latest\n      - uses: actions/checkout@${"G".repeat(40)} # v4\n`), [1, 2]);
  assert.deepEqual(unpinnedUses(`      - uses: actions/checkout@${sha} # v4.4.0\n        uses: actions/setup-node@${sha} # v4\n`), []);
  assert.deepEqual(unpinnedUses("      - run: echo uses actions/checkout@v4\n"), []);
});

test("every action of every workflow is pinned to a full commit SHA, with its version in a trailing comment", () => {
  assert.ok(WORKFLOWS.length >= 1);
  for (const path of WORKFLOWS) {
    assert.deepEqual(unpinnedUses(read(path)), [], `${path}: pin each uses: to @<40-character SHA> # v<version> (Dependabot keeps them current)`);
  }
});

/** One step of a workflow: its first line (1-based) and the lines it spans. */
interface Step {
  line: number;
  lines: string[];
}

/** The steps of a workflow: each list item that opens with a key, with its first line (1-based) and the lines it spans. */
function steps(text: string): Step[] {
  const lines = text.split("\n");
  const found: Step[] = [];
  lines.forEach((l, i) => {
    const open = /^(\s*)-\s+[\w-]+:/.exec(l);
    if (!open) return;
    const end = lines.findIndex((next, j) => j > i && next.trim() !== "" && next.length - next.trimStart().length <= open[1]!.length && !/^\s*#/.test(next));
    found.push({ line: i + 1, lines: lines.slice(i, end === -1 ? undefined : end) });
  });
  return found;
}

/** First lines of the `actions/checkout` steps that do not set `persist-credentials: false`. */
const checkoutsKeepingToken = (text: string) =>
  steps(text).flatMap((step) =>
    step.lines.some((l) => /^\s*(?:-\s*)?uses:\s*actions\/checkout@/.test(l)) && !step.lines.some((l) => /^\s+persist-credentials:\s*false\s*$/.test(l)) ? [step.line] : [],
  );

test("the checkout check fires on a checkout that keeps the workflow token, whatever the step's key order", () => {
  const kept = "    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n";
  const dropped = "    steps:\n      - uses: actions/checkout@v4\n        with:\n          persist-credentials: false\n      - run: npm ci\n";
  const droppedAfterName = "      - name: Get the code\n        uses: actions/checkout@v4\n        with:\n          persist-credentials: false\n";
  assert.deepEqual(checkoutsKeepingToken(kept), [2]);
  assert.deepEqual(checkoutsKeepingToken(dropped), []);
  assert.deepEqual(checkoutsKeepingToken(droppedAfterName), []);
  assert.deepEqual(checkoutsKeepingToken("      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          persist-credentials: false\n"), [1]);
});

test("every checkout step of every workflow leaves no token in the clone", () => {
  for (const path of WORKFLOWS) assert.deepEqual(checkoutsKeepingToken(read(path)), [], `${path}: set with: persist-credentials: false on each actions/checkout step`);
});

/** The jobs of a workflow with the lines they span: the entries of the top-level `jobs:` map, two spaces in. */
function jobs(text: string): { name: string; lines: string[] }[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\S/.test(l));
  const body = end === -1 ? rest : rest.slice(0, end);
  const found: { name: string; lines: string[] }[] = [];
  for (const l of body) {
    const open = /^ {2}([\w-]+):\s*$/.exec(l);
    if (open) found.push({ name: open[1]!, lines: [] });
    else found.at(-1)?.lines.push(l);
  }
  return found;
}

/** The jobs that have no `timeout-minutes` below GitHub's default of 360, which a hung job would otherwise run to. */
const jobsWithoutTimeout = (text: string) =>
  jobs(text).flatMap((job) => {
    const minutes = job.lines.map((l) => /^ {4}timeout-minutes:\s*(\d+)\s*$/.exec(l)).find(Boolean);
    return minutes && Number(minutes[1]) > 0 && Number(minutes[1]) < 360 ? [] : [job.name];
  });

test("the job timeout check names a job with no timeout-minutes of its own and one that keeps GitHub's default", () => {
  const text = "name: ci\njobs:\n  test:\n    runs-on: x\n    timeout-minutes: 20\n    steps:\n      - run: a\n  mermaid:\n    runs-on: x\n    steps:\n      - run: a\n  slow:\n    timeout-minutes: 360\n";
  assert.deepEqual(jobsWithoutTimeout(text), ["mermaid", "slow"]);
  assert.deepEqual(jobsWithoutTimeout("jobs:\n  a:\n    timeout-minutes: 5\n"), []);
  assert.deepEqual(jobsWithoutTimeout("jobs:\n  a:\n    steps:\n      - timeout-minutes: 5\n"), ["a"]);
});

test("every CI job is bounded by a timeout, so a hung step does not hold a runner for six hours", () => {
  for (const path of WORKFLOWS) {
    assert.ok(jobs(read(path)).length >= 1, `${path} has no jobs the check can read`);
    assert.deepEqual(jobsWithoutTimeout(read(path)), [], `${path}: set timeout-minutes (20 for the test job) on each of these jobs`);
  }
});

/** The `--test-timeout` of a `test` script, in milliseconds, or undefined when the script runs the node:test runner without one. */
function testTimeoutMs(manifest: string): number | undefined {
  const script = (JSON.parse(manifest) as { scripts?: { test?: string } }).scripts?.test ?? "";
  const found = /(?:^|\s)--test-timeout=(\d+)(?:\s|$)/.exec(script);
  return found ? Number(found[1]) : undefined;
}

test("the test timeout reader finds the flag in a script and returns nothing when it is missing", () => {
  assert.equal(testTimeoutMs('{ "scripts": { "test": "tsx --test --test-timeout=120000 test/*.test.ts" } }'), 120000);
  assert.equal(testTimeoutMs('{ "scripts": { "test": "tsx --test test/*.test.ts" } }'), undefined);
  assert.equal(testTimeoutMs('{ "scripts": { "test": "npm run test --workspaces && tsx --test test/*.test.ts" } }'), undefined);
  assert.equal(testTimeoutMs('{ "scripts": {} }'), undefined);
});

test("every test script bounds one test with --test-timeout, since node:test waits forever by default", () => {
  for (const path of MANIFESTS) assert.ok((testTimeoutMs(read(path)) ?? 0) > 0, `${path}: add --test-timeout=<milliseconds> to the test script`);
});

/** The `node-version` entries of the matrix of a workflow's test job: `["22.13.0", "22.x"]` becomes its two strings. */
function matrixNodeVersions(text: string): string[] {
  const list = /^\s*node-version:\s*\[(.*)\]\s*$/m.exec(text);
  return list ? list[1]!.split(",").map((v) => v.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : [];
}

test("the matrix reader returns the quoted versions of a flow list", () => {
  assert.deepEqual(matrixNodeVersions('        node-version: ["22.13.0", "22.x"]\n'), ["22.13.0", "22.x"]);
  assert.deepEqual(matrixNodeVersions("        node-version: 22.x\n"), []);
});

test("CI tests the Node floor the manifests declare and every newer line users run", () => {
  const floor = /^>=(\d+\.\d+)$/.exec((JSON.parse(read("package.json")) as { engines: { node: string } }).engines.node)![1]!;
  const matrix = matrixNodeVersions(read(".github/workflows/ci.yml"));
  for (const wanted of [`${floor}.0`, "22.x", "24.x", "26.x"]) assert.ok(matrix.includes(wanted), `the test matrix of ci.yml lacks ${wanted}: it has ${matrix.join(", ")}`);
});
