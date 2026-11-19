// Diretório de estado do runtime no repositório alvo (`.workflows/`): journal, jobs, logs, memo, worktrees.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { errorText } from "./error-text.js";
import { PRIVATE_DIR, PRIVATE_FILE } from "./state-files.js";

/** Per-user directory of the kit (`~/.cursor-workflows`): metrics database, global runs index. `WF_HOME` overrides it (tests, CI). */
export function userDir(): string {
  return process.env.WF_HOME ?? join(homedir(), ".cursor-workflows");
}

export function assertUserDirWritable(): void {
  const dir = userDir();
  const probe = join(dir, `.write-probe-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
    writeFileSync(probe, "", { mode: PRIVATE_FILE });
    rmSync(probe);
  } catch (err) {
    throw new Error(
      `cannot write to the user directory ${dir} (${errorText(err)}); no run was created. The command most likely runs in an agent sandbox, which blocks writes outside the repository: start it with full permissions (outside the sandbox), or point WF_HOME at a writable directory.`,
    );
  }
}

const excludeFiles = new Map<string, string>();

export function ensureExcluded(cwd: string, entry: string): boolean {
  if (!existsSync(join(cwd, ".git"))) return false;
  let exclude = excludeFiles.get(cwd);
  if (!exclude) {
    try {
      exclude = resolve(cwd, execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim()); // once per repo, and bounded
    } catch {
      return false;
    }
    excludeFiles.set(cwd, exclude); // `stateDir` roda a cada gravação de job: o git só é consultado uma vez por repositório
  }
  mkdirSync(dirname(exclude), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!current.split("\n").includes(entry)) appendFileSync(exclude, `${current.endsWith("\n") || !current ? "" : "\n"}${entry}\n`);
  return true;
}

/** Where the repo's run state lives, whether or not it exists: nothing is created. */
export const stateRootIn = (cwd: string): string => join(cwd, ".workflows");

/** A folder of the repo's run state (`.workflows/<parts>`), made when it is not there, for its user alone (`PRIVATE_DIR`): it holds the private source of the repo. */
export function stateDir(cwd: string, ...parts: string[]): string {
  ensureExcluded(cwd, ".workflows/");
  const dir = join(stateRootIn(cwd), ...parts);
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
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

/** A new run id: the workflow's name, with anything but letters, digits, "_" and "-" made a "-" (the id names the run's folder), and a random suffix. */
export function newRunId(workflow: string): string {
  return `${workflow.replace(/[^A-Za-z0-9_-]/g, "-")}-${randomUUID().slice(0, 8)}`;
}
