// Testes offline do fluxo do implement-issue (tdd → review em 3 eixos → PR), com SDK falso, `gh` falso no PATH,
// repositório git temporário e `node --test` de verdade como comando de teste.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { calls, script } from "@cursor/sdk";
import { runWorkflow } from "../src/runtime/engine.js";
import implementIssue from "../workflows/implement-issue.js";
import { globToRegExp } from "../workflows/implement-issue/tdd.js";

type Handler = (o: any, msg: string) => unknown;

let root: string;
let repo: string;
let ghState: string;
let savedPath: string | undefined;
let handlers: Record<string, Handler>;

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
const labelOf = (o: any) => String(o.name).replace(/^implement-issue:/, "");
const names = () => calls.map(labelOf);
const submit = (o: any, v: unknown) => o.local.customTools.submit_result.execute(v, {});
const write = (o: any, file: string, content: string) => {
  const p = join(o.local.cwd, file);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
};
const gh = () => JSON.parse(readFileSync(ghState, "utf8")) as { comments: string[]; prs: Array<{ url: string; body: string }>; calls: string[][] };

const FAKE_GH = `#!/usr/bin/env node
const fs = require("fs");
const f = process.env.FAKE_GH_STATE;
const st = JSON.parse(fs.readFileSync(f, "utf8"));
const a = process.argv.slice(2);
st.calls.push(a);
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

function issue(labels: string[], title = "Add subtract(a, b)") {
  writeFileSync(
    ghState,
    JSON.stringify({ issue: { number: 7, title, body: "Exportar `subtract(a, b)` em src/math.js, que devolve a - b.", labels: labels.map((name) => ({ name })) }, comments: [], prs: [], calls: [] }),
  );
}

// Respostas padrão de cada etapa; cada teste sobrescreve só o que precisa.
const SUB_TEST = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { subtract } from "../src/math.js";\n\ntest("subtract", () => {\n  assert.equal(subtract(5, 3), 2);\n});\n';
const SUB_CODE = "export function add(a, b) {\n  return a + b;\n}\n\nexport function subtract(a, b) {\n  return a - b;\n}\n";
const PLAN = {
  seams: [{ name: "math.subtract", interface: "subtract(a, b): number", why: "comportamento pedido pela issue" }],
  slices: [{ behavior: "subtract devolve a diferença", seam: "math.subtract", testIdea: "subtract(5, 3) é 2" }],
  testCommand: "node --test",
};
function defaults(): Record<string, Handler> {
  return {
    "teste-1": (o) => { write(o, "test/sub.test.js", SUB_TEST); submit(o, { testFile: "test/sub.test.js", testName: "subtract" }); },
    "codigo-1": (o) => { write(o, "src/math.js", SUB_CODE); submit(o, { summary: "subtract exportado", filesChanged: ["src/math.js"] }); },
    planejar: (o) => submit(o, PLAN),
    "review:standards": (o) => submit(o, { findings: [], worst: "" }),
    "review:spec": (o) => submit(o, { findings: [], worst: "" }),
    "review:security": (o) => submit(o, { findings: [], worst: "" }),
    "pr-texto": (o) => submit(o, { summary: "```diff\n+export function subtract(a, b)\n```", door: "two-way", blastRadius: "local" }),
  };
}
const dispatcher = (o: any, msg: string) => {
  const label = labelOf(o);
  const h = handlers[label] ?? handlers[label.replace(/:\d+$/, "")];
  if (!h) throw new Error(`etapa sem resposta no teste: ${label}`);
  const r = h(o, msg);
  return r && typeof r === "object" ? r : { status: "finished", result: "ok" };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-ii-"));
  repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(repo, "package.json"), '{ "name": "fx", "type": "module" }\n');
  writeFileSync(join(repo, "src", "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  writeFileSync(join(repo, "test", "math.test.js"), 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/math.js";\n\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n});\n');
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "teste");
  git(repo, "config", "user.email", "teste@example.invalid");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(root, "init", "-q", "--bare", "origin.git");
  git(repo, "remote", "add", "origin", join(root, "origin.git"));
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  ghState = join(root, "gh.json");
  process.env.FAKE_GH_STATE = ghState;
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  handlers = defaults();
  for (let i = 0; i < 200; i++) script.push(dispatcher);
  calls.length = 0;
});

afterEach(() => {
  process.env.PATH = savedPath;
  script.length = 0;
  calls.length = 0;
  rmSync(root, { recursive: true, force: true });
});

const run = (args: Record<string, unknown>, runId?: string) =>
  runWorkflow(implementIssue, { issue: 7, testCommand: "node --test", ...args } as any, { cwd: repo, runId });

test("LOW: red → green, 3 eixos de review, PR com evidência red → green; resume não chama agentes nem duplica o PR", async () => {
  issue(["complexity:low"]);
  const r = await run({ openPr: true });
  assert.equal(r.status, "finished", r.error);
  assert.equal((r.result as any).status, "done");
  assert.deepEqual(names().slice(0, 2), ["teste-1", "codigo-1"]);
  assert.deepEqual(names().slice(2, 5).sort(), ["review:security:1", "review:spec:1", "review:standards:1"]);
  assert.equal(names()[5], "pr-texto");
  const { prs } = gh();
  assert.equal(prs.length, 1);
  assert.match(prs[0]!.body, /^Closes #7/m);
  assert.match(prs[0]!.body, /## Summary/);
  assert.match(prs[0]!.body, /## Evidence/);
  assert.match(prs[0]!.body, /\*\*Before:\*\*/);
  assert.match(prs[0]!.body, /\*\*After:\*\*/);
  assert.match(prs[0]!.body, /## Merge Danger/);
  assert.match(prs[0]!.body, /two-way/);
  assert.match(git(join(root, "origin.git"), "log", "--oneline", "wf/issue-7"), /#7/);

  const created = calls.length;
  const again = await run({ openPr: true }, r.runId);
  assert.equal((again.result as any).status, "done");
  assert.equal(calls.length, created, "resume depois de done não pode criar agentes");
  assert.equal(gh().prs.length, 1);
});

test("MED: primeiro run propõe as seams na issue e para; o resume com approveSeams reaproveita o plano", async () => {
  issue(["complexity:medium"]);
  const first = await run({});
  assert.equal((first.result as any).status, "seams-proposed");
  assert.deepEqual(names(), ["planejar"]);
  const comments = gh().comments;
  assert.equal(comments.length, 1);
  assert.match(comments[0]!, /math\.subtract/);
  assert.match(comments[0]!, new RegExp(`--resume ${first.runId}`));
  assert.match(comments[0]!, /approveSeams/);

  const second = await run({ approveSeams: true }, first.runId);
  assert.equal((second.result as any).status, "done", JSON.stringify(second.result));
  assert.equal(names().filter((n) => n === "planejar").length, 1, "o plano vem do journal");
  assert.equal(gh().comments.length, 1, "o comentário não se repete");
});

test("seams editadas por args replanejam com as seams aprovadas no prompt", async () => {
  issue(["complexity:medium"]);
  let planPrompt = "";
  handlers.planejar = (o, msg) => { planPrompt = msg; submit(o, PLAN); };
  const r = await run({ seams: ["math.subtract(a, b)"] });
  assert.equal((r.result as any).status, "done", JSON.stringify(r.result));
  assert.match(planPrompt, /math\.subtract\(a, b\)/);
  assert.equal(gh().comments.length, 0);
});

test("HIGH: três designers em paralelo e um juiz antes de propor as seams", async () => {
  issue(["complexity:high"]);
  const design = (o: any) => submit(o, { interface: "subtract(a, b)", usage: "subtract(5, 3)", hides: "nada", dependencies: "em processo", tradeoffs: "-" });
  handlers["desenhar:minima"] = design;
  handlers["desenhar:flexivel"] = design;
  handlers["desenhar:comum"] = design;
  handlers.julgar = (o) => submit(o, { ...PLAN, rationale: "a interface mínima basta" });
  const r = await run({});
  assert.equal((r.result as any).status, "seams-proposed");
  assert.deepEqual(names().slice(0, 3).sort(), ["desenhar:comum", "desenhar:flexivel", "desenhar:minima"]);
  assert.equal(names()[3], "julgar");
});

test("a etapa de teste que mexe em arquivo que não é de teste é refeita uma vez e depois o run para", async () => {
  issue(["complexity:low"]);
  handlers["teste-1"] = (o) => {
    write(o, "test/sub.test.js", SUB_TEST);
    write(o, "src/math.js", SUB_CODE); // implementação junto com o teste: viola o red
    submit(o, { testFile: "test/sub.test.js", testName: "subtract" });
  };
  const r = await run({});
  assert.equal((r.result as any).status, "tdd-violation");
  assert.equal(names().filter((n) => n.startsWith("teste-1")).length, 2);
  assert.ok(!names().includes("codigo-1"));
});

test("teste que já passa sem implementação não é red: uma nova tentativa e depois test-not-red", async () => {
  issue(["complexity:low"]);
  handlers["teste-1"] = (o) => {
    write(o, "test/add2.test.js", 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/math.js";\n\ntest("add de novo", () => {\n  assert.equal(add(1, 1), 2);\n});\n');
    submit(o, { testFile: "test/add2.test.js", testName: "add de novo" });
  };
  const r = await run({});
  assert.equal((r.result as any).status, "test-not-red");
  assert.equal(names().filter((n) => n.startsWith("teste-1")).length, 2);
});

test("a etapa de código que mexe nos testes é refeita uma vez e depois o run para", async () => {
  issue(["complexity:low"]);
  handlers["codigo-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE);
    write(o, "test/sub.test.js", "// teste apagado para passar\n");
    submit(o, { summary: "x", filesChanged: ["src/math.js", "test/sub.test.js"] });
  };
  const r = await run({});
  assert.equal((r.result as any).status, "tdd-violation");
  assert.equal(names().filter((n) => n.startsWith("codigo-1")).length, 2);
});

test("suíte vermelha antes da primeira fatia: baseline-red, sem chamar agentes", async () => {
  issue(["complexity:low"]);
  writeFileSync(join(repo, "test", "quebrado.test.js"), 'import { test } from "node:test";\ntest("quebrado", () => { throw new Error("x"); });\n');
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "teste quebrado");
  const r = await run({});
  assert.equal((r.result as any).status, "baseline-red");
  assert.equal(calls.length, 0);
});

test("review: requisito faltando vira fatia TDD extra e padrão violado vira refactor; depois o re-review limpo entrega", async () => {
  issue(["complexity:low"]);
  let specRound = 0;
  let stdRound = 0;
  handlers["review:spec"] = (o) => {
    specRound++;
    submit(o, specRound === 1
      ? { findings: [{ kind: "missing", quote: "devolve a - b", note: "falta subtract com negativos", behavior: "subtract com negativos", seam: "math.subtract" }], worst: "falta caso negativo" }
      : { findings: [], worst: "" });
  };
  handlers["review:standards"] = (o) => {
    stdRound++;
    submit(o, stdRound === 1
      ? { findings: [{ file: "src/math.js", rule: "Mysterious Name", kind: "hard", note: "nome ruim" }], worst: "nome" }
      : { findings: [], worst: "" });
  };
  handlers["teste-extra-1"] = (o) => {
    write(o, "test/neg.test.js", 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { subtractAll } from "../src/math.js";\n\ntest("subtractAll", () => {\n  assert.equal(subtractAll(10, 3, 2), 5);\n});\n');
    submit(o, { testFile: "test/neg.test.js", testName: "subtractAll" });
  };
  handlers["codigo-extra-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE + "\nexport function subtractAll(a, ...rest) {\n  return rest.reduce((acc, x) => acc - x, a);\n}\n");
    submit(o, { summary: "subtractAll", filesChanged: ["src/math.js"] });
  };
  handlers["refatorar-1"] = (o) => submit(o, { summary: "renomeado", filesChanged: ["src/math.js"] });
  const r = await run({});
  assert.equal((r.result as any).status, "done", JSON.stringify(r.result));
  assert.ok(names().includes("teste-extra-1") && names().includes("codigo-extra-1"));
  assert.ok(names().includes("refatorar-1"));
  assert.ok(names().includes("review:spec:2") && names().includes("review:standards:2"));
  assert.ok(!names().includes("review:security:2"), "só os eixos que bloquearam são revistos");
});

test("review que continua bloqueando depois da rodada de correção encerra com review-blocking", async () => {
  issue(["complexity:low"]);
  handlers["review:security"] = (o) => submit(o, { findings: [{ file: "src/math.js", severity: "blocking", issue: "eval de entrada" }], worst: "eval" });
  handlers["refatorar-1"] = (o) => submit(o, { summary: "tentou", filesChanged: [] });
  const r = await run({});
  assert.equal((r.result as any).status, "review-blocking");
  assert.ok(!names().includes("pr-texto"));
});

test("resume depois de falha na fatia 2 não refaz nem reconfere a fatia 1", async () => {
  issue(["complexity:medium"]);
  const twoSlices = { ...PLAN, slices: [PLAN.slices[0], { behavior: "subtractAll", seam: "math.subtract", testIdea: "subtractAll(10, 3, 2) é 5" }] };
  handlers.planejar = (o) => submit(o, twoSlices);
  handlers["teste-2"] = (o) => {
    write(o, "test/all.test.js", 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { subtractAll } from "../src/math.js";\n\ntest("subtractAll", () => {\n  assert.equal(subtractAll(10, 3, 2), 5);\n});\n');
    submit(o, { testFile: "test/all.test.js", testName: "subtractAll" });
  };
  handlers["codigo-2"] = () => ({ status: "error", error: { message: "queda simulada" } });
  const first = await run({ seams: ["math.subtract"] });
  assert.equal(first.status, "failed");

  handlers["codigo-2"] = (o) => {
    write(o, "src/math.js", SUB_CODE + "\nexport function subtractAll(a, ...rest) {\n  return rest.reduce((acc, x) => acc - x, a);\n}\n");
    submit(o, { summary: "subtractAll", filesChanged: ["src/math.js"] });
  };
  const before = names().length;
  const second = await run({ seams: ["math.subtract"] }, first.runId);
  assert.equal((second.result as any).status, "done", JSON.stringify(second.result));
  const resumed = names().slice(before);
  assert.ok(!resumed.includes("teste-1") && !resumed.includes("codigo-1"), `fatia 1 refeita: ${resumed}`);
  assert.ok(existsSync(join(repo, ".workflows", "runs", first.runId, "tdd-progress.json")));
});

test("globToRegExp: ** atravessa pastas, * não", () => {
  assert.ok(globToRegExp("**/*.test.*").test("test/deep/a.test.ts"));
  assert.ok(globToRegExp("**/*.test.*").test("a.test.js"));
  assert.ok(globToRegExp("test/**").test("test/x/y.js"));
  assert.ok(!globToRegExp("test/*").test("test/x/y.js"));
  assert.ok(!globToRegExp("**/*.test.*").test("src/math.js"));
});
