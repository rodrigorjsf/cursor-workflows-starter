// Regressões da revisão adversarial do implement-issue (lentes: laço TDD, resume e idempotência, segurança e custo).
// Cada teste reproduz um cenário em que a versão anterior entregava "done" com o laço TDD burlado, entregava suíte
// vermelha, vazava segredo, perdia trabalho no resume ou travava.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runTests } from "../workflows/implement-issue.js";
import {
  ALL_CODE,
  ALL_TEST,
  CLEAN_REVIEW,
  PLAN,
  SUB_CODE,
  SUB_TEST,
  fx,
  gh,
  git,
  issue,
  names,
  run,
  setup,
  submit,
  suitePasses,
  teardown,
  worktreeOf,
  write,
} from "./implement-issue.fixture.js";

beforeEach(setup);
afterEach(teardown);

const FAKE_KEY = "crsr_" + "x".repeat(40);
const res = (r: { result?: unknown }) => r.result as any;
const onOrigin = () => {
  try {
    git(join(fx.root, "origin.git"), "rev-parse", "--verify", "--quiet", "refs/heads/wf/issue-7");
    return true;
  } catch {
    return false;
  }
};
const weakTest = 'import { test } from "node:test";\ntest("subtract", () => {});\n';
const missing = (behavior: string) => ({
  findings: [{ kind: "missing", quote: "devolve a - b", note: `falta ${behavior}`, behavior, seam: "math.subtract" }],
  worst: behavior,
});

// ── Laço TDD ──────────────────────────────────────────────────────────────────────────

test("green que move o teste red para fora dos globs é desfeito: tdd-violation, nada no origin", async () => {
  issue(["complexity:low"]);
  fx.handlers["codigo-1"] = (o) => {
    mkdirSync(join(o.local.cwd, "docs"), { recursive: true });
    writeFileSync(join(o.local.cwd, "docs", "sub.js"), readFileSync(join(o.local.cwd, "test", "sub.test.js")));
    rmSync(join(o.local.cwd, "test", "sub.test.js"));
    submit(o, { summary: "movido", filesChanged: [] });
  };
  const r = await run({ openPr: true });
  assert.equal(res(r).status, "tdd-violation", JSON.stringify(res(r)));
  assert.ok(!onOrigin());
});

test("green que reconfigura o runner (scripts do package.json) é desfeito: tdd-violation", async () => {
  issue(["complexity:low"]);
  fx.handlers["codigo-1"] = (o) => {
    write(o, "package.json", '{ "name": "fx", "type": "module", "scripts": { "test": "node --test test/math.test.js" } }\n');
    submit(o, { summary: "só o teste antigo roda", filesChanged: ["package.json"] });
  };
  const r = await run({ testCommand: "npm test --silent" });
  assert.equal(res(r).status, "tdd-violation", JSON.stringify(res(r)));
});

test("green que marca o teste com skip-worktree e o enfraquece é desfeito: tdd-violation", async () => {
  issue(["complexity:low"]);
  fx.handlers["codigo-1"] = (o) => {
    git(o.local.cwd, "update-index", "--skip-worktree", "test/sub.test.js");
    write(o, "test/sub.test.js", weakTest);
    submit(o, { summary: "x", filesChanged: [] });
  };
  const r = await run({});
  assert.equal(res(r).status, "tdd-violation", JSON.stringify(res(r)));
});

test("red que apaga um teste existente é desfeito: tdd-violation", async () => {
  issue(["complexity:low"]);
  fx.handlers["teste-1"] = (o) => {
    rmSync(join(o.local.cwd, "test", "math.test.js"));
    write(o, "test/sub.test.js", SUB_TEST);
    submit(o, { testFile: "test/sub.test.js", testName: "subtract" });
  };
  const r = await run({});
  assert.equal(res(r).status, "tdd-violation", JSON.stringify(res(r)));
  assert.ok(!names().includes("codigo-1"));
});

test("red pode atualizar o teste que fixa o comportamento antigo; green implementa e o run entrega", async () => {
  issue(["complexity:low"], "add passa a aceitar um terceiro número");
  fx.handlers["teste-1"] = (o) => {
    write(o, "test/math.test.js", 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/math.js";\n\ntest("add", () => {\n  assert.equal(add(2, 3, 4), 9);\n});\n');
    submit(o, { testFile: "test/math.test.js", testName: "add" });
  };
  fx.handlers["codigo-1"] = (o) => {
    write(o, "src/math.js", "export function add(a, b, c = 0) {\n  return a + b + c;\n}\n");
    submit(o, { summary: "terceiro parâmetro", filesChanged: ["src/math.js"] });
  };
  const r = await run({});
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
});

test("achado 'missing' de algo que já existe: o teste passa, a etapa confirma e o run entrega com o achado refutado", async () => {
  issue(["complexity:low"]);
  let specRound = 0;
  fx.handlers["review:spec"] = (o) => submit(o, ++specRound === 1 ? missing("add soma") : CLEAN_REVIEW);
  fx.handlers["teste-extra-1"] = (o) => {
    write(o, "test/add2.test.js", 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/math.js";\n\ntest("add de novo", () => {\n  assert.equal(add(1, 1), 2);\n});\n');
    submit(o, { testFile: "test/add2.test.js", testName: "add de novo", alreadySatisfied: true, evidence: "src/math.js já exporta add" });
  };
  const r = await run({ openPr: true });
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
  assert.ok(!names().includes("codigo-extra-1"));
  assert.match(gh().prs[0]!.body, /refutado por teste/);
});

test("runTests: teto de tempo vira 'timeout' e saída grande não vira red", () => {
  const slow = runTests("sleep 5", fx.root, 300) as { ok: boolean; kind?: string };
  assert.equal(slow.kind, "timeout");
  const big = runTests("head -c 2000000 /dev/zero | tr '\\0' a; echo", fx.root);
  assert.equal(big.ok, true);
});

// ── Resume e idempotência ─────────────────────────────────────────────────────────────

test("refactor que quebra a suíte é desfeito; o resume não entrega suíte vermelha", async () => {
  issue(["complexity:low"]);
  let stdRound = 0;
  fx.handlers["review:standards"] = (o) =>
    submit(o, ++stdRound === 1 ? { findings: [{ file: "src/math.js", rule: "Mysterious Name", kind: "hard", note: "nome" }], worst: "nome" } : CLEAN_REVIEW);
  fx.handlers["refatorar-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE.replace("a - b", "a + b"));
    submit(o, { summary: "quebrou", filesChanged: ["src/math.js"] });
  };
  const first = await run({});
  assert.equal(res(first).status, "tests-failed-after-review");
  assert.ok(suitePasses(worktreeOf()), "o worktree volta ao último estado verde");

  fx.handlers["refatorar-1"] = (o) => submit(o, { summary: "nada a mudar", filesChanged: [] });
  const second = await run({}, first.runId);
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));
  assert.ok(suitePasses(worktreeOf()));
});

test("etapa que falha no meio é desfeita: o resume não herda um teste enfraquecido", async () => {
  issue(["complexity:low"]);
  fx.handlers["codigo-1"] = (o) => {
    write(o, "test/sub.test.js", weakTest);
    return { status: "error", error: { message: "queda simulada" } };
  };
  const first = await run({});
  assert.equal(first.status, "failed");

  fx.handlers["codigo-1"] = (o) => submit(o, { summary: "nada", filesChanged: [] });
  fx.handlers["corrigir-1-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE);
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  const second = await run({}, first.runId);
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));
  assert.equal(readFileSync(join(worktreeOf(), "test", "sub.test.js"), "utf8"), SUB_TEST);
  assert.match(readFileSync(join(worktreeOf(), "src", "math.js"), "utf8"), /subtract/);
});

test("queda do processo durante uma etapa: o resume volta ao snapshot de antes dela", async () => {
  issue(["complexity:low"]);
  fx.handlers["codigo-1"] = () => ({ status: "error", error: { message: "queda simulada" } });
  const first = await run({});
  assert.equal(first.status, "failed");
  // O processo "morre" no meio da etapa: o progresso diz que ela está em andamento e o worktree ficou sujo.
  const file = join(fx.repo, ".workflows", "runs", first.runId, "tdd-progress.json");
  const p = JSON.parse(readFileSync(file, "utf8"));
  git(worktreeOf(), "add", "-A");
  p.inFlight = { id: "green:simulada", before: git(worktreeOf(), "write-tree").trim(), resumes: 0 };
  writeFileSync(file, JSON.stringify(p));
  writeFileSync(join(worktreeOf(), "test", "sub.test.js"), weakTest);

  fx.handlers["codigo-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE);
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  const second = await run({}, first.runId);
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));
  assert.equal(readFileSync(join(worktreeOf(), "test", "sub.test.js"), "utf8"), SUB_TEST);
});

test("resume depois de done com fatia extra não pede review novo", async () => {
  issue(["complexity:low"]);
  let specRound = 0;
  fx.handlers["review:spec"] = (o) => submit(o, ++specRound === 1 ? missing("subtractAll") : CLEAN_REVIEW);
  fx.handlers["teste-extra-1"] = (o) => {
    write(o, "test/all.test.js", ALL_TEST);
    submit(o, { testFile: "test/all.test.js", testName: "subtractAll" });
  };
  fx.handlers["codigo-extra-1"] = (o) => {
    write(o, "src/math.js", ALL_CODE);
    submit(o, { summary: "subtractAll", filesChanged: ["src/math.js"] });
  };
  const first = await run({});
  assert.equal(res(first).status, "done", JSON.stringify(res(first)));
  const before = names().length;
  const again = await run({}, first.runId);
  assert.equal(res(again).status, "done");
  assert.deepEqual(names().slice(before), [], "o resume reaproveita o review guardado");
});

test("approveSeams executa o plano mostrado na issue, mesmo com o repositório mudado", async () => {
  issue(["complexity:medium"]);
  const first = await run({});
  assert.equal(res(first).status, "seams-proposed");
  writeFileSync(join(fx.repo, "GLOSSARY.md"), "# Glossário\n");
  git(fx.repo, "add", "-A");
  git(fx.repo, "commit", "-qm", "glossário");
  fx.handlers.planejar = (o) => submit(o, { ...PLAN, slices: [{ behavior: "outra coisa", seam: "math.subtract", testIdea: "x" }] });

  const second = await run({ approveSeams: true }, first.runId);
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));
  assert.equal(names().filter((n) => n === "planejar").length, 1, "o plano aprovado não é recalculado");
});

test("resume com o worktree removido mantém os commits da branch", async () => {
  issue(["complexity:low"]);
  const first = await run({});
  assert.equal(res(first).status, "done");
  git(fx.repo, "worktree", "remove", "--force", worktreeOf());

  const second = await run({}, first.runId);
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));
  assert.match(git(fx.repo, "log", "--oneline", "main..wf/issue-7"), /#7/);
  assert.match(readFileSync(join(worktreeOf(), "src", "math.js"), "utf8"), /subtract/);
});

test("comando de relançamento postado na issue sobrevive a aspas simples nos args", async () => {
  issue(["complexity:medium"]);
  const r = await run({ testCommand: "node --test # it's" });
  assert.equal(res(r).status, "seams-proposed");
  assert.match(gh().comments[0]!, /it'\\''s/);
});

// ── Segurança ─────────────────────────────────────────────────────────────────────────

test("commit feito por agente não escapa da trava de segredos nem chega ao origin", async () => {
  issue(["complexity:low"]);
  fx.handlers["codigo-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE);
    write(o, "auth.json", JSON.stringify({ apiKey: FAKE_KEY }));
    git(o.local.cwd, "add", "-A");
    git(o.local.cwd, "commit", "-qm", "agente commitou");
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  const r = await run({ openPr: true });
  assert.equal(res(r).status, "secret-blocked", JSON.stringify(res(r)));
  assert.ok(!JSON.stringify(res(r)).includes(FAKE_KEY));
  assert.ok(!onOrigin());
  assert.equal(gh().prs.length, 0);
});

test("segredo no plano não vai para o comentário de seams", async () => {
  issue(["complexity:medium"]);
  fx.handlers.planejar = (o) => submit(o, { ...PLAN, seams: [{ ...PLAN.seams[0], why: `use a chave ${FAKE_KEY}` }] });
  const r = await run({});
  assert.equal(res(r).status, "secret-blocked");
  assert.equal(gh().comments.length, 0);
  assert.ok(!JSON.stringify(res(r)).includes(FAKE_KEY));
});

test("segredo no texto do PR bloqueia a entrega antes do push", async () => {
  issue(["complexity:low"]);
  fx.handlers["pr-texto"] = (o) => submit(o, { summary: `chave: ${FAKE_KEY}`, door: "two-way", blastRadius: "local" });
  const r = await run({ openPr: true });
  assert.equal(res(r).status, "secret-blocked");
  assert.equal(gh().prs.length, 0);
  assert.ok(!onOrigin());
});

test("a evidência do PR não leva caminhos locais", async () => {
  issue(["complexity:low"]);
  const r = await run({ openPr: true });
  assert.equal(res(r).status, "done");
  assert.ok(!gh().prs[0]!.body.includes(fx.repo), "o caminho do worktree vira <worktree>");
});

test("approveSeams sem plano proposto neste run (outro runId ou outro --cwd) não executa um plano que ninguém viu", async () => {
  issue(["complexity:medium"]);
  const r = await run({ approveSeams: true });
  assert.equal(res(r).status, "seams-not-proposed", JSON.stringify(res(r)));
  assert.ok(!names().includes("planejar"));
  assert.equal(gh().comments.length, 0);
});
