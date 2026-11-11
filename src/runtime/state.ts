// Diretório de estado do runtime no repositório alvo (`.workflows/`): journal, jobs, logs, memo, worktrees.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Garante `.workflows/` fora do git no repositório alvo (via .git/info/exclude, sem tocar no .gitignore). */
export function ensureIgnored(cwd: string): void {
  const info = join(cwd, ".git", "info");
  if (!existsSync(join(cwd, ".git"))) return;
  mkdirSync(info, { recursive: true });
  const exclude = join(info, "exclude");
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!current.split("\n").includes(".workflows/")) appendFileSync(exclude, `${current.endsWith("\n") || !current ? "" : "\n"}.workflows/\n`);
}

export function stateDir(cwd: string, ...parts: string[]): string {
  ensureIgnored(cwd);
  const dir = join(cwd, ".workflows", ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}
