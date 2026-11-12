// Workflow de referência: implementar uma issue do GitHub de ponta a ponta, seguindo em código os fluxos das skills
// tdd e codebase-design (implementação), code-review (review) e pr (corpo do PR) de mattpocock/skills (MIT). As
// instruções estão em workflows/implement-issue/prompts.ts; créditos em docs/vision/02-a-ideia-e-as-referencias.md.
//
// O que é decidido em CÓDIGO (não pelo modelo):
//   - o tier (LOW/MED/HIGH) vem das labels da issue; só sem label um classificador barato decide;
//   - MED: um planejador define seams e fatias verticais; HIGH: três designers desenham a interface de formas
//     radicalmente diferentes e um juiz escolhe ou combina ("Design it twice"); LOW: uma fatia, sem planejador;
//   - MED/HIGH param depois do plano (status "seams-proposed", comentário na issue, plano guardado no progresso do
//     run): o segundo run, com `--resume <runId>` e `approveSeams: true`, executa EXATAMENTE o plano proposto; com
//     `seams: [...]`, refaz o plano com as seams dadas. A skill tdd manda combinar as seams antes dos testes, e o
//     runtime não pausa para perguntar. Sem plano proposto no progresso (outro runId ou outro --cwd), `approveSeams`
//     para com "seams-not-proposed" em vez de aprovar um plano novo; para pular o checkpoint, passe `seams`;
//   - a suíte tem de estar verde antes da primeira fatia ("baseline-red"; um runner sem nenhum teste conta como
//     verde); `setupCommand` opcional antes; os testes têm teto de tempo ("tests-timeout");
//   - cada fatia é um ciclo red → green controlado pelo código. Red: o que a etapa mudar fora dos testes é
//     descartado (medido: o composer-2.5 implementa junto com o teste), nenhum teste é apagado, e a suíte FALHA (ou a etapa declara, com a suíte verde, que o
//     comportamento já existia). Green, correções e refactor: nenhum teste, configuração do runner (`protectedGlobs`,
//     scripts do package.json) ou o teste da fatia muda, e a suíte PASSA. Quem tocou o quê vem de snapshots de
//     árvore git antes e depois de cada etapa (sem detecção de renomeação); violação desfaz a etapa e tenta de novo
//     uma vez ("tdd-violation" na segunda);
//   - o progresso (fatias, saídas red/green, plano proposto, relatórios de review, etapa de escrita em andamento)
//     fica em .workflows/runs/<runId>/tdd-progress.json. O resume desfaz uma etapa interrompida, não refaz nem
//     reconfere o que passou, e reaproveita o review já feito. Etapas que escrevem nunca vêm do journal: o efeito
//     delas está no worktree, e cada uma leva um número de sequência no prompt;
//   - o review roda sempre, em três eixos separados e em paralelo (Standards, Spec, Segurança), sem misturar nem
//     reordenar relatórios. Bloqueia: padrão documentado violado, requisito faltando ou errado, falha de segurança.
//     Requisito faltando ou errado vira fatia TDD extra (até 2); padrão e segurança viram refactor sem tocar testes;
//     depois, só os eixos que bloquearam são revistos ("review-blocking" se continuar);
//   - antes do commit a suíte roda de novo (vermelha → "tests-failed"); commits feitos por agentes são desfeitos
//     (`reset --soft` para a base, mantendo a árvore); a trava de segredos olha o diff desde a base, o comentário
//     das seams e o corpo do PR ("secret-blocked");
//   - o corpo do PR segue o template da skill pr; a Evidence é a saída real red → green de cada fatia, sem caminhos
//     locais; com fatias adiadas, o PR só referencia a issue (`Refs`) em vez de fechá-la.
//
// Custo por etapa (passo 4 da /skill-to-workflow). "[]" = settingSources vazio: sem AGENTS.md, regras, hooks, MCP e
// sem as skills que o SDK carrega com qualquer outra camada (medido: 58).
//   etapa            modelo                 tools                    settingSources   memo
//   classificar      composer-2.5           nenhuma                  []               sim
//   planejar (MED)   grok-4.7               só leitura               []               sim
//   desenhar ×3      composer-2.5           só leitura               []               sim
//   julgar (HIGH)    grok-4.7 high          só leitura               []               sim
//   teste-N          do tier                todas                    default          não
//   codigo-N         do tier                todas                    default          não
//   corrigir-N-R     tier acima             todas                    default          não
//   review ×3        grok-4.7 high          só leitura, sem shell    []               sim (o diff e a rodada no prompt)
//   refatorar-1      do tier                todas                    default          não
//   pr-texto         composer-2.5           só leitura, sem shell    []               sim
// Exceção ao checklist (docs/08 §6): as etapas que escrevem ficam com todas as tools, "task" inclusive, e o default
// do engine (project, team, mdm). A allowlist de escrita do SDK ainda não foi medida, e os hooks do time e do MDM
// têm de valer onde o agente escreve.
// Agentes por caminho, típico (sem retentativas nem achados) e pior caso (2 tentativas por etapa, 2 correções por
// fatia, 2 fatias extras, refactor, re-review). Teto padrão: 3 milhões de tokens (`budget`); --max-tokens troca:
//   LOW   típico 6  (1 fatia + 3 reviews + PR)                     pior caso ~26
//   MED   típico 11 (plano; até 3 fatias + 3 reviews + PR)          pior caso ~39
//   HIGH  típico 20 (3 designers + juiz; até 5 fatias + ...)        pior caso ~55
// Tokens medidos (docs/research/verificacoes-locais.md §13): LOW 339 mil (6 agentes); MED 769 mil nos dois runs
// (9 agentes, 2 fatias); um MED com 3 fatias e 2 adiadas, antes do teto no prompt do planejador, gastou 887 mil.
// Fora de agentes (zero tokens): leitura da issue, roteamento, git, testes, diff, comentário, commit e PR.
//
// IDs de modelo: confirme os seus com `npm run models`. Os defaults são modelos do Cursor (Composer e Grok), que os
// planos pagos da The X Subscription incluem na franquia semanal; modelos de terceiros exigem crédito pré-pago
// (medido). Em planos legados e no Enterprise, troque por WF_MODEL_* (só o ID; os params ficam de fora).
//
// STATUS: LOW e MED verificados contra a API real em 2026-11-11 (docs/research/verificacoes-locais.md §13). HIGH, o
// review que bloqueia e o alreadySatisfied só têm testes offline.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ModelSelection, SettingSource } from "@cursor/sdk";
import { defineWorkflow, type AgentCallOptions } from "../src/runtime/workflow.js";
import { buildPrBody, type PrText } from "./implement-issue/pr-body.js";
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

export { runTests } from "./implement-issue/tdd.js";

type Tier = "LOW" | "MED" | "HIGH";

const HIGH_EFFORT = [{ id: "reasoning_effort", value: "high" }];
const pick = (env: string | undefined, fallback: ModelSelection): ModelSelection => (env ? { id: env } : fallback);
const MODELS: Record<Tier | "REVIEW" | "CLASSIFY", ModelSelection> = {
  CLASSIFY: pick(process.env.WF_MODEL_CLASSIFY, { id: "composer-2.5" }),
  LOW: pick(process.env.WF_MODEL_LOW, { id: "composer-2.5" }),
  MED: pick(process.env.WF_MODEL_MED, { id: "grok-4.7" }),
  HIGH: pick(process.env.WF_MODEL_HIGH, { id: "grok-4.7", params: HIGH_EFFORT }),
  REVIEW: pick(process.env.WF_MODEL_REVIEW, { id: "grok-4.7", params: HIGH_EFFORT }),
};

/** Labels da issue → tier. Ajuste ao vocabulário do seu time. */
const LABEL_TIERS: Record<string, Tier> = {
  "complexity:low": "LOW",
  "good first issue": "LOW",
  "complexity:medium": "MED",
  "complexity:high": "HIGH",
  security: "HIGH",
};

const SLICE_CAP: Record<Tier, number> = { LOW: 1, MED: 3, HIGH: 5 };
const EXTRA_SLICE_CAP = 2;
const MAX_FIX_ROUNDS = 2;
const READ_ONLY = ["read", "grep", "glob", "ls", "semSearch"];
const REVIEW_TOOLS = ["read", "grep", "glob", "ls"];
const NO_SETTINGS: SettingSource[] = [];
const MAX_DIFF_CHARS = 40_000;
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
  /** Teto de tempo de cada rodada de testes, em segundos (default 600). */
  testTimeoutSec?: number;
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
  "Classifique a complexidade de implementação da issue em LOW (mecânica, 1 arquivo), MED (típica) ou HIGH " +
  "(arquitetural, segurança, vários módulos). Responda só pela tool submit_result.";

const AXIS_INSTRUCTIONS: Record<Axis, string> = {
  standards: P.STANDARDS_INSTRUCTIONS,
  spec: P.SPEC_INSTRUCTIONS,
  security: P.SECURITY_INSTRUCTIONS,
};

const issueBlock = (i: { number: number; title: string; body: string }) => `## Issue #${i.number}: ${i.title}\n\n${i.body}`;
const sliceBlock = (s: Slice) => `## Fatia\n- Comportamento: ${s.behavior}\n- Seam: ${s.seam}\n- Ideia de teste: ${s.testIdea}`;
const listBlock = (title: string, items: string[]) => (items.length ? `## ${title}\n${items.map((f) => `- ${f}`).join("\n")}` : "");
const tail = (s: string | undefined, n = 3000) => (s ?? "").slice(-n);
/** Aspas simples para shell: o comando de relançamento postado na issue não quebra com `'` nos args. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const sh = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function hasStagedChanges(cwd: string): boolean {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], { cwd });
    return false; // exit 0 = nada staged
  } catch {
    return true;
  }
}

function existingPr(branch: string, repoFlag: string[], cwd: string): string | undefined {
  try {
    return sh("gh", ["pr", "view", branch, "--json", "url", "-q", ".url", ...repoFlag], cwd).trim() || undefined;
  } catch {
    return undefined;
  }
}

function branchExists(cwd: string, branch: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Escreve um corpo longo num arquivo temporário para `--body-file` (sem limite de argumento de linha de comando). */
function withBodyFile<T>(body: string, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "wf-body-"));
  const path = join(dir, "body.md");
  writeFileSync(path, body);
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Diff desde a base do worktree, para o review e o PR. Grande demais: estatística + início, e o agente lê o resto. */
function diffSinceBase(cwd: string, base: string): string {
  sh("git", ["add", "-A"], cwd);
  const diff = sh("git", ["diff", "--cached", "--no-color", base], cwd);
  if (diff.length <= MAX_DIFF_CHARS) return "```diff\n" + diff + "\n```";
  const stat = sh("git", ["diff", "--cached", "--stat", base], cwd);
  return `(diff truncado: leia os arquivos para o resto)\n\n${stat}\n\n\`\`\`diff\n${diff.slice(0, MAX_DIFF_CHARS)}\n\`\`\``;
}

/** Regras de segredo para qualquer texto que vai sair da máquina. Devolve a regra que disparou, nunca o trecho. */
export function findSecretInText(text: string, knownSecrets: string[] = savedSecrets()): string | undefined {
  if (/crsr_[A-Za-z0-9_-]{16,}/.test(text)) return "chave do Cursor (crsr_)";
  if (/\bsk-[A-Za-z0-9_-]{20,}/.test(text)) return "chave sk-";
  if (knownSecrets.some((k) => k.length >= 16 && text.includes(k))) return "a chave salva do SDK ou CURSOR_API_KEY";
  return undefined;
}

/**
 * Trava de segredos antes do commit. Uma issue com prompt injection poderia fazer uma etapa copiar
 * ~/.cursor/sdk/auth.json para o worktree, e o sandbox do SDK não restringe leitura. Olha o diff staged desde `base`
 * (default: HEAD, ou a árvore vazia num repo sem commits), para pegar também o que um agente tenha commitado. Devolve a regra que disparou, nunca o trecho.
 */
export function findStagedSecret(worktree: string, knownSecrets: string[] = savedSecrets(), base?: string): string | undefined {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: worktree, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  for (const name of git("diff", "--cached", "--name-only", ...(base ? [base] : [])).split("\n").filter(Boolean)) {
    const file = basename(name);
    if (file === "auth.json") return "arquivo auth.json no commit";
    if (file === ".env" || file.startsWith(".env.")) return "arquivo .env no commit";
  }
  const added = git("diff", "--cached", "--no-color", "-U0", ...(base ? [base] : []))
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n");
  const hit = findSecretInText(added, knownSecrets);
  return hit ? `${hit} no diff` : undefined;
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
      "Implementa uma issue do GitHub com TDD fatia a fatia (red → green conferido pelo código), review em três eixos (Standards, Spec, Segurança) e PR no template Summary/Evidence/Merge Danger.",
    whenToUse: "Quando o usuário pedir para implementar/resolver uma issue específica pelo número.",
    phases: [{ title: "Triagem" }, { title: "Plano" }, { title: "Implementação" }, { title: "Review" }, { title: "Entrega" }],
    argsSchema: {
      type: "object",
      required: ["issue"],
      additionalProperties: false,
      properties: {
        issue: { type: "number" },
        repo: { type: "string" },
        testCommand: { type: "string" },
        testTimeoutSec: { type: "number" },
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
    const { issue: number, repo, openPr = false } = ctx.args;
    const globs = ctx.args.testGlobs?.length ? ctx.args.testGlobs : DEFAULT_TEST_GLOBS;
    const protectedGlobs = ctx.args.protectedGlobs ?? DEFAULT_PROTECTED_GLOBS;
    const testTimeout = (ctx.args.testTimeoutSec ?? 600) * 1000;
    const isTest = (f: string) => isTestFile(f, globs);
    const progress = new ProgressStore(ctx.cwd, ctx.runId);

    // ── Triagem: dados da issue via gh (código, sem modelo) ─────────────────────────────
    ctx.phase("Triagem");
    const repoFlag = repo ? ["--repo", repo] : [];
    const issue = JSON.parse(sh("gh", ["issue", "view", String(number), ...repoFlag, "--json", "number,title,body,labels"], ctx.cwd)) as Issue;
    let tier = issue.labels.map((l) => LABEL_TIERS[l.name.toLowerCase()]).find(Boolean);
    if (!tier) {
      const c = await ctx.agent<{ tier: Tier; reason: string }>(`${CLASSIFY_INSTRUCTIONS}\n\n${issueBlock(issue)}`, {
        label: "classificar",
        model: MODELS.CLASSIFY,
        tools: [], // só texto: classificar não precisa ler o repositório
        settingSources: NO_SETTINGS, // sem AGENTS.md, hooks, MCP nem as skills que qualquer outra camada carrega (medido)
        memo: true,
        schema: CLASSIFY_SCHEMA,
      });
      tier = c.tier;
    }
    const base = { issue: issue.number, tier };
    ctx.log(`Issue #${issue.number} → tier ${tier} (modelo ${MODELS[tier].id})`);
    ctx.metric("tier", tier); // covariável de dificuldade: compare modelos dentro do mesmo tier
    ctx.metric("tier_source", issue.labels.some((l) => LABEL_TIERS[l.name.toLowerCase()]) ? "label" : "classifier");
    const ctxFiles = CONTEXT_FILES.filter((f) => existsSync(join(ctx.cwd, f)));
    const contextBlock = listBlock("Arquivos de contexto do repositório (leia os que importam)", ctxFiles);

    // ── Plano (codebase-design): LOW uma fatia; MED planejador; HIGH "Design it twice" ─────
    let plan: Plan;
    if (tier === "LOW") {
      plan = {
        seams: [{ name: "interface pública afetada", interface: "escolhida pela etapa de teste", why: "LOW: uma fatia, sem planejador" }],
        slices: [{ behavior: issue.title, seam: "a interface pública mais próxima do comportamento pedido", testIdea: "use um exemplo do enunciado da issue como valor esperado" }],
        testCommand: ctx.args.testCommand ?? "npm test",
      };
    } else if (ctx.args.approveSeams && !ctx.args.seams?.length && !progress.data.proposedPlan) {
      // Aprovar exige um plano mostrado: sem ele, um planejador novo produziria um plano que ninguém viu.
      return { ...base, status: "seams-not-proposed", runId: ctx.runId, hint: "rode sem approveSeams para propor as seams, ou retome o run que as propôs com o mesmo --cwd" };
    } else if (ctx.args.approveSeams && !ctx.args.seams?.length && progress.data.proposedPlan) {
      plan = progress.data.proposedPlan as Plan; // aprova exatamente o que foi mostrado na issue
      ctx.log("seams aprovadas: usando o plano proposto no primeiro run");
    } else {
      ctx.phase("Plano");
      const approved = listBlock("Seams aprovadas (use exatamente estas)", ctx.args.seams ?? []);
      // O planejador sabe o teto: sem isso, propôs 5 fatias para um tier de 3 na issue #8, e o PR saiu parcial.
      const capBlock =
        `## Limite de fatias\nEste tier faz até ${SLICE_CAP[tier]} fatias. Para a issue caber inteira, uma fatia pode cobrir ` +
        "casos de um mesmo comportamento que se testam juntos (o caso ímpar e o par de uma função; o valor e o erro). " +
        "Se ainda assim não couber, ponha por último o que pode ficar para depois.";
      const planData = `${issueBlock(issue)}\n\n${capBlock}\n\n${contextBlock}${approved ? `\n\n${approved}` : ""}`;
      if (tier === "MED") {
        plan = await ctx.agent<Plan>(`${P.PLAN_INSTRUCTIONS}\n\n${planData}`, {
          label: "planejar",
          model: MODELS.MED,
          tools: READ_ONLY,
          settingSources: NO_SETTINGS,
          schema: PLAN_SCHEMA,
          memo: true,
        });
      } else {
        const kinds = ["minima", "flexivel", "comum"] as const;
        const designs = await ctx.parallel(
          kinds.map((k) => () =>
            ctx.agent<Record<string, string>>(`${P.DESIGN_INSTRUCTIONS}\n\n## Restrição\n${P.DESIGN_CONSTRAINTS[k]}\n\n${issueBlock(issue)}\n\n${contextBlock}`, {
              label: `desenhar:${k}`,
              phase: "Plano",
              model: MODELS.CLASSIFY,
              tools: READ_ONLY,
              settingSources: NO_SETTINGS,
              schema: DESIGN_SCHEMA,
              memo: true,
            }),
          ),
        );
        const done = designs.flatMap((d, i) => (d ? [{ constraint: kinds[i], ...d }] : []));
        if (done.length < 2) return { ...base, status: "design-failed", designs: done.length };
        plan = await ctx.agent<Plan>(`${P.JUDGE_INSTRUCTIONS}\n\n${planData}\n\n## Desenhos\n${JSON.stringify(done, null, 2)}`, {
          label: "julgar",
          model: MODELS.HIGH,
          tools: READ_ONLY,
          settingSources: NO_SETTINGS,
          schema: PLAN_SCHEMA,
          memo: true,
        });
      }
      // tdd: seams combinadas antes de qualquer teste. O runtime não pausa: propõe na issue, guarda o plano e para.
      if (!ctx.args.seams?.length && !ctx.args.approveSeams) {
        progress.data.proposedPlan = plan;
        progress.save();
        const relaunch = `npm run wf -- run implement-issue --args ${shellQuote(JSON.stringify({ ...ctx.args, approveSeams: true }))} --resume ${ctx.runId}`;
        const comment = [
          SEAMS_MARKER,
          `## Seams propostas pelo workflow \`implement-issue\` (tier ${tier})`,
          "",
          ...plan.seams.map((s) => `- **${s.name}**: \`${s.interface}\` — ${s.why}`),
          "",
          "### Fatias (uma por ciclo red → green)",
          "",
          ...plan.slices.map(
            (s, i) => `${i + 1}. ${s.behavior} (seam: ${s.seam}; teste: ${s.testIdea})${i >= SLICE_CAP[tier] ? " (adiada)" : ""}`,
          ),
          ...(plan.slices.length > SLICE_CAP[tier]
            ? ["", `As fatias marcadas como adiadas ficam fora pelo limite do tier ${tier} (${SLICE_CAP[tier]} fatias): o PR só referencia a issue, sem fechá-la.`]
            : []),
          "",
          `Comando de teste: \`${ctx.args.testCommand ?? plan.testCommand}\``,
          ...(plan.rationale ? ["", `### Por que este desenho\n\n${plan.rationale}`] : []),
          "",
          "### Para aprovar",
          "",
          "Relance com os mesmos args e `approveSeams: true`, no mesmo diretório (ou com o mesmo `--cwd`) deste run; ele executa exatamente este plano:",
          "",
          "```bash",
          relaunch,
          "```",
          "",
          `No chat: \`/run-workflow implement-issue\` com \`resumeRunId: "${ctx.runId}"\` e \`approveSeams: true\`. Para trocar as seams, passe \`seams: [...]\` no lugar de \`approveSeams\`.`,
        ].join("\n");
        const leak = findSecretInText(comment);
        if (leak) return { ...base, status: "secret-blocked", reason: `${leak} no comentário das seams` };
        const existing = JSON.parse(sh("gh", ["issue", "view", String(issue.number), ...repoFlag, "--json", "comments"], ctx.cwd)) as { comments: Array<{ body: string }> };
        if (!existing.comments.some((c) => c.body.includes(SEAMS_MARKER) && c.body.includes(ctx.runId))) {
          withBodyFile(comment, (f) => sh("gh", ["issue", "comment", String(issue.number), ...repoFlag, "--body-file", f], ctx.cwd));
        }
        return { ...base, status: "seams-proposed", runId: ctx.runId, seams: plan.seams, slices: plan.slices, next: relaunch };
      }
    }

    // ── Implementação (tdd): worktree, base verde, fatias red → green ──────────────────
    ctx.phase("Implementação");
    const branch = `wf/issue-${issue.number}`;
    const worktree = join(ctx.cwd, ".workflows", "worktrees", branch.replace("/", "-"));
    if (existsSync(worktree)) ctx.log(`worktree ${worktree} já existe; reaproveitando`);
    else if (progress.data.baseCommit && branchExists(ctx.cwd, branch)) sh("git", ["worktree", "add", worktree, branch], ctx.cwd); // resume: mantém os commits
    else {
      if (branchExists(ctx.cwd, branch)) ctx.log(`branch ${branch} de um run anterior foi recriada a partir de HEAD`);
      sh("git", ["worktree", "add", "-B", branch, worktree], ctx.cwd);
    }
    if (!progress.data.baseCommit) {
      progress.data.baseCommit = sh("git", ["rev-parse", "HEAD"], worktree).trim();
      progress.save();
    }
    // Uma etapa de escrita interrompida (o processo caiu no meio): volta ao estado de antes dela.
    if (progress.data.inFlight) {
      ctx.log(`desfazendo a etapa interrompida ${progress.data.inFlight.id}`);
      revertTo(worktree, progress.data.inFlight.before);
      progress.data.inFlight = undefined;
      progress.save();
    }
    const testCommand = ctx.args.testCommand ?? plan.testCommand ?? "npm test";
    const suite = () => runTests(testCommand, worktree, testTimeout);
    if (!progress.data.baselineGreen) {
      if (ctx.args.setupCommand) {
        const setup = runTests(ctx.args.setupCommand, worktree, testTimeout);
        if (!setup.ok) return { ...base, status: "setup-failed", worktree, output: setup.output };
      }
      const baseline = suite();
      if (baseline.kind === "timeout" || baseline.kind === "overflow") return { ...base, status: `tests-${baseline.kind}`, worktree, output: baseline.output };
      if (!baseline.ok && !looksLikeNoTests(baseline.output)) return { ...base, status: "baseline-red", worktree, output: baseline.output };
      if (!baseline.ok) ctx.log("a suíte de base não tem nenhum teste: conta como verde");
      progress.data.baselineGreen = true;
      progress.save();
    }

    /**
     * Etapa que escreve: snapshot antes, registro "em andamento" no progresso e um número de sequência no prompt.
     * O número faz cada execução ser nova para o journal: o efeito de uma etapa está no worktree, não na resposta
     * guardada. Se o agente falhar, a etapa é desfeita antes de o erro subir.
     */
    const writeStep = async <T>(id: string, prompt: string, opts: AgentCallOptions): Promise<{ value: T; before: string }> => {
      const before = snapshotTree(worktree);
      const seq = (progress.data.writeSeq ?? 0) + 1;
      progress.data.writeSeq = seq;
      progress.data.inFlight = { id, before, resumes: 0 };
      progress.save();
      try {
        const value = await ctx.agent<T>(`${prompt}\n\n<!-- etapa de escrita ${seq} -->`, { ...opts, cwd: worktree });
        return { value, before };
      } catch (err) {
        revertTo(worktree, before);
        settle();
        throw err;
      }
    };
    const settle = () => {
      progress.data.inFlight = undefined;
      progress.save();
    };
    /** O que uma etapa de código (green, correção, refactor) não pode mudar. Vazio = nenhuma violação. */
    const codeViolation = (before: string, after: string, rec?: SliceRecord): string => {
      const changed = changedBetween(worktree, before, after);
      const tests = changed.filter(isTest);
      const guarded = changed.filter((f) => matchesAny(f, protectedGlobs));
      const problems: string[] = [];
      if (tests.length) problems.push(`alterou arquivos de teste (${tests.join(", ")})`);
      if (guarded.length) problems.push(`alterou a configuração do runner (${guarded.join(", ")})`);
      if (runnerConfigChanged(worktree, before, after)) problems.push("alterou scripts ou a configuração de testes do package.json");
      if (rec?.testFile && fileHash(worktree, rec.testFile) !== rec.testHash) problems.push(`o teste da fatia (${rec.testFile}) mudou ou sumiu`);
      return problems.length ? `Você ${problems.join("; ")}. A mudança foi desfeita: o teste é a especificação, mude só o código.` : "";
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
        for (let attempt = rec.redAttempt ?? 1; attempt <= 2 && !rec.red; attempt++) {
          if (attempt > 1) tddRetries++;
          rec.redAttempt = attempt;
          progress.upsert(rec);
          const { value: t, before } = await writeStep<TestOut>(
            `red:${key}:${attempt}`,
            `${P.TEST_INSTRUCTIONS}\n\n${issueBlock(issue)}\n\n${sliceBlock(sl)}\n\n## Comando de teste\n\`${testCommand}\`${problem ? `\n\n## Corrija\n${problem}` : ""}`,
            { label: attempt === 1 ? `teste-${sfx}` : `teste-${sfx}:${attempt}`, model: MODELS[tier], schema: TEST_SCHEMA },
          );
          let after = snapshotTree(worktree);
          const changes = changesBetween(worktree, before, after);
          // O que não é teste (implementação, stub, configuração) é descartado pelo código: o teste fica e tem de
          // falhar sozinho. Medido: o composer-2.5 implementou junto com o teste nas duas tentativas da issue #7.
          const nonTest = changes.filter((c) => !isTest(c.path)).map((c) => c.path);
          if (nonTest.length) {
            restorePaths(worktree, before, nonTest);
            redDiscarded += nonTest.length;
            ctx.log(`fatia ${sfx}: a etapa red alterou ${nonTest.join(", ")}; essas mudanças foram descartadas, só o teste fica`);
            after = snapshotTree(worktree);
          }
          const deleted = changes.filter((c) => c.status === "D" && isTest(c.path)).map((c) => c.path);
          if (deleted.length || runnerConfigChanged(worktree, before, after)) {
            revertTo(worktree, before);
            settle();
            problem =
              `A mudança foi desfeita: ${deleted.length ? `você apagou testes (${deleted.join(", ")})` : "você mudou a configuração do runner"}. ` +
              "Escreva ou atualize testes, sem apagar nenhum.";
            lastProblem = problem;
            if (attempt === 2) return "tdd-violation";
            continue;
          }
          const res = suite();
          if (res.kind === "timeout" || res.kind === "overflow") {
            revertTo(worktree, before);
            settle();
            return `tests-${res.kind}`;
          }
          if (res.ok) {
            if (t.alreadySatisfied) {
              settle(); // o comportamento já existia: o teste fica como regressão, sem etapa de código
              Object.assign(rec, { testFile: t.testFile, testName: t.testName, alreadySatisfied: t.evidence ?? "confirmado pela etapa de teste", green: res.output, done: true });
              progress.upsert(rec);
              return undefined;
            }
            revertTo(worktree, before);
            settle();
            problem =
              "O teste passou sem implementação. Se o comportamento já existe, responda alreadySatisfied: true com a evidência; " +
              "senão, escreva um teste que falhe porque o comportamento da fatia falta.";
            lastProblem = problem;
            if (attempt === 2) return "test-not-red";
            continue;
          }
          settle();
          if (!res.output.includes(t.testName) && !res.output.includes(basename(t.testFile))) {
            redUnattributed++;
            ctx.log(`fatia ${sfx}: a saída red não cita ${t.testName}; confira se a falha é do teste novo`);
          }
          Object.assign(rec, { testFile: t.testFile, testName: t.testName, red: res.output, redTree: after, testHash: fileHash(worktree, t.testFile) });
          progress.upsert(rec);
        }
        if (!rec.red) return "test-not-red";
      }

      // green: o mínimo de código; nada de testes, runner ou teste da fatia; a suíte tem de passar
      if (!rec.greenDone) {
        let problem = "";
        for (let attempt = rec.greenAttempt ?? 1; attempt <= 2 && !rec.greenDone; attempt++) {
          if (attempt > 1) tddRetries++;
          rec.greenAttempt = attempt;
          progress.upsert(rec);
          const { before } = await writeStep<Impl>(
            `green:${key}:${attempt}`,
            `${P.CODE_INSTRUCTIONS}\n\n${issueBlock(issue)}\n\n${sliceBlock(sl)}\n\n## Teste que falha\n\`${rec.testName}\` em \`${rec.testFile}\`\n\n## Saída da suíte\n${tail(rec.red)}${problem ? `\n\n## Corrija\n${problem}` : ""}`,
            { label: attempt === 1 ? `codigo-${sfx}` : `codigo-${sfx}:${attempt}`, model: MODELS[tier], schema: IMPL_SCHEMA },
          );
          problem = codeViolation(before, snapshotTree(worktree), rec);
          if (problem) {
            lastProblem = problem;
            revertTo(worktree, before);
            settle();
            if (attempt === 2) return "tdd-violation";
            continue;
          }
          settle();
          rec.greenDone = true;
          progress.upsert(rec);
        }
        if (!rec.greenDone) return "tdd-violation";
      }
      let res = suite();
      for (let round = (rec.fixRound ?? 0) + 1; res.kind === "failed" && round <= MAX_FIX_ROUNDS; round++) {
        ctx.log(`fatia ${sfx}: testes falharam; correção ${round}/${MAX_FIX_ROUNDS}`);
        rec.fixRound = round;
        progress.upsert(rec);
        const { before } = await writeStep<Impl>(`fix:${key}:${round}`, `${P.FIX_INSTRUCTIONS}\n\n${sliceBlock(sl)}\n\n## Saída dos testes\n${res.output}`, {
          label: `corrigir-${sfx}-${round}`,
          model: MODELS[tier === "LOW" ? "MED" : "HIGH"], // escala o modelo na correção
          schema: IMPL_SCHEMA,
        });
        lastProblem = codeViolation(before, snapshotTree(worktree), rec);
        if (lastProblem) {
          revertTo(worktree, before);
          settle();
          return "tdd-violation";
        }
        settle();
        res = suite();
      }
      if (res.kind === "timeout" || res.kind === "overflow") return `tests-${res.kind}`;
      if (!res.ok) return "tests-failed";
      Object.assign(rec, { green: res.output, done: true });
      progress.upsert(rec);
      return undefined;
    };
    /** Falha de fatia: o worktree volta ao estado do começo dela (verde), para o resume e para quem inspeciona. */
    const sliceStart = () => snapshotTree(worktree);

    const planned = plan.slices.slice(0, SLICE_CAP[tier]);
    const deferred = plan.slices.slice(SLICE_CAP[tier]).map((s) => `${s.behavior} (seam: ${s.seam})`);
    if (deferred.length) ctx.log(`limite de ${SLICE_CAP[tier]} fatias no tier ${tier}: ${deferred.length} adiada(s)`);
    ctx.metric("slices_planned", plan.slices.length);
    for (const [i, sl] of planned.entries()) {
      const start = sliceStart();
      const failed = await runSlice(sliceKey("s", sl.behavior, sl.seam), String(i + 1), sl);
      if (failed) {
        if (failed !== "tdd-violation" && failed !== "test-not-red") revertTo(worktree, start);
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
      const diff = diffSinceBase(worktree, progress.data.baseCommit!);
      const extra: Record<Axis, string> = {
        standards: listBlock("Arquivos de padrão do repositório", standardsFiles) || "## Arquivos de padrão do repositório\nNenhum: use só a baseline de smells.",
        spec: listBlock("Fatias adiadas pelo limite (não são 'missing')", deferred),
        security: "",
      };
      // A rodada entra no prompt: sem ela, a rodada 2 de um resume teria a mesma chave de journal da rodada 1 e
      // receberia a resposta antiga. Na rodada 2 o revisor vê também a resposta da correção (o agente pode discordar).
      const roundBlock =
        round === 1 ? "## Rodada 1" : `## Rodada ${round}, depois da correção\n${progress.data.refactorSummary ?? "Só fatias extras: veja o diff."}`;
      const results = await ctx.parallel(
        axes.map((axis) => () =>
          ctx.agent<any>(`${AXIS_INSTRUCTIONS[axis]}\n\n${extra[axis]}\n\n${issueBlock(issue)}\n\n${roundBlock}\n\n## Diff desde a base\n${diff}`, {
            label: `review:${axis}:${round}`,
            phase: "Review",
            model: MODELS.REVIEW,
            cwd: worktree,
            tools: REVIEW_TOOLS,
            settingSources: NO_SETTINGS,
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
      for (const [i, f] of [...b.missing, ...b.wrong].slice(0, EXTRA_SLICE_CAP).entries()) {
        const behavior = f.behavior ?? f.note;
        const seam = f.seam ?? "a interface pública mais próxima";
        const key = sliceKey("x", behavior, seam);
        const start = sliceStart();
        const failed = await runSlice(key, `extra-${i + 1}`, { behavior, seam, testIdea: `requisito da issue: "${f.quote}"` });
        if (failed) {
          if (failed !== "tdd-violation" && failed !== "test-not-red") revertTo(worktree, start);
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
          `${P.REFACTOR_INSTRUCTIONS}\n\n${issueBlock(issue)}\n\n## Achados\n${JSON.stringify(toRefactor, null, 2)}`,
          { label: "refatorar-1", model: MODELS[tier], schema: IMPL_SCHEMA },
        );
        const refactorProblem = codeViolation(before, snapshotTree(worktree));
        if (refactorProblem) {
          revertTo(worktree, before);
          settle();
          return { ...base, status: "tdd-violation", step: "refatorar-1", reason: refactorProblem, worktree };
        }
        const after = suite();
        if (!after.ok) {
          revertTo(worktree, before); // volta ao último verde
          settle();
          return { ...base, status: "tests-failed-after-review", worktree, output: after.output };
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
    ctx.phase("Entrega");
    const final = suite();
    if (!final.ok) return { ...base, status: final.kind === "failed" ? "tests-failed" : `tests-${final.kind}`, worktree, output: final.output };
    const baseCommit = progress.data.baseCommit!;
    const head = sh("git", ["rev-parse", "HEAD"], worktree).trim();
    if (head !== progress.data.deliveredCommit) {
      // Commits feitos por agentes (a instrução pede para não fazer) são desfeitos, mantendo a árvore.
      if (head !== baseCommit) sh("git", ["reset", "--soft", baseCommit], worktree);
      sh("git", ["add", "-A"], worktree);
      const secret = findStagedSecret(worktree, undefined, baseCommit);
      if (secret) {
        // Nada de commit, push ou PR. O worktree fica para inspeção; o motivo não repete o segredo.
        ctx.metric("secret_blocked", 1);
        ctx.log(`entrega bloqueada: ${secret}`);
        return { ...base, status: "secret-blocked", reason: secret, branch, worktree, spentCents: ctx.budget.spentCents() };
      }
      if (hasStagedChanges(worktree)) sh("git", ["commit", "-m", `feat: ${issue.title} (#${issue.number})`], worktree);
      progress.data.deliveredCommit = sh("git", ["rev-parse", "HEAD"], worktree).trim();
      progress.save();
    }
    let prUrl: string | undefined;
    if (openPr) {
      prUrl = existingPr(branch, repoFlag, worktree);
      if (!prUrl) {
        const text = await ctx.agent<PrText>(
          `${P.PR_INSTRUCTIONS}\n\n${contextBlock}\n\n${issueBlock(issue)}\n\n## Diff\n${diffSinceBase(worktree, baseCommit)}`,
          { label: "pr-texto", model: MODELS.CLASSIFY, cwd: worktree, tools: REVIEW_TOOLS, settingSources: NO_SETTINGS, schema: PR_SCHEMA, memo: true },
        );
        const body = buildPrBody({
          issueNumber: issue.number,
          text,
          slices: progress.data.slices,
          review: reports,
          deferred,
          refuted,
          worktree,
        });
        const leak = findSecretInText(body);
        if (leak) return { ...base, status: "secret-blocked", reason: `${leak} no corpo do PR`, branch, worktree };
        sh("git", ["push", "-u", "origin", branch], worktree);
        prUrl = withBodyFile(body, (f) =>
          sh("gh", ["pr", "create", "--head", branch, "--title", `${issue.title} (#${issue.number})`, "--body-file", f, ...repoFlag], worktree).trim(),
        );
      } else {
        sh("git", ["push", "-u", "origin", branch], worktree);
      }
    }
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
  },
});
