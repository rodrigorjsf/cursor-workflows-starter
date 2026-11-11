// Workflow de referência: implementar uma issue do GitHub de ponta a ponta, seguindo em código os fluxos das skills
// tdd e codebase-design (implementação), code-review (review) e pr (corpo do PR) de mattpocock/skills (MIT). As
// instruções estão em workflows/implement-issue/prompts.ts; créditos em CREDITS.md.
//
// O que é decidido em CÓDIGO (não pelo modelo):
//   - o tier (LOW/MED/HIGH) vem das labels da issue; só sem label um classificador barato decide;
//   - MED: um planejador define seams e fatias verticais; HIGH: três designers desenham a interface de formas
//     radicalmente diferentes e um juiz escolhe ou combina ("Design it twice"); LOW: uma fatia, sem planejador;
//   - MED/HIGH param depois do plano (status "seams-proposed", comentário na issue): o segundo run, com
//     `--resume <runId>` e `approveSeams: true` (ou `seams` editadas), executa. A skill tdd manda combinar as seams
//     antes de escrever testes, e o runtime não pausa para perguntar;
//   - a suíte tem de estar verde antes da primeira fatia ("baseline-red", senão); `setupCommand` opcional antes;
//   - cada fatia é um ciclo red → green controlado pelo código: a etapa de teste só pode tocar arquivos de teste e o
//     teste novo tem de FALHAR; a etapa de código não pode tocar testes e a suíte tem de PASSAR (até 2 correções).
//     Quem tocou o quê vem de snapshots de árvore git antes e depois de cada etapa; violação desfaz a etapa e tenta
//     de novo uma vez ("tdd-violation" na segunda);
//   - o progresso de cada fatia (e as saídas red/green) fica em .workflows/runs/<runId>/tdd-progress.json: o resume
//     não refaz nem reconfere fatias concluídas, e a evidência do PR vem desse arquivo;
//   - o review roda sempre, em três eixos separados e em paralelo (Standards, Spec, Segurança), sem misturar nem
//     reordenar relatórios. Bloqueia: padrão documentado violado, requisito faltando ou errado, falha de segurança.
//     Requisito faltando ou errado vira fatia TDD extra (até 2); padrão e segurança viram refactor sem tocar testes;
//     depois, só os eixos que bloquearam são revistos ("review-blocking" se continuar);
//   - o corpo do PR segue o template da skill pr; a Evidence é a saída real red → green de cada fatia;
//   - commit e PR só com testes verdes, review limpo e nenhum segredo no diff staged ("secret-blocked"), e são
//     idempotentes no resume.
//
// Custo por etapa (passo 4 da /skill-to-workflow). "[]" = settingSources vazio: sem AGENTS.md, regras, hooks, MCP e
// sem as skills que o SDK carrega com qualquer outra camada (medido: 58).
//   etapa            modelo                 tools                    settingSources   memo
//   classificar      composer-2.5           nenhuma                  team, mdm        sim
//   planejar (MED)   grok-4.7               só leitura               []               sim
//   desenhar ×3      composer-2.5           só leitura               []               sim
//   julgar (HIGH)    grok-4.7 high          só leitura               []               sim
//   teste-N          do tier                todas                    default          não
//   codigo-N         do tier                todas                    default          não
//   corrigir-N-R     tier acima             todas                    default          não
//   review ×3        grok-4.7 high          só leitura, sem shell    []               não (diff no prompt)
//   refatorar-1      do tier                todas                    default          não
//   pr-texto         composer-2.5           só leitura, sem shell    []               não
// Estimativa por caminho (a medir com --max-tokens baixo; o LOW antigo, sem TDD nem review, mediu ~80 mil tokens):
//   LOW   1 fatia (2 etapas) + 3 reviews + PR                          ≈ 6 agentes, 250–400 mil tokens
//   MED   run 1: planejar; run 2: até 3 fatias (6) + 3 reviews + PR    ≈ 11 agentes, 0,5–1 milhão
//   HIGH  run 1: 3 designers + juiz; run 2: até 5 fatias (10) + reviews + refactor + re-review + PR ≈ 20, 1,5–2,5 milhões
// Fora de agentes (zero tokens): leitura da issue, roteamento, git, testes, diff, comentário, commit e PR.
//
// IDs de modelo: confirme os seus com `npm run models`. Os defaults são modelos do Cursor (Composer e Grok), que os
// planos pagos da The X Subscription incluem na franquia semanal; modelos de terceiros exigem crédito pré-pago
// (medido). Em planos legados e no Enterprise, troque por WF_MODEL_* (só o ID; os params ficam de fora).
//
// STATUS: o fluxo TDD + review em três eixos + PR no template ainda não rodou contra a API real; a versão anterior
// (implementar → testes → PR) foi verificada no caminho LOW (docs/research/verificacoes-locais.md §9).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ModelSelection, SettingSource } from "@cursor/sdk";
import { defineWorkflow } from "../src/runtime/workflow.js";
import { buildPrBody, type PrText } from "./implement-issue/pr-body.js";
import * as P from "./implement-issue/prompts.js";
import { AXES, AXIS_SCHEMAS, blockingAxes, blockingOf, type Axis, type ReviewReports } from "./implement-issue/review.js";
import { DEFAULT_TEST_GLOBS, ProgressStore, changedBetween, isTestFile, runTests, snapshotTree, type SliceRecord } from "./implement-issue/tdd.js";

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
  /** Roda uma vez no worktree novo antes da suíte de base (ex.: `npm ci`). */
  setupCommand?: string;
  openPr?: boolean;
  /** Segundo run de MED/HIGH: aprova as seams propostas no primeiro (use com `--resume <runId>`). */
  approveSeams?: boolean;
  /** Seams aprovadas por você, no lugar das propostas: o plano é refeito com elas. */
  seams?: string[];
  /** O que conta como arquivo de teste (default: DEFAULT_TEST_GLOBS). */
  testGlobs?: string[];
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
const TEST_SCHEMA = { type: "object", required: ["testFile", "testName"], properties: { testFile: str, testName: str } };
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

const sh = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, encoding: "utf8" });

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

/** Desfaz o que uma etapa mudou: volta o worktree ao snapshot (remove arquivos novos, restaura os alterados). */
function revertTo(cwd: string, tree: string): void {
  execFileSync("git", ["read-tree", "--reset", "-u", tree], { cwd });
}

/** Diff desde a base do worktree, para o review e o PR. Grande demais: estatística + início, e o agente lê o resto. */
function diffSinceBase(cwd: string, base: string): string {
  sh("git", ["add", "-A"], cwd);
  const diff = sh("git", ["diff", "--cached", "--no-color", base], cwd);
  if (diff.length <= MAX_DIFF_CHARS) return "```diff\n" + diff + "\n```";
  const stat = sh("git", ["diff", "--cached", "--stat", base], cwd);
  return `(diff truncado: leia os arquivos para o resto)\n\n${stat}\n\n\`\`\`diff\n${diff.slice(0, MAX_DIFF_CHARS)}\n\`\`\``;
}

/**
 * Trava de segredos antes do commit. Uma issue com prompt injection poderia fazer uma etapa copiar
 * ~/.cursor/sdk/auth.json para o worktree, e o sandbox do SDK não restringe leitura. Olha só o diff staged.
 * Devolve o nome da regra que disparou, nunca o trecho encontrado.
 */
export function findStagedSecret(worktree: string, knownSecrets: string[] = savedSecrets()): string | undefined {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: worktree, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  for (const name of git("diff", "--cached", "--name-only").split("\n").filter(Boolean)) {
    const file = basename(name);
    if (file === "auth.json") return "arquivo auth.json no commit";
    if (file === ".env" || file.startsWith(".env.")) return "arquivo .env no commit";
  }
  const added = git("diff", "--cached", "--no-color", "-U0")
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n");
  if (/crsr_[A-Za-z0-9_-]{16,}/.test(added)) return "chave do Cursor (crsr_) no diff";
  if (/\bsk-[A-Za-z0-9_-]{20,}/.test(added)) return "chave sk- no diff";
  if (knownSecrets.some((k) => k.length >= 16 && added.includes(k))) return "a chave salva do SDK ou CURSOR_API_KEY no diff";
  return undefined;
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
      properties: {
        issue: { type: "number" },
        repo: { type: "string" },
        testCommand: { type: "string" },
        setupCommand: { type: "string" },
        openPr: { type: "boolean" },
        approveSeams: { type: "boolean" },
        seams: { type: "array", items: { type: "string" } },
        testGlobs: { type: "array", items: { type: "string" } },
      },
    },
  },
  defaults: { timeoutMs: 30 * 60_000, retries: 1, schemaRetries: 2 },

  async run(ctx) {
    const { issue: number, repo, openPr = false } = ctx.args;
    const globs = ctx.args.testGlobs?.length ? ctx.args.testGlobs : DEFAULT_TEST_GLOBS;
    const isTest = (f: string) => isTestFile(f, globs);

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
        settingSources: ["team", "mdm"], // sem AGENTS.md, regras, hooks e MCP do projeto; skills continuam (medido)
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
    } else {
      ctx.phase("Plano");
      const approved = listBlock("Seams aprovadas (use exatamente estas)", ctx.args.seams ?? []);
      const planData = `${issueBlock(issue)}\n\n${contextBlock}${approved ? `\n\n${approved}` : ""}`;
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
      // tdd: seams combinadas antes de qualquer teste. O runtime não pausa: propõe na issue e para.
      if (!ctx.args.seams?.length && !ctx.args.approveSeams) {
        const relaunch = `npm run wf -- run implement-issue --args '${JSON.stringify({ ...ctx.args, approveSeams: true })}' --resume ${ctx.runId}`;
        const comment = [
          SEAMS_MARKER,
          `## Seams propostas pelo workflow \`implement-issue\` (tier ${tier})`,
          "",
          ...plan.seams.map((s) => `- **${s.name}**: \`${s.interface}\` — ${s.why}`),
          "",
          "### Fatias (uma por ciclo red → green)",
          "",
          ...plan.slices.map((s, i) => `${i + 1}. ${s.behavior} (seam: ${s.seam}; teste: ${s.testIdea})`),
          ...(plan.rationale ? ["", `### Por que este desenho\n\n${plan.rationale}`] : []),
          "",
          "### Para aprovar",
          "",
          "Relance com os mesmos args e `approveSeams: true` (o plano vem do journal, sem custo):",
          "",
          "```bash",
          relaunch,
          "```",
          "",
          `No chat: \`/run-workflow implement-issue\` com \`resumeRunId: "${ctx.runId}"\` e \`approveSeams: true\`. Para trocar as seams, passe \`seams: [...]\` no lugar de \`approveSeams\`.`,
        ].join("\n");
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
    else sh("git", ["worktree", "add", "-B", branch, worktree], ctx.cwd);
    const progress = new ProgressStore(ctx.cwd, ctx.runId);
    if (!progress.data.baseCommit) {
      progress.data.baseCommit = sh("git", ["rev-parse", "HEAD"], worktree).trim();
      progress.save();
    }
    const testCommand = ctx.args.testCommand ?? plan.testCommand ?? "npm test";
    if (!progress.data.baselineGreen) {
      if (ctx.args.setupCommand) {
        const setup = runTests(ctx.args.setupCommand, worktree);
        if (!setup.ok) return { ...base, status: "setup-failed", worktree, output: setup.output };
      }
      const baseline = runTests(testCommand, worktree);
      if (!baseline.ok) return { ...base, status: "baseline-red", worktree, output: baseline.output };
      progress.data.baselineGreen = true;
      progress.save();
    }

    let tddRetries = 0;
    /** Um ciclo red → green. Devolve um status de falha, ou undefined quando a fatia fica verde. */
    const runSlice = async (key: string, sfx: string, sl: Slice): Promise<string | undefined> => {
      const rec: SliceRecord = progress.slice(key) ?? { key, behavior: sl.behavior, seam: sl.seam, done: false };
      if (rec.done) return undefined; // resume: fatia já verde

      // red: um teste, só arquivos de teste, e a suíte tem de falhar
      if (!rec.red) {
        let problem = "";
        let red: { file: string; name: string; output: string } | undefined;
        for (let attempt = 1; attempt <= 2 && !red; attempt++) {
          if (attempt > 1) tddRetries++;
          const before = snapshotTree(worktree);
          const t = await ctx.agent<{ testFile: string; testName: string }>(
            `${P.TEST_INSTRUCTIONS}\n\n${issueBlock(issue)}\n\n${sliceBlock(sl)}\n\n## Comando de teste\n\`${testCommand}\`${problem ? `\n\n## Corrija\n${problem}` : ""}`,
            { label: attempt === 1 ? `teste-${sfx}` : `teste-${sfx}:${attempt}`, model: MODELS[tier], cwd: worktree, schema: TEST_SCHEMA },
          );
          const touched = changedBetween(worktree, before, snapshotTree(worktree));
          const nonTest = touched.filter((f) => !isTest(f));
          if (nonTest.length) {
            revertTo(worktree, before);
            problem = `Você alterou arquivos que não são de teste (${nonTest.join(", ")}); a mudança foi desfeita. Escreva só o teste.`;
            if (attempt === 2) return "tdd-violation";
            continue;
          }
          const res = runTests(testCommand, worktree);
          if (res.ok) {
            revertTo(worktree, before);
            problem = "O teste passou sem implementação: ele não exercita comportamento novo. Escreva um teste que falhe até a fatia existir.";
            if (attempt === 2) return "test-not-red";
            continue;
          }
          red = { file: t.testFile, name: t.testName, output: res.output };
        }
        if (!red) return "test-not-red";
        Object.assign(rec, { testFile: red.file, testName: red.name, red: red.output });
        progress.upsert(rec);
      }

      // green: o mínimo de código, sem tocar testes, e a suíte tem de passar
      let problem = "";
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (attempt > 1) tddRetries++;
        const before = snapshotTree(worktree);
        await ctx.agent<Impl>(
          `${P.CODE_INSTRUCTIONS}\n\n${issueBlock(issue)}\n\n${sliceBlock(sl)}\n\n## Teste que falha\n\`${rec.testName}\` em \`${rec.testFile}\`\n\n## Saída da suíte\n${tail(rec.red)}${problem ? `\n\n## Corrija\n${problem}` : ""}`,
          { label: attempt === 1 ? `codigo-${sfx}` : `codigo-${sfx}:${attempt}`, model: MODELS[tier], cwd: worktree, schema: IMPL_SCHEMA },
        );
        const testsTouched = changedBetween(worktree, before, snapshotTree(worktree)).filter(isTest);
        if (!testsTouched.length) break;
        revertTo(worktree, before);
        problem = `Você alterou arquivos de teste (${testsTouched.join(", ")}); a mudança foi desfeita. O teste é a especificação: mude só o código.`;
        if (attempt === 2) return "tdd-violation";
      }
      let res = runTests(testCommand, worktree);
      for (let round = 1; !res.ok && round <= MAX_FIX_ROUNDS; round++) {
        ctx.log(`fatia ${sfx}: testes falharam; correção ${round}/${MAX_FIX_ROUNDS}`);
        const before = snapshotTree(worktree);
        await ctx.agent<Impl>(`${P.FIX_INSTRUCTIONS}\n\n${sliceBlock(sl)}\n\n## Saída dos testes\n${res.output}`, {
          label: `corrigir-${sfx}-${round}`,
          model: MODELS[tier === "LOW" ? "MED" : "HIGH"], // escala o modelo na correção
          cwd: worktree,
          schema: IMPL_SCHEMA,
        });
        if (changedBetween(worktree, before, snapshotTree(worktree)).some(isTest)) {
          revertTo(worktree, before);
          return "tdd-violation";
        }
        res = runTests(testCommand, worktree);
      }
      if (!res.ok) return "tests-failed";
      Object.assign(rec, { green: res.output, done: true });
      progress.upsert(rec);
      return undefined;
    };

    const planned = plan.slices.slice(0, SLICE_CAP[tier]);
    const deferred = plan.slices.slice(SLICE_CAP[tier]).map((s) => `${s.behavior} (seam: ${s.seam})`);
    if (deferred.length) ctx.log(`limite de ${SLICE_CAP[tier]} fatias no tier ${tier}: ${deferred.length} adiada(s)`);
    ctx.metric("slices_planned", plan.slices.length);
    for (const [i, sl] of planned.entries()) {
      const failed = await runSlice(`s${i + 1}`, String(i + 1), sl);
      if (failed) return { ...base, status: failed, slice: i + 1, worktree };
    }

    // ── Review (code-review + Segurança): três eixos separados, sempre ─────────────────
    ctx.phase("Review");
    const reports: ReviewReports = {};
    const standardsFiles = STANDARDS_FILES.filter((f) => existsSync(join(worktree, f)));
    const review = async (axes: Axis[], round: number): Promise<boolean> => {
      const diff = diffSinceBase(worktree, progress.data.baseCommit!);
      const extra: Record<Axis, string> = {
        standards: listBlock("Arquivos de padrão do repositório", standardsFiles) || "## Arquivos de padrão do repositório\nNenhum: use só a baseline de smells.",
        spec: listBlock("Fatias adiadas pelo limite (não são 'missing')", deferred),
        security: "",
      };
      const results = await ctx.parallel(
        axes.map((axis) => () =>
          ctx.agent<any>(`${AXIS_INSTRUCTIONS[axis]}\n\n${extra[axis]}\n\n${issueBlock(issue)}\n\n## Diff desde a base\n${diff}`, {
            label: `review:${axis}:${round}`,
            phase: "Review",
            model: MODELS.REVIEW,
            cwd: worktree,
            tools: REVIEW_TOOLS,
            settingSources: NO_SETTINGS,
            schema: AXIS_SCHEMAS[axis],
          }),
        ),
      );
      // Review exigido que não rodou não pode virar "sem achados".
      if (results.some((r) => r === null)) return false;
      axes.forEach((a, i) => ((reports as Record<Axis, unknown>)[a] = results[i]));
      return true;
    };
    if (!(await review(AXES, 1))) return { ...base, status: "review-failed", worktree };
    for (const a of AXES) ctx.metric(`review_${a}_findings`, reports[a]?.findings.length ?? 0);
    const redo = blockingAxes(reports);
    ctx.metric("review_blocking_axes", redo.length);
    if (redo.length) {
      const b = blockingOf(reports);
      // Requisito faltando ou errado: novo comportamento, então nova fatia TDD (red → green), com teto.
      const toSlice = [...b.missing, ...b.wrong];
      for (const [i, f] of toSlice.slice(0, EXTRA_SLICE_CAP).entries()) {
        const failed = await runSlice(`x${i + 1}`, `extra-${i + 1}`, {
          behavior: f.behavior ?? f.note,
          seam: f.seam ?? "a interface pública mais próxima",
          testIdea: `requisito da issue: "${f.quote}"`,
        });
        if (failed) return { ...base, status: failed, slice: `extra-${i + 1}`, worktree };
      }
      // Padrão e segurança: refactor, sem tocar testes e com a suíte verde.
      const toRefactor = [...b.standards, ...b.security];
      if (toRefactor.length) {
        const before = snapshotTree(worktree);
        await ctx.agent<Impl>(`${P.REFACTOR_INSTRUCTIONS}\n\n${issueBlock(issue)}\n\n## Achados\n${JSON.stringify(toRefactor, null, 2)}`, {
          label: "refatorar-1",
          model: MODELS[tier],
          cwd: worktree,
          schema: IMPL_SCHEMA,
        });
        if (changedBetween(worktree, before, snapshotTree(worktree)).some(isTest)) {
          revertTo(worktree, before);
          return { ...base, status: "tdd-violation", step: "refatorar-1", worktree };
        }
        const after = runTests(testCommand, worktree);
        if (!after.ok) return { ...base, status: "tests-failed-after-review", worktree, output: after.output };
      }
      if (!(await review(redo, 2))) return { ...base, status: "review-failed", worktree };
      if (blockingAxes(reports).length) return { ...base, status: "review-blocking", worktree, findings: blockingOf(reports) };
    }
    ctx.metric("tdd_retries", tddRetries);
    ctx.metric("slices_done", progress.data.slices.filter((s) => s.done).length);

    // ── Entrega (pr): commit/PR feitos pelo código; idempotentes no resume ──────────────
    ctx.phase("Entrega");
    sh("git", ["add", "-A"], worktree);
    const secret = findStagedSecret(worktree);
    if (secret) {
      // Nada de commit, push ou PR. O worktree fica para inspeção; o motivo não repete o segredo.
      ctx.metric("secret_blocked", 1);
      ctx.log(`entrega bloqueada: ${secret}`);
      return { ...base, status: "secret-blocked", reason: secret, branch, worktree, spentCents: ctx.budget.spentCents() };
    }
    const diff = diffSinceBase(worktree, progress.data.baseCommit!);
    if (hasStagedChanges(worktree)) sh("git", ["commit", "-m", `feat: ${issue.title} (#${issue.number})`], worktree);
    let prUrl: string | undefined;
    if (openPr) {
      const text = await ctx.agent<PrText>(`${P.PR_INSTRUCTIONS}\n\n${contextBlock}\n\n${issueBlock(issue)}\n\n## Diff\n${diff}`, {
        label: "pr-texto",
        model: MODELS.CLASSIFY,
        cwd: worktree,
        tools: REVIEW_TOOLS,
        settingSources: NO_SETTINGS,
        schema: PR_SCHEMA,
      });
      const body = buildPrBody({ issueNumber: issue.number, text, slices: progress.data.slices, review: reports, deferred });
      sh("git", ["push", "-u", "origin", branch], worktree);
      prUrl =
        existingPr(branch, repoFlag, worktree) ??
        withBodyFile(body, (f) =>
          sh("gh", ["pr", "create", "--head", branch, "--title", `${issue.title} (#${issue.number})`, "--body-file", f, ...repoFlag], worktree).trim(),
        );
    }
    return {
      ...base,
      status: "done",
      branch,
      worktree,
      prUrl,
      slices: progress.data.slices.filter((s) => s.done).map((s) => ({ behavior: s.behavior, test: s.testName })),
      deferred,
      review: Object.fromEntries(AXES.map((a) => [a, { findings: reports[a]?.findings.length ?? 0, worst: reports[a]?.worst ?? "" }])),
      spentCents: ctx.budget.spentCents(),
    };
  },
});
