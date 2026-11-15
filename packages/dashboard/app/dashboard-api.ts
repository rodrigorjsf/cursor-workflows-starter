// How the pages talk to the dashboard's JSON API: a GET, and a POST that carries the CSRF token every action needs. The
// dashboard hands the token to a script of its own origin and to no other; it is read for each action, so a dashboard that was
// restarted since the page loaded still accepts it. An answer is data, never a throw: the page shows `error` as it is, which is
// the server's own sentence when it sent one. `origin` is empty in a browser (the page's own); a test points it at the server.

import { errorText } from "./error-text.js";

/** What an API call came to: the answer's body, or why there is none. */
export type ApiReply<T> = { ok: true; status: number; body: T } | { ok: false; status?: number; error: string };

/** A failed reply's text: the server's `{ error }` when it sent one, else the status. */
async function failure(reply: Response): Promise<{ ok: false; status: number; error: string }> {
  const body = (await reply.json().catch(() => ({}))) as { error?: unknown };
  return { ok: false, status: reply.status, error: typeof body.error === "string" ? body.error : `the dashboard answered ${reply.status}` };
}

const unreachable = (err: unknown): { ok: false; error: string } => ({ ok: false, error: `could not reach the dashboard: ${errorText(err)}` });

export async function getJson<T>(path: string, origin = ""): Promise<ApiReply<T>> {
  try {
    const reply = await fetch(`${origin}${path}`);
    return reply.ok ? { ok: true, status: reply.status, body: (await reply.json()) as T } : await failure(reply);
  } catch (err) {
    return unreachable(err);
  }
}

/** POSTs `body` (as JSON, when there is one) to the action at `path`, behind the CSRF token. */
export async function postAction<T>(path: string, body?: unknown, origin = ""): Promise<ApiReply<T>> {
  try {
    const tokenReply = await fetch(`${origin}/api/csrf`);
    if (!tokenReply.ok) return { ok: false, status: tokenReply.status, error: `the dashboard answered ${tokenReply.status} to the token request` };
    const { csrfToken } = (await tokenReply.json()) as { csrfToken: string };
    const headers: Record<string, string> = { "x-csrf-token": csrfToken, ...(body === undefined ? {} : { "content-type": "application/json" }) };
    const reply = await fetch(`${origin}${path}`, { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return reply.ok ? { ok: true, status: reply.status, body: (await reply.json().catch(() => ({}))) as T } : await failure(reply);
  } catch (err) {
    return unreachable(err);
  }
}
