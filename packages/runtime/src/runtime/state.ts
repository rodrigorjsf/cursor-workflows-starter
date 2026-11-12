// Diretório de estado do runtime no repositório alvo (`.workflows/`): journal, jobs, logs, memo, worktrees.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Per-user directory of the kit (`~/.cursor-workflows`): metrics database, global runs index. `WF_HOME` overrides it (tests, CI). */
export function userDir(): string {
  return process.env.WF_HOME ?? join(homedir(), ".cursor-workflows");
}

const excludeFiles = new Map<string, string>();

/**
 * Garante `.workflows/` fora do git no repositório alvo (via info/exclude, sem tocar no .gitignore). Em um worktree
 * ligado ou submódulo o `.git` é um arquivo: é o git que diz onde está o `info/exclude` (`--git-path`).
 */
export function ensureIgnored(cwd: string): void {
  if (!existsSync(join(cwd, ".git"))) return;
  let exclude = excludeFiles.get(cwd);
  if (!exclude) {
    try {
      exclude = resolve(cwd, execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    } catch {
      return; // sem git instalado ou .git inválido: nada a proteger
    }
    excludeFiles.set(cwd, exclude); // `stateDir` roda a cada gravação de job: o git só é consultado uma vez por repositório
  }
  mkdirSync(dirname(exclude), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!current.split("\n").includes(".workflows/")) appendFileSync(exclude, `${current.endsWith("\n") || !current ? "" : "\n"}.workflows/\n`);
}

export function stateDir(cwd: string, ...parts: string[]): string {
  ensureIgnored(cwd);
  const dir = join(cwd, ".workflows", ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}
