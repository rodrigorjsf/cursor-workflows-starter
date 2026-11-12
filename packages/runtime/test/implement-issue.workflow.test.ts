// Testes offline do fluxo do implement-issue (tdd → review em 3 eixos → PR). O ambiente (SDK falso, gh falso,
// repositório temporário) está em implement-issue.fixture.ts.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { calls } from "@cursor/sdk";
import { globToRegExp } from "../workflows/implement-issue/tdd.js";
import { PLAN, SUB_CODE, SUB_TEST, fx, gh, git, issue, names, run, setup, submit, teardown, write } from "./implement-issue.fixture.js";

beforeEach(setup);
afterEach(teardown);

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
  assert.match(git(join(fx.root, "origin.git"), "log", "--oneline", "wf/issue-7"), /#7/);

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
  assert.equal(names().filter((n) => n === "planejar").length, 1, "o plano vem do progresso do run");
  assert.equal(gh().comments.length, 1, "o comentário não se repete");
});

test("seams editadas por args replanejam com as seams aprovadas no prompt", async () => {
  issue(["complexity:medium"]);
  let planPrompt = "";
  fx.handlers.planejar = (o, msg) => { planPrompt = msg; submit(o, PLAN); };
  const r = await run({ seams: ["math.subtract(a, b)"] });
  assert.equal((r.result as any).status, "done", JSON.stringify(r.result));
  assert.match(planPrompt, /math\.subtract\(a, b\)/);
  assert.equal(gh().comments.length, 0);
});

test("HIGH: três designers em paralelo e um juiz antes de propor as seams", async () => {
  issue(["complexity:high"]);
  const design = (o: any) => submit(o, { interface: "subtract(a, b)", usage: "subtract(5, 3)", hides: "nada", dependencies: "em processo", tradeoffs: "-" });
  fx.handlers["desenhar:minima"] = design;
  fx.handlers["desenhar:flexivel"] = design;
  fx.handlers["desenhar:comum"] = design;
  fx.handlers.julgar = (o) => submit(o, { ...PLAN, rationale: "a interface mínima basta" });
  const r = await run({});
  assert.equal((r.result as any).status, "seams-proposed");
  assert.deepEqual(names().slice(0, 3).sort(), ["desenhar:comum", "desenhar:flexivel", "desenhar:minima"]);
  assert.equal(names()[3], "julgar");
});

test("a etapa de teste que também implementa: o código descarta o que não é teste, confere o red e segue", async () => {
  // Medido no run real de 2026-11-11 (issue #7): o composer-2.5 implementou junto com o teste nas duas tentativas.
  issue(["complexity:low"]);
  fx.handlers["teste-1"] = (o) => {
    write(o, "test/sub.test.js", SUB_TEST);
    write(o, "src/math.js", SUB_CODE); // implementação junto com o teste
    submit(o, { testFile: "test/sub.test.js", testName: "subtract" });
  };
  let mathAtGreen = "";
  fx.handlers["codigo-1"] = (o) => {
    mathAtGreen = readFileSync(join(o.local.cwd, "src", "math.js"), "utf8");
    write(o, "src/math.js", SUB_CODE);
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  const r = await run({});
  assert.equal((r.result as any).status, "done", JSON.stringify(r.result));
  assert.equal(names().filter((n) => n.startsWith("teste-1")).length, 1, "sem nova tentativa: o teste aproveitado já é red");
  assert.doesNotMatch(mathAtGreen, /subtract/, "a implementação da etapa red foi descartada antes do green");
});

test("teste que já passa sem implementação não é red: uma nova tentativa e depois test-not-red", async () => {
  issue(["complexity:low"]);
  fx.handlers["teste-1"] = (o) => {
    write(o, "test/add2.test.js", 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/math.js";\n\ntest("add de novo", () => {\n  assert.equal(add(1, 1), 2);\n});\n');
    submit(o, { testFile: "test/add2.test.js", testName: "add de novo" });
  };
  const r = await run({});
  assert.equal((r.result as any).status, "test-not-red");
  assert.equal(names().filter((n) => n.startsWith("teste-1")).length, 2);
});

test("a etapa de código que mexe nos testes é refeita uma vez e depois o run para", async () => {
  issue(["complexity:low"]);
  fx.handlers["codigo-1"] = (o) => {
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
  writeFileSync(join(fx.repo, "test", "quebrado.test.js"), 'import { test } from "node:test";\ntest("quebrado", () => { throw new Error("x"); });\n');
  git(fx.repo, "add", "-A");
  git(fx.repo, "commit", "-qm", "teste quebrado");
  const r = await run({});
  assert.equal((r.result as any).status, "baseline-red");
  assert.equal(calls.length, 0);
});

test("review: requisito faltando vira fatia TDD extra e padrão violado vira refactor; depois o re-review limpo entrega", async () => {
  issue(["complexity:low"]);
  let specRound = 0;
  let stdRound = 0;
  fx.handlers["review:spec"] = (o) => {
    specRound++;
    submit(o, specRound === 1
      ? { findings: [{ kind: "missing", quote: "devolve a - b", note: "falta subtract com negativos", behavior: "subtract com negativos", seam: "math.subtract" }], worst: "falta caso negativo" }
      : { findings: [], worst: "" });
  };
  fx.handlers["review:standards"] = (o) => {
    stdRound++;
    submit(o, stdRound === 1
      ? { findings: [{ file: "src/math.js", rule: "Mysterious Name", kind: "hard", note: "nome ruim" }], worst: "nome" }
      : { findings: [], worst: "" });
  };
  fx.handlers["teste-extra-1"] = (o) => {
    write(o, "test/neg.test.js", 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { subtractAll } from "../src/math.js";\n\ntest("subtractAll", () => {\n  assert.equal(subtractAll(10, 3, 2), 5);\n});\n');
    submit(o, { testFile: "test/neg.test.js", testName: "subtractAll" });
  };
  fx.handlers["codigo-extra-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE + "\nexport function subtractAll(a, ...rest) {\n  return rest.reduce((acc, x) => acc - x, a);\n}\n");
    submit(o, { summary: "subtractAll", filesChanged: ["src/math.js"] });
  };
  fx.handlers["refatorar-1"] = (o) => submit(o, { summary: "renomeado", filesChanged: ["src/math.js"] });
  const r = await run({});
  assert.equal((r.result as any).status, "done", JSON.stringify(r.result));
  assert.ok(names().includes("teste-extra-1") && names().includes("codigo-extra-1"));
  assert.ok(names().includes("refatorar-1"));
  assert.ok(names().includes("review:spec:2") && names().includes("review:standards:2"));
  assert.ok(!names().includes("review:security:2"), "só os eixos que bloquearam são revistos");
});

test("review que continua bloqueando depois da rodada de correção encerra com review-blocking", async () => {
  issue(["complexity:low"]);
  fx.handlers["review:security"] = (o) => submit(o, { findings: [{ file: "src/math.js", severity: "blocking", issue: "eval de entrada" }], worst: "eval" });
  fx.handlers["refatorar-1"] = (o) => submit(o, { summary: "tentou", filesChanged: [] });
  const r = await run({});
  assert.equal((r.result as any).status, "review-blocking");
  assert.ok(!names().includes("pr-texto"));
});

test("resume depois de falha na fatia 2 não refaz nem reconfere a fatia 1", async () => {
  issue(["complexity:medium"]);
  const twoSlices = { ...PLAN, slices: [PLAN.slices[0], { behavior: "subtractAll", seam: "math.subtract", testIdea: "subtractAll(10, 3, 2) é 5" }] };
  fx.handlers.planejar = (o) => submit(o, twoSlices);
  fx.handlers["teste-2"] = (o) => {
    write(o, "test/all.test.js", 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { subtractAll } from "../src/math.js";\n\ntest("subtractAll", () => {\n  assert.equal(subtractAll(10, 3, 2), 5);\n});\n');
    submit(o, { testFile: "test/all.test.js", testName: "subtractAll" });
  };
  fx.handlers["codigo-2"] = () => ({ status: "error", error: { message: "queda simulada" } });
  const first = await run({ seams: ["math.subtract"] });
  assert.equal(first.status, "failed");

  fx.handlers["codigo-2"] = (o) => {
    write(o, "src/math.js", SUB_CODE + "\nexport function subtractAll(a, ...rest) {\n  return rest.reduce((acc, x) => acc - x, a);\n}\n");
    submit(o, { summary: "subtractAll", filesChanged: ["src/math.js"] });
  };
  const before = names().length;
  const second = await run({ seams: ["math.subtract"] }, first.runId);
  assert.equal((second.result as any).status, "done", JSON.stringify(second.result));
  const resumed = names().slice(before);
  assert.ok(!resumed.includes("teste-1") && !resumed.includes("codigo-1"), `fatia 1 refeita: ${resumed}`);
  assert.ok(existsSync(join(fx.repo, ".workflows", "runs", first.runId, "tdd-progress.json")));
});

test("globToRegExp: ** atravessa pastas, * não", () => {
  assert.ok(globToRegExp("**/*.test.*").test("test/deep/a.test.ts"));
  assert.ok(globToRegExp("**/*.test.*").test("a.test.js"));
  assert.ok(globToRegExp("test/**").test("test/x/y.js"));
  assert.ok(!globToRegExp("test/*").test("test/x/y.js"));
  assert.ok(!globToRegExp("**/*.test.*").test("src/math.js"));
});

test("o comentário das seams avisa quais fatias ficam fora pelo limite do tier", async () => {
  issue(["complexity:medium"]);
  const slice = (n: number) => ({ behavior: `comportamento ${n}`, seam: "math.subtract", testIdea: `ideia ${n}` });
  fx.handlers.planejar = (o) => submit(o, { ...PLAN, slices: [1, 2, 3, 4, 5].map(slice) });
  const r = await run({});
  assert.equal((r.result as any).status, "seams-proposed");
  const comment = gh().comments[0]!;
  assert.match(comment, /4\. comportamento 4 .*\(deferred/);
  assert.match(comment, /tier MED slice cap \(3 slices\)/);
  assert.doesNotMatch(comment, /3\. comportamento 3 .*\(deferred/);
});

test("planejador e juiz recebem o teto de fatias do tier", async () => {
  issue(["complexity:medium"]);
  let planPrompt = "";
  fx.handlers.planejar = (o, msg) => { planPrompt = msg; submit(o, PLAN); };
  await run({});
  assert.match(planPrompt, /up to 3 slices/);

  issue(["complexity:high"]);
  let judgePrompt = "";
  const design = (o: any) => submit(o, { interface: "i", usage: "u", hides: "h", dependencies: "d", tradeoffs: "t" });
  for (const k of ["desenhar:minima", "desenhar:flexivel", "desenhar:comum"]) fx.handlers[k] = design;
  fx.handlers.julgar = (o, msg) => { judgePrompt = msg; submit(o, PLAN); };
  await run({});
  assert.match(judgePrompt, /up to 5 slices/);
});
