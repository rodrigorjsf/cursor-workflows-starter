// Pure: what the Start panel's form holds and how it becomes the request the server takes. No DOM, network or clock.
//
// The server decides what may start (which repository, which workflow, whether the args fit) and says why not in its own words;
// what is checked here is what only the browser sees: that the args box holds JSON, and that a cap box holds a number.
import type { WorkflowEntry } from "../src/start.js";

/** What the form's boxes hold. The caps are text, as typed: an empty box is a cap that is not given, which the server refuses by name. */
export interface StartFormState {
  repo: string;
  workflow: string;
  argsText: string;
  maxTokens: string;
  maxCents: string;
}

/** The body of `POST /api/start`. A cap left out is one the server refuses with its name. */
export interface StartRequestBody {
  repo: string;
  workflow: string;
  args: Record<string, unknown>;
  maxTokens?: number;
  maxCents?: number;
}

export const EMPTY_FORM: StartFormState = { repo: "", workflow: "", argsText: "{}", maxTokens: "", maxCents: "" };

/** The args box's text for a workflow: its skeleton, written out as JSON so each field is on a line of its own. */
export const argsTextOf = (workflow: WorkflowEntry | undefined): string => JSON.stringify(workflow?.argsSkeleton ?? {}, null, 2);

/** A cap box's number: undefined for an empty box (not given), NaN for text that is not a number. */
function capOf(text: string): number | undefined {
  return text.trim() === "" ? undefined : Number(text);
}

/** The request the form stands for, or the sentence that says what is wrong with the box that cannot become one. */
export function startBody(form: StartFormState): { ok: true; body: StartRequestBody } | { ok: false; error: string } {
  let args: unknown;
  try {
    args = JSON.parse(form.argsText);
  } catch (err) {
    return { ok: false, error: `the args are not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return { ok: false, error: "the args must be a JSON object" };
  const maxTokens = capOf(form.maxTokens);
  const maxCents = capOf(form.maxCents);
  if (Number.isNaN(maxTokens)) return { ok: false, error: "maxTokens must be a number" };
  if (Number.isNaN(maxCents)) return { ok: false, error: "maxCents must be a number" };
  return {
    ok: true,
    body: { repo: form.repo, workflow: form.workflow, args: args as Record<string, unknown>, ...(maxTokens === undefined ? {} : { maxTokens }), ...(maxCents === undefined ? {} : { maxCents }) },
  };
}
