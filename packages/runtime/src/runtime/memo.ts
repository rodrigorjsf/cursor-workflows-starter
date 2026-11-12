// Cache de resultado entre runs (memo) para etapas sem efeitos.
//
// O Cursor SDK não expõe controle de prompt caching: o cache do provedor é automático e só aparece
// como `cacheReadTokens`/`cacheWriteTokens` no uso. A economia que ESTE runtime controla é não chamar
// o modelo quando a resposta já é conhecida. Um resultado é reaproveitado quando coincidem:
//   - a etapa: prompt, modelo, schema, tools e camadas de contexto;
//   - o estado do repositório: HEAD + hash das mudanças locais (staged, unstaged e arquivos novos).
// Mudou um arquivo, mudou a chave. Por isso só vale para etapas de leitura.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolName } from "@cursor/sdk";
import { stateDir } from "./state.js";

/** Tools que não alteram o repositório nem o mundo externo. */
export const READ_ONLY_TOOLS: readonly ToolName[] = ["read", "grep", "glob", "ls", "semSearch", "readLints", "readTodos"];

export function isReadOnly(tools: readonly ToolName[] | undefined): boolean {
  return tools !== undefined && tools.every((t) => READ_ONLY_TOOLS.includes(t));
}

/** Estado do repositório em `cwd`, ou undefined se não for um repositório git. */
export function repoState(cwd: string): string | undefined {
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const head = git("rev-parse", "HEAD").trim();
    const hash = createHash("sha256").update(git("diff", "HEAD", "--binary"));
    // Arquivos novos (não rastreados) entram pelo conteúdo. `.workflows/` fica fora via .git/info/exclude.
    for (const file of git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean).sort()) {
      hash.update(file).update("\0").update(readFileSync(join(cwd, file)));
    }
    const dirty = hash.digest("hex");
    return `${head}:${dirty}`;
  } catch {
    return undefined;
  }
}

export class MemoStore {
  private readonly dir: string;
  constructor(cwd: string) {
    this.dir = stateDir(cwd, "memo");
  }
  key(stepFingerprint: unknown, state: string): string {
    return createHash("sha256").update(JSON.stringify(stepFingerprint)).update("\0").update(state).digest("hex");
  }
  get(key: string): unknown | undefined {
    const file = join(this.dir, `${key}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { result: unknown }).result : undefined;
  }
  set(key: string, result: unknown): void {
    writeFileSync(join(this.dir, `${key}.json`), JSON.stringify({ result }));
  }
}
