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

import { reviewFixPrompt } from "../workflows/implement-issue.js";

test("toda etapa que escreve leva a regra de escopo, inclusive a correção de review", () => {
  const prompt = reviewFixPrompt([{ severity: "blocking", issue: "x" }]);
  assert.match(prompt, /Altere apenas arquivos dentro deste repositório/);
  assert.match(prompt, /"severity": "blocking"/);
});
