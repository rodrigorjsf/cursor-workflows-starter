// What the buttons of the Run view ask of the dashboard.
import { runApiPath } from "./location.js";

/** What a cancel came to: the job's state and what was done (`note`), or why nothing was done (`error`). */
export type CancelOutcome = { ok: true; status: string; note: string } | { ok: false; error: string };

/** The server's sentence, as a sentence: a capital first letter and a full stop. */
const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;

/** What the header says after a cancel: of the run (`cloudOnly` false), or of the cloud agents a dead run left (`cloudOnly`). */
export function cancelResult(outcome: CancelOutcome, cloudOnly: boolean): { step: "done" | "failed"; message: string } {
  if (!outcome.ok) return { step: "failed", message: sentence(outcome.error) };
  if (cloudOnly) return { step: /could not reach cloud agent/.test(outcome.note) ? "failed" : "done", message: sentence(outcome.note.replace(/^the run is not running \(\w+\); /, "")) };
  return { step: "done", message: outcome.status === "cancelled" ? "Cancelled." : `Cancelling: ${outcome.note}` };
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
