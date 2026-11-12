// Corpo do PR no template da skill pr (Summary, Evidence, Merge Danger). O agente escreve Summary e Merge Danger;
// a Evidence é a saída real da suíte em cada fatia (falhando, depois passando), guardada pelo código.
import { homedir } from "node:os";
import type { ReviewReports } from "./review.js";
import type { SliceRecord } from "./tdd.js";

export interface PrText { summary: string; door: "one-way" | "two-way"; doorNote?: string; blastRadius: string; blastNote?: string }

const MAX_BODY = 60_000; // o GitHub aceita até 65.536 caracteres
/** O fim de uma saída, a partir de uma linha inteira: o pedaço de linha que o limite corta sai. */
const tail = (s: string | undefined, n: number) => {
  const t = (s ?? "").trim();
  if (t.length <= n) return t;
  const cut = t.slice(-n);
  const nl = cut.indexOf("\n");
  return nl >= 0 && nl < cut.length - 1 ? cut.slice(nl + 1) : cut;
};
const fence = (s: string) => "```text\n" + s.replace(/```/g, "ˋˋˋ") + "\n```";

/**
 * Texto do modelo vai para um PR público: neutraliza o que teria efeito no GitHub. Palavras de fechamento citando
 * outra issue (fecharia a issue errada), menções (notificariam pessoas) e `<!--` (esconderia o resto do corpo).
 */
export function sanitizeModelText(text: string): string {
  return text
    .replace(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s+)((?:[\w.-]+\/[\w.-]+)?#\d+)/gi, "$1$2`$3`")
    .replace(/(^|[^\w`])@([A-Za-z0-9][\w-]*)/g, "$1@​$2")
    .replace(/<!--/g, "&lt;!--");
}

/** Saída de teste vai para o PR: troca caminhos locais (pasta pessoal, worktree) por marcadores. */
export function redactPaths(text: string, worktree?: string): string {
  let out = text;
  if (worktree) out = out.split(worktree).join("<worktree>");
  const home = homedir();
  return home && home !== "/" ? out.split(home).join("~") : out;
}

export function buildPrBody(input: {
  issueNumber: number;
  text: PrText;
  slices: SliceRecord[];
  review: ReviewReports;
  deferred: string[];
  /** Achados "missing"/"wrong" cujo teste passou sem implementação: o comportamento já existia. */
  refuted?: string[];
  worktree?: string;
}): string {
  const { issueNumber, slices, review, deferred, refuted = [], worktree } = input;
  const t = {
    summary: sanitizeModelText(input.text.summary),
    door: input.text.door,
    doorNote: input.text.doorNote ? sanitizeModelText(input.text.doorNote) : undefined,
    blastRadius: sanitizeModelText(input.text.blastRadius),
    blastNote: input.text.blastNote ? sanitizeModelText(input.text.blastNote) : undefined,
  };
  const clean = (s: string | undefined, n: number) => redactPaths(tail(s, n), worktree);
  const evidence = slices
    .filter((s) => s.done)
    .map((s) =>
      s.alreadySatisfied
        ? `- \`${s.testName ?? s.behavior}\`: o comportamento já existia (${sanitizeModelText(s.alreadySatisfied)}); o teste passou sem implementação.`
        : [
            `- **Before:** \`${s.testName ?? s.behavior}\` (${s.testFile ?? "teste"}) falhando`,
            "",
            fence(clean(s.red, 700)),
            "",
            "  **After:** a suíte passa",
            "",
            fence(clean(s.green, 300)),
          ].join("\n"),
    )
    .join("\n\n");

  const notes: string[] = [];
  for (const f of review.standards?.findings ?? []) if (f.kind === "judgement") notes.push(`- Standards (julgamento): ${f.rule} em \`${f.file}\`: ${f.note}`);
  for (const f of review.spec?.findings ?? []) if (f.kind === "scope-creep") notes.push(`- Spec (fora do pedido): ${f.note}`);
  for (const f of review.security?.findings ?? []) if (f.severity === "note") notes.push(`- Segurança (nota): \`${f.file}\`: ${f.issue}`);
  for (const r of refuted) notes.push(`- Spec (refutado por teste: o comportamento já existia): ${r}`);

  const body = [
    // Com fatias adiadas, a issue não fica resolvida: o PR só a referencia.
    deferred.length ? `Refs #${issueNumber} (entrega parcial: veja "Adiado")` : `Closes #${issueNumber}`,
    "",
    "## Summary",
    "",
    t.summary.trim(),
    "",
    "## Evidence",
    "",
    evidence || "_Nenhuma fatia registrada._",
    "",
    "## Merge Danger",
    "",
    `**Door:** ${t.door}`,
    ...(t.doorNote ? ["", t.doorNote] : []),
    "",
    `**Blast Radius:** ${t.blastRadius}`,
    ...(t.blastNote ? ["", t.blastNote] : []),
    ...(notes.length ? ["", "## Achados de review que não bloqueiam", "", ...notes.map(sanitizeModelText)] : []),
    ...(deferred.length ? ["", "## Adiado (limite de fatias)", "", ...deferred.map((d) => `- ${sanitizeModelText(d)}`)] : []),
    "",
    "---",
    "_Gerado pelo workflow `implement-issue` (cursor-workflows-starter): TDD fatia a fatia, review em três eixos._",
  ].join("\n");
  return body.length > MAX_BODY ? body.slice(0, MAX_BODY - 40) + "\n\n_(corpo truncado)_" : body;
}
