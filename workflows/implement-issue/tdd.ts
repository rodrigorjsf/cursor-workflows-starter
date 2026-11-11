// Peças do laço TDD que o CÓDIGO controla: o que conta como arquivo de teste, quais arquivos uma etapa tocou, a
// suíte de testes e o progresso por fatia (para o resume não refazer nem reconferir fatias concluídas).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** O que conta como arquivo de teste quando o run não informa `testGlobs`. */
export const DEFAULT_TEST_GLOBS = ["**/*.test.*", "**/*.spec.*", "test/**", "tests/**", "**/__tests__/**"];

/** Glob → RegExp: `**` atravessa pastas, `*` e `?` não. Sem `path.matchesGlob`, que é experimental no Node 22.13. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
}

export function isTestFile(path: string, globs: string[] = DEFAULT_TEST_GLOBS): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * Snapshot do estado atual do worktree como uma árvore git (respeita o .gitignore). Comparar dois snapshots diz o
 * que uma etapa tocou, mesmo que o agente tenha rodado `git add`, `stash` ou `commit` no meio.
 */
export function snapshotTree(cwd: string): string {
  git(cwd, "add", "-A");
  return git(cwd, "write-tree").trim();
}

export function changedBetween(cwd: string, before: string, after: string): string[] {
  return git(cwd, "diff", "--name-only", before, after).split("\n").filter(Boolean);
}

/**
 * Roda o comando de teste com o ambiente de quem chamou o workflow. Sem `-l`: um shell de login recarrega o perfil e
 * pode trocar o PATH (medido: o npm do `mise exec` virou outro, quebrado). Sem NODE_TEST_CONTEXT: dentro de um runner
 * de testes, um `node --test` aninhado herda essa variável e sai com 0 mesmo com teste falhando (medido no 22.13 e 22.23).
 */
export function runTests(command: string, cwd: string): { ok: boolean; output: string } {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    return { ok: true, output: execFileSync("bash", ["-c", command], { cwd, env, encoding: "utf8", stdio: "pipe" }).slice(-4000) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}\n${e.stderr ?? ""}`.slice(-4000) };
  }
}

export interface SliceRecord {
  key: string;
  behavior: string;
  seam: string;
  testFile?: string;
  testName?: string;
  /** Saída da suíte com o teste novo falhando (evidência "antes"). */
  red?: string;
  /** Saída da suíte passando depois da implementação (evidência "depois"). */
  green?: string;
  done: boolean;
}

export interface Progress {
  /** Commit do worktree antes de qualquer mudança: base do diff do review. */
  baseCommit?: string;
  baselineGreen?: boolean;
  slices: SliceRecord[];
}

/** Progresso por run, em `.workflows/runs/<runId>/`, fora da árvore versionada. */
export class ProgressStore {
  readonly file: string;
  data: Progress;
  constructor(cwd: string, runId: string) {
    this.file = join(cwd, ".workflows", "runs", runId, "tdd-progress.json");
    this.data = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Progress) : { slices: [] };
  }
  slice(key: string): SliceRecord | undefined {
    return this.data.slices.find((s) => s.key === key);
  }
  upsert(rec: SliceRecord): void {
    const i = this.data.slices.findIndex((s) => s.key === rec.key);
    if (i >= 0) this.data.slices[i] = rec;
    else this.data.slices.push(rec);
    this.save();
  }
  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
