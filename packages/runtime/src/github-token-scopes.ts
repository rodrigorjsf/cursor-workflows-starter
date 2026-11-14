// What the GitHub token the forge CLI holds can do, read the way GitHub documents: a classic OAuth token's scopes come back in the
// `X-OAuth-Scopes` header of any API response, and a fine-grained token's response has no such header. `wf doctor` asks for them
// and warns when the token holds a scope the kit does not need, because any step that can run the CLI's print-token command can
// read the token and use every power it has (SECURITY.md, `SECURITY_TOKEN_SECTION`).
//
// The CLI's name and the commands live in the forge module (`ForgeToken`, ADR-0009); this module takes the arguments it is given.
// It never reads, prints or returns the token: the only thing taken from the response is the scopes header, and the call asks for
// no body. It knows nothing of GitLab: the scopes of a `glab` token are not read.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorText } from "./runtime/error-text.js";

/** The heading of the SECURITY.md section on the GitHub token: the doctor's warning names it, and a test checks the section is there. */
export const SECURITY_TOKEN_SECTION = "O token do GitHub";

/**
 * The scopes the kit does not need and a leaked token would turn into a lasting or destructive power. `admin:` and `write:` both
 * list: GitHub's documentation gives `write:public_key` "Create, list, and view details for public keys", which is all it takes to
 * plant an SSH key, and the response header lists only the scope that was granted, not the ones it implies.
 *   - public keys, SSH signing keys, GPG keys: a key planted with the token keeps its access after the token is revoked;
 *   - `admin:org`, `admin:repo_hook`: change who belongs to an organization, and what a repository sends and to whom;
 *   - `delete_repo`: delete repositories the user administers;
 *   - `workflow`: add and update GitHub Actions workflow files, which run in CI with its secrets.
 * What the kit does need is `repo` (a classic token) or Contents, Pull requests and Issues on one repository (a fine-grained one).
 */
export const BROAD_SCOPES: readonly string[] = [
  "admin:public_key",
  "write:public_key",
  "admin:ssh_signing_key",
  "write:ssh_signing_key",
  "admin:gpg_key",
  "write:gpg_key",
  "admin:org",
  "admin:repo_hook",
  "delete_repo",
  "workflow",
];

/** The scopes of `scopes` that are in `BROAD_SCOPES`, in the order the token lists them. */
export const broadScopesOf = (scopes: readonly string[]): string[] => scopes.filter((scope) => BROAD_SCOPES.includes(scope));

/**
 * What asking GitHub for the token's scopes found: the scopes the header lists (an empty list is a classic token with none), no
 * header (what a fine-grained token's response has), or an answer that could not be had (`said` is what the call printed on
 * stderr, else why it failed: never the response headers).
 */
export type TokenScopes = { kind: "listed"; scopes: string[] } | { kind: "none" } | { kind: "unreadable"; said: string };

/** The first lines `err`, a failed `execFile`, printed on stderr; else its own message (which names the command line, never a header of the answer). */
function saidOnStderr(err: unknown): string {
  const lines = ((err as { stderr?: string }).stderr ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines.length ? lines.slice(0, 4).join("\n") : errorText(err);
}

/** The scopes the `X-OAuth-Scopes` header of `output` (the headers `gh api -i` printed, then a blank line, then the body) lists; undefined when there is no such header. */
export function scopesFromHeaders(output: string): string[] | undefined {
  for (const line of output.split(/\r?\n/)) {
    if (line === "") return undefined; // the headers end at the first blank line: what follows is the body, which is not read
    const header = /^x-oauth-scopes:(.*)$/i.exec(line);
    if (header) {
      return header[1]!
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope) => scope !== "");
    }
  }
  return undefined;
}

/**
 * Runs `cli` with `args` (the forge's `ForgeToken.scopesArgs`: the call that prints the response headers) and reads the token's scopes
 * from them, waiting at most `timeoutMs`. GitHub sends the headers of an error answer too, so a failed call that still brought the
 * scopes header counts as an answer.
 */
export async function readTokenScopes(cli: string, args: string[], timeoutMs: number): Promise<TokenScopes> {
  let output: string;
  let failure: unknown;
  try {
    output = (await promisify(execFile)(cli, args, { timeout: timeoutMs, encoding: "utf8" })).stdout;
  } catch (err) {
    failure = err;
    output = (err as { stdout?: string }).stdout ?? ""; // a call that never ran or was killed has none
  }
  const scopes = scopesFromHeaders(output);
  if (scopes !== undefined) return { kind: "listed", scopes };
  return failure === undefined ? { kind: "none" } : { kind: "unreadable", said: saidOnStderr(failure) };
}
