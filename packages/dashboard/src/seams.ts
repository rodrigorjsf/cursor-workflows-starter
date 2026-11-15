// What the dashboard's seams decision says to the browser and takes from it, apart from the HTTP plumbing (server.ts): the bodies of
// `POST /api/runs/<runId>/seams/approve` and `.../seams/replace` checked into a decision, and the runtime's answer (`approveSeams` and
// `replaceSeams`, observe) turned into a status and a sentence. Pure: no clock, no network, no disk.
//
// An approval names the proposal it is for (its `digest`, which `GET /api/runs/<runId>` offers with the proposal): the browser sends back
// what it showed, so a plan that changed in between is refused instead of approved unseen. A replacement names no proposal: it carries the
// person's own seams, which the run plans again with.
//
// Every refusal is a 404 for a run the index does not know, a 400 for a body that is not a decision, and a 409 for the rest: the run exists,
// but waits for no decision, or on another proposal, or has not got what it takes to be resumed from here.
import type { SeamsActionOutcome } from "@cursor-workflows/runtime/observe";
import { isTextList } from "../app/is-record.js";
import { jsonObjectOf } from "./request-body.js";
import { type ResumedReply, resumeReply } from "./resume.js";

/** The most a seams decision may weigh. A list of seams is a few lines of text; anything larger is not one. */
export const MAX_SEAMS_BODY_BYTES = 64 * 1024;


export type SeamsDecision = { kind: "approve"; digest: string } | { kind: "replace"; seams: string[] };

export type ParsedSeams = { ok: true; decision: SeamsDecision } | { ok: false; error: string };

/** The decision a body (`raw`, the text received) holds for `action`, or why it is not one. A replacement's seams are trimmed, and a blank one is dropped. */
export function parseSeamsBody(action: SeamsDecision["kind"], raw: string): ParsedSeams {
  const parsed = jsonObjectOf(raw, action === "approve" ? "the request body must be a JSON object with the digest of the proposal" : "the request body must be a JSON object with seams: a list of text");
  if (!parsed.ok) return parsed;
  const { digest, seams } = parsed.body;
  if (action === "approve") {
    if (digest === undefined || digest === "") return { ok: false, error: "digest is required: the digest of the proposal the page showed" };
    if (typeof digest !== "string") return { ok: false, error: "digest must be text: the digest of the proposal the page showed" };
    return { ok: true, decision: { kind: "approve", digest } };
  }
  const list = seams ?? [];
  if (!isTextList(list)) return { ok: false, error: "seams must be a list of text: one seam in each" };
  const given = list.map((seam) => seam.trim()).filter((seam) => seam !== "");
  if (given.length === 0) return { ok: false, error: "seams must list at least one seam: a replacement with none would leave the run with nothing to plan on" };
  return { ok: true, decision: { kind: "replace", seams: given } };
}

/** The status and the body the runtime's answer to a decision becomes. A decision that worked is 202: the resumed job runs on its own, and the run shows `running` a moment later. */
export function seamsReply(outcome: SeamsActionOutcome): { status: number; body: ResumedReply | { error: string } } {
  switch (outcome.kind) {
    case "no-proposal":
      return { status: 409, body: { error: "the run waits for no decision on its seams: it did not stop at a proposal, or it went on since; reload the page" } };
    case "proposal-changed":
      return { status: 409, body: { error: "the proposal changed since this page showed it; reload the page and read the new one before approving" } };
    case "no-start":
      return {
        status: 409,
        body: { error: "the run was not started as a job (wf run in a terminal, or by an older kit), so the dashboard does not know the args to decide with; decide from the terminal with the relaunch command of the seams comment on the issue" },
      };
    default:
      return resumeReply(outcome);
  }
}
