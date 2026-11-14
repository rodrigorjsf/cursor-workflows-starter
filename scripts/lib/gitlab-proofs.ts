// WHAT: What scripts/verify/prove-gitlab.ts proves on a real GitLab, as data and as verdicts: the closing phrases and the
//   quick-action payloads it posts, what each posting did, the problems those results are (a phrase the sanitizer lets close an
//   issue, a command it lets run, a check that proved nothing because its control did nothing), and the evidence that goes in
//   the pull request description.
// WHY: the sanitizer for model text bound for GitLab (`sanitizeModelText`, packages/runtime/workflows/implement-issue/pr-body.ts)
//   was written from GitLab's documentation and source, never against a live instance. A verdict that reads a run's results is
//   a function, so the offline tests can pin it (test/gitlab-proofs.test.ts) while only the run itself needs the real GitLab. A
//   "no effect" result counts only when a control did take effect (`Closes #N` closing, a bare `/close` running, the references
//   linking), or the check proves nothing. The other phrases and payloads show beside their sanitized result what GitLab did with
//   them as written: one that does nothing even then is text to this GitLab, which the guard neutralizes for older versions.
// WHEN: imported by scripts/verify/prove-gitlab.ts and test/gitlab-proofs.test.ts; not run on its own.
// HOW: `problems(report)` is empty when every proof held; `renderEvidence(report)` is the Markdown for the pull request description.
import type { MrState } from "../../packages/runtime/src/runtime/forge-pr-state.js";

/** The words GitLab's default issue-closing pattern lists (its documentation, "Default closing pattern"), each in the forms it accepts. */
const CLOSING_WORDS = ["Close", "Closes", "Closed", "Closing", "Fix", "Fixes", "Fixed", "Fixing", "Resolve", "Resolves", "Resolved", "Resolving", "Implement", "Implements", "Implemented", "Implementing"];

/** The issue a closing phrase names: its number, its project (`group/project`) and its URL. */
export interface ClosingTarget {
  number: number;
  project: string;
  issueUrl: string;
}

/** One way a merge request description can name an issue for GitLab to close it when the request merges. */
export interface ClosingForm {
  /** What the evidence calls it: the phrase with `N` for the number. */
  name: string;
  text(target: ClosingTarget): string;
}

/** The phrase every other one is read against: the line the workflow writes itself (`Closes #N`), and the control of the whole check. */
export const CONTROL_CLOSING_FORM = "Closes #N";

export const CLOSING_FORMS: ClosingForm[] = [
  ...CLOSING_WORDS.map((word) => ({ name: `${word} #N`, text: (t: ClosingTarget) => `${word} #${t.number}` })),
  { name: "CLOSES #N", text: (t) => `CLOSES #${t.number}` },
  { name: "Closes: #N", text: (t) => `Closes: #${t.number}` },
  { name: "Fixes issue #N", text: (t) => `Fixes issue #${t.number}` },
  { name: "Resolves group/project#N", text: (t) => `Resolves ${t.project}#${t.number}` },
  { name: "Closes <issue URL>", text: (t) => `Closes ${t.issueUrl}` },
  { name: "This implements #N (in a sentence)", text: (t) => `This change implements #${t.number} and adds a test.` },
];

/** Where a quick action in model text could run: the surfaces the workflow writes model text to. */
export type Surface = "issue note" | "merge request description";
export const SURFACES: Surface[] = ["issue note", "merge request description"];

/** What the guard does with a payload: it changes the text (a command made text, a fence closed), or it leaves the text alone because it sits in a fence GitLab reads as code. */
export type Guard = "neutralizes" | "leaves-as-code";

/** One payload of model text with a `/close` in it. */
export interface QuickActionCase {
  name: string;
  /** The pieces of model text, each sanitized on its own and joined with a blank line, as the workflow builds a body (`buildPrBody`). */
  pieces: string[];
  guard: Guard;
}

/** The payload every other is read against: a bare command, which has to run when nothing guards it, or the check proved nothing. */
export const CONTROL_CASE = "a bare /close";

/** The payloads the ticket lists (#89): each is a way to hide or shape a quick action that the guard's rules have to see through. */
export const QUICK_ACTION_CASES: QuickActionCase[] = [
  { name: CONTROL_CASE, pieces: ["I looked at it.\n/close\nThanks."], guard: "neutralizes" },
  { name: "/CLOSE in capitals", pieces: ["Done.\n/CLOSE"], guard: "neutralizes" },
  { name: "/close followed by a tab", pieces: ["Done.\n/close\t"], guard: "neutralizes" },
  { name: "/close after a lone carriage return", pieces: ["Done.\n\r/close"], guard: "neutralizes" },
  { name: "/close in text with CRLF line endings", pieces: ["Done.\r\n/close\r\nThanks."], guard: "neutralizes" },
  { name: "/close inside a fence of three backticks", pieces: ["Example:\n```\n/close\n```"], guard: "leaves-as-code" },
  { name: "/close inside a fence of tildes", pieces: ["Example:\n~~~\n/close\n~~~"], guard: "neutralizes" },
  { name: "/close inside a fence of four backticks", pieces: ["Example:\n````\n/close\n````"], guard: "neutralizes" },
  { name: "/close after a <div> line", pieces: ["<div>\n/close"], guard: "neutralizes" },
  { name: "/close after a >>> line", pieces: [">>>\n/close"], guard: "neutralizes" },
  { name: "/close after a $$ line", pieces: ["$$\n/close"], guard: "neutralizes" },
  // The first piece leaves a fence open, so the fence of the second would pair with it the wrong way round and put its /close outside any code.
  { name: "a fence opened in one piece and never closed, then a fenced /close in the next", pieces: ["Notes:\n```\nsome code", "Example:\n```\n/close\n```"], guard: "neutralizes" },
];

/** Text with the three reference sigils GitLab links: a merge request, a label and a milestone. `!1`, `~bug` and `%v1` exist in the project the prover makes. */
export const SIGIL_TEXT = "See !1, ~bug and %v1.";

/** What a phrase did on merge: whether the issue it names was closed, and how long GitLab took (absent when it did not close). */
export interface ClosingOutcome {
  closed: boolean;
  seconds?: number;
}

export interface ClosingResult {
  form: string;
  /** The phrase as GitLab got it, unsanitized, and sanitized by `sanitizeModelText`. */
  raw: ClosingOutcome;
  sanitized: ClosingOutcome;
}

export interface QuickActionResult {
  case: string;
  surface: Surface;
  /** Whether the command ran: the issue is closed (an issue note), the merge request is closed (its description). */
  raw: boolean;
  sanitized: boolean;
}

/** The links `<a>` GitLab rendered from one text, and whether it wrote a "mentioned in" note on the merge request `!1`. */
export interface SigilOutcome {
  links: number;
  crossReferenced: boolean;
}

export interface SigilResult {
  raw: SigilOutcome;
  sanitized: SigilOutcome;
}

export interface WorkflowResult {
  /** The `status` the run ended with (`done` when it opened the merge request). */
  status: string;
  runId?: string;
  /** What the run said about why it did not finish, when it did not. */
  reason?: string;
  mrUrl?: string;
  /** The merge request's state before it was merged: `opened`. */
  mrState?: MrState;
  /** The description holds the line that closes the issue on merge (`Closes #N`). */
  closesIssueLine?: boolean;
  merged?: boolean;
  issueClosed?: boolean;
  secondsToClose?: number;
  /** What the run spent, as it reported: tokens, and the caps it ran under. */
  tokens?: number;
  caps: { maxTokens: number; maxCents: number };
}

/** The versions behind the results, and behind a recording of the fixtures: the glab, the GitLab and the image it ran. */
export interface Versions {
  glab: string;
  gitlab: string;
  image: string;
}

/** Every result of one run. A stage that did not run, or did not finish, is absent. */
export interface ProofReport {
  versions: Versions;
  closing?: ClosingResult[];
  quickActions?: QuickActionResult[];
  sigils?: SigilResult;
  workflow?: WorkflowResult;
}

/** The stages of a run, in the order they run: the free ones first, the one that spends tokens last. */
export const STAGES = ["closing", "quick-actions", "references", "workflow"] as const;
export type Stage = (typeof STAGES)[number];

function closingProblems(results: ClosingResult[]): string[] {
  const found: string[] = [];
  const control = results.find((r) => r.form === CONTROL_CLOSING_FORM);
  if (control === undefined || !control.raw.closed) found.push(`the control proved nothing: "${CONTROL_CLOSING_FORM}" did not close its issue on merge, so no phrase can be shown not to close`);
  for (const r of results) if (r.sanitized.closed) found.push(`"${r.form}" closes its issue on merge after sanitizeModelText: the sanitizer has to cover it`);
  return found;
}

function quickActionProblems(results: QuickActionResult[]): string[] {
  const found: string[] = [];
  for (const surface of SURFACES) {
    const control = results.find((r) => r.case === CONTROL_CASE && r.surface === surface);
    if (control === undefined || !control.raw) found.push(`the control proved nothing: a bare /close did not run in a ${surface}, so no payload can be shown not to run`);
  }
  for (const r of results) if (r.sanitized) found.push(`"${r.case}" ran as a command in a ${r.surface} after sanitizeModelText: the guard has to cover it`);
  return found;
}

function sigilProblems(result: SigilResult): string[] {
  const found: string[] = [];
  if (result.raw.links === 0) found.push("the control proved nothing: GitLab linked none of !1, ~bug and %v1 in the unsanitized text");
  if (!result.raw.crossReferenced) found.push("the control proved nothing: GitLab wrote no cross-reference note on !1 for the unsanitized text");
  if (result.sanitized.links > 0) found.push(`GitLab still linked ${result.sanitized.links} reference(s) of the sanitized text: the zero-width space does not stop it`);
  if (result.sanitized.crossReferenced) found.push("GitLab still wrote a cross-reference note on !1 for the sanitized text");
  return found;
}

function workflowProblems(result: WorkflowResult): string[] {
  if (result.status !== "done") return [`implement-issue ended "${result.status}"${result.reason ? `: ${result.reason}` : ""}, not "done"`];
  const found: string[] = [];
  if (result.mrUrl === undefined) found.push("implement-issue is done but opened no merge request");
  if (result.mrState !== "opened") found.push(`the merge request implement-issue opened is "${result.mrState ?? "unknown"}", not "opened"`);
  if (result.closesIssueLine !== true) found.push("the merge request description has no `Closes #N` line");
  if (result.merged !== true) found.push("the merge request implement-issue opened could not be merged");
  else if (result.issueClosed !== true) found.push("merging the merge request implement-issue opened did not close its issue");
  return found;
}

/** What each stage a run was asked for (all of them by default) has to show, in a sentence a maintainer can act on. Empty when every proof held. */
export function problems(report: ProofReport, stages: readonly Stage[] = STAGES): string[] {
  /** The problems of one stage: none when it was not asked for, "not checked" when it was and left no result. */
  const judge = <T>(stage: Stage, result: T | undefined, notChecked: string, problemsOf: (result: T) => string[]): string[] =>
    !stages.includes(stage) ? [] : result === undefined ? [notChecked] : problemsOf(result);
  return [
    ...judge("closing", report.closing, "the closing phrases were not checked", closingProblems),
    ...judge("quick-actions", report.quickActions, "the quick actions were not checked", quickActionProblems),
    ...judge("references", report.sigils, "the references were not checked", sigilProblems),
    ...judge("workflow", report.workflow, "implement-issue was not run", workflowProblems),
  ];
}

const yes = (flag: boolean) => (flag ? "yes" : "no");
const closedCell = (o: ClosingOutcome) => (o.closed ? `yes (${o.seconds ?? "?"} s)` : "no");
const code = (text: string) => `\`${text}\``;
const cell = (text: string) => text.replace(/\|/g, "\\|");

/** The Markdown for the pull request description: what ran, against what, and what GitLab did. Contains no secret and no host: the caller scrubs it. */
export function renderEvidence(report: ProofReport, stages: readonly Stage[] = STAGES): string {
  const { glab, gitlab, image } = report.versions;
  const out: string[] = [`Run with glab ${glab} against GitLab CE ${gitlab} (${code(image)}), by \`scripts/verify/gitlab-e2e.sh\`.`, ""];

  if (report.closing) {
    const implement = report.closing.filter((r) => /^Implement/.test(r.form));
    const closes = implement.filter((r) => r.raw.closed);
    const notClosing = report.closing.filter((r) => !r.raw.closed);
    out.push(
      "### Which phrases close an issue when the merge request merges",
      "",
      `Does GitLab's default closing pattern match \`Implement(s|ed|ing) #N\`? **${closes.length === implement.length ? "Yes" : closes.length === 0 ? "No" : "Some forms"}**: ${closes.length} of ${implement.length} forms closed the issue (${implement.map((r) => `${code(r.form)}: ${yes(r.raw.closed)}`).join(", ")}). After \`sanitizeModelText\`, ${implement.filter((r) => r.sanitized.closed).length} of them still close it.`,
      "",
      "Each phrase was put in the description of a merge request that was then merged. Raw is the phrase as written; sanitized is the same text through `sanitizeModelText`.",
      "",
      "| Phrase | Raw: issue closed | Sanitized: issue closed |",
      "|---|---|---|",
      ...report.closing.map((r) => `| ${cell(code(r.form))} | ${closedCell(r.raw)} | ${closedCell(r.sanitized)} |`),
      "",
      ...(notClosing.length === 0 ? [] : [`Not closing even as written: ${notClosing.map((r) => code(r.form)).join(", ")}. GitLab's pattern does not match them; the sanitizer neutralizes them anyway.`, ""]),
    );
  }

  if (report.quickActions) {
    const ranAsWritten = new Set(report.quickActions.filter((r) => r.raw).map((r) => r.case));
    const total = new Set(report.quickActions.map((r) => r.case)).size;
    out.push(
      "### Quick actions in model text",
      "",
      "A \"command ran\" means GitLab acted on a `/close`: the issue closed (a note on it) or the merge request closed (its description). Sanitized is the payload through `sanitizeModelText`, piece by piece, as the workflow builds a body.",
      "",
      "| Payload | Surface | Raw: command ran | Sanitized: command ran |",
      "|---|---|---|---|",
      ...report.quickActions.map((r) => `| ${cell(r.case)} | ${r.surface} | ${yes(r.raw)} | ${yes(r.sanitized)} |`),
      "",
      `Ran as written: ${ranAsWritten.size} of ${total} payloads.${ranAsWritten.size === total ? "" : " The others are text to this GitLab; the guard neutralizes them anyway, for the versions that read them as commands."}`,
      "",
    );
  }

  if (report.sigils) {
    const { raw, sanitized } = report.sigils;
    out.push(
      "### References behind the zero-width space",
      "",
      `The text ${code(SIGIL_TEXT)} names a merge request, a label and a milestone that exist. Raw, GitLab rendered ${raw.links} link(s) and ${raw.crossReferenced ? "wrote a" : "wrote no"} cross-reference note on \`!1\`. After \`sanitizeModelText\`, which puts a zero-width space after each sigil, it rendered ${sanitized.links} link(s) and ${sanitized.crossReferenced ? "wrote a" : "wrote no"} cross-reference note.`,
      "",
    );
  }

  if (report.workflow) {
    const w = report.workflow;
    out.push(
      "### `implement-issue` with local steps",
      "",
      "| What | Result |",
      "|---|---|",
      `| Run status | ${code(w.status)}${w.reason ? ` (${cell(w.reason)})` : ""} |`,
      `| Run id | ${w.runId ? code(w.runId) : "none"} |`,
      `| Merge request opened | ${w.mrUrl ?? "no"} |`,
      `| Its state when the run ended | ${w.mrState ?? "unknown"} |`,
      `| Its description closes the issue on merge (${code("Closes #N")}) | ${yes(w.closesIssueLine === true)} |`,
      `| Merged | ${yes(w.merged === true)} |`,
      `| The issue closed after the merge | ${w.issueClosed === true ? `yes (${w.secondsToClose ?? "?"} s)` : "no"} |`,
      `| Tokens | ${w.tokens ?? "not reported"}, under \`--max-tokens ${w.caps.maxTokens} --max-cents ${w.caps.maxCents}\` |`,
      "",
    );
  }

  const found = problems(report, stages);
  out.push(found.length === 0 ? "Every proof held." : ["Problems:", ...found.map((p) => `- ${p}`)].join("\n"));
  return `${out.join("\n")}\n`;
}
