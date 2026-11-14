// WHAT: Turns text that a real GitLab and the real `glab` printed into text that is safe to commit: the token, the root
//   password, the local host and the machine's paths are replaced by fixed placeholders, every other credential the
//   runtime's redactor knows (a project's runner registration token, say) becomes `[REDACTED]`, and `leaksIn` finds
//   whatever is left of any of them.
// WHY: the recorded outputs of `glab` become the fixtures of the fake `glab` (packages/runtime/test/fixtures/glab), which
//   are committed. A recording that kept a token or a local host would put a credential or a machine detail in the
//   repository, so the recorder scrubs and then refuses to write anything `leaksIn` still finds.
// WHEN: imported by scripts/verify/record-glab-fixtures.ts, and by scripts/verify/prove-gitlab.ts for the evidence it prints
//   (which goes in a public pull request); test/glab-fixtures.test.ts also reads it, to check the committed fixtures. Not run on its own.
// HOW: `scrubText(text, secrets)` returns the scrubbed text; `leaksIn(text, secrets)` returns what a scrubbed text still
//   holds (empty when it is clean); `refuseLeaks(text, secrets, what, outcome)` throws when that is not empty.
import { createRedactor, findCredential } from "../../packages/runtime/src/runtime/redaction.js";

/** What replaces each kind of detail. The fake `glab` swaps `HOST_PLACEHOLDER` for the host of the repository it runs in. The scheme of a URL stays as glab printed it. */
export const HOST_PLACEHOLDER = "gitlab.example.com";
export const TOKEN_PLACEHOLDER = "glpat-REDACTED";
export const PASSWORD_PLACEHOLDER = "REDACTED-PASSWORD";
export const HOME_PLACEHOLDER = "/home/user";
export const SCRATCH_PLACEHOLDER = "/tmp/scratch";
/** The picture Gravatar serves for no email at all: what an avatar URL that hashes the root user's email becomes. */
export const AVATAR_PLACEHOLDER = "https://www.gravatar.com/avatar/00000000000000000000000000000000";

/** What a recording must not carry: the secrets and the machine's own details. */
export interface Secrets {
  /** The personal access token the recording used. */
  token: string;
  /** The password of the root user in the container. */
  password: string;
  /** The directory the recording ran in, and the user's home. */
  scratch: string;
  home: string;
}

/** A host of this machine, with the port it has when it names one: `localhost:8929`, `127.0.0.1`, `[::1]:80`. */
const LOCAL_HOST = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?/gi;
/** The avatar of a user is a hash of the email, served by Gravatar (an MD5 or, on newer GitLab, a SHA-256 hash). */
const GRAVATAR = /https:\/\/(?:www\.|secure\.)?gravatar\.com\/avatar\/[0-9a-f]{32,64}/gi;
/** The runtime's own list of credential shapes, with nothing from the environment: what any text committed here must be a fixed point of. */
const redactor = () => createRedactor({ env: {} });

/** `text` with the token, the password, the local host and the paths of this machine replaced by their placeholders. */
export function scrubText(text: string, secrets: Secrets): string {
  let out = text;
  // The scratch directory before the home directory: it may sit inside it, and the longer path must go first.
  for (const [detail, placeholder] of [
    [secrets.token, TOKEN_PLACEHOLDER],
    [secrets.password, PASSWORD_PLACEHOLDER],
    [secrets.scratch, SCRATCH_PLACEHOLDER],
    [secrets.home, HOME_PLACEHOLDER],
  ] as const) {
    if (detail !== "") out = out.split(detail).join(placeholder);
  }
  return redactor().text(out.replace(LOCAL_HOST, HOST_PLACEHOLDER).replace(GRAVATAR, AVATAR_PLACEHOLDER));
}

/** What a scrubbed `text` still holds that it must not: the token, the password, a local host, a path of this machine, or a credential shape the runtime's redactor knows (any other token, a Bearer header, a password in a URL). */
export function leaksIn(text: string, secrets: Secrets): string[] {
  const found: string[] = [];
  if (secrets.token !== "" && text.includes(secrets.token)) found.push("the token");
  if (secrets.password !== "" && text.includes(secrets.password)) found.push("the root password");
  if (secrets.scratch !== "" && text.includes(secrets.scratch)) found.push("the scratch directory");
  if (secrets.home !== "" && text.includes(secrets.home)) found.push("the home directory");
  if ((text.match(LOCAL_HOST) ?? []).length > 0) found.push("a local host");
  // The run's own token is reported above; this finds any other credential, whatever its shape.
  const others = secrets.token === "" ? text : text.split(secrets.token).join("");
  if (redactor().text(others) !== others) found.push(`a credential: ${findCredential(others) ?? "a shape the runtime redacts"}`);
  return found;
}

/**
 * Throws when a scrubbed `text` still holds anything `leaksIn` finds, so that it is never written or printed: `what` names the text
 * and `outcome` what did not happen to it (`the evidence still holds the token: nothing was printed`).
 */
export function refuseLeaks(text: string, secrets: Secrets, what: string, outcome: "written" | "printed"): void {
  const leaks = leaksIn(text, secrets);
  if (leaks.length > 0) throw new Error(`${what} still holds ${leaks.join(", ")}: nothing was ${outcome}`);
}

/** `leaksIn` for the details a committed fixture can be checked for without knowing this run's secrets: a local host and any credential shape the runtime redacts. */
export function leaksWithoutSecrets(text: string): string[] {
  return leaksIn(text, { token: "", password: "", scratch: "", home: "" });
}
