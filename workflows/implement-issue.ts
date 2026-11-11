// Workflow de referência: implementar uma issue do GitHub de ponta a ponta.
//
// O que é decidido em CÓDIGO (não pelo modelo):
//   - o tier (LOW/MED/HIGH) vem das labels da issue; só sem label um classificador barato decide;
//   - o tier escolhe o modelo de cada etapa;
//   - plano só para MED/HIGH; code review só para HIGH ou diff grande;
//   - testes rodam via shell no próprio workflow, e o loop de correção tem teto;
//   - review exigido que falha encerra o run (status "review-failed"), nunca vira "sem achados";
//   - depois de corrigir achados bloqueantes, os testes e o review rodam de novo (1 rodada extra);
//   - commit e PR só acontecem com testes verdes, review limpo e nenhum segredo no diff staged
//     (senão o status é "secret-blocked"), e são idempotentes no resume.
//
// Custo por caminho (etapas de agente; preencha as faixas em ¢ após o primeiro run com --max-cents baixo):
//   LOW com label   : implementar (+ até 2 correções em MED)                   → 1–3 agentes
//   MED com label   : planejar[memo] + implementar (+ até 2 correções em HIGH)  → 2–4 agentes
//   HIGH            : planejar[memo] + implementar + 2 reviews (+ correção + 2 re-reviews) (+ correções) → 4–9 agentes
//   sem label       : + classificar (composer-2.5, só texto, sem contexto do projeto, memo)
// Fora de agentes (zero tokens): leitura da issue, roteamento por label, testes, diff, commit e PR.
//
// IDs de modelo: confirme os seus com `npm run models` (a lista depende do plano e das restrições do admin).
// Os defaults são modelos do Cursor (Composer e Grok), que os planos pagos da The X Subscription incluem na franquia
// semanal. Medido num Premium em 2026-11-11: `gpt-5.3-codex` (o default antigo, do cookbook) falha com "not included
// in your weekly usage" sem crédito pré-pago, e `auto-low` não existe no catálogo. Em planos legados e no
// Enterprise, modelos de terceiros saem do pool do time: troque por WF_MODEL_* (só o ID; os params ficam de fora).
//
// STATUS: caminho LOW verificado de ponta a ponta contra a API real (Premium, 2026-11-11), com resume sem repetir
// commit nem PR. MED e HIGH (plano, review) não foram executados. Ver docs/research/verificacoes-locais.md §9.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ModelSelection } from "@cursor/sdk";
import { defineWorkflow } from "../src/runtime/workflow.js";

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

const REVIEW_DIFF_LINES = 300;

// ── Prompts: parte fixa primeiro, dados variáveis no fim (ver docs/08) ────────────────────
// O cache de prompt do provedor funciona por prefixo idêntico. Instruções fixas no começo e dados
// (issue, plano, saída de teste) no fim mantêm o maior prefixo possível igual entre runs e retries.
const CLASSIFY_INSTRUCTIONS =
  "Classifique a complexidade de implementação da issue em LOW (mecânica, 1 arquivo), MED (típica) ou HIGH " +
  "(arquitetural, segurança, vários módulos). Responda só pela tool submit_result.";
const PLAN_INSTRUCTIONS =
  "Leia o código e escreva um plano de implementação para a issue. Não edite arquivos. Seja específico: " +
  "arquivos, funções e o comando de teste do projeto.";
// Regra de escopo nas etapas que escrevem: medido em 2026-11-11, uma etapa de correção editou um arquivo fora do
// repositório para "consertar" o ambiente. Ver docs/07 e docs/research/verificacoes-locais.md.
const SCOPE_RULE =
  "Altere apenas arquivos dentro deste repositório. Se a falha vier do ambiente (ferramenta ausente ou quebrada, " +
  "PATH, instalação, rede), não altere nada fora do repositório: descreva o problema e pare.";
const IMPL_INSTRUCTIONS =
  "Implemente a issue abaixo no repositório atual. Escreva ou atualize testes. Não faça commit. " + SCOPE_RULE + " " +
  "Ao terminar, resuma o que mudou e liste os arquivos alterados.";
const FIX_INSTRUCTIONS = "Os testes falharam. Corrija o código (não os testes, salvo se estiverem errados). " + SCOPE_RULE;
const REVIEW_INSTRUCTIONS =
  "Revise as mudanças staged (`git diff --cached`). Marque como blocking só o que quebraria produção ou a issue. " +
  "Não edite arquivos.";

const issueBlock = (i: { number: number; title: string; body: string }) => `## Issue #${i.number}: ${i.title}\n\n${i.body}`;
const MAX_FIX_ROUNDS = 2;
const MAX_REVIEW_FIX_ROUNDS = 1;

interface Args {
  issue: number;
  /** owner/repo; default: o repo do cwd. */
  repo?: string;
  /** Comando de teste; default: o que o plano sugerir, ou `npm test`. */
  testCommand?: string;
  openPr?: boolean;
}

interface Issue {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
}

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

/** Prompt da correção de review: instruções fixas (com a regra de escopo) primeiro, achados no fim. */
export function reviewFixPrompt(blocking: unknown[]): string {
  return `Corrija estes achados bloqueantes de review. ${SCOPE_RULE}\n\n${JSON.stringify(blocking, null, 2)}`;
}

/**
 * Trava de segredos antes do commit. Issues LOW/MED não passam por review, e o sandbox do SDK não restringe leitura:
 * uma issue com prompt injection poderia fazer uma etapa copiar ~/.cursor/sdk/auth.json para o worktree, que o código
 * commitaria e enviaria no PR. Olha só o diff staged. Devolve o nome da regra que disparou, nunca o trecho encontrado.
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

/**
 * Roda o comando de teste com o ambiente de quem chamou o workflow. Sem `-l`: um shell de login recarrega o perfil e
 * pode trocar o PATH (medido: o npm do `mise exec` virou outro, quebrado, e a etapa de correção foi mexer fora do repo).
 */
export function runTests(command: string, cwd: string): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execFileSync("bash", ["-c", command], { cwd, encoding: "utf8", stdio: "pipe" }).slice(-4000) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}\n${e.stderr ?? ""}`.slice(-4000) };
  }
}

const PLAN_SCHEMA = {
  type: "object",
  required: ["steps", "files", "testCommand"],
  properties: {
    steps: { type: "array", items: { type: "string" }, minItems: 1 },
    files: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    testCommand: { type: "string" },
  },
};

const IMPL_SCHEMA = {
  type: "object",
  required: ["summary", "filesChanged"],
  properties: { summary: { type: "string" }, filesChanged: { type: "array", items: { type: "string" } } },
};

const REVIEW_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "severity", "issue"],
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          severity: { enum: ["blocking", "minor"] },
          issue: { type: "string" },
        },
      },
    },
  },
};

export default defineWorkflow<Args>({
  meta: {
    name: "implement-issue",
    description: "Implementa uma issue do GitHub: tier por label → plano → código → testes → review condicional → PR.",
    whenToUse: "Quando o usuário pedir para implementar/resolver uma issue específica pelo número.",
    phases: [{ title: "Triagem" }, { title: "Plano" }, { title: "Implementação" }, { title: "Verificação" }, { title: "Review" }, { title: "Entrega" }],
    argsSchema: { type: "object", required: ["issue"], properties: { issue: { type: "number" }, repo: { type: "string" }, testCommand: { type: "string" }, openPr: { type: "boolean" } } },
  },
  defaults: { timeoutMs: 30 * 60_000, retries: 1, schemaRetries: 2 },

  async run(ctx) {
    const { issue: number, repo, openPr = false } = ctx.args;

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
          settingSources: ["team", "mdm"], // sem AGENTS.md, regras, hooks e MCP do projeto; skills continuam (medido); governança mantida
          memo: true, // mesma issue + mesmo estado do repo → reaproveita entre runs
          schema: { type: "object", required: ["tier", "reason"], properties: { tier: { enum: ["LOW", "MED", "HIGH"] }, reason: { type: "string" } } },
      });
      tier = c.tier;
    }
    ctx.log(`Issue #${issue.number} → tier ${tier} (modelo ${MODELS[tier].id})`);
    // Covariável de dificuldade: compare custo/sucesso de modelos dentro do mesmo tier, não no agregado.
    ctx.metric("tier", tier);
    ctx.metric("tier_source", issue.labels.some((l) => LABEL_TIERS[l.name.toLowerCase()]) ? "label" : "classifier");

    // ── Plano: só para MED/HIGH ─────────────────────────────────────────────────────────
    let plan: { steps: string[]; files: string[]; testCommand: string; risks?: string[] } | undefined;
    if (tier !== "LOW") {
      ctx.phase("Plano");
      plan = await ctx.agent(`${PLAN_INSTRUCTIONS}\n\n${issueBlock(issue)}`, {
        label: "planejar",
        model: MODELS[tier],
        tools: ["read", "grep", "glob", "ls", "semSearch"],
        schema: PLAN_SCHEMA,
        memo: true, // só leitura: relançar no mesmo commit não paga o plano de novo
      });
    }
    const testCommand = ctx.args.testCommand ?? plan?.testCommand ?? "npm test";

    // ── Implementação num worktree isolado (código cria; agente só edita) ───────────────
    ctx.phase("Implementação");
    const branch = `wf/issue-${issue.number}`;
    const worktree = join(ctx.cwd, ".workflows", "worktrees", branch.replace("/", "-"));
    if (existsSync(worktree)) {
      ctx.log(`worktree ${worktree} já existe; reaproveitando`);
    } else {
      // Erro aqui (repo sem commit, não é repo git, branch em uso) derruba o workflow: melhor que agentes num cwd inexistente.
      sh("git", ["worktree", "add", "-B", branch, worktree], ctx.cwd);
    }
    const task =
      `${IMPL_INSTRUCTIONS}\n\n${issueBlock(issue)}\n\n` +
      (plan ? `## Plano\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n` : "") +
      `## Comando de teste\n\`${testCommand}\``;
    let impl = await ctx.agent<{ summary: string; filesChanged: string[] }>(task, {
      label: "implementar",
      model: MODELS[tier],
      cwd: worktree,
      schema: IMPL_SCHEMA,
    });

    // ── Verificação: testes rodam no workflow; correção com teto de rodadas ─────────────
    ctx.phase("Verificação");
    let tests = runTests(testCommand, worktree);
    let fixRounds = 0;
    for (let round = 1; !tests.ok && round <= MAX_FIX_ROUNDS; round++) {
      fixRounds = round;
      ctx.log(`testes falharam; rodada de correção ${round}/${MAX_FIX_ROUNDS}`);
      impl = await ctx.agent(`${FIX_INSTRUCTIONS}\n\n## Saída dos testes\n${tests.output}`, {
        label: `corrigir-${round}`,
        model: MODELS[tier === "LOW" ? "MED" : "HIGH"], // escala o modelo na correção
        cwd: worktree,
        schema: IMPL_SCHEMA,
      });
      tests = runTests(testCommand, worktree);
    }
    ctx.metric("fix_rounds", fixRounds);
    ctx.metric("tests_passed", tests.ok ? 1 : 0);
    if (!tests.ok) {
      return { issue: issue.number, tier, status: "tests-failed", worktree, output: tests.output };
    }

    // ── Review condicional: HIGH ou diff grande; dois revisores com lentes diferentes ──
    sh("git", ["add", "-A"], worktree);
    const diffLines = sh("git", ["diff", "--cached", "--numstat"], worktree)
      .split("\n")
      .filter(Boolean)
      .reduce((n, l) => n + l.split("\t").slice(0, 2).map(Number).reduce((a, b) => a + (b || 0), 0), 0);
    const needsReview = tier === "HIGH" || diffLines > REVIEW_DIFF_LINES;
    ctx.metric("diff_lines", diffLines);
    ctx.metric("reviewed", needsReview ? 1 : 0);
    if (needsReview) {
      ctx.phase("Review");
      for (let round = 0; ; round++) {
        const lenses = ["corretude e casos de borda", "segurança e tratamento de erros"];
        const reviews = await ctx.parallel(
          lenses.map((lens) => () =>
            ctx.agent<{ findings: Array<{ file: string; severity: string; issue: string }> }>(
              `${REVIEW_INSTRUCTIONS}\n\n## Foco\n${lens}\n\n${issueBlock(issue)}\n\n(rodada ${round + 1})`,
              { label: `review:${lens}:${round + 1}`, phase: "Review", model: MODELS.REVIEW, cwd: worktree, tools: ["read", "grep", "glob", "ls", "shell"], schema: REVIEW_SCHEMA },
            ),
          ),
        );
        // Review exigido que não rodou não pode virar "sem achados": falha explícita.
        if (reviews.some((r) => r === null)) return { issue: issue.number, tier, status: "review-failed", worktree };
        const blocking = reviews.flatMap((r) => r!.findings).filter((f) => f.severity === "blocking");
        ctx.metric(`review_blocking_round_${round + 1}`, blocking.length);
        if (!blocking.length) break;
        if (round >= MAX_REVIEW_FIX_ROUNDS) return { issue: issue.number, tier, status: "review-blocking", worktree, findings: blocking };
        await ctx.agent(reviewFixPrompt(blocking), {
          label: `corrigir-review-${round + 1}`,
          model: MODELS[tier],
          cwd: worktree,
          schema: IMPL_SCHEMA,
        });
        tests = runTests(testCommand, worktree);
        if (!tests.ok) return { issue: issue.number, tier, status: "tests-failed-after-review", worktree, output: tests.output };
        sh("git", ["add", "-A"], worktree); // revisores leem o staged na próxima rodada
      }
    }

    // ── Entrega: commit/PR feitos pelo código, não pelo agente; idempotentes para o resume ─
    ctx.phase("Entrega");
    sh("git", ["add", "-A"], worktree);
    const secret = findStagedSecret(worktree);
    if (secret) {
      // Nada de commit, push ou PR. O worktree fica para inspeção; o motivo não repete o segredo.
      ctx.metric("secret_blocked", 1);
      ctx.log(`entrega bloqueada: ${secret}`);
      return { issue: issue.number, tier, status: "secret-blocked", reason: secret, branch, worktree, spentCents: ctx.budget.spentCents() };
    }
    if (hasStagedChanges(worktree)) sh("git", ["commit", "-m", `fix: ${issue.title} (#${issue.number})`], worktree);
    let prUrl: string | undefined;
    if (openPr) {
      sh("git", ["push", "-u", "origin", branch], worktree);
      prUrl = existingPr(branch, repoFlag, worktree) ??
        sh("gh", ["pr", "create", "--head", branch, "--title", `${issue.title} (#${issue.number})`, "--body", `Closes #${issue.number}\n\n${impl.summary}`, ...repoFlag], worktree).trim();
    }
    return {
      issue: issue.number,
      tier,
      status: "done",
      branch,
      worktree,
      prUrl,
      summary: impl.summary,
      reviewed: needsReview,
      spentCents: ctx.budget.spentCents(),
    };
  },
});
