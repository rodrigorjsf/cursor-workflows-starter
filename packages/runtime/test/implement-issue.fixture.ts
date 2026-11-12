// Ambiente dos testes de fluxo do implement-issue: SDK falso com um despachante por label de etapa, `gh` falso no
// PATH (estado num arquivo JSON), repositório git temporário com identidade e um origin bare, e `node --test` de
// verdade como comando de teste. Cada arquivo de teste chama `beforeEach(setup)` e `afterEach(teardown)`.
process.env.WF_METRICS = "off";
import { execFileSync } from "node:child_process";
import "./isolate-home.js";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calls, script } from "@cursor/sdk";
import { runWorkflow } from "../src/runtime/engine.js";
import implementIssue from "../workflows/implement-issue.js";

export type Handler = (o: any, msg: string) => unknown;

/** Estado do teste corrente. `handlers` é a resposta de cada etapa, por label (o sufixo `:N` é opcional). */
export const fx = {
  root: "",
  repo: "",
  ghState: "",
  savedPath: undefined as string | undefined,
  handlers: {} as Record<string, Handler>,
};

export const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
export const labelOf = (o: any) => String(o.name).replace(/^implement-issue:/, "");
export const names = () => calls.map(labelOf);
export const submit = (o: any, v: unknown) => o.local.customTools.submit_result.execute(v, {});
export const write = (o: any, file: string, content: string) => {
  const p = join(o.local.cwd, file);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
};
export const gh = () =>
  JSON.parse(readFileSync(fx.ghState, "utf8")) as { comments: string[]; prs: Array<{ url: string; body: string }>; calls: string[][]; fail?: Record<string, string> };
/** From now on the fake gh fails `gh <command>` (for example "pr view") with `message` on stderr and exit code 1; `message` undefined restores it. */
export function failGh(command: string, message: string | undefined) {
  const state = JSON.parse(readFileSync(fx.ghState, "utf8"));
  state.fail = { ...state.fail };
  if (message === undefined) delete state.fail[command];
  else state.fail[command] = message;
  writeFileSync(fx.ghState, JSON.stringify(state));
}

export const worktreeOf = () => join(fx.repo, ".workflows", "worktrees", "wf-issue-7");

const FAKE_GH = `#!/usr/bin/env node
const fs = require("fs");
const f = process.env.FAKE_GH_STATE;
const st = JSON.parse(fs.readFileSync(f, "utf8"));
const a = process.argv.slice(2);
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
} else if (a[0] === "pr" && a[1] === "view") {
  save(); if (st.prs.length) process.stdout.write(st.prs[0].url + "\\n"); else { process.stderr.write("no pull requests found"); process.exit(1); }
} else if (a[0] === "pr" && a[1] === "create") {
  st.prs.push({ url: "https://example.invalid/pull/" + (st.prs.length + 1), body: body() }); save();
  process.stdout.write(st.prs[st.prs.length - 1].url + "\\n");
} else { save(); process.stderr.write("fake gh: unsupported " + a.join(" ")); process.exit(2); }
`;

export function issue(labels: string[], title = "Add subtract(a, b)") {
  writeFileSync(
    fx.ghState,
    JSON.stringify({ issue: { number: 7, title, body: "Exportar `subtract(a, b)` em src/math.js, que devolve a - b.", labels: labels.map((name) => ({ name })) }, comments: [], prs: [], calls: [] }),
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
    "teste-1": (o) => { write(o, "test/sub.test.js", SUB_TEST); submit(o, { testFile: "test/sub.test.js", testName: "subtract" }); },
    "codigo-1": (o) => { write(o, "src/math.js", SUB_CODE); submit(o, { summary: "subtract exportado", filesChanged: ["src/math.js"] }); },
    planejar: (o) => submit(o, PLAN),
    "review:standards": (o) => submit(o, CLEAN_REVIEW),
    "review:spec": (o) => submit(o, CLEAN_REVIEW),
    "review:security": (o) => submit(o, CLEAN_REVIEW),
    "pr-texto": (o) => submit(o, { summary: "```diff\n+export function subtract(a, b)\n```", door: "two-way", blastRadius: "local" }),
  };
}
const dispatcher = (o: any, msg: string) => {
  const label = labelOf(o);
  const h = fx.handlers[label] ?? fx.handlers[label.replace(/:\d+$/, "")];
  if (!h) throw new Error(`etapa sem resposta no teste: ${label}`);
  const r = h(o, msg);
  return r && typeof r === "object" ? r : { status: "finished", result: "ok" };
};

export function setup() {
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
  git(repo, "remote", "add", "origin", join(root, "origin.git"));
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  fx.ghState = join(root, "gh.json");
  process.env.FAKE_GH_STATE = fx.ghState;
  fx.savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${fx.savedPath}`;
  fx.handlers = defaults();
  for (let i = 0; i < 200; i++) script.push(dispatcher);
  calls.length = 0;
}

export function teardown() {
  process.env.PATH = fx.savedPath;
  script.length = 0;
  calls.length = 0;
  rmSync(fx.root, { recursive: true, force: true });
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
