// Peças do laço TDD que o CÓDIGO controla: o que conta como arquivo de teste e como configuração do runner, quais
// arquivos uma etapa tocou, a suíte de testes e o progresso por fatia (para o resume não refazer nem reconferir o
// que já passou, e para desfazer o que uma etapa interrompida deixou pela metade).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../../src/runtime/state-files.js";
import { CommandError, type Commands } from "./commands.js";

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

/**
 * Snapshot do estado atual do worktree como uma árvore git (respeita o .gitignore). Comparar dois snapshots diz o
 * que uma etapa tocou, mesmo que o agente tenha rodado `git add`, `stash` ou `commit` no meio. Antes, desliga
 * `skip-worktree` e `assume-unchanged`: com eles, um arquivo editado some do `git add -A` (medido no review).
 */
export async function snapshotTree(cmd: Commands, cwd: string): Promise<string> {
  const flagged = (await cmd.gitRead(cwd, "ls-files", "-v"))
    .split("\n")
    .filter((l) => /^(S |[a-z] )/.test(l))
    .map((l) => l.slice(2));
  if (flagged.length) await cmd.git(cwd, "update-index", "--no-skip-worktree", "--no-assume-unchanged", "--", ...flagged);
  await cmd.git(cwd, "add", "-A");
  return (await cmd.gitRead(cwd, "write-tree")).trim();
}

export interface Change { path: string; status: string }

/** O que mudou entre dois snapshots. `--no-renames`: um arquivo movido aparece como removido E criado. */
export async function changesBetween(cmd: Commands, cwd: string, before: string, after: string): Promise<Change[]> {
  return (await cmd.gitRead(cwd, "diff", "--no-renames", "--name-status", before, after))
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [status, path] = l.split("\t");
      return { status: status!, path: path! };
    });
}

export const changedBetween = async (cmd: Commands, cwd: string, before: string, after: string) => (await changesBetween(cmd, cwd, before, after)).map((c) => c.path);

/**
 * Desfaz o que uma etapa mudou: volta índice e arquivos ao snapshot (remove os novos, restaura os alterados). O `read-tree`
 * deixa para trás o arquivo novo que ninguém pôs no índice (o agente criou e o processo caiu antes do próximo `git add`):
 * todo arquivo que o snapshot tinha está na árvore, então o que sobra sem rastreio é da etapa, e `clean` o apaga. Os
 * ignorados (`node_modules`) ficam.
 */
export async function revertTo(cmd: Commands, cwd: string, tree: string): Promise<void> {
  await cmd.git(cwd, "read-tree", "--reset", "-u", tree);
  await cmd.git(cwd, "clean", "-fdq");
}

/** Volta só estes caminhos ao snapshot: os que existiam são restaurados, os criados depois são apagados. */
export async function restorePaths(cmd: Commands, cwd: string, tree: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const inTree = new Set((await cmd.gitRead(cwd, "ls-tree", "-r", "--name-only", tree, "--", ...paths)).split("\n").filter(Boolean));
  const existed = paths.filter((p) => inTree.has(p));
  if (existed.length) await cmd.git(cwd, "checkout", tree, "--", ...existed);
  for (const p of paths.filter((x) => !inTree.has(x))) {
    await cmd.git(cwd, "rm", "-q", "-f", "--cached", "--ignore-unmatch", "--", p);
    rmSync(join(cwd, p), { force: true });
  }
}

const PKG_RUNNER_FIELDS = ["jest", "vitest", "mocha", "ava", "c8", "nyc"];

/** O `package.json` mudou o que roda nos testes? Compara os scripts e os campos de configuração de runners. */
export async function runnerConfigChanged(cmd: Commands, cwd: string, before: string, after: string): Promise<boolean> {
  const read = async (tree: string) => {
    try {
      return JSON.parse(await cmd.gitRead(cwd, "show", `${tree}:package.json`)) as Record<string, unknown>;
    } catch (err) {
      // O git respondeu que não há package.json na árvore (saiu com erro), ou ele não é JSON: não mudou o que roda.
      if ((err instanceof CommandError && err.result.exitCode !== null) || err instanceof SyntaxError) return {};
      throw err; // o git estourou o tempo, não iniciou, ou o run foi cancelado: não é uma resposta
    }
  };
  const a = await read(before);
  const b = await read(after);
  const pick = (p: Record<string, unknown>) => JSON.stringify([p.scripts ?? null, ...PKG_RUNNER_FIELDS.map((f) => p[f] ?? null)]);
  return pick(a) !== pick(b);
}

export const fileHash = (cwd: string, path: string): string | null => {
  const p = join(cwd, path);
  return existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
};

export interface TestRun {
  ok: boolean;
  /** O fim da saída (4000 caracteres). */
  output: string;
  /**
   * passed; failed (a suíte rodou e falhou); timeout (morta no teto de tempo); killed (um sinal a matou, o OOM killer por
   * exemplo, ou ela nem iniciou: não é resultado de teste). Só "failed" vale como red.
   */
  kind: "passed" | "failed" | "timeout" | "killed";
}

/**
 * Roda o comando de teste por `ctx.exec`, com o ambiente de quem chamou o workflow: a suíte aparece no log do run como um
 * nó de comando, e nada trava o processo enquanto ela roda. Sem `-l`: um shell de login recarrega o perfil e pode trocar
 * o PATH (medido: o npm do `mise exec` virou outro, quebrado). Sem NODE_TEST_CONTEXT: dentro de um runner de testes, um
 * `node --test` aninhado herda essa variável e sai com 0 mesmo com teste falhando (medido no 22.13 e 22.23). Com teto de
 * tempo: um teste red de comportamento assíncrono que ainda não existe costuma travar.
 */
export async function runTests(cmd: Commands, command: string, cwd: string, opts: { timeoutMs: number; label: string }): Promise<TestRun> {
  const r = await cmd.exec("bash", ["-c", command], { cwd, env: { NODE_TEST_CONTEXT: undefined }, timeoutMs: opts.timeoutMs, label: opts.label });
  const output = (r.error ? `${r.error}\n${r.tail}` : r.tail).slice(-4000);
  if (r.timedOut) return { ok: false, output, kind: "timeout" };
  if (r.exitCode === null) return { ok: false, output, kind: "killed" };
  return { ok: r.ok, output, kind: r.ok ? "passed" : "failed" };
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
export interface InFlight {
  id: string;
  before: string;
  /**
   * O código chegou a ver a etapa terminar sem o desfazer (um cancelamento no meio dela, ou um git que travou): o processo
   * não caiu, então o resume não conta isto como uma queda.
   */
  interrupted?: boolean;
}

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
  /**
   * Quantas vezes o processo caiu no meio de cada etapa de escrita (por id), contadas pelo resume que a encontrou em andamento.
   * Passadas `maxStepCrashes`, o run para em vez de retomar a etapa de novo. A contagem fica: o resume seguinte também para.
   */
  crashes?: Record<string, number>;
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
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
  }
}
