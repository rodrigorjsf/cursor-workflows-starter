// Corpo do PR no template da skill pr (Summary, Evidence, Merge Danger). O agente escreve Summary e Merge Danger;
// a Evidence é a saída real da suíte em cada fatia (falhando, depois passando), guardada pelo código.
// The test output is redacted (redaction.ts) and its local paths replaced before it goes in.
import { homedir } from "node:os";
import { createRedactor } from "../../src/runtime/redaction.js";
import { neutralizeGitlabText, type ForgeName } from "./forge.js";
import type { ReviewReports } from "./review.js";
import type { SliceRecord } from "./tdd.js";

export interface PrText { summary: string; door: "one-way" | "two-way"; doorNote?: string; blastRadius: string; blastNote?: string }

const MAX_BODY = 60_000; // o GitHub aceita até 65.536 caracteres
/**
 * The cap in UTF-8 bytes. `glab mr create` takes the description as one argument (it has no body-file flag), and Linux refuses an
 * argument over 128 KiB (E2BIG): 60 000 characters of a three-byte script are some 180 KB.
 */
const MAX_BODY_BYTES = 100_000;
const TRUNCATED = "\n\n_(body truncated)_";
/** `body` within both caps, cut at a whole character (never inside a surrogate pair), with a note that it was cut. */
function capped(body: string): string {
  if (body.length <= MAX_BODY && Buffer.byteLength(body) <= MAX_BODY_BYTES) return body;
  let end = 0;
  let bytes = 0;
  for (const ch of body) {
    const size = Buffer.byteLength(ch);
    if (end + ch.length > MAX_BODY - 40 || bytes + size > MAX_BODY_BYTES - 40) break;
    end += ch.length;
    bytes += size;
  }
  return body.slice(0, end) + TRUNCATED;
}
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
 * Model text as an inline code span. A backtick in it would close the span and give the rest its effect again (a mention,
 * `<!--`), and a line break would end it: backticks become ˋ (U+02CB) and line breaks spaces, so the span holds.
 */
export const inlineCode = (s: string) => "`" + s.replace(/`/g, "ˋ").replace(/\r\n|\r|\n/g, " ") + "`";

/**
 * Texto do modelo vai para um PR público: neutraliza o que teria efeito no GitHub. Palavras de fechamento citando
 * outra issue (fecharia a issue errada), menções (notificariam pessoas) e `<!--` (esconderia o resto do corpo).
 *
 * The same filters serve GitLab, which reads more as a command. Its closing keywords also include `Closing`, `Fixing`,
 * `Resolving` and `Implement*`, and its issue reference can follow the word `issue` and be a path through subgroups or the
 * URL of the issue: those filters run on both forges. On GitLab (`forge`, the forge the text goes to) a line that starts with a
 * quick action (`/close`, `/merge`) runs it, and `!12`, `~label` and `%milestone` link other objects: `neutralizeGitlabText`
 * runs there only, since what it does to a fence or a sigil would change how GitHub renders the text and protect nothing.
 */
export function sanitizeModelText(text: string, forge: ForgeName): string {
  const shared = text
    .replace(
      /\b(clos(?:e[sd]?|ing)|fix(?:e[sd]|ing)?|resolv(?:e[sd]?|ing)|implement(?:s|ed|ing)?)(\s*:?\s+)((?:issues?\s+)?(?:(?:[\w.-]+\/)+[\w.-]+)?#\d+|(?:issues?\s+)?https?:\/\/\S+?\/-\/(?:issues|work_items)\/\d+)/gi,
      "$1$2`$3`",
    )
    .replace(/(^|[^\w`])@([A-Za-z0-9][\w-]*)/g, "$1@​$2")
    .replace(/<!--/g, "&lt;!--");
  return forge === "gitlab" ? neutralizeGitlabText(shared) : shared;
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
  /** Redacts the test output before it goes in (default: the redactor of this process's environment, as the event log's). */
  redact?: (text: string) => string;
  /** The forge the PR goes to: what its model text is guarded against (`sanitizeModelText`). */
  forge: ForgeName;
}): string {
  const { issueNumber, slices, review, deferred, refuted = [], worktree } = input;
  const sanitize = (text: string) => sanitizeModelText(text, input.forge);
  const redact = input.redact ?? createRedactor().text;
  const t = {
    summary: sanitize(input.text.summary),
    door: input.text.door,
    doorNote: input.text.doorNote ? sanitize(input.text.doorNote) : undefined,
    blastRadius: sanitize(input.text.blastRadius),
    blastNote: input.text.blastNote ? sanitize(input.text.blastNote) : undefined,
  };
  // Test output can print a credential (an env dump, a token in a fixture): redacted whole, before the tail cuts a token in two.
  const clean = (s: string | undefined, n: number) => redactPaths(tail(redact(s ?? ""), n), worktree);
  const evidence = slices
    .filter((s) => s.done)
    .map((s) =>
      s.alreadySatisfied
        ? `- ${inlineCode(s.testName ?? s.behavior)}: the behaviour already existed (${sanitize(s.alreadySatisfied)}); the test passed with no implementation.`
        : [
            `- **Before:** ${inlineCode(s.testName ?? s.behavior)} (${s.testFile ? inlineCode(s.testFile) : "test"}) failing`,
            "",
            fence(clean(s.red, 700)),
            "",
            "  **After:** the suite passes",
            "",
            fence(clean(s.green, 300)),
          ].join("\n"),
    )
    .join("\n\n");

  // Each piece of model text is neutralized on its own: prose by sanitizeModelText, a file name as an inline code span.
  // Sanitizing the whole line would put backticks inside the span and break it.
  const prose = sanitize;
  const notes: string[] = [];
  for (const f of review.standards?.findings ?? []) if (f.kind === "judgement") notes.push(`- Standards (judgement): ${prose(f.rule)} in ${inlineCode(f.file)}: ${prose(f.note)}`);
  for (const f of review.spec?.findings ?? []) if (f.kind === "scope-creep") notes.push(`- Spec (scope creep): ${prose(f.note)}`);
  for (const f of review.security?.findings ?? []) if (f.severity === "note") notes.push(`- Security (note): ${inlineCode(f.file)}: ${prose(f.issue)}`);
  for (const r of refuted) notes.push(`- Spec (refuted by a test: the behaviour already existed): ${prose(r)}`);

  const raw = [
    // Com fatias adiadas, a issue não fica resolvida: o PR só a referencia.
    deferred.length ? `Refs #${issueNumber} (partial delivery: see "Deferred")` : `Closes #${issueNumber}`,
    "",
    "## Summary",
    "",
    t.summary.trim(),
    "",
    "## Evidence",
    "",
    evidence || "_No slice recorded._",
    "",
    "## Merge Danger",
    "",
    `**Door:** ${t.door}`,
    ...(t.doorNote ? ["", t.doorNote] : []),
    "",
    `**Blast Radius:** ${t.blastRadius}`,
    ...(t.blastNote ? ["", t.blastNote] : []),
    ...(notes.length ? ["", "## Non-blocking review findings", "", ...notes] : []),
    ...(deferred.length ? ["", "## Deferred (slice cap)", "", ...deferred.map((d) => `- ${sanitize(d)}`)] : []),
    "",
    "---",
    "_Generated by the `implement-issue` workflow (cursor-workflows-starter): TDD slice by slice, review on three axes._",
  ].join("\n");
  // The whole body is redacted, the model's text included: a step result keeps the redact-only formats (JWT, `Bearer`, a
  // URL password) for the workflow to use, but a public PR gets none of them. Redacting the Evidence twice changes nothing.
  const body = redact(raw);
  return capped(body);
}
