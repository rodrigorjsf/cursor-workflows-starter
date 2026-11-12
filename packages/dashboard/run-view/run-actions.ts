// What the buttons of the Run view ask of the dashboard.
import { runApiPath } from "./location.js";

/** What a cancel came to: the job's state and what was done (`note`), or why nothing was done (`error`). */
export type CancelOutcome = { ok: true; status: string; note: string } | { ok: false; error: string };

/** The server's sentence, as a sentence: a capital first letter and a full stop. */
const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;

/** A note that says something is still left to cancel: an agent the Cursor API did not reach, or a killed process not gone yet. */
const LEFT_TO_CANCEL = /could not reach cloud agent|has not exited yet/;

/**
 * What the header says after a cancel: of the run (`cloudOnly` false), or of the cloud agents a dead run left (`cloudOnly`).
 * A refusal that says there is nothing to cancel (the run ended, or its agents were cancelled already) is a done outcome. A
 * frozen run's process is killed, so its job is not `running` afterwards: the note says what the kill did. A note that says
 * something is left to cancel is a failure, so the button stays.
 */
export function cancelResult(outcome: CancelOutcome, cloudOnly: boolean): { step: "done" | "failed"; message: string } {
  if (!outcome.ok) return { step: /nothing to cancel/.test(outcome.error) ? "done" : "failed", message: sentence(outcome.error) };
  const step = LEFT_TO_CANCEL.test(outcome.note) ? "failed" : "done";
  if (cloudOnly) return { step, message: sentence(outcome.note.replace(/^the run is not running \(\w+\); /, "")) };
  if (outcome.status === "cancelled") return { step: "done", message: "Cancelled." };
  if (outcome.status === "running") return { step: "done", message: `Cancelling: ${outcome.note}` };
  return { step, message: sentence(outcome.note) };
}

/**
 * Cancels the run. The dashboard wants its CSRF token on every action: it hands the token to a script of its own origin, and
 * to no other. The token is read for each cancel, so a dashboard that was restarted since the page loaded still accepts it.
 */
export async function cancelRun(runId: string): Promise<CancelOutcome> {
  try {
    const tokenReply = await fetch("/api/csrf");
    if (!tokenReply.ok) return { ok: false, error: `the dashboard answered ${tokenReply.status} to the token request` };
    const { csrfToken } = (await tokenReply.json()) as { csrfToken: string };
    const reply = await fetch(`${runApiPath(runId)}/cancel`, { method: "POST", headers: { "x-csrf-token": csrfToken } });
    const body = (await reply.json().catch(() => ({}))) as { status?: string; note?: string; error?: string };
    if (!reply.ok) return { ok: false, error: body.error ?? `the dashboard answered ${reply.status}` };
    return { ok: true, status: body.status ?? "running", note: body.note ?? "" };
  } catch (err) {
    return { ok: false, error: `could not reach the dashboard: ${err instanceof Error ? err.message : String(err)}` };
  }
}
