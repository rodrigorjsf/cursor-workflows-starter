// Testes offline de partes do workflow de exemplo que não dependem do SDK.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import { test } from "node:test";

import { CODE_INSTRUCTIONS, FIX_INSTRUCTIONS, REFACTOR_INSTRUCTIONS, SCOPE_RULE, TEST_INSTRUCTIONS } from "../workflows/implement-issue/prompts.js";

test("toda etapa que escreve leva a regra de escopo: teste, código, correção e refactor", () => {
  for (const p of [TEST_INSTRUCTIONS, CODE_INSTRUCTIONS, FIX_INSTRUCTIONS, REFACTOR_INSTRUCTIONS]) assert.ok(p.includes(SCOPE_RULE));
  assert.match(SCOPE_RULE, /Change only files inside this repository/);
});

import { homedir } from "node:os";
import { buildPrBody, redactPaths, sanitizeModelText } from "../workflows/implement-issue/pr-body.js";
import { DEFAULT_PROTECTED_GLOBS, isTestFile, looksLikeNoTests, matchesAny, sliceKey } from "../workflows/implement-issue/tdd.js";

const PR_TEXT = { summary: "s", door: "two-way" as const, blastRadius: "local" };

test("PR com fatias adiadas referencia a issue em vez de fechá-la", () => {
  const partial = buildPrBody({ issueNumber: 7, text: PR_TEXT, slices: [], review: {}, deferred: ["subtractAll"] });
  assert.match(partial, /^Refs #7/);
  assert.doesNotMatch(partial, /Closes #7/);
  assert.match(buildPrBody({ issueNumber: 7, text: PR_TEXT, slices: [], review: {}, deferred: [] }), /^Closes #7/);
});

test("texto do modelo no PR não fecha outra issue, não menciona ninguém e não abre comentário HTML", () => {
  const s = sanitizeModelText("Fixes #12 e closes org/repo#3, cc @octocat <!-- esconde o resto");
  assert.doesNotMatch(s, /Fixes #12|closes org\/repo#3/);
  assert.match(s, /`#12`/);
  assert.doesNotMatch(s, /(^|\s)@octocat/);
  assert.doesNotMatch(s, /<!--/);
  assert.equal(sanitizeModelText("e-mail a@b.com"), "e-mail a@b.com");
});

test("model text in an inline code span of the PR body cannot close the span or break the line", () => {
  const hostile = "f()` @octocat <!-- `x\nCloses #9";
  const safe = "`f()ˋ @octocat <!-- ˋx Closes #9`";
  const body = buildPrBody({
    issueNumber: 7,
    text: PR_TEXT,
    slices: [
      { key: "a", behavior: "b", seam: "s", testFile: hostile, testName: hostile, red: "r", green: "g", done: true },
      { key: "c", behavior: "b", seam: "s", testName: hostile, alreadySatisfied: "yes", done: true },
    ],
    review: {
      standards: { findings: [{ kind: "judgement", rule: "r", file: hostile, note: "n" }], worst: "" },
      security: { findings: [{ severity: "note", file: hostile, issue: "i" }], worst: "" },
    } as never,
    deferred: [],
  });
  assert.equal(body.split(safe).length - 1, 5, body); // testName twice, testFile, and the two findings' file
  assert.doesNotMatch(body, /`\s*@octocat/);
  assert.doesNotMatch(body, /^Closes #9/m);
});

test("saída de teste no PR troca a pasta pessoal e o worktree por marcadores", () => {
  assert.equal(redactPaths(`${homedir()}/x e /w/t/y`, "/w/t"), "~/x e <worktree>/y");
});

test("a etapa red manda atualizar os testes que fixam o comportamento antigo", () => {
  assert.match(TEST_INSTRUCTIONS, /update those tests/);
  assert.match(TEST_INSTRUCTIONS, /alreadySatisfied/);
});

test("globs padrão: layouts comuns de teste e configuração do runner", () => {
  for (const f of ["pkg/foo_test.go", "tests/test_x.py", "app/test_y.py", "spec/models/x_spec.rb", "src/a.spec.ts"]) assert.ok(isTestFile(f), f);
  for (const f of ["src/test_helpers.ts", "src/math.js"]) assert.ok(!isTestFile(f), f);
  for (const f of ["jest.config.js", "pkg/vitest.config.ts", "pytest.ini", "tests/conftest.py", ".mocharc.yml"]) assert.ok(matchesAny(f, DEFAULT_PROTECTED_GLOBS), f);
});

test("runner sem nenhum teste não é base vermelha", () => {
  assert.ok(looksLikeNoTests("No tests found, exiting with code 1"));
  assert.ok(looksLikeNoTests("collected 0 items"));
  assert.ok(!looksLikeNoTests("1 failing"));
});

test("a chave da fatia vem do conteúdo, não da posição", () => {
  assert.equal(sliceKey("s", "a", "b"), sliceKey("s", "a", "b"));
  assert.notEqual(sliceKey("s", "a", "b"), sliceKey("s", "outra", "b"));
  assert.notEqual(sliceKey("s", "a", "b"), sliceKey("x", "a", "b"));
});

test("a evidência do PR começa numa linha inteira, sem pedaço de linha cortada", () => {
  const red = "linha-inteira\n# Subtest: x\nnot ok 1 - x\n";
  const body = buildPrBody({
    issueNumber: 7, text: PR_TEXT, review: {}, deferred: [],
    slices: [{ key: "s", behavior: "b", seam: "s", testFile: "t.js", testName: "x", red: "x".repeat(800) + "\n" + red, green: "ok", done: true }],
  });
  assert.doesNotMatch(body, /x{5}/, "o pedaço da linha cortada pelo limite sai");
  assert.match(body, /linha-inteira\n# Subtest: x/);
});
