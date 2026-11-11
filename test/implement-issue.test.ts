// Testes offline de partes do workflow de exemplo que não dependem do SDK.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTests } from "../workflows/implement-issue.js";

test("runTests usa o PATH de quem chamou, não o do perfil de login", () => {
  // Medido em 2026-11-11: `bash -lc` recarregava o perfil, trocava o npm do `mise exec` por outro quebrado, e o
  // agente de correção foi "consertar" um arquivo fora do repositório.
  const dir = mkdtempSync(join(tmpdir(), "wf-runtests-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "npm"), "#!/bin/sh\necho npm-de-quem-chamou\n");
  chmodSync(join(bin, "npm"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const r = runTests("npm test", dir);
    assert.equal(r.ok, true);
    assert.match(r.output, /npm-de-quem-chamou/);
  } finally {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

import { execFileSync } from "node:child_process";
import { findStagedSecret } from "../workflows/implement-issue.js";

function stagedRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-secret-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git("add", "-A");
  return dir;
}

test("trava de segredos: bloqueia auth.json, .env, chaves crsr_/sk- e a chave salva, sem repetir o segredo", () => {
  const key = "crsr_" + "a".repeat(40);
  const cases: Array<[Record<string, string>, string | undefined, RegExp]> = [
    [{ "copia/auth.json": '{"apiKey":"x"}' }, undefined, /auth\.json/],
    [{ ".env.local": "TOKEN=1" }, undefined, /\.env/],
    [{ "src/a.js": `const k = "${key}";\n` }, undefined, /crsr_/],
    [{ "src/b.js": `const k = "sk-${"b".repeat(30)}";\n` }, undefined, /sk-/],
    [{ "src/c.js": "const k = 'segredo-salvo-1234567890';\n" }, "segredo-salvo-1234567890", /chave salva/],
  ];
  for (const [files, saved, rule] of cases) {
    const dir = stagedRepo(files);
    try {
      const hit = findStagedSecret(dir, saved ? [saved] : []);
      assert.ok(hit, `deveria bloquear ${Object.keys(files)[0]}`);
      assert.match(hit!, rule);
      assert.ok(!hit!.includes(key) && !(saved && hit!.includes(saved)), "o motivo não pode conter o segredo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const clean = stagedRepo({ "src/math.js": "export const subtract = (a, b) => a - b;\n" });
  try {
    assert.equal(findStagedSecret(clean, []), undefined);
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }
});

import { CODE_INSTRUCTIONS, FIX_INSTRUCTIONS, REFACTOR_INSTRUCTIONS, SCOPE_RULE, TEST_INSTRUCTIONS } from "../workflows/implement-issue/prompts.js";

test("toda etapa que escreve leva a regra de escopo: teste, código, correção e refactor", () => {
  for (const p of [TEST_INSTRUCTIONS, CODE_INSTRUCTIONS, FIX_INSTRUCTIONS, REFACTOR_INSTRUCTIONS]) assert.ok(p.includes(SCOPE_RULE));
  assert.match(SCOPE_RULE, /Altere apenas arquivos dentro deste repositório/);
});

test("runTests não se engana com node --test aninhado (NODE_TEST_CONTEXT do runner)", () => {
  // Medido: dentro de um runner, `node --test` herda NODE_TEST_CONTEXT=child-v8 e sai com 0 mesmo com teste falhando.
  const dir = mkdtempSync(join(tmpdir(), "wf-nested-"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "a.test.mjs"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("falha", () => assert.equal(1, 2));\n');
  try {
    assert.equal(runTests("node --test", dir).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { homedir } from "node:os";
import { buildPrBody, redactPaths, sanitizeModelText } from "../workflows/implement-issue/pr-body.js";
import { TEST_INSTRUCTIONS } from "../workflows/implement-issue/prompts.js";
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

test("saída de teste no PR troca a pasta pessoal e o worktree por marcadores", () => {
  assert.equal(redactPaths(`${homedir()}/x e /w/t/y`, "/w/t"), "~/x e <worktree>/y");
});

test("a etapa red manda atualizar os testes que fixam o comportamento antigo", () => {
  assert.match(TEST_INSTRUCTIONS, /atualize esses testes/);
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
