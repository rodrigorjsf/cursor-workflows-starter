// What the seams panel of the Run view works with, apart from the component (SeamsPanel.tsx): the proposal as the API offers it, narrowed
// from what `GET /api/runs/<runId>` answered, and the replacement the person types, one seam per line, turned into the list the server
// takes. Pure: no DOM, no clock, no network. The proposal's type is declared here, not imported: this folder is checked without the
// runtime's or the server's types (see its tsconfig), and the answer is untrusted JSON until `isSeamsProposal` has looked at it.

import { isRecord } from "../app/is-record.js";

export interface ProposedSeam {
  name: string;
  interface: string;
  why: string;
}

export interface ProposedSlice {
  behavior: string;
  seam: string;
  testIdea: string;
}

/** What a run that stopped at a proposal waits on, as `GET /api/runs/<runId>` offers it (`seamsProposal`). `digest` names it: an approval sends it back. */
export interface SeamsProposalInfo {
  /** `seams-proposed`: the plan, with the seams to approve or replace. `test-command-proposed`: a plan whose test command the planner chose, waiting for its own decision. */
  stop: "seams-proposed" | "test-command-proposed";
  seams: ProposedSeam[];
  slices: ProposedSlice[];
  /** The command the run executes once the plan is approved. */
  testCommand: string;
  digest: string;
  /** Whether the dashboard can take a decision on this run (a job started it, and its record says how). When it cannot, the page shows the proposal and sends the person to the terminal. */
  decidable: boolean;
}

const hasTexts = (value: unknown, names: string[]): boolean => isRecord(value) && names.every((name) => typeof value[name] === "string");
const isListOf = (value: unknown, names: string[]): boolean => Array.isArray(value) && value.every((item) => hasTexts(item, names));

/** Whether `value`, parsed from the API's answer, is a proposal this page can show: every field it reads is there, of its type. */
export function isSeamsProposal(value: unknown): value is SeamsProposalInfo {
  return (
    isRecord(value) &&
    (value.stop === "seams-proposed" || value.stop === "test-command-proposed") &&
    typeof value.testCommand === "string" &&
    typeof value.digest === "string" &&
    typeof value.decidable === "boolean" &&
    isListOf(value.seams, ["name", "interface", "why"]) &&
    isListOf(value.slices, ["behavior", "seam", "testIdea"])
  );
}

/** The seams a textarea holds: one per line, each trimmed, blank lines dropped. */
export const seamsFromText = (text: string): string[] =>
  text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** The replacement a textarea holds, or the sentence the box shows when it holds none: a replacement with no seams would leave the run with nothing to plan on. */
export function replacementOf(text: string): { ok: true; seams: string[] } | { ok: false; error: string } {
  const seams = seamsFromText(text);
  return seams.length > 0 ? { ok: true, seams } : { ok: false, error: "List at least one seam, one per line." };
}
