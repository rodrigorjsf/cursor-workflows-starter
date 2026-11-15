// How the pages talk to the dashboard's JSON API: a GET, and a POST that carries the CSRF token every action needs. The
// dashboard hands the token to a script of its own origin and to no other; it is read for each action, so a dashboard that was
// restarted since the page loaded still accepts it. An answer is data, never a throw: the page shows `error` as it is, which is
// the server's own sentence when it sent one. An answer is checked by the caller's `isBody` before the page reads it, so a
// dashboard of another version (or something else on the port) is a failure that says so, not a body of the wrong type.
// `origin` is empty in a browser (the page's own); a test points it at the server.

import { errorText } from "./error-text.js";
import { isRecord } from "./is-record.js";

/** Whether a parsed answer is the body the caller reads: every field it uses is there, of its type. */
export type BodyCheck<T> = (value: unknown) => value is T;

/** What an API call came to: the answer's body, or why there is none. */
export type ApiReply<T> = { ok: true; status: number; body: T } | { ok: false; status?: number; error: string };

/** A failed reply's text: the server's `{ error }` when it sent one, else the status. */
async function failure(reply: Response): Promise<{ ok: false; status: number; error: string }> {
  const body: unknown = await reply.json().catch(() => ({}));
  return { ok: false, status: reply.status, error: isRecord(body) && typeof body.error === "string" ? body.error : `the dashboard answered ${reply.status}` };
}

/** A successful reply's body, when `isBody` accepts it. */
async function success<T>(reply: Response, isBody: BodyCheck<T>, fallback?: unknown): Promise<ApiReply<T>> {
  const body: unknown = await reply.json().catch(() => fallback);
  return isBody(body) ? { ok: true, status: reply.status, body } : { ok: false, status: reply.status, error: `the dashboard answered ${reply.status} with a body this page cannot read` };
}

const unreachable = (err: unknown): { ok: false; error: string } => ({ ok: false, error: `could not reach the dashboard: ${errorText(err)}` });

export async function getJson<T>(path: string, isBody: BodyCheck<T>, origin = ""): Promise<ApiReply<T>> {
  try {
    const reply = await fetch(`${origin}${path}`);
    return reply.ok ? await success(reply, isBody) : await failure(reply);
  } catch (err) {
    return unreachable(err);
  }
}

/** POSTs `body` (as JSON, when there is one) to the action at `path`, behind the CSRF token. An action that answers no body is read as `{}`. */
export async function postAction<T>(path: string, isBody: BodyCheck<T>, body?: unknown, origin = ""): Promise<ApiReply<T>> {
  try {
    const tokenReply = await fetch(`${origin}/api/csrf`);
    if (!tokenReply.ok) return { ok: false, status: tokenReply.status, error: `the dashboard answered ${tokenReply.status} to the token request` };
    const token: unknown = await tokenReply.json().catch(() => undefined);
    if (!isRecord(token) || typeof token.csrfToken !== "string") return { ok: false, status: tokenReply.status, error: `the dashboard answered ${tokenReply.status} to the token request with no token` };
    const headers: Record<string, string> = { "x-csrf-token": token.csrfToken, ...(body === undefined ? {} : { "content-type": "application/json" }) };
    const reply = await fetch(`${origin}${path}`, { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return reply.ok ? await success(reply, isBody, {}) : await failure(reply);
  } catch (err) {
    return unreachable(err);
  }
}
