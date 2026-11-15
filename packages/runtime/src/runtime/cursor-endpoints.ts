// Where the Cursor SDK may send the API key. The SDK (`@cursor/sdk` 1.3.1) reads `CURSOR_BACKEND_URL` for the API and the token
// exchange and `CURSOR_WEBSITE_URL` for login, from the environment, and sends the key to whatever they hold: it checks neither the
// scheme nor the host. The MCP server inherits its environment from the IDE, so any process that can set a variable in it (a
// project's `.env` loader, a shell profile, an MCP entry's `env`) can point the key at a host of its own. The kit looks at both
// variables before it calls the SDK, and refuses a value that is not an https URL on cursor.sh or cursor.com (`wf doctor` reports the
// same predicate as its `endpoints` check). `test/sdk-environment.test.ts` fails when an SDK bump reads another endpoint variable.

/** The environment variables the SDK reads for an endpoint. `test/sdk-environment.test.ts` keeps this list equal to the ones the installed SDK reads. */
export const CURSOR_ENDPOINT_VARIABLES = ["CURSOR_BACKEND_URL", "CURSOR_WEBSITE_URL"] as const;

/** The only values accepted: an https URL on cursor.sh or cursor.com, or on a subdomain of either. Anchored at both ends of the host: `cursor.sh.evil.example` and `evilcursor.sh` do not match. */
export const CURSOR_ENDPOINT_PATTERN = /^https:\/\/([a-z0-9-]+\.)*(cursor\.sh|cursor\.com)(\/|$)/;

/** One variable whose value is not a Cursor address. */
export interface EndpointProblem {
  variable: string;
  /** Why it is refused. It shows the scheme and host of the value (`https://evil.example`) or says it is not a URL: the path, the query and any userinfo stay out of every message. */
  message: string;
}

/** Scheme and host of `value`, or undefined when it is not a URL. Userinfo, path and query are dropped: a credential in a URL must not reach a log. */
export function schemeAndHost(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

/** The variables of `env` that hold a value other than an https URL on cursor.sh or cursor.com. An unset or empty variable is no problem: the SDK uses its own endpoint. */
export function cursorEndpointProblems(env: Readonly<Record<string, string | undefined>> = process.env): EndpointProblem[] {
  const problems: EndpointProblem[] = [];
  for (const variable of CURSOR_ENDPOINT_VARIABLES) {
    const value = env[variable];
    if (value === undefined || value === "" || CURSOR_ENDPOINT_PATTERN.test(value)) continue;
    const shown = schemeAndHost(value);
    problems.push({
      variable,
      message: shown === undefined ? `${variable} is not a URL, so it is not an https URL on cursor.sh or cursor.com` : `${variable} is ${shown}, which is not an https URL on cursor.sh or cursor.com`,
    });
  }
  return problems;
}

/** Why a run, or a command that calls the SDK, must not start: one sentence per variable, with how to fix it. Undefined when every endpoint variable is unset or a Cursor address. */
export function cursorEndpointRefusal(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const problems = cursorEndpointProblems(env);
  if (problems.length === 0) return undefined;
  return problems.map((p) => `${p.message}: the Cursor SDK sends your API key there. Unset ${p.variable} to use Cursor's own endpoint.`).join(" ");
}

/** Thrown where a command cannot go on without calling the SDK. Its message is `cursorEndpointRefusal`'s. */
export class CursorEndpointError extends Error {}

/** Throws `CursorEndpointError` when `env` names an endpoint the key must not be sent to. */
export function assertCursorEndpoints(env: Readonly<Record<string, string | undefined>> = process.env): void {
  const refusal = cursorEndpointRefusal(env);
  if (refusal !== undefined) throw new CursorEndpointError(refusal);
}
