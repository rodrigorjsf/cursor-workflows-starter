// Corpo do PR no template da skill pr (Summary, Evidence, Merge Danger). O agente escreve Summary e Merge Danger;
// a Evidence é a saída real da suíte em cada fatia (falhando, depois passando), guardada pelo código.
import type { ReviewReports } from "./review.js";
import type { SliceRecord } from "./tdd.js";

export interface PrText { summary: string; door: "one-way" | "two-way"; doorNote?: string; blastRadius: string; blastNote?: string }

const MAX_BODY = 60_000; // o GitHub aceita até 65.536 caracteres
const tail = (s: string | undefined, n: number) => (s ?? "").trim().slice(-n);
const fence = (s: string) => "```text\n" + s.replace(/```/g, "ˋˋˋ") + "\n```";

export function buildPrBody(input: {
  issueNumber: number;
  text: PrText;
  slices: SliceRecord[];
  review: ReviewReports;
  deferred: string[];
}): string {
  const { issueNumber, text, slices, review, deferred } = input;
  const evidence = slices
    .filter((s) => s.done)
    .map((s) =>
      [
        `- **Before:** \`${s.testName ?? s.behavior}\` (${s.testFile ?? "teste"}) falhando`,
        "",
        fence(tail(s.red, 700)),
        "",
        "  **After:** a suíte passa",
        "",
        fence(tail(s.green, 300)),
      ].join("\n"),
    )
    .join("\n\n");

  const notes: string[] = [];
  for (const f of review.standards?.findings ?? []) if (f.kind === "judgement") notes.push(`- Standards (julgamento): ${f.rule} em \`${f.file}\`: ${f.note}`);
  for (const f of review.spec?.findings ?? []) if (f.kind === "scope-creep") notes.push(`- Spec (fora do pedido): ${f.note}`);
  for (const f of review.security?.findings ?? []) if (f.severity === "note") notes.push(`- Segurança (nota): \`${f.file}\`: ${f.issue}`);

  const body = [
    `Closes #${issueNumber}`,
    "",
    "## Summary",
    "",
    text.summary.trim(),
    "",
    "## Evidence",
    "",
    evidence || "_Nenhuma fatia registrada._",
    "",
    "## Merge Danger",
    "",
    `**Door:** ${text.door}`,
    ...(text.doorNote ? ["", text.doorNote] : []),
    "",
    `**Blast Radius:** ${text.blastRadius}`,
    ...(text.blastNote ? ["", text.blastNote] : []),
    ...(notes.length ? ["", "## Achados de review que não bloqueiam", "", ...notes] : []),
    ...(deferred.length ? ["", "## Adiado (limite de fatias)", "", ...deferred.map((d) => `- ${d}`)] : []),
    "",
    "---",
    "_Gerado pelo workflow `implement-issue` (cursor-workflows-starter): TDD fatia a fatia, review em três eixos._",
  ].join("\n");
  return body.length > MAX_BODY ? body.slice(0, MAX_BODY - 40) + "\n\n_(corpo truncado)_" : body;
}
