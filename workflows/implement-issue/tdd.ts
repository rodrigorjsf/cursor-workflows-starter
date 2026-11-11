// Peças do laço TDD que o CÓDIGO controla: o que conta como arquivo de teste e como configuração do runner, quais
// arquivos uma etapa tocou, a suíte de testes e o progresso por fatia (para o resume não refazer nem reconferir o
// que já passou, e para desfazer o que uma etapa interrompida deixou pela metade).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** O que conta como arquivo de teste quando o run não informa `testGlobs`. */
export const DEFAULT_TEST_GLOBS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/test_*.py",
  "test/**",
  "tests/**",
  "spec/**",
  "**/__tests__/**",
];

/**
 * Configuração do runner de testes: as etapas de código, correção e refactor não podem tocá-la, senão desligariam o
 * teste red sem implementar nada (`protectedGlobs` troca a lista). O `package.json` é tratado à parte: só os campos
 * que mudam o que roda nos testes são protegidos (ver `runnerConfigChanged`).
 */
export const DEFAULT_PROTECTED_GLOBS = [
  "**/jest.config.*",
  "**/vitest.config.*",
  "**/vitest.workspace.*",
  "**/.mocharc*",
  "**/karma.conf.*",
  "**/playwright.config.*",
  "**/pytest.ini",
  "**/conftest.py",
  "**/tox.ini",
  "**/.nycrc*",
];

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

export const matchesAny = (path: string, globs: string[]) => globs.some((g) => globToRegExp(g).test(path));
export const isTestFile = (path: string, globs: string[] = DEFAULT_TEST_GLOBS) => matchesAny(path, globs);

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * Snapshot do estado atual do worktree como uma árvore git (respeita o .gitignore). Comparar dois snapshots diz o
 * que uma etapa tocou, mesmo que o agente tenha rodado `git add`, `stash` ou `commit` no meio. Antes, desliga
 * `skip-worktree` e `assume-unchanged`: com eles, um arquivo editado some do `git add -A` (medido no review).
 */
export function snapshotTree(cwd: string): string {
  const flagged = git(cwd, "ls-files", "-v")
    .split("\n")
    .filter((l) => /^(S |[a-z] )/.test(l))
    .map((l) => l.slice(2));
  if (flagged.length) git(cwd, "update-index", "--no-skip-worktree", "--no-assume-unchanged", "--", ...flagged);
  git(cwd, "add", "-A");
  return git(cwd, "write-tree").trim();
}

export interface Change { path: string; status: string }

/** O que mudou entre dois snapshots. `--no-renames`: um arquivo movido aparece como removido E criado. */
export function changesBetween(cwd: string, before: string, after: string): Change[] {
  return git(cwd, "diff", "--no-renames", "--name-status", before, after)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [status, path] = l.split("\t");
      return { status: status!, path: path! };
    });
}

export const changedBetween = (cwd: string, before: string, after: string) => changesBetween(cwd, before, after).map((c) => c.path);

/** Desfaz o que uma etapa mudou: volta índice e arquivos ao snapshot (remove os novos, restaura os alterados). */
export function revertTo(cwd: string, tree: string): void {
  git(cwd, "read-tree", "--reset", "-u", tree);
}

/** Volta só estes caminhos ao snapshot: os que existiam são restaurados, os criados depois são apagados. */
export function restorePaths(cwd: string, tree: string, paths: string[]): void {
  if (!paths.length) return;
  const inTree = new Set(git(cwd, "ls-tree", "-r", "--name-only", tree, "--", ...paths).split("\n").filter(Boolean));
  const existed = paths.filter((p) => inTree.has(p));
  if (existed.length) git(cwd, "checkout", tree, "--", ...existed);
  for (const p of paths.filter((x) => !inTree.has(x))) {
    git(cwd, "rm", "-q", "-f", "--cached", "--ignore-unmatch", "--", p);
    rmSync(join(cwd, p), { force: true });
  }
}

const PKG_RUNNER_FIELDS = ["jest", "vitest", "mocha", "ava", "c8", "nyc"];

/** O `package.json` mudou o que roda nos testes? Compara os scripts e os campos de configuração de runners. */
export function runnerConfigChanged(cwd: string, before: string, after: string): boolean {
  const read = (tree: string) => {
    try {
      return JSON.parse(git(cwd, "show", `${tree}:package.json`)) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const a = read(before);
  const b = read(after);
  const pick = (p: Record<string, unknown>) => JSON.stringify([p.scripts ?? null, ...PKG_RUNNER_FIELDS.map((f) => p[f] ?? null)]);
  return pick(a) !== pick(b);
}

export const fileHash = (cwd: string, path: string): string | null => {
  const p = join(cwd, path);
  return existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
};

export interface TestRun {
  ok: boolean;
  output: string;
  /** passed; failed (a suíte rodou e falhou); timeout; overflow (saída maior que o buffer). Só "failed" vale como red. */
  kind: "passed" | "failed" | "timeout" | "overflow";
}

/**
 * Roda o comando de teste com o ambiente de quem chamou o workflow. Sem `-l`: um shell de login recarrega o perfil e
 * pode trocar o PATH (medido: o npm do `mise exec` virou outro, quebrado). Sem NODE_TEST_CONTEXT: dentro de um runner
 * de testes, um `node --test` aninhado herda essa variável e sai com 0 mesmo com teste falhando (medido no 22.13 e
 * 22.23). Com teto de tempo: um teste red de comportamento assíncrono que ainda não existe costuma travar.
 */
export function runTests(command: string, cwd: string, timeoutMs = 10 * 60_000): TestRun {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    const out = execFileSync("bash", ["-c", command], { cwd, env, encoding: "utf8", stdio: "pipe", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, output: out.slice(-4000), kind: "passed" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: string; signal?: string };
    const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.slice(-4000);
    if (e.code === "ENOBUFS") return { ok: false, output, kind: "overflow" };
    if (e.code === "ETIMEDOUT" || e.signal === "SIGTERM") return { ok: false, output, kind: "timeout" };
    return { ok: false, output, kind: "failed" };
  }
}

/** Runners que saem com erro quando não há nenhum teste (jest, vitest, pytest, mocha): isso não é base vermelha. */
export const looksLikeNoTests = (output: string) =>
  /no tests? (were )?found|no test files found|no tests ran|collected 0 items|0 passing/i.test(output);

/** Chave estável de uma fatia: pelo conteúdo, não pela posição (o resume não confunde fatias diferentes). */
export const sliceKey = (prefix: string, behavior: string, seam: string) =>
  `${prefix}:${createHash("sha256").update(`${behavior}\n${seam}`).digest("hex").slice(0, 12)}`;

export interface SliceRecord {
  key: string;
  behavior: string;
  seam: string;
  testFile?: string;
  testName?: string;
  /** Hash do arquivo de teste quando ficou red: a etapa de código não pode mudá-lo. */
  testHash?: string | null;
  /** Árvore logo depois do red: ponto de partida do green, inclusive no resume. */
  redTree?: string;
  /** Saída da suíte com o teste novo falhando (evidência "antes"). */
  red?: string;
  /** Saída da suíte passando depois da implementação (evidência "depois"). */
  green?: string;
  /** O comportamento já existia: o teste passou sem implementação e a etapa confirmou. */
  alreadySatisfied?: string;
  redAttempt?: number;
  greenAttempt?: number;
  /** A etapa de código passou nas checagens de escopo; falta a suíte (e as correções). */
  greenDone?: boolean;
  fixRound?: number;
  done: boolean;
}

/** Etapa que escreve em andamento: se o processo cair, o resume volta a `before` antes de seguir. */
export interface InFlight { id: string; before: string; resumes: number }

export interface Progress {
  /** Commit do worktree antes de qualquer mudança: base do diff do review e do commit final. */
  baseCommit?: string;
  baselineGreen?: boolean;
  /** Plano mostrado na issue: `approveSeams` aprova exatamente este, não um recalculado. */
  proposedPlan?: unknown;
  /** Relatórios de review por rodada: o resume os reaproveita em vez de pedir um review novo. */
  reviews?: Record<string, unknown>;
  refactorDone?: boolean;
  /** O que a rodada de correção disse que fez (ou por que discordou): vai para o revisor da rodada 2. */
  refactorSummary?: string;
  deliveredCommit?: string;
  inFlight?: InFlight;
  /** Contador das etapas de escrita: entra no prompt para o journal nunca devolver uma escrita antiga. */
  writeSeq?: number;
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
