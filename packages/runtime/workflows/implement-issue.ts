// Workflow de referência: implementar uma issue do GitHub de ponta a ponta, seguindo em código os fluxos das skills
// tdd e codebase-design (implementação), code-review (review) e pr (corpo do PR) de mattpocock/skills (MIT). As
// instruções estão em workflows/implement-issue/prompts.ts; créditos em docs/vision/02-a-ideia-e-as-referencias.md.
//
// O que é decidido em CÓDIGO (não pelo modelo):
//   - o tier (LOW/MED/HIGH) vem das labels da issue, e vale o mais alto entre os que casam (a ordem das labels não rebaixa
//     uma issue difícil); só sem label que case um classificador barato decide;
//   - MED: um planejador define seams e fatias verticais; HIGH: três designers desenham a interface de formas
//     radicalmente diferentes e um juiz escolhe ou combina ("Design it twice"); LOW: uma fatia, sem planejador;
//   - MED/HIGH param depois do plano (status "seams-proposed", comentário na issue, plano guardado no progresso do
//     run): o segundo run, com `--resume <runId>` e `approveSeams: true`, executa EXATAMENTE o plano proposto; com
//     `seams: [...]`, refaz o plano com as seams dadas. A skill tdd manda combinar as seams antes dos testes, e o
//     runtime não pausa para perguntar. Sem plano proposto no progresso (outro runId ou outro --cwd), `approveSeams`
//     para com "seams-not-proposed" em vez de aprovar um plano novo; para pular o checkpoint, passe `seams`;
//   - a suíte tem de estar verde antes da primeira fatia ("baseline-red"; um runner sem nenhum teste conta como
//     verde); `setupCommand` opcional antes; os testes têm teto de tempo ("tests-timeout"), e uma suíte morta por um sinal não conta como red ("tests-killed");
//   - cada fatia é um ciclo red → green controlado pelo código. Red: o que a etapa mudar fora dos testes é
//     descartado (medido: o composer-2.5 implementa junto com o teste), nenhum teste é apagado, e a suíte FALHA (ou a etapa declara, com a suíte verde, que o
//     comportamento já existia). Green, correções e refactor: nenhum teste, configuração do runner (`protectedGlobs`,
//     scripts do package.json) ou o teste da fatia muda, e a suíte PASSA. Quem tocou o quê vem de snapshots de
//     árvore git antes e depois de cada etapa (sem detecção de renomeação); violação desfaz a etapa e tenta de novo
//     uma vez ("tdd-violation" na segunda);
//   - o progresso (fatias, saídas red/green, plano proposto, relatórios de review, etapa de escrita em andamento)
//     fica em .workflows/runs/<runId>/tdd-progress.json. O resume desfaz uma etapa interrompida, não refaz nem
//     reconfere o que passou, e reaproveita o review já feito. Etapas que escrevem nunca vêm do journal: o efeito
//     delas está no worktree, e cada uma leva um número de sequência no prompt. Uma etapa que derrubou o processo mais
//     de `maxStepCrashes` vezes não é retomada de novo ("step-crash-loop"), e cada nova tentativa de uma etapa que
//     escreve parte do worktree de antes dela (`revertOnRetry`);
//   - o review roda sempre, em três eixos separados e em paralelo (Standards, Spec, Segurança), sem misturar nem
//     reordenar relatórios. Bloqueia: padrão documentado violado, requisito faltando ou errado, falha de segurança.
//     Requisito faltando ou errado vira fatia TDD extra (até `extraSlices`); padrão e segurança viram refactor sem tocar testes;
//     depois, só os eixos que bloquearam são revistos ("review-blocking" se continuar);
//   - antes do commit a suíte roda de novo (vermelha → "tests-failed"); commits feitos por agentes são desfeitos
//     (`reset --soft` para a base, mantendo a árvore); a trava de segredos olha o diff desde a base, o comentário
//     das seams e o corpo do PR ("secret-blocked");
//   - o corpo do PR segue o template da skill pr; a Evidence é a saída real red → green de cada fatia, sem caminhos
//     locais; com fatias adiadas, o PR só referencia a issue (`Refs`) em vez de fechá-la;
//   - todo comando (testes, git, gh) roda por `ctx.exec` (implement-issue/commands.ts): assíncrono, com teto de tempo
//     (testes: `testTimeoutSec`; `git push` e `gh`: `networkTimeoutSec`; git local: o `execTimeoutMs` da configuração) e como nó de comando no log
//     do run. Um erro do `gh` ou do `git` falha o run com a mensagem dele; "sem PR" é só a resposta conhecida do `gh`;
//   - cada run tem a sua branch (`wf/issue-<n>-<run>`) e o seu worktree, criados a partir da cabeça ATUAL da branch padrão; o
//     worktree só é reaproveitado pelo run que o registrou no progresso. Uma issue tem no máximo um run ativo: o segundo run
//     devolve "issue-locked" com o id do que está ativo (lock `issue-<n>` no run store, por repositório; um `repo` que o `gh`
//     diz ser o repositório do cwd é o mesmo lock que um run sem `repo`);
//   - a entrega empurra com `--force-with-lease`, só em branch `wf/`, e só quando o commit que o origin tem na branch é um que
//     este run empurrou: o resume depois do PR refaz o commit e entrega por cima; commit de outra pessoa na branch dá
//     "push-refused" e não é sobrescrito.
//
// Os limites (fatias por tier, fatias extras, rodadas de correção, tentativas de red e green, tamanho do diff, mapa
// label → tier, limite de quedas, tetos de tempo dos testes e dos comandos de rede) são os `settings` do workflow: os valores abaixo são os padrões, e o repositório os troca em
// `workflows.implement-issue.settings` (docs/reference/config.md).
//
// Custo por etapa (passo 4 da /skill-to-workflow). "[]" = settingSources vazio: sem AGENTS.md, regras, hooks, MCP e
// sem as skills que o SDK carrega com qualquer outra camada (medido: 58).
//   etapa            modelo                 tools                    settingSources   memo
//   classify         composer-2.5           nenhuma                  []               sim
//   plan (MED)       grok-4.7               só leitura               []               sim
//   design ×3        composer-2.5           só leitura               []               sim
//   judge (HIGH)     grok-4.7 high          só leitura               []               sim
//   test-N           do tier                todas                    default          não
//   code-N           do tier                todas                    default          não
//   fix-N-R          tier acima             todas                    default          não
//   review ×3        grok-4.7 high          só leitura, sem shell    []               sim (o diff e a rodada no prompt)
//   refactor-1       do tier                todas                    default          não
//   pr-text          composer-2.5           só leitura, sem shell    []               sim
// Exceção ao checklist (docs/operating/02-custos-e-cache.md §6): as etapas que escrevem ficam com todas as tools, "task" inclusive, e o default
// do engine (project, team, mdm). A allowlist de escrita do SDK ainda não foi medida, e os hooks do time e do MDM
// têm de valer onde o agente escreve.
// Agentes por caminho, típico (sem retentativas nem achados) e pior caso (2 tentativas por etapa, 2 correções por
// fatia, 2 fatias extras, refactor, re-review; com os ajustes padrão). Teto padrão: 3 milhões de tokens (`budget`); --max-tokens troca:
//   LOW   típico 6  (1 fatia + 3 reviews + PR)                     pior caso ~26
//   MED   típico 11 (plano; até 3 fatias + 3 reviews + PR)          pior caso ~39
//   HIGH  típico 20 (3 designers + juiz; até 5 fatias + ...)        pior caso ~55
// Tokens medidos (docs/research/verificacoes-locais.md §13): LOW 339 mil (6 agentes); MED 769 mil nos dois runs
// (9 agentes, 2 fatias); um MED com 3 fatias e 2 adiadas, antes do teto no prompt do planejador, gastou 887 mil.
// Fora de agentes (zero tokens): leitura da issue, roteamento, git, testes, diff, comentário, commit e PR.
//
// IDs de modelo: confirme os seus com `npm run models`. Os defaults são modelos do Cursor (Composer e Grok), que os
// planos pagos da The X Subscription incluem na franquia semanal; modelos de terceiros exigem crédito pré-pago
// (medido). Em planos legados e no Enterprise, troque o modelo de um papel pela config
// (`workflows.implement-issue.roles.<papel>.model`) ou por WF_MODEL_<PAPEL> (por exemplo WF_MODEL_REVIEW, ou o nome
// antigo WF_MODEL_HIGH): o ID sozinho mantém os params do papel, `id[param=valor]` os troca (docs/reference/config.md).
//
// STATUS: LOW e MED verificados contra a API real em 2026-11-11 (docs/research/verificacoes-locais.md §13). HIGH, o
// review que bloqueia e o alreadySatisfied só têm testes offline.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ModelSelection, SettingSource } from "@cursor/sdk";
import { wasKilledByCancel } from "../src/runtime/job-state.js";
import { createRedactor, findCredential, findSecretEnvValue } from "../src/runtime/redaction.js";
import { NamedLockedError, acquireNamedLock, eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { defineWorkflow, type AgentCallOptions, type WorkflowCard } from "../src/runtime/workflow.js";
import { buildPrBody, sanitizeModelText, type PrText } from "./implement-issue/pr-body.js";
import { CommandError, Commands, NETWORK_TIMEOUT_SEC, SNAPSHOT_GRACE_HOURS, WORKFLOW_BRANCH_PREFIX, worktreeOf } from "./implement-issue/commands.js";
import * as P from "./implement-issue/prompts.js";
import { AXES, AXIS_SCHEMAS, blockingAxes, blockingOf, type Axis, type ReviewReports } from "./implement-issue/review.js";
import {
  DEFAULT_PROTECTED_GLOBS,
  DEFAULT_TEST_GLOBS,
  ProgressStore,
  changedBetween,
  changesBetween,
  fileHash,
  isTestFile,
  looksLikeNoTests,
  matchesAny,
  restorePaths,
  revertTo,
  runTests,
  runnerConfigChanged,
  sliceKey,
  snapshotTree,
  type SliceRecord,
} from "./implement-issue/tdd.js";

type Tier = "LOW" | "MED" | "HIGH";

const HIGH_EFFORT = [{ id: "reasoning_effort", value: "high" }];
const COMPOSER: ModelSelection = { id: "composer-2.5" };
const GROK: ModelSelection = { id: "grok-4.7" };
const GROK_HIGH: ModelSelection = { id: "grok-4.7", params: HIGH_EFFORT };
/** The role of the steps that write code at a tier: `implement.low`, `implement.med`, `implement.high`. */
const implementRole = (tier: Tier) => `implement.${tier.toLowerCase()}`;

const TIER_RANK: Record<Tier, number> = { LOW: 0, MED: 1, HIGH: 2 };

/**
 * Os ajustes do workflow (`meta.settings`): os padrões do código. O arquivo de configuração global e o do repositório os
 * trocam em `workflows.implement-issue.settings` (o esquema valida, docs/reference/config.md documenta), e o run os lê de
 * `ctx.settings`. Cada ajuste vale inteiro: o de uma camada de cima troca o de baixo, sem combinar campos.
 */
type Settings = {
  /** Máximo de fatias TDD por tier; as do plano que passam dele ficam adiadas. */
  sliceCaps: Record<Tier, number>;
  /** Máximo de fatias extras que o review pode abrir. */
  extraSlices: number;
  /** Rodadas de correção de uma fatia cuja suíte falha depois do green. */
  fixRounds: number;
  /** Tentativas de cada etapa red e green de uma fatia. */
  redGreenAttempts: number;
  /** Caracteres do diff que entram no prompt do review e do PR. */
  maxDiffChars: number;
  /** Labels da issue → tier (a comparação ignora maiúsculas). Ajuste ao vocabulário do seu time. */
  labelTiers: Record<string, Tier>;
  /** Quedas do processo que uma mesma etapa de escrita pode causar antes de o resume desistir dela. */
  maxStepCrashes: number;
  /** `wf gc`: o run que falhou há mais dias que isto perde o worktree e as branches. Quem o lê é o `wf gc`, não o run. */
  gcFailedAfterDays: number;
  /** `wf gc`: a branch de snapshot de uma etapa na nuvem só é varrida quando o run dela não teve evento nenhum há mais horas que isto (o agente na nuvem pode ainda estar partindo dela). Quem o lê é o `wf gc`, não o run. */
  gcSnapshotGraceHours: number;
  /** Teto de tempo de cada rodada de testes (e do `setupCommand`), em segundos. */
  testTimeoutSec: number;
  /** Teto de tempo de cada comando de rede (`git push` e `gh`), em segundos: uma credencial pedida ou uma conexão parada falha a etapa. */
  networkTimeoutSec: number;
};
const SETTINGS: Settings = {
  sliceCaps: { LOW: 1, MED: 3, HIGH: 5 },
  extraSlices: 2,
  fixRounds: 2,
  redGreenAttempts: 2,
  maxDiffChars: 40_000,
  labelTiers: {
    "complexity:low": "LOW",
    "good first issue": "LOW",
    "complexity:medium": "MED",
    "complexity:high": "HIGH",
    security: "HIGH",
  },
  maxStepCrashes: 2,
  gcFailedAfterDays: 14,
  gcSnapshotGraceHours: SNAPSHOT_GRACE_HOURS,
  testTimeoutSec: 600,
  networkTimeoutSec: NETWORK_TIMEOUT_SEC,
};
const READ_ONLY = ["read", "grep", "glob", "ls", "semSearch"];
const REVIEW_TOOLS = ["read", "grep", "glob", "ls"];
const NO_SETTING_SOURCES: SettingSource[] = [];
const SEAMS_MARKER = "<!-- wf:implement-issue:seams -->";
/** Arquivos que orientam o desenho e o review, quando existem no repositório. */
const CONTEXT_FILES = ["GLOSSARY.md", "CONTEXT.md", "AGENTS.md", "CODING_STANDARDS.md", "CONTRIBUTING.md", "docs/adr"];
const STANDARDS_FILES = ["CODING_STANDARDS.md", "CONTRIBUTING.md", "AGENTS.md", ".editorconfig"];

interface Args {
  issue: number;
  /** owner/repo; default: o repo do cwd. */
  repo?: string;
  /** Comando de teste; default: o que o plano sugerir, ou `npm test`. */
  testCommand?: string;
  /** Roda uma vez no worktree novo antes da suíte de base (ex.: `npm ci`). */
  setupCommand?: string;
  openPr?: boolean;
  /** Segundo run de MED/HIGH (com `--resume <runId>` e o mesmo `--cwd`): aprova o plano proposto no primeiro. */
  approveSeams?: boolean;
  /** Seams aprovadas por você, no lugar das propostas: o plano é refeito com elas. */
  seams?: string[];
  /** O que conta como arquivo de teste (default: DEFAULT_TEST_GLOBS). */
  testGlobs?: string[];
  /** Configuração do runner que nenhuma etapa pode tocar (default: DEFAULT_PROTECTED_GLOBS). */
  protectedGlobs?: string[];
}

interface Issue {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
}

interface Slice { behavior: string; seam: string; testIdea: string }
interface Plan { seams: Array<{ name: string; interface: string; why: string }>; slices: Slice[]; testCommand: string; rationale?: string }
interface Impl { summary: string; filesChanged: string[] }
interface TestOut { testFile: string; testName: string; alreadySatisfied?: boolean; evidence?: string }

const str = { type: "string" };
const PLAN_SCHEMA = {
  type: "object",
  required: ["seams", "slices", "testCommand"],
  properties: {
    seams: { type: "array", minItems: 1, items: { type: "object", required: ["name", "interface", "why"], properties: { name: str, interface: str, why: str } } },
    slices: { type: "array", minItems: 1, items: { type: "object", required: ["behavior", "seam", "testIdea"], properties: { behavior: str, seam: str, testIdea: str } } },
    testCommand: str,
    rationale: str,
  },
};
const DESIGN_SCHEMA = {
  type: "object",
  required: ["interface", "usage", "hides", "dependencies", "tradeoffs"],
  properties: { interface: str, usage: str, hides: str, dependencies: str, tradeoffs: str },
};
const TEST_SCHEMA = {
  type: "object",
  required: ["testFile", "testName"],
  properties: { testFile: str, testName: str, alreadySatisfied: { type: "boolean" }, evidence: str },
};
const IMPL_SCHEMA = { type: "object", required: ["summary", "filesChanged"], properties: { summary: str, filesChanged: { type: "array", items: str } } };
const PR_SCHEMA = {
  type: "object",
  required: ["summary", "door", "blastRadius"],
  properties: { summary: str, door: { enum: ["one-way", "two-way"] }, doorNote: str, blastRadius: str, blastNote: str },
};
const CLASSIFY_SCHEMA = { type: "object", required: ["tier", "reason"], properties: { tier: { enum: ["LOW", "MED", "HIGH"] }, reason: str } };
const CLASSIFY_INSTRUCTIONS =
  "Classify the issue's implementation complexity as LOW (mechanical, 1 file), MED (typical) or HIGH " +
  "(architectural, security, several modules). Answer only through the submit_result tool.";

const AXIS_INSTRUCTIONS: Record<Axis, string> = {
  standards: P.STANDARDS_INSTRUCTIONS,
  spec: P.SPEC_INSTRUCTIONS,
  security: P.SECURITY_INSTRUCTIONS,
};

const issueBlock = (i: { number: number; title: string; body: string }) => `## Issue #${i.number}: ${i.title}\n\n${i.body}`;
const sliceBlock = (s: Slice) => `## Slice\n- Behaviour: ${s.behavior}\n- Seam: ${s.seam}\n- Test idea: ${s.testIdea}`;
const listBlock = (title: string, items: string[]) => (items.length ? `## ${title}\n${items.map((f) => `- ${f}`).join("\n")}` : "");
const tail = (s: string | undefined, n = 3000) => (s ?? "").slice(-n);
/** Aspas simples para shell: o comando de relançamento postado na issue não quebra com `'` nos args. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The issue's card on the dashboard's Board: its number and title, and its tier. `extra` adds what a later point of the run knows. */
const issueCard = (issue: { number: number; title: string }, tier: Tier, extra: Partial<WorkflowCard> = {}): WorkflowCard => ({
  title: `#${issue.number} ${issue.title}`,
  badges: [tier],
  ...extra,
});
/** The link text of a pull request: `PR #9` for `https://github.com/o/r/pull/9`. */
const prLabel = (url: string) => {
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return number ? `PR #${number}` : "Pull request";
};

/** The URL of the branch's PR, or undefined when it has none. Any other `gh` failure (auth, network) is an error, never "no PR". */
async function existingPr(cmd: Commands, branch: string, repoFlag: string[], cwd: string): Promise<string | undefined> {
  const url = await cmd.ghOrNothing(cwd, /no pull requests? found/i, "pr", "view", branch, "--json", "url", "-q", ".url", ...repoFlag);
  return url?.trim() || undefined;
}

/** O tier das labels da issue: o mais alto entre os que casam, para a ordem das labels nunca rebaixar uma issue difícil. */
function tierOfLabels(labels: Array<{ name: string }>, labelTiers: Record<string, Tier>): Tier | undefined {
  const known = new Map(Object.entries(labelTiers).map(([label, tier]) => [label.toLowerCase(), tier]));
  let best: Tier | undefined;
  for (const { name } of labels) {
    const tier = known.get(name.toLowerCase());
    if (tier && (!best || TIER_RANK[tier] > TIER_RANK[best])) best = tier;
  }
  return best;
}

const branchExists = (cmd: Commands, cwd: string, branch: string) => cmd.gitIs(cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);

/**
 * The name of the lock on an issue: `issue-<n>` for an issue of the cwd's repository, and for one of another repository a name
 * that carries a hash of that repository (GitHub names ignore case), so the same number there is another lock. A `--repo` that
 * names the cwd's own repository, in any form `gh` takes, is the cwd's issue: `gh repo view` says which repository each one is,
 * and a run without `--repo` asks nothing. When `gh` cannot say (no GitHub remote here, no network), the lock is the named
 * repository's, as for another one, and the log says so.
 */
async function issueLockName(cmd: Commands, cwd: string, issue: number, repo: string | undefined, log: (message: string) => void): Promise<string> {
  if (!repo) return `issue-${issue}`;
  let named = repo.toLowerCase();
  try {
    const urlOf = async (...which: string[]) => (await cmd.gh(cwd, "repo", "view", ...which, "--json", "url", "-q", ".url")).trim().toLowerCase();
    const cwdRepository = await urlOf();
    named = await urlOf(repo);
    if (named === cwdRepository) return `issue-${issue}`;
  } catch (err) {
    if (!(err instanceof CommandError)) throw err; // a cancel is not an answer
    log(`could not tell whether ${repo} is this directory's repository, so the issue lock is ${repo}'s: ${err.message}`);
  }
  return `issue-${issue}-${createHash("sha256").update(named).digest("hex").slice(0, 12)}`;
}

/**
 * The run's executions as its event log has them, in order: the job that ran each (`wf start`; absent for `wf run`) and the
 * status of its `run-end` (absent while running, after a crash, or after a cancel killed its frozen job).
 */
function executionsOf(cwd: string, runId: string): Array<{ jobId?: string; ended?: string }> {
  const executions: Array<{ jobId?: string; ended?: string }> = [];
  for (const e of readEventLog(eventLogPath(cwd, runId), { content: false }).events) {
    if (e.type === "run-start") executions.push(e.jobId === undefined ? {} : { jobId: e.jobId });
    else if (e.type === "run-end" && executions.length) executions[executions.length - 1]!.ended = e.status;
  }
  return executions;
}

const issueBranch = (issue: number) => `${WORKFLOW_BRANCH_PREFIX}issue-${issue}`;

/**
 * The branch of a run: one per run, named after the issue and the run id, so two runs on an issue never share one. A run id
 * with characters a branch name cannot hold is cleaned, and a short hash of the whole id keeps two such ids apart.
 */
function runBranch(issue: number, runId: string): string {
  const id = runId.replace(/^implement-issue-/, "");
  const clean = id.replace(/[^\w-]+/g, "-");
  return `${issueBranch(issue)}-${clean === id ? clean : `${clean}-${createHash("sha256").update(runId).digest("hex").slice(0, 6)}`}`;
}

/** Is `dir` the root of a worktree, and not a directory inside some other repository (where git would act on that repository)? */
async function isWorktreeRoot(cmd: Commands, dir: string): Promise<boolean> {
  try {
    return realpathSync((await cmd.gitRead(dir, "rev-parse", "--show-toplevel")).trim()) === realpathSync(dir);
  } catch (err) {
    if (err instanceof CommandError && err.result.exitCode !== null) return false; // git answered that this is not a repository
    throw err;
  }
}

/**
 * The commit a fresh run starts from: the head of the repository's default branch, as it is now. That is the branch
 * `origin/HEAD` names (a clone records it), or else the one checked out. The local branch wins over `origin/<name>`: commits
 * that are on it here but not pushed are part of the base, as they were when a run started from the checked out HEAD.
 */
async function defaultBranchHead(cmd: Commands, cwd: string): Promise<string> {
  const remoteDefault = (await cmd.gitRead(cwd, "for-each-ref", "--format=%(symref:short)", "refs/remotes/origin/HEAD")).trim();
  const name = remoteDefault.replace(/^origin\//, "") || (await cmd.gitRead(cwd, "branch", "--show-current")).trim();
  if (!name) return (await cmd.gitRead(cwd, "rev-parse", "HEAD")).trim(); // a detached HEAD and no origin/HEAD: nothing names a default branch
  for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
    if (await cmd.gitIs(cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`)) return (await cmd.gitRead(cwd, "rev-parse", ref)).trim();
  }
  throw new Error(`the default branch ${name} has no commit in this repository: fetch it, or check out the branch the run should start from`);
}

/**
 * Puts the run's delivered commit on the origin's copy of its branch. On a resume the history is rewritten (a commit an agent
 * made is undone, the tree is committed again), so a plain push is refused once the branch has been pushed. The push is a force
 * with a lease on the commit the origin has right now, and it happens only when that commit is one this run pushed (or the
 * branch is not there yet; for a run from before the pushes were recorded, `isOlderDelivery` decides): a commit anyone else made
 * on the branch is never overwritten. Returns why the push was refused, or
 * undefined when the branch is on the origin.
 */
async function pushDelivery(cmd: Commands, progress: ProgressStore, worktree: string, branch: string, repo: string | undefined, message: string): Promise<string | undefined> {
  const delivered = progress.data.deliveredCommit!;
  const onOrigin = await cmd.remoteBranchHead(worktree, branch);
  if (onOrigin === delivered) return undefined;
  const ours = (sha: string) =>
    progress.data.pushed ? progress.data.pushed.includes(sha) : isOlderDelivery(cmd, worktree, sha, progress.data.baseCommit!, message);
  if (onOrigin && !(await ours(onOrigin))) {
    return `origin/${branch} is at ${onOrigin.slice(0, 7)}, which has commits this workflow did not make, and the push would overwrite them: merge your work from ${worktree} by hand, or push it under another branch`;
  }
  progress.data.pushed = [...(progress.data.pushed ?? []), delivered]; // before the push: a crash right after it still leaves the origin's branch recognized as this run's
  progress.data.repo = repo; // where its PR lives: `wf gc` asks there for the PR's state
  progress.save();
  await cmd.pushOwned(worktree, branch, onOrigin);
  return undefined;
}

/**
 * For a run that delivered before runs recorded what they pushed (no `pushed` list): is `sha` a delivery the workflow made? It
 * is when this repository has the commit, its only parent is the run's base and its message is the delivery's. A commit
 * someone added on top has the delivery as its parent, and one made elsewhere is not here: neither is overwritten.
 */
async function isOlderDelivery(cmd: Commands, worktree: string, sha: string, baseCommit: string, message: string): Promise<boolean> {
  try {
    const [parents, subject] = (await cmd.gitRead(worktree, "log", "-1", "--format=%P%n%B", sha)).split("\n");
    return parents === baseCommit && subject === message;
  } catch (err) {
    if (err instanceof CommandError && err.result.exitCode !== null) return false; // git does not have the commit
    throw err;
  }
}

/** Escreve um corpo longo num arquivo temporário para `--body-file` (sem limite de argumento de linha de comando). */
async function withBodyFile<T>(body: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "wf-body-"));
  const path = join(dir, "body.md");
  writeFileSync(path, body);
  try {
    return await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Diff desde a base do worktree, para o review e o PR. Grande demais: estatística + início, e o agente lê o resto. */
async function diffSinceBase(cmd: Commands, cwd: string, base: string, maxChars: number): Promise<string> {
  await cmd.git(cwd, "add", "-A");
  const diff = await cmd.gitRead(cwd, "diff", "--cached", "--no-color", base);
  if (diff.length <= maxChars) return "```diff\n" + diff + "\n```";
  const stat = await cmd.gitRead(cwd, "diff", "--cached", "--stat", base);
  return `(diff truncated: read the files for the rest)\n\n${stat}\n\n\`\`\`diff\n${diff.slice(0, maxChars)}\n\`\`\``;
}

/**
 * Regras de segredo para qualquer texto que vai sair da máquina. Devolve a regra que disparou, nunca o trecho.
 * The credential formats are the event-log redactor's (redaction.ts, one list for both), plus the saved Cursor key and the
 * value of every secret-named environment variable (16 characters or more) of `env`.
 */
export function findSecretInText(text: string, knownSecrets: string[] = savedSecrets(), env: NodeJS.ProcessEnv = process.env): string | undefined {
  const format = findCredential(text);
  if (format) return format;
  if (knownSecrets.some((k) => k.length >= 16 && text.includes(k))) return "the saved SDK key or CURSOR_API_KEY";
  const variable = findSecretEnvValue(text, env, 16);
  return variable ? `the value of the secret-named environment variable ${variable}` : undefined;
}

/**
 * Trava de segredos antes do commit. Uma issue com prompt injection poderia fazer uma etapa copiar
 * ~/.cursor/sdk/auth.json para o worktree, e o sandbox do SDK não restringe leitura. Olha o diff staged desde `base`
 * (default: HEAD, ou a árvore vazia num repo sem commits), para pegar também o que um agente tenha commitado. Devolve a regra que disparou, nunca o trecho.
 */
export async function findStagedSecret(cmd: Commands, worktree: string, knownSecrets: string[] = savedSecrets(), base?: string): Promise<string | undefined> {
  const git = (...a: string[]) => cmd.gitRead(worktree, ...a);
  for (const name of (await git("diff", "--cached", "--name-only", ...(base ? [base] : []))).split("\n").filter(Boolean)) {
    const file = basename(name);
    if (file === "auth.json") return "auth.json file in the commit";
    if (file === ".env" || file.startsWith(".env.")) return "a .env file in the commit";
  }
  const added = (await git("diff", "--cached", "--no-color", "-U0", ...(base ? [base] : [])))
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n");
  const hit = findSecretInText(added, knownSecrets);
  return hit ? `${hit} in the diff` : undefined;
}

/** A chave salva por `wf login` e a de CURSOR_API_KEY, lidas só em memória para a comparação. */
function savedSecrets(): string[] {
  const keys: string[] = [];
  if (process.env.CURSOR_API_KEY) keys.push(process.env.CURSOR_API_KEY);
  try {
    const stored = JSON.parse(readFileSync(join(homedir(), ".cursor", "sdk", "auth.json"), "utf8")) as { apiKey?: unknown };
    if (typeof stored.apiKey === "string") keys.push(stored.apiKey);
  } catch {
    // sem login salvo
  }
  return keys;
}

export default defineWorkflow<Args>({
  meta: {
    name: "implement-issue",
    description:
      "Implements a GitHub issue with slice-by-slice TDD (red → green checked by the code), a three-axis review (Standards, Spec, Security) and a PR in the Summary/Evidence/Merge Danger template.",
    whenToUse: "When the user asks to implement or resolve a specific issue by number.",
    phases: [{ title: "Triage" }, { title: "Plan" }, { title: "Implementation" }, { title: "Review" }, { title: "Delivery" }],
    // Roles: the keys of `workflows.implement-issue.roles` in the config. Each role's model is a code default that the
    // config and WF_MODEL_<ROLE> replace. `fix` and `design` declare no model: it depends on the tier or on the step.
    // `cloud`: the engine can run a write step in the cloud (its commits come back into the worktree: ADR-0007), but the roles
    // that write stay `never` here: their prompts forbid git commands, which a cloud agent needs to deliver its work, and no
    // TDD loop has run on a cloud agent yet (see #45). The read-only ones may go (they read the run's worktree, hence `read-only`).
    roles: [
      { name: "classify", description: "Classifies the complexity when the issue has no label.", cloud: "ok", defaults: { model: COMPOSER, settingSources: NO_SETTING_SOURCES } },
      { name: "implement.low", description: "Writes test and code in the LOW tier (and the refactor).", cloud: "never", envAliases: ["LOW"], defaults: { model: COMPOSER } },
      { name: "implement.med", description: "Writes test and code in the MED tier (and the refactor).", cloud: "never", envAliases: ["MED"], defaults: { model: GROK } },
      { name: "implement.high", description: "Writes test and code in the HIGH tier (and the refactor).", cloud: "never", envAliases: ["HIGH"], defaults: { model: GROK_HIGH } },
      { name: "review", description: "Reviews the diff on three axes (Standards, Spec, Security).", cloud: "read-only", defaults: { model: GROK_HIGH, settingSources: NO_SETTING_SOURCES } },
      { name: "fix", description: "Fixes a slice's red suite; the model steps up with the tier.", cloud: "never" },
      { name: "design", description: "Plans the slices (MED) or designs and judges the interface (HIGH).", cloud: "read-only", defaults: { settingSources: NO_SETTING_SOURCES } },
      { name: "pr-text", description: "Writes the PR body text.", cloud: "read-only", defaults: { model: COMPOSER, settingSources: NO_SETTING_SOURCES } },
    ],
    // The tunable limits; the config files change them (see `Settings`). Copied: the config layer never edits the constant.
    settings: structuredClone(SETTINGS),
    argsSchema: {
      type: "object",
      required: ["issue"],
      additionalProperties: false,
      properties: {
        issue: { type: "number" },
        repo: { type: "string" },
        testCommand: { type: "string" },
        setupCommand: { type: "string" },
        openPr: { type: "boolean" },
        approveSeams: { type: "boolean" },
        seams: { type: "array", items: { type: "string" } },
        testGlobs: { type: "array", items: { type: "string" } },
        protectedGlobs: { type: "array", items: { type: "string" } },
      },
    },
  },
  defaults: { timeoutMs: 30 * 60_000, retries: 1, schemaRetries: 2 },
  // O texto da issue pode empurrar o run para o pior caso (mais fatias, mais achados): o teto vale mesmo sem --max-tokens.
  budget: { maxTokens: 3_000_000 },

  async run(ctx) {
    const settings = ctx.settings as unknown as Settings; // o esquema da configuração valida os tipos; os padrões vêm de `meta.settings`
    // Todo comando do workflow (testes, git, gh) passa por ctx.exec: assíncrono, com teto de tempo e visível no log do run.
    // O git local não passa teto: vale o `execTimeoutMs` da configuração do workflow.
    const cmd = new Commands((command, args, opts) => ctx.exec(command, args, opts), {
      networkMs: settings.networkTimeoutSec * 1000,
    });
    // Lido antes do lock: só lê o arquivo (o engine já trava o run), e um progresso ilegível falha o run sem segurar a issue.
    const progress = new ProgressStore(ctx.cwd, ctx.runId);
    // Uma issue tem no máximo um run ativo: dois runs na mesma issue brigariam pelo mesmo trabalho e abririam dois PRs. O lock
    // fica no run store (`.workflows/locks/issue-<n>.lock`, ou `issue-<n>-<hash do repositório>.lock` quando o `--repo` é outro
    // repositório que não o do cwd: a issue #5 de outro repositório é outra issue) e vale até o run terminar, qualquer que seja
    // o jeito (status, erro, cancelamento).
    let releaseIssue: () => void;
    try {
      releaseIssue = acquireNamedLock(ctx.cwd, await issueLockName(cmd, ctx.cwd, ctx.args.issue, ctx.args.repo, (m) => ctx.log(m)), ctx.runId);
    } catch (err) {
      if (!(err instanceof NamedLockedError)) throw err;
      return {
        issue: ctx.args.issue,
        status: "issue-locked",
        activeRunId: err.holderRunId,
        reason: `issue #${ctx.args.issue} already has an active run: ${err.holderRunId ?? "unknown"}; wait for it to end, or cancel it and start again`,
        lock: err.message,
      };
    }
    /** A ordem desta execução no log de eventos do run; lida na primeira etapa de escrita. */
    let execution: number | undefined;
    try {
      const { issue: number, repo, openPr = false } = ctx.args;
      const globs = ctx.args.testGlobs?.length ? ctx.args.testGlobs : DEFAULT_TEST_GLOBS;
      const protectedGlobs = ctx.args.protectedGlobs ?? DEFAULT_PROTECTED_GLOBS;
      // Os tetos de tempo são ajustes, não args: só os arquivos de configuração os trocam (ADR-0001).
      const testTimeout = settings.testTimeoutSec * 1000;
      const isTest = (f: string) => isTestFile(f, globs);

      // ── Triagem: dados da issue via gh (código, sem modelo) ─────────────────────────────
      ctx.phase("Triage");
      const repoFlag = repo ? ["--repo", repo] : [];
      const issue = JSON.parse(await cmd.gh(ctx.cwd, "issue", "view", String(number), ...repoFlag, "--json", "number,title,body,labels")) as Issue;
      const labelTier = tierOfLabels(issue.labels, settings.labelTiers);
      let tier = labelTier;
      if (!tier) {
        const c = await ctx.agent<{ tier: Tier; reason: string }>(`${CLASSIFY_INSTRUCTIONS}\n\n${issueBlock(issue)}`, {
          label: "classify",
          role: "classify", // the role's settingSources is []: no AGENTS.md, hooks, MCP or the skills any other layer loads (measured)
          tools: [], // só texto: classificar não precisa ler o repositório
          memo: true,
          schema: CLASSIFY_SCHEMA,
        });
        tier = c.tier;
      }
      const base = { issue: issue.number, tier };
      const sliceCap = settings.sliceCaps[tier];
      ctx.log(`Issue #${issue.number} → tier ${tier} (role ${implementRole(tier)})`);
      ctx.metric("tier", tier); // covariável de dificuldade: compare modelos dentro do mesmo tier
      ctx.metric("tier_source", labelTier ? "label" : "classifier");
      ctx.card(issueCard(issue, tier)); // on the Board from here on; delivery updates it
      const ctxFiles = CONTEXT_FILES.filter((f) => existsSync(join(ctx.cwd, f)));
      const contextBlock = listBlock("Repository context files (read the ones that matter)", ctxFiles);

      // ── Plano (codebase-design): LOW uma fatia; MED planejador; HIGH "Design it twice" ─────
      let plan: Plan;
      if (tier === "LOW") {
        plan = {
          seams: [{ name: "affected public interface", interface: "chosen by the test step", why: "LOW: one slice, no planner" }],
          slices: [{ behavior: issue.title, seam: "the public interface closest to the requested behaviour", testIdea: "use an example from the issue as the expected value" }],
          testCommand: ctx.args.testCommand ?? "npm test",
        };
      } else if (ctx.args.approveSeams && !ctx.args.seams?.length && !progress.data.proposedPlan) {
        // Aprovar exige um plano mostrado: sem ele, um planejador novo produziria um plano que ninguém viu.
        return { ...base, status: "seams-not-proposed", runId: ctx.runId, hint: "run without approveSeams to propose the seams, or resume the run that proposed them with the same --cwd" };
      } else if (ctx.args.approveSeams && !ctx.args.seams?.length && progress.data.proposedPlan) {
        plan = progress.data.proposedPlan as Plan; // aprova exatamente o que foi mostrado na issue
        ctx.log("seams approved: using the plan proposed by the first run");
      } else {
        ctx.phase("Plan");
        const approved = listBlock("Approved seams (use exactly these)", ctx.args.seams ?? []);
        // O planejador sabe o teto: sem isso, propôs 5 fatias para um tier de 3 na issue #8, e o PR saiu parcial.
        const capBlock =
          `## Slice cap\nThis tier does up to ${sliceCap} slices. To fit the whole issue, one slice may cover ` +
          "cases of one behaviour that are tested together (the odd and the even case of a function; the value and the error). " +
          "If it still does not fit, put last what can wait.";
        const planData = `${issueBlock(issue)}\n\n${capBlock}\n\n${contextBlock}${approved ? `\n\n${approved}` : ""}`;
        if (tier === "MED") {
          plan = await ctx.agent<Plan>(`${P.PLAN_INSTRUCTIONS}\n\n${planData}`, {
            label: "plan",
            role: "design",
            model: GROK,
            tools: READ_ONLY,
            schema: PLAN_SCHEMA,
            memo: true,
          });
        } else {
          const kinds = ["minimal", "flexible", "common"] as const;
          const designs = await ctx.parallel(
            kinds.map((k) => () =>
              ctx.agent<Record<string, string>>(`${P.DESIGN_INSTRUCTIONS}\n\n## Constraint\n${P.DESIGN_CONSTRAINTS[k]}\n\n${issueBlock(issue)}\n\n${contextBlock}`, {
                label: `design:${k}`,
                phase: "Plan",
                role: "design",
                model: COMPOSER,
                tools: READ_ONLY,
                schema: DESIGN_SCHEMA,
                memo: true,
              }),
            ),
          );
          const done = designs.flatMap((d, i) => (d ? [{ constraint: kinds[i], ...d }] : []));
          if (done.length < 2) return { ...base, status: "design-failed", designs: done.length };
          plan = await ctx.agent<Plan>(`${P.JUDGE_INSTRUCTIONS}\n\n${planData}\n\n## Designs\n${JSON.stringify(done, null, 2)}`, {
            label: "judge",
            role: "design",
            model: GROK_HIGH,
            tools: READ_ONLY,
            schema: PLAN_SCHEMA,
            memo: true,
          });
        }
        // tdd: seams combinadas antes de qualquer teste. O runtime não pausa: propõe na issue, guarda o plano e para.
        if (!ctx.args.seams?.length && !ctx.args.approveSeams) {
          progress.data.proposedPlan = plan;
          progress.save();
          const relaunch = `npm run wf -- run implement-issue --args ${shellQuote(JSON.stringify({ ...ctx.args, approveSeams: true }))} --resume ${ctx.runId}`;
          // Model text goes to a public issue: neutralized like the PR body's (closing keywords, mentions, `<!--`). The
          // interface and the test command sit in code spans, where GitHub gives them no effect.
          const prose = sanitizeModelText;
          const comment = [
            SEAMS_MARKER,
            `## Seams proposed by the \`implement-issue\` workflow (tier ${tier})`,
            "",
            ...plan.seams.map((s) => `- **${prose(s.name)}**: \`${s.interface}\` — ${prose(s.why)}`),
            "",
            "### Slices (one per red → green cycle)",
            "",
            ...plan.slices.map(
              (s, i) => `${i + 1}. ${prose(s.behavior)} (seam: ${prose(s.seam)}; test: ${prose(s.testIdea)})${i >= sliceCap ? " (deferred)" : ""}`,
            ),
            ...(plan.slices.length > sliceCap
              ? ["", `The slices marked deferred are left out by the tier ${tier} slice cap (${sliceCap} slices): the PR only references the issue, without closing it.`]
              : []),
            "",
            `Test command: \`${ctx.args.testCommand ?? plan.testCommand}\``,
            ...(plan.rationale ? ["", `### Why this design\n\n${prose(plan.rationale)}`] : []),
            "",
            "### To approve",
            "",
            "Relaunch with the same args and `approveSeams: true`, in the same directory as this run (or with the same `--cwd`); it executes exactly this plan:",
            "",
            "```bash",
            relaunch,
            "```",
            "",
            `In the chat: \`/run-workflow implement-issue\` with \`resumeRunId: "${ctx.runId}"\` and \`approveSeams: true\`. To change the seams, pass \`seams: [...]\` instead of \`approveSeams\`.`,
          ].join("\n");
          const leak = findSecretInText(comment);
          if (leak) return { ...base, status: "secret-blocked", reason: `${leak} in the seams comment` };
          const existing = JSON.parse(await cmd.gh(ctx.cwd, "issue", "view", String(issue.number), ...repoFlag, "--json", "comments")) as { comments: Array<{ body: string }> };
          if (!existing.comments.some((c) => c.body.includes(SEAMS_MARKER) && c.body.includes(ctx.runId))) {
            await withBodyFile(comment, (f) => cmd.gh(ctx.cwd, "issue", "comment", String(issue.number), ...repoFlag, "--body-file", f));
          }
          return { ...base, status: "seams-proposed", runId: ctx.runId, seams: plan.seams, slices: plan.slices, next: relaunch };
        }
      }

      // ── Implementação (tdd): worktree, base verde, fatias red → green ──────────────────
      ctx.phase("Implementation");
      // Cada run tem a sua branch e o seu worktree, com o id do run no nome. O worktree só é reaproveitado pelo run que o registrou.
      const legacy = !progress.data.worktree && progress.data.baseCommit !== undefined; // run começado quando a branch era `wf/issue-<n>`, fixa
      const branch = progress.data.branch ?? (legacy ? issueBranch(issue.number) : runBranch(issue.number, ctx.runId));
      const worktree = progress.data.worktree ?? worktreeOf(ctx.cwd, branch);
      if (!progress.data.worktree) {
        // Nada deste run ainda. O que estiver no lugar dele não foi criado por ele (com o id do run no nome, só sobra um run apagado ou um engano): não se reaproveita.
        if (!legacy && (existsSync(worktree) || (await branchExists(cmd, ctx.cwd, branch)))) {
          throw new Error(`${worktree} (branch ${branch}) already exists and was not created by this run: remove it, or run again under another run id`);
        }
        progress.data.branch = branch; // registrado antes de criar: uma queda no meio do `worktree add` ainda é deste run
        progress.data.worktree = worktree;
        progress.save();
      }
      if (existsSync(worktree) && !(await isWorktreeRoot(cmd, worktree))) {
        // O run registrou este caminho, mas ele não é um worktree: o `git worktree add` caiu no meio. Um git rodado ali agiria no repositório em volta.
        ctx.log(`${worktree} is the run's, but is not a worktree (an interrupted \`git worktree add\`); removing it to create it again`);
        rmSync(worktree, { recursive: true, force: true });
        await cmd.git(ctx.cwd, "worktree", "prune");
      }
      if (existsSync(worktree)) ctx.log(`worktree ${worktree} is this run's; reusing it`);
      else if (await branchExists(cmd, ctx.cwd, branch)) await cmd.git(ctx.cwd, "worktree", "add", worktree, branch); // resume: mantém os commits
      else {
        // Nem o worktree nem a branch: ou o run ainda não os fez, ou alguém os removeu (`wf gc`, ou à mão). Refazê-los vazios,
        // com fatias já dadas como prontas, entregaria uma árvore vazia por cima do trabalho (o push dela tem o lease do próprio run).
        const worked = progress.data.slices.length;
        if (progress.data.baseCommit && worked) {
          throw new Error(
            `${worktree} and its branch ${branch} are gone, and the run had already worked in them (slices recorded: ${worked}): they were removed, by \`wf gc\` or by hand, so this run cannot go on. Start a new run`,
          );
        }
        await cmd.git(ctx.cwd, "worktree", "add", "-b", branch, worktree, progress.data.baseCommit ?? (await defaultBranchHead(cmd, ctx.cwd)));
      }
      if (!progress.data.baseCommit) {
        progress.data.baseCommit = (await cmd.gitRead(worktree, "rev-parse", "HEAD")).trim();
        progress.save();
      }
      // Uma etapa de escrita interrompida (o processo caiu no meio, ou o run foi cancelado nela): volta ao estado de antes dela.
      if (progress.data.inFlight) {
        const { id, before, interrupted, execution: startedIn } = progress.data.inFlight;
        // Só uma queda conta para o limite: numa etapa `interrupted` o código estava vivo (um cancelamento, um erro que subiu), e
        // numa cuja execução terminou cancelada também (o engine encerra o run cancelado sem esperar este código chegar ao catch,
        // e o `wf` sai logo depois: a marca pode não ter sido escrita). Um job congelado que o cancelamento matou (SIGKILL) não
        // grava o fim do run: o registro do job diz que foi o cancelamento (`wasKilledByCancel`), e isso também não é queda.
        // A queda é contada antes de desfazer, e o registro passa a `interrupted`: um cancelamento no meio do desfazer não a
        // perde nem a conta de novo.
        const began = startedIn === undefined ? undefined : executionsOf(ctx.cwd, ctx.runId)[startedIn - 1];
        const cancelled = began !== undefined && (began.ended === "cancelled" || (began.jobId !== undefined && wasKilledByCancel(ctx.cwd, began.jobId)));
        if (!interrupted && !cancelled) {
          progress.data.crashes = { ...progress.data.crashes, [id]: (progress.data.crashes?.[id] ?? 0) + 1 };
          progress.data.inFlight = { id, before, interrupted: true };
          progress.save();
        }
        ctx.log(`undoing the interrupted step ${id}`);
        await revertTo(cmd, worktree, before);
        progress.data.inFlight = undefined;
        progress.save();
      }
      // Uma etapa que já derrubou o processo mais vezes que o limite não é retomada de novo (o worktree já voltou ao estado de antes dela).
      const looping = Object.entries(progress.data.crashes ?? {}).find(([, crashes]) => crashes > settings.maxStepCrashes);
      if (looping) {
        const [step, crashes] = looping;
        ctx.log(`step ${step} crashed the process ${crashes} times (limit ${settings.maxStepCrashes}): not resuming it again`);
        return {
          ...base,
          status: "step-crash-loop",
          step,
          crashes,
          limit: settings.maxStepCrashes,
          worktree,
          hint: "find what makes this step kill the process, or raise workflows.implement-issue.settings.maxStepCrashes in the config and resume the run; a new run starts the count again",
        };
      }
      const testCommand = ctx.args.testCommand ?? plan.testCommand ?? "npm test";
      const suite = (label: string) => runTests(cmd, testCommand, worktree, { timeoutMs: testTimeout, label: `suite:${label}` });
      if (!progress.data.baselineGreen) {
        if (ctx.args.setupCommand) {
          const setup = await runTests(cmd, ctx.args.setupCommand, worktree, { timeoutMs: testTimeout, label: "setup" });
          if (!setup.ok) return { ...base, status: "setup-failed", worktree, output: setup.output };
        }
        const baseline = await suite("baseline");
        if (baseline.kind === "timeout" || baseline.kind === "killed") return { ...base, status: `tests-${baseline.kind}`, worktree, output: baseline.output };
        if (!baseline.ok && !looksLikeNoTests(baseline.output)) return { ...base, status: "baseline-red", worktree, output: baseline.output };
        if (!baseline.ok) ctx.log("the baseline suite has no tests: counted as green");
        progress.data.baselineGreen = true;
        progress.save();
      }

      /**
       * Etapa que escreve: snapshot antes, registro "em andamento" no progresso e um número de sequência no prompt.
       * O número faz cada execução ser nova para o journal: o efeito de uma etapa está no worktree, não na resposta
       * guardada. Se o agente falhar, a etapa é desfeita antes de o erro subir.
       */
      const writeStep = async <T>(id: string, prompt: string, opts: AgentCallOptions): Promise<{ value: T; before: string }> => {
        const before = await snapshotTree(cmd, worktree);
        const seq = (progress.data.writeSeq ?? 0) + 1;
        progress.data.writeSeq = seq;
        execution ??= executionsOf(ctx.cwd, ctx.runId).length; // esta execução: a última do log, que o engine abriu antes do run
        progress.data.inFlight = { id, before, execution };
        progress.save();
        try {
          // revertOnRetry: o worktree é só desta etapa, e uma nova tentativa não pode herdar o que a que falhou deixou.
          const value = await ctx.agent<T>(`${prompt}\n\n<!-- write step ${seq} -->`, { ...opts, cwd: worktree, revertOnRetry: true });
          return { value, before };
        } catch (err) {
          try {
            await revertTo(cmd, worktree, before);
            settle();
          } catch {
            // O desfazer falhou (o run foi cancelado, ou o git travou): o erro da etapa é o que sobe, e o registro "em andamento" fica,
            // para o resume voltar ao snapshot de antes dela. O catch do run o marca `interrupted`: o processo não caiu.
          }
          throw err;
        }
      };
      const settle = () => {
        progress.data.inFlight = undefined;
        progress.save();
      };
      /** O que uma etapa de código (green, correção, refactor) não pode mudar. Vazio = nenhuma violação. */
      const codeViolation = async (before: string, after: string, rec?: SliceRecord): Promise<string> => {
        const changed = await changedBetween(cmd, worktree, before, after);
        const tests = changed.filter(isTest);
        const guarded = changed.filter((f) => matchesAny(f, protectedGlobs));
        const problems: string[] = [];
        if (tests.length) problems.push(`changed test files (${tests.join(", ")})`);
        if (guarded.length) problems.push(`changed the runner configuration (${guarded.join(", ")})`);
        if (await runnerConfigChanged(cmd, worktree, before, after)) problems.push("changed the scripts or the test configuration in package.json");
        if (rec?.testFile && fileHash(worktree, rec.testFile) !== rec.testHash) problems.push(`the slice's test (${rec.testFile}) changed or is gone`);
        return problems.length ? `You ${problems.join("; ")}. The change was undone: the test is the specification, change only the code.` : "";
      };

      let tddRetries = 0;
      let redUnattributed = 0;
      let redDiscarded = 0;
      /** O motivo da última violação, devolvido no resultado de tdd-violation e test-not-red. */
      let lastProblem = "";
      /** Um ciclo red → green. Devolve um status de falha (com o worktree de volta ao último estado verde), ou undefined. */
      const runSlice = async (key: string, sfx: string, sl: Slice): Promise<string | undefined> => {
        const rec: SliceRecord = progress.slice(key) ?? { key, behavior: sl.behavior, seam: sl.seam, done: false };
        if (rec.done) return undefined; // resume: fatia já verde

        // red: um teste (ou a atualização dos que fixam o comportamento antigo); a suíte tem de falhar
        if (!rec.red) {
          let problem = "";
          for (let attempt = rec.redAttempt ?? 1; attempt <= settings.redGreenAttempts && !rec.red; attempt++) {
            if (attempt > 1) tddRetries++;
            rec.redAttempt = attempt;
            progress.upsert(rec);
            const { value: t, before } = await writeStep<TestOut>(
              `red:${key}:${attempt}`,
              `${P.TEST_INSTRUCTIONS}\n\n${issueBlock(issue)}\n\n${sliceBlock(sl)}\n\n## Test command\n\`${testCommand}\`${problem ? `\n\n## Fix\n${problem}` : ""}`,
              { label: attempt === 1 ? `test-${sfx}` : `test-${sfx}:${attempt}`, role: implementRole(tier), schema: TEST_SCHEMA },
            );
            let after = await snapshotTree(cmd, worktree);
            const changes = await changesBetween(cmd, worktree, before, after);
            // O que não é teste (implementação, stub, configuração) é descartado pelo código: o teste fica e tem de
            // falhar sozinho. Medido: o composer-2.5 implementou junto com o teste nas duas tentativas da issue #7.
            const nonTest = changes.filter((c) => !isTest(c.path)).map((c) => c.path);
            if (nonTest.length) {
              await restorePaths(cmd, worktree, before, nonTest);
              redDiscarded += nonTest.length;
              ctx.log(`slice ${sfx}: the red step changed ${nonTest.join(", ")}; those changes were discarded, only the test stays`);
              after = await snapshotTree(cmd, worktree);
            }
            const deleted = changes.filter((c) => c.status === "D" && isTest(c.path)).map((c) => c.path);
            if (deleted.length || await runnerConfigChanged(cmd, worktree, before, after)) {
              await revertTo(cmd, worktree, before);
              settle();
              problem =
                `The change was undone: ${deleted.length ? `you deleted tests (${deleted.join(", ")})` : "you changed the runner configuration"}. ` +
                "Write or update tests, without deleting any.";
              lastProblem = problem;
              if (attempt === settings.redGreenAttempts) return "tdd-violation";
              continue;
            }
            const res = await suite(`red:${sfx}`);
            if (res.kind === "timeout" || res.kind === "killed") {
              await revertTo(cmd, worktree, before);
              settle();
              return `tests-${res.kind}`;
            }
            if (res.ok) {
              if (t.alreadySatisfied) {
                settle(); // o comportamento já existia: o teste fica como regressão, sem etapa de código
                Object.assign(rec, { testFile: t.testFile, testName: t.testName, alreadySatisfied: t.evidence ?? "confirmed by the test step", green: res.output, done: true });
                progress.upsert(rec);
                return undefined;
              }
              await revertTo(cmd, worktree, before);
              settle();
              problem =
                "The test passed without implementation. If the behaviour already exists, answer alreadySatisfied: true with the evidence; " +
                "otherwise, write a test that fails because the slice's behaviour is missing.";
              lastProblem = problem;
              if (attempt === settings.redGreenAttempts) return "test-not-red";
              continue;
            }
            settle();
            if (!res.output.includes(t.testName) && !res.output.includes(basename(t.testFile))) {
              redUnattributed++;
              ctx.log(`slice ${sfx}: the red output does not name ${t.testName}; check that the failure comes from the new test`);
            }
            Object.assign(rec, { testFile: t.testFile, testName: t.testName, red: res.output, redTree: after, testHash: fileHash(worktree, t.testFile) });
            progress.upsert(rec);
          }
          if (!rec.red) return "test-not-red";
        }

        // green: o mínimo de código; nada de testes, runner ou teste da fatia; a suíte tem de passar
        if (!rec.greenDone) {
          let problem = "";
          for (let attempt = rec.greenAttempt ?? 1; attempt <= settings.redGreenAttempts && !rec.greenDone; attempt++) {
            if (attempt > 1) tddRetries++;
            rec.greenAttempt = attempt;
            progress.upsert(rec);
            const { before } = await writeStep<Impl>(
              `green:${key}:${attempt}`,
              `${P.CODE_INSTRUCTIONS}\n\n${issueBlock(issue)}\n\n${sliceBlock(sl)}\n\n## Failing test\n\`${rec.testName}\` in \`${rec.testFile}\`\n\n## Suite output\n${tail(rec.red)}${problem ? `\n\n## Fix\n${problem}` : ""}`,
              { label: attempt === 1 ? `code-${sfx}` : `code-${sfx}:${attempt}`, role: implementRole(tier), schema: IMPL_SCHEMA },
            );
            problem = await codeViolation(before, await snapshotTree(cmd, worktree), rec);
            if (problem) {
              lastProblem = problem;
              await revertTo(cmd, worktree, before);
              settle();
              if (attempt === settings.redGreenAttempts) return "tdd-violation";
              continue;
            }
            settle();
            rec.greenDone = true;
            progress.upsert(rec);
          }
          if (!rec.greenDone) return "tdd-violation";
        }
        let res = await suite(`green:${sfx}`);
        // Uma rodada só conta quando a etapa de correção dela chega ao fim (`fixRound` é gravado depois do settle). Interrompida
        // antes (cancelamento, queda, falha do agente), o resume desfaz a etapa e refaz a MESMA rodada, como o red e o green
        // refazem a mesma tentativa; com o mesmo id, uma etapa que derruba o processo chega ao `maxStepCrashes`. Interrompida
        // na suíte depois do settle, a correção fica no worktree e a suíte do green do resume é a desta rodada.
        for (let round = (rec.fixRound ?? 0) + 1; res.kind === "failed" && round <= settings.fixRounds; round++) {
          ctx.log(`slice ${sfx}: tests failed; fix ${round}/${settings.fixRounds}`);
          const { before } = await writeStep<Impl>(`fix:${key}:${round}`, `${P.FIX_INSTRUCTIONS}\n\n${sliceBlock(sl)}\n\n## Test output\n${res.output}`, {
            label: `fix-${sfx}-${round}`,
            role: "fix",
            model: tier === "LOW" ? GROK : GROK_HIGH, // escala o modelo na correção
            schema: IMPL_SCHEMA,
          });
          lastProblem = await codeViolation(before, await snapshotTree(cmd, worktree), rec);
          if (lastProblem) {
            await revertTo(cmd, worktree, before);
            settle();
            return "tdd-violation";
          }
          // settle e rodada contada numa só gravação: nenhuma queda entre as duas desfaz uma correção já contada.
          progress.data.inFlight = undefined;
          rec.fixRound = round;
          progress.upsert(rec);
          res = await suite(`fix:${sfx}:${round}`);
        }
        if (res.kind === "timeout" || res.kind === "killed") return `tests-${res.kind}`;
        if (!res.ok) return "tests-failed";
        Object.assign(rec, { green: res.output, done: true });
        progress.upsert(rec);
        return undefined;
      };
      /** Falha de fatia: o worktree volta ao estado do começo dela (verde), para o resume e para quem inspeciona. */
      const sliceStart = () => snapshotTree(cmd, worktree);

      const planned = plan.slices.slice(0, sliceCap);
      const deferred = plan.slices.slice(sliceCap).map((s) => `${s.behavior} (seam: ${s.seam})`);
      if (deferred.length) ctx.log(`cap of ${sliceCap} slices at tier ${tier}: ${deferred.length} deferred`);
      ctx.metric("slices_planned", plan.slices.length);
      for (const [i, sl] of planned.entries()) {
        const start = await sliceStart();
        const failed = await runSlice(sliceKey("s", sl.behavior, sl.seam), String(i + 1), sl);
        if (failed) {
          if (failed !== "tdd-violation" && failed !== "test-not-red") await revertTo(cmd, worktree, start);
          return { ...base, status: failed, slice: i + 1, reason: lastProblem || undefined, worktree };
        }
      }

      // ── Review (code-review + Segurança): três eixos separados, sempre ─────────────────
      ctx.phase("Review");
      const reports: ReviewReports = {};
      const standardsFiles = STANDARDS_FILES.filter((f) => existsSync(join(worktree, f)));
      /** Uma rodada de review. O resultado fica no progresso: o resume o reaproveita em vez de pedir outro. */
      const review = async (axes: Axis[], round: number): Promise<boolean> => {
        const pinned = progress.data.reviews?.[`r${round}`] as ReviewReports | undefined;
        if (pinned) {
          Object.assign(reports, pinned);
          return true;
        }
        const diff = await diffSinceBase(cmd, worktree, progress.data.baseCommit!, settings.maxDiffChars);
        const extra: Record<Axis, string> = {
          standards: listBlock("Repository standards files", standardsFiles) || "## Repository standards files\nNone: use only the smell baseline.",
          spec: listBlock("Slices deferred by the cap (not 'missing')", deferred),
          security: "",
        };
        // A rodada entra no prompt: sem ela, a rodada 2 de um resume teria a mesma chave de journal da rodada 1 e
        // receberia a resposta antiga. Na rodada 2 o revisor vê também a resposta da correção (o agente pode discordar).
        const roundBlock =
          round === 1 ? "## Round 1" : `## Round ${round}, after the fix\n${progress.data.refactorSummary ?? "Extra slices only: see the diff."}`;
        const results = await ctx.parallel(
          axes.map((axis) => () =>
            ctx.agent<any>(`${AXIS_INSTRUCTIONS[axis]}\n\n${extra[axis]}\n\n${issueBlock(issue)}\n\n${roundBlock}\n\n## Diff since the base\n${diff}`, {
              label: `review:${axis}:${round}`,
              phase: "Review",
              role: "review",
              cwd: worktree,
              tools: REVIEW_TOOLS,
              schema: AXIS_SCHEMAS[axis],
              memo: true, // o mesmo diff na mesma rodada não paga de novo
            }),
          ),
        );
        // Review exigido que não rodou não pode virar "sem achados".
        if (results.some((r) => r === null)) return false;
        const got: ReviewReports = {};
        axes.forEach((a, i) => ((got as Record<Axis, unknown>)[a] = results[i]));
        Object.assign(reports, got);
        progress.data.reviews = { ...(progress.data.reviews ?? {}), [`r${round}`]: got };
        progress.save();
        return true;
      };
      if (!(await review(AXES, 1))) return { ...base, status: "review-failed", worktree };
      for (const a of AXES) ctx.metric(`review_${a}_findings`, reports[a]?.findings.length ?? 0);
      const redo = blockingAxes(reports);
      ctx.metric("review_blocking_axes", redo.length);
      const refuted: string[] = [];
      if (redo.length) {
        const b = blockingOf(reports);
        // Requisito faltando ou errado: comportamento novo, então nova fatia TDD (red → green), com teto.
        for (const [i, f] of [...b.missing, ...b.wrong].slice(0, settings.extraSlices).entries()) {
          const behavior = f.behavior ?? f.note;
          const seam = f.seam ?? "the closest public interface";
          const key = sliceKey("x", behavior, seam);
          const start = await sliceStart();
          const failed = await runSlice(key, `extra-${i + 1}`, { behavior, seam, testIdea: `issue requirement: "${f.quote}"` });
          if (failed) {
            if (failed !== "tdd-violation" && failed !== "test-not-red") await revertTo(cmd, worktree, start);
            return { ...base, status: failed, slice: `extra-${i + 1}`, reason: lastProblem || undefined, worktree };
          }
          const rec = progress.slice(key);
          if (rec?.alreadySatisfied) refuted.push(`${behavior}: ${rec.alreadySatisfied}`); // o review se enganou
        }
        // Padrão e segurança: refactor, sem tocar testes e com a suíte verde.
        const toRefactor = [...b.standards, ...b.security];
        if (toRefactor.length && !progress.data.refactorDone) {
          const { value: fix, before } = await writeStep<Impl>(
            "refactor",
            `${P.REFACTOR_INSTRUCTIONS}\n\n${issueBlock(issue)}\n\n## Findings\n${JSON.stringify(toRefactor, null, 2)}`,
            { label: "refactor-1", role: implementRole(tier), schema: IMPL_SCHEMA },
          );
          const refactorProblem = await codeViolation(before, await snapshotTree(cmd, worktree));
          if (refactorProblem) {
            await revertTo(cmd, worktree, before);
            settle();
            return { ...base, status: "tdd-violation", step: "refactor-1", reason: refactorProblem, worktree };
          }
          const after = await suite("refactor");
          if (!after.ok) {
            await revertTo(cmd, worktree, before); // volta ao último verde
            settle();
            // Como em toda suíte: passar do teto ou morrer por um sinal não é uma suíte vermelha.
            const status = after.kind === "timeout" || after.kind === "killed" ? `tests-${after.kind}` : "tests-failed-after-review";
            return { ...base, status, worktree, output: after.output };
          }
          settle();
          progress.data.refactorDone = true;
          progress.data.refactorSummary = fix.summary;
          progress.save();
        }
        if (!(await review(redo, 2))) return { ...base, status: "review-failed", worktree };
        if (blockingAxes(reports).length) return { ...base, status: "review-blocking", worktree, findings: blockingOf(reports) };
      }
      ctx.metric("tdd_retries", tddRetries);
      ctx.metric("red_unattributed", redUnattributed);
      ctx.metric("red_discarded_files", redDiscarded);
      ctx.metric("slices_done", progress.data.slices.filter((s) => s.done).length);

      // ── Entrega (pr): suíte verde, commit e PR feitos pelo código; idempotentes no resume ─
      ctx.phase("Delivery");
      const final = await suite("final");
      if (!final.ok) return { ...base, status: final.kind === "failed" ? "tests-failed" : `tests-${final.kind}`, worktree, output: final.output };
      const baseCommit = progress.data.baseCommit!;
      const head = (await cmd.gitRead(worktree, "rev-parse", "HEAD")).trim();
      const deliveryMessage = `feat: ${issue.title} (#${issue.number})`;
      if (head !== progress.data.deliveredCommit) {
        // Commits feitos por agentes (a instrução pede para não fazer) são desfeitos, mantendo a árvore.
        if (head !== baseCommit) await cmd.git(worktree, "reset", "--soft", baseCommit);
        await cmd.git(worktree, "add", "-A");
        const secret = await findStagedSecret(cmd, worktree, undefined, baseCommit);
        if (secret) {
          // Nada de commit, push ou PR. O worktree fica para inspeção; o motivo não repete o segredo.
          ctx.metric("secret_blocked", 1);
          ctx.log(`delivery blocked: ${secret}`);
          return { ...base, status: "secret-blocked", reason: secret, branch, worktree, spentCents: ctx.budget.spentCents() };
        }
        if (!(await cmd.gitIs(worktree, "diff", "--cached", "--quiet"))) await cmd.git(worktree, "commit", "-m", deliveryMessage);
        progress.data.deliveredCommit = (await cmd.gitRead(worktree, "rev-parse", "HEAD")).trim();
        progress.save();
      }
      let prUrl: string | undefined;
      if (openPr) {
        prUrl = await existingPr(cmd, branch, repoFlag, worktree);
        let body: string | undefined; // sem PR ainda: o texto e a trava de segredos vêm ANTES do push, e o PR só depois dele
        if (!prUrl) {
          const text = await ctx.agent<PrText>(
            `${P.PR_INSTRUCTIONS}\n\n${contextBlock}\n\n${issueBlock(issue)}\n\n## Diff\n${await diffSinceBase(cmd, worktree, baseCommit, settings.maxDiffChars)}`,
            { label: "pr-text", role: "pr-text", cwd: worktree, tools: REVIEW_TOOLS, schema: PR_SCHEMA, memo: true },
          );
          body = buildPrBody({
            issueNumber: issue.number,
            text,
            slices: progress.data.slices,
            review: reports,
            deferred,
            refuted,
            worktree,
            redact: createRedactor({ extra: savedSecrets() }).text, // the saved Cursor key is in no env var
          });
          const leak = findSecretInText(body);
          if (leak) return { ...base, status: "secret-blocked", reason: `${leak} in the PR body`, branch, worktree };
        }
        const refused = await pushDelivery(cmd, progress, worktree, branch, repo, deliveryMessage);
        if (refused) return { ...base, status: "push-refused", reason: refused, branch, worktree };
        if (body !== undefined) {
          prUrl = (await withBodyFile(body, (f) => cmd.gh(worktree, "pr", "create", "--head", branch, "--title", `${issue.title} (#${issue.number})`, "--body-file", f, ...repoFlag))).trim();
        }
      }
      ctx.card(issueCard(issue, tier, { subtitle: branch, links: prUrl ? [{ label: prLabel(prUrl), url: prUrl }] : undefined }));
      return {
        ...base,
        status: "done",
        branch,
        worktree,
        prUrl,
        slices: progress.data.slices.filter((s) => s.done).map((s) => ({ behavior: s.behavior, test: s.testName, alreadySatisfied: Boolean(s.alreadySatisfied) })),
        deferred,
        refutedFindings: refuted,
        review: Object.fromEntries(AXES.map((a) => [a, { findings: reports[a]?.findings.length ?? 0, worst: reports[a]?.worst ?? "" }])),
        spentCents: ctx.budget.spentCents(),
      };
    } catch (err) {
      // Um erro que chega aqui (um cancelamento no meio da suíte, de um snapshot ou de uma checagem de uma etapa de escrita; um git
      // que estourou o teto) passou por este código: o processo está vivo. A etapa em andamento que esta execução começou fica para
      // o resume desfazer, marcada `interrupted`, e não conta como queda para `maxStepCrashes`. A de uma execução anterior não é
      // tocada: se ela derrubou o processo, a queda ainda tem de ser contada.
      const step = progress.data.inFlight;
      if (step && !step.interrupted && execution !== undefined && step.execution === execution) {
        progress.data.inFlight = { ...step, interrupted: true };
        progress.save();
      }
      throw err;
    } finally {
      releaseIssue();
    }
  },
});
