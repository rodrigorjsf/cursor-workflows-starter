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
      exclude = resolve(cwd, execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim()); // once per repo, and bounded
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

/**
 * Is `id` a plain name: letters, digits, "_" and "-" only? A job id, a run id or a lock name that comes from outside (the
 * chat, the command line) becomes a file or folder name under `.workflows/`: one that is not plain could walk out of it
 * (`../`). Every place that turns such an id into a path checks it with this.
 */
export function isPlainName(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);
}

/** `id`, when it is a plain name (`isPlainName`); otherwise throws `invalid <what> "<id>"`. */
export function plainName(id: string, what: string): string {
  if (!isPlainName(id)) throw new Error(`invalid ${what} ${JSON.stringify(id)}: letters, digits, "_" and "-" only (it becomes a file name)`);
  return id;
}
