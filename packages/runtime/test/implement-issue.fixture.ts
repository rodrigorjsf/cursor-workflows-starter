// Shared by the implement-issue tests: the environment of a run of the workflow. A fake SDK with one dispatcher per step label,
// a fake `gh` and a fake `glab` on the PATH (one state in a JSON file, which the forge of the test owns: the other CLI fails
// the call and records it), a temporary git repository with an identity and a bare origin that the `origin` remote reaches through
// the URL of the forge's host, and a real `node --test` as the test command. A test file calls `beforeEach(setup)` and
// `afterEach(teardown)` (a GitHub-only file), or registers its tests with `forgeTest`, which runs each on every forge.
process.env.WF_METRICS = "off";
import { execFileSync } from "node:child_process";
import "./isolate-home.js";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { calls, script } from "@cursor/sdk";
import { runWorkflow } from "../src/runtime/engine.js";
import implementIssue from "../workflows/implement-issue.js";
import { RECORDINGS_PATH, TEST_HOST } from "./glab-recordings.js";

export type Handler = (o: any, msg: string) => unknown;

/** The forges a test can run on. */
export const FORGES = ["github", "gitlab"] as const;
export type TestForge = (typeof FORGES)[number];

/** Estado do teste corrente. `handlers` é a resposta de cada etapa, por label (o sufixo `:N` é opcional). */
export const fx = {
  root: "",
  repo: "",
  /** The JSON file both fake forge CLIs keep their state in. */
  forgeStateFile: "",
  /** The forge of the running test: its host is the `origin` remote's, and its CLI is the one the fakes answer. */
  forge: "github" as TestForge,
  savedPath: undefined as string | undefined,
  handlers: {} as Record<string, Handler>,
};

/** The URL `origin` has in each forge's tests: the host decides the forge. The bare repository behind it is reached through `url.<base>.insteadOf`. */
const ORIGIN_URLS: Record<TestForge, string> = { github: "https://github.com/owner/repo.git", gitlab: "https://gitlab.com/owner/repo.git" };

export const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
export const labelOf = (o: any) => String(o.name).replace(/^implement-issue:/, "");
export const names = () => calls.map(labelOf);
export const submit = (o: any, v: unknown) => o.local.customTools.submit_result.execute(v, {});
export const write = (o: any, file: string, content: string) => {
  const p = join(o.local.cwd, file);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
};
/** The state of the fake forge: what the fake CLI of the test's forge was asked and holds (the comments of the issue and the PRs, or merge requests, opened). */
export const forgeState = () =>
  JSON.parse(readFileSync(fx.forgeStateFile, "utf8")) as {
    comments: string[];
    prs: Array<{ url: string; body: string; head?: string; state?: string; title?: string }>;
    calls: string[][];
    fail?: Record<string, string>;
    /** The calls the CLI of the other forge got: the workflow asked the wrong one. */
    wrongCli?: string[][];
  };
/** From now on the fake forge fails the operation `op` with `message` on stderr and exit code 1; `message` undefined restores it. `op` is the `gh` call it replaces: "issue view", "issue comment", "pr view" or "pr create" (glab's own commands and routes map to the same names). */
export function failForge(op: string, message: string | undefined) {
  changeForgeState((state) => {
    state.fail = { ...state.fail };
    if (message === undefined) delete state.fail[op];
    else state.fail[op] = message;
  });
}

/** Changes what the fake forge holds (the comments the issue has, the system notes GitLab added, the PRs that exist, what fails): `change` edits the state it is given. */
export function changeForgeState(change: (state: Record<string, any>) => void) {
  const state = JSON.parse(readFileSync(fx.forgeStateFile, "utf8"));
  change(state);
  writeFileSync(fx.forgeStateFile, JSON.stringify(state));
}

/** Makes `url` the URL of `origin`, reached through the bare repository the fixture made (as the fixture does for its own forge): the remote moved to another host. */
export function setOrigin(url: string) {
  git(fx.repo, "remote", "set-url", "origin", url);
  git(fx.repo, "config", "--add", `url.${join(fx.root, "origin.git")}.insteadOf`, url);
}

/**
 * From now on the fake forge answers the state of the PR opened on `branch` with `state` (a merge or a close that happened on the forge).
 * `"locked"` is GitLab's fourth state, a merge request being merged: the fake glab prints it as it is (the fake gh would too, and gh's reader would refuse it).
 */
export function setPrState(branch: string, state: "OPEN" | "MERGED" | "CLOSED" | "locked") {
  changeForgeState((st) => {
    const pr = (st.prs as Array<{ head?: string; state?: string }>).filter((p) => p.head === branch).pop();
    if (!pr) throw new Error(`the fake forge has no PR on ${branch}`);
    pr.state = state;
  });
}

/** The progress record of a run of implement-issue: what `wf gc` reads to know the run's branch, worktree and forge. */
export const progressFileOf = (runId: string) => join(fx.repo, ".workflows", "runs", runId, "tdd-progress.json");

/** The branch and the worktree of a run on issue 7: each run owns its own (`wf/issue-<n>-<run>`), named after the run id without the workflow's name. */
const runSuffix = (runId: string) => runId.replace(/^implement-issue-/, "");
export const branchOf = (runId: string) => `wf/issue-7-${runSuffix(runId)}`;
export const worktreeOf = (runId: string) => join(fx.repo, ".workflows", "worktrees", `wf-issue-7-${runSuffix(runId)}`);
/** The branches the workflow has on the origin (everything under `wf/`). */
export const originBranches = () =>
  git(join(fx.root, "origin.git"), "for-each-ref", "--format=%(refname:short)", "refs/heads/wf/")
    .split("\n")
    .filter(Boolean);
export const onOrigin = () => originBranches().length > 0;

const FAKE_GH = `#!/usr/bin/env node
const fs = require("fs");
const f = process.env.FAKE_FORGE_STATE;
const st = JSON.parse(fs.readFileSync(f, "utf8"));
const a = process.argv.slice(2);
if (st.forge !== "github") { (st.wrongCli = st.wrongCli || []).push(["gh", ...a]); fs.writeFileSync(f, JSON.stringify(st)); process.stderr.write("fake gh: this test's forge is " + st.forge); process.exit(99); }
st.calls.push(a);
const failure = (st.fail || {})[a[0] + " " + a[1]];
if (failure !== undefined) { fs.writeFileSync(f, JSON.stringify(st)); process.stderr.write(failure); process.exit(1); }
const flag = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const save = () => fs.writeFileSync(f, JSON.stringify(st));
const body = () => (flag("--body-file") ? fs.readFileSync(flag("--body-file"), "utf8") : flag("--body"));
if (a[0] === "issue" && a[1] === "view") {
  const out = {};
  for (const k of (flag("--json") || "").split(",")) out[k] = k === "comments" ? st.comments.map((b) => ({ body: b })) : st.issue[k];
  save(); process.stdout.write(JSON.stringify(out));
} else if (a[0] === "issue" && a[1] === "comment") {
  st.comments.push(body()); save(); process.stdout.write("https://example.invalid/issues/1#c" + st.comments.length + "\\n");
} else if (a[0] === "pr" && a[1] === "view" && flag("--json") === "state") {
  // gh pr view <branch> --json state: the state of the latest PR whose head is that branch
  save();
  const pr = st.prs.filter((p) => p.head === a[2]).pop();
  if (pr) process.stdout.write((pr.state || "OPEN") + "\\n"); else { process.stderr.write('no pull requests found for branch "' + a[2] + '"'); process.exit(1); }
} else if (a[0] === "pr" && a[1] === "view") {
  // A PR seeded by a test has no head and answers for every branch; one made by pr create answers for its own branch only
  save(); const pr = st.prs.find((p) => !p.head || p.head === a[2]);
  if (pr) process.stdout.write(pr.url + "\\n"); else { process.stderr.write("no pull requests found"); process.exit(1); }
} else if (a[0] === "pr" && a[1] === "create") {
  st.prs.push({ url: "https://example.invalid/pull/" + (st.prs.length + 1), body: body(), head: flag("--head"), state: "OPEN" }); save();
  process.stdout.write(st.prs[st.prs.length - 1].url + "\\n");
} else { save(); process.stderr.write("fake gh: unsupported " + a.join(" ")); process.exit(2); }
`;


// The fake glab: the commands and the `glab api` routes the forge module uses, on the state the fake gh keeps. What it prints is what the
// real glab 1.130.0 printed for a real GitLab, recorded by scripts/verify/gitlab-e2e.sh (test/fixtures/glab/recordings.json, read here
// through glab-recordings.ts): every object is the recorded one with the fields the test controls (numbers, titles, bodies, states)
// set on it, and every list is in the order and the paging the real GitLab and glab gave. A route it does not know exits 2.
const fakeGlab = () => `#!/usr/bin/env node
const fs = require("fs");
const f = process.env.FAKE_FORGE_STATE;
const st = JSON.parse(fs.readFileSync(f, "utf8"));
const a = process.argv.slice(2);
const save = () => fs.writeFileSync(f, JSON.stringify(st));
const fail = (text, code) => { save(); process.stderr.write(text); process.exit(code); };
if (st.forge !== "gitlab") { (st.wrongCli = st.wrongCli || []).push(["glab", ...a]); fail("fake glab: this test's forge is " + st.forge, 99); }
// A host named through the environment comes first in the log, as \`GITLAB_HOST=<host>\`.
st.calls.push(process.env.GITLAB_HOST === undefined ? a : ["GITLAB_HOST=" + process.env.GITLAB_HOST, ...a]);
const flag = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
// glab 1.130.0 takes a bare host in --hostname: with a port it fails before asking anyone, as it did when tried
if (a[0] === "api" && (flag("--hostname") || "").includes(":")) fail("ERROR error parsing --hostname: invalid hostname.", 1);
const has = (...n) => n.some((x) => a.includes(x));
const REC = JSON.parse(fs.readFileSync(${JSON.stringify(RECORDINGS_PATH)}, "utf8"));
const FAKE_HOST = ${JSON.stringify(TEST_HOST)};
// The recorded GitLab's placeholder host is the test's, and its http:// URLs (the recording ran on plain http) are gitlab.com's https:// ones: the same swap as recorded() in glab-recordings.ts, which this process cannot import.
const fill = (text) => text.split("http://" + REC.placeholders.host).join("https://" + FAKE_HOST).split(REC.placeholders.host).join(FAKE_HOST);
const printed = (name) => REC.recordings[name];
const recordedJson = (name) => JSON.parse(fill(printed(name).stdout));
const DEFAULT_PAGE_SIZE = 20; // GitLab's default page size: without --paginate glab prints only the first page; with it, every page as one array
const STATES = { OPEN: "opened", MERGED: "merged", CLOSED: "closed" };
const MR = recordedJson("mr-list")[0];
const NOTES = recordedJson("issue-notes");
const NOTE_OF = { user: NOTES.find((n) => !n.system), system: NOTES.find((n) => n.system) };
const mrOf = (p, i) => ({ ...MR, id: i + 1, iid: i + 1, title: p.title, description: p.body, web_url: p.url, state: STATES[p.state || "OPEN"] || p.state, source_branch: p.head });
// What glab printed on stderr for the recording goes to stderr too (a warning, the text around a URL), then the value goes to stdout.
const out = (value, name) => { save(); process.stderr.write(fill(printed(name).stderr)); process.stdout.write(JSON.stringify(value) + "\\n"); };
const pageOf = (items, size) => (has("--paginate") ? items : items.slice(0, size));
// which gh call each glab call stands for, so a test can fail it with failForge
const endpoint = a[0] === "api" ? a.slice(1).find((x, i, all) => !x.startsWith("-") && !["--method", "-X", "-F", "--field", "-f", "--raw-field", "--hostname"].includes(all[i - 1])) : undefined;
// Where glab is: the host and the project of the cwd come from its raw \`origin\` URL (a \`url.<base>.insteadOf\` rewrite is not applied), and \`--hostname\` of \`glab api\` names another host.
const originUrl = () => require("child_process").execFileSync("git", ["config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
const hostAndPath = (url) => { const m = /^[a-z][a-z0-9+.-]*:\\/\\/(?:[^@/]*@)?([^/:]+)(?::\\d+)?\\/(.+?)(?:\\.git)?\\/?$/i.exec(url) || /^(?:[^@/:]+@)?([^@/:]+):(.+?)(?:\\.git)?$/.exec(url); return { host: m[1].toLowerCase(), path: m[2] }; };
const post = a[0] === "api" && ["POST", "post"].includes(flag("--method") || flag("-X"));
const route = a[0] === "issue" && a[1] === "view" ? "issue view"
  : a[0] === "mr" && a[1] === "create" ? "pr create"
  : endpoint && /\\/issues\\/\\d+\\/notes$/.test(endpoint) ? (post ? "issue comment" : "issue view")
  : endpoint && /\\/merge_requests\\?/.test(endpoint) ? "pr view"
  : endpoint && /^projects\\/[^/?]+$/.test(endpoint) ? "repo view"
  : undefined;
const failure = route && (st.fail || {})[route];
if (failure !== undefined) fail(failure, 1);
if (route === "issue view" && a[0] === "issue") {
  if (flag("--output") !== "json") fail("fake glab: issue view without --output json", 2);
  // the recording of the same form: \`--repo <url>\` names the project, without it the cwd's origin does
  const name = has("--repo", "-R") ? "issue-view-repo" : "issue-view";
  out({ ...recordedJson(name), iid: st.issue.number, title: st.issue.title, description: st.issue.body, labels: st.issue.labels.map((l) => l.name) }, name);
} else if (route === "issue view") {
  // all the notes of the issue, newest first as GitLab lists them: the comments, then GitLab's own system notes made before them
  const notes = [...(st.systemNotes || []).map((body) => ({ body, system: true })), ...st.comments.map((body) => ({ body, system: false }))]
    .map((n, i) => ({ ...(n.system ? NOTE_OF.system : NOTE_OF.user), id: i + 1, body: n.body, system: n.system }))
    .reverse();
  out(pageOf(notes, DEFAULT_PAGE_SIZE), "issue-notes");
} else if (route === "issue comment") {
  const field = flag("-F") || flag("--field") || "";
  const [key, ...rest] = field.split("=");
  const value = rest.join("=");
  if (key !== "body") fail("fake glab: a note needs -F body=@<file>", 2);
  st.comments.push(value.startsWith("@") ? fs.readFileSync(value.slice(1), "utf8") : value);
  out({ ...recordedJson("note-create"), id: st.comments.length, body: st.comments[st.comments.length - 1], system: false }, "note-create");
} else if (route === "pr view") {
  const query = new URLSearchParams(endpoint.split("?")[1]);
  // A PR seeded by a test has no head and answers for every branch; one made by mr create answers for its own branch only
  let mrs = st.prs.map(mrOf).filter((m) => !m.source_branch || m.source_branch === query.get("source_branch"));
  if (query.get("sort") !== "asc") mrs = mrs.reverse(); // created_at descending: the latest first
  out(pageOf(mrs, Number(query.get("per_page") || DEFAULT_PAGE_SIZE)), mrs.length ? "mr-list" : "mr-list-empty");
} else if (route === "pr create") {
  if (has("-H", "--head")) fail("fake glab: -H names the head repository, not the branch: use --source-branch", 2);
  if (!flag("--source-branch") || !has("--yes")) fail("fake glab: mr create needs --source-branch and --yes (no prompts)", 2);
  // what glab printed for the recorded merge request, with the branch, the title and the number of this one
  const number = st.prs.length + 1;
  const now = (text) => fill(text).split(REC.subjects.branch).join(flag("--source-branch")).split(REC.subjects.title).join(flag("--title")).split("/merge_requests/" + REC.subjects.mr).join("/merge_requests/" + number);
  const stdout = now(printed("mr-create").stdout);
  st.prs.push({ url: /https?:\\/\\/\\S+\\/-\\/merge_requests\\/\\d+/.exec(stdout)[0], body: flag("--description"), title: flag("--title"), head: flag("--source-branch"), state: "OPEN" });
  save();
  process.stderr.write(now(printed("mr-create").stderr));
  process.stdout.write(stdout);
} else if (route === "repo view") {
  // the project of the cwd is the one its origin names; a named one comes back in GitLab's case (lower case here), on the host asked for
  const cwdRemote = hostAndPath(originUrl());
  const named = endpoint === "projects/:fullpath" ? cwdRemote.path : decodeURIComponent(endpoint.slice("projects/".length)).toLowerCase();
  const name = endpoint === "projects/:fullpath" ? "repo-view" : flag("--hostname") ? "repo-view-hostname" : "repo-view-repo";
  out({ ...recordedJson(name), path_with_namespace: named, web_url: "https://" + (flag("--hostname") || process.env.GITLAB_HOST || cwdRemote.host) + "/" + named }, name);
} else fail("fake glab: unsupported " + a.join(" "), 2);
`;

export function issue(labels: string[], title = "Add subtract(a, b)") {
  writeFileSync(
    fx.forgeStateFile,
    JSON.stringify({
      forge: fx.forge,
      issue: { number: 7, title, body: "Exportar `subtract(a, b)` em src/math.js, que devolve a - b.", labels: labels.map((name) => ({ name })) },
      comments: [],
      prs: [],
      calls: [],
    }),
  );
}

// Respostas padrão de cada etapa; cada teste sobrescreve só o que precisa.
export const SUB_TEST = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { subtract } from "../src/math.js";\n\ntest("subtract", () => {\n  assert.equal(subtract(5, 3), 2);\n});\n';
export const SUB_CODE = "export function add(a, b) {\n  return a + b;\n}\n\nexport function subtract(a, b) {\n  return a - b;\n}\n";
export const ALL_TEST = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { subtractAll } from "../src/math.js";\n\ntest("subtractAll", () => {\n  assert.equal(subtractAll(10, 3, 2), 5);\n});\n';
export const ALL_CODE = SUB_CODE + "\nexport function subtractAll(a, ...rest) {\n  return rest.reduce((acc, x) => acc - x, a);\n}\n";
export const PLAN = {
  seams: [{ name: "math.subtract", interface: "subtract(a, b): number", why: "comportamento pedido pela issue" }],
  slices: [{ behavior: "subtract devolve a diferença", seam: "math.subtract", testIdea: "subtract(5, 3) é 2" }],
  testCommand: "node --test",
};
export const CLEAN_REVIEW = { findings: [], worst: "" };

function defaults(): Record<string, Handler> {
  return {
    "test-1": (o) => { write(o, "test/sub.test.js", SUB_TEST); submit(o, { testFile: "test/sub.test.js", testName: "subtract" }); },
    "code-1": (o) => { write(o, "src/math.js", SUB_CODE); submit(o, { summary: "subtract exportado", filesChanged: ["src/math.js"] }); },
    plan: (o) => submit(o, PLAN),
    "review:standards": (o) => submit(o, CLEAN_REVIEW),
    "review:spec": (o) => submit(o, CLEAN_REVIEW),
    "review:security": (o) => submit(o, CLEAN_REVIEW),
    "pr-text": (o) => submit(o, { summary: "```diff\n+export function subtract(a, b)\n```", door: "two-way", blastRadius: "local" }),
  };
}
const dispatcher = (o: any, msg: string) => {
  const label = labelOf(o);
  const h = fx.handlers[label] ?? fx.handlers[label.replace(/:\d+$/, "")];
  if (!h) throw new Error(`etapa sem resposta no teste: ${label}`);
  const r = h(o, msg);
  return r && typeof r === "object" ? r : { status: "finished", result: "ok" };
};

/** The environment of a test on GitHub: what `beforeEach` calls (it hands its argument to the hook, so no parameter here). */
export function setup() {
  setupFor("github");
}

/** The environment of a test whose forge is `forge`. */
function setupFor(forge: TestForge) {
  fx.forge = forge;
  fx.root = mkdtempSync(join(tmpdir(), "wf-ii-"));
  fx.repo = join(fx.root, "repo");
  const { root, repo } = fx;
  const bin = join(root, "bin");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(repo, "package.json"), '{ "name": "fx", "type": "module", "scripts": { "test": "node --test" } }\n');
  writeFileSync(join(repo, "src", "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  writeFileSync(join(repo, "test", "math.test.js"), 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/math.js";\n\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n});\n');
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "teste");
  git(repo, "config", "user.email", "teste@example.invalid");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(root, "init", "-q", "--bare", "origin.git");
  git(repo, "remote", "add", "origin", ORIGIN_URLS[forge]);
  git(repo, "config", `url.${join(root, "origin.git")}.insteadOf`, ORIGIN_URLS[forge]); // the host is the forge's; the repository is the bare one
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(bin, "glab"), fakeGlab());
  chmodSync(join(bin, "glab"), 0o755);
  fx.forgeStateFile = join(root, "forge.json");
  process.env.FAKE_FORGE_STATE = fx.forgeStateFile;
  fx.savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${fx.savedPath}`;
  fx.handlers = defaults();
  for (let i = 0; i < 200; i++) script.push(dispatcher);
  calls.length = 0;
}

export function teardown() {
  rmSync(join(process.env.WF_HOME!, "config.json"), { force: true }); // a test that declared forges in the global file leaves none behind
  process.env.PATH = fx.savedPath;
  script.length = 0;
  calls.length = 0;
  rmSync(fx.root, { recursive: true, force: true });
}

/**
 * Registers `fn` as one test per forge in `forges` (every forge by default), titled `<title> [<forge>]`, each in a fresh environment
 * of that forge, set up before and torn down after (the file does not call `beforeEach(setup)`). `fn` is told its forge, for the few
 * assertions that name what only one forge says.
 */
export function forgeTest(title: string, fn: (forge: TestForge) => unknown, forges: readonly TestForge[] = FORGES): void {
  for (const forge of forges) {
    test(`${title} [${forge}]`, async () => {
      setupFor(forge);
      try {
        await fn(forge);
      } finally {
        teardown();
      }
    });
  }
}

export const run = (args: Record<string, unknown>, runId?: string) =>
  runWorkflow(implementIssue, { issue: 7, testCommand: "node --test", ...args } as any, { cwd: fx.repo, runId });

/** A suíte passa no worktree entregue? (a verdade, fora do que o workflow diz) */
export function suitePasses(cwd: string): boolean {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    execFileSync("node", ["--test"], { cwd, env, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
