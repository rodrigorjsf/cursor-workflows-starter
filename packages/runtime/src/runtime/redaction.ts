// Secrets never reach the run's event log, nor its journal and memo (a step's result is redacted before it is stored, and
// the workflow gets that redacted value). Two things are replaced with `[REDACTED]` before an event is written (and before
// any listener sees it):
//   - text that has the shape of a well-known credential (GitHub, AWS, Slack, Google, npm, Stripe and Cursor keys, JWTs,
//     bearer tokens, private key blocks, the `sk-` keys of the model providers, and the password in a URL's userinfo);
//   - the value of any environment variable whose name contains KEY, TOKEN, SECRET or PASSWORD, plus keys handed to the run
//     directly (the Cursor API key arrives this way, as `CURSOR_API_KEY` or the `apiKey` option), and those of the
//     environment each `ctx.exec` command runs with (its `env` option, and process.env as it is when the command starts).
// Best effort, not a guarantee: a secret in a format not listed here, held in a variable not named like one, passes through.
//
// The same credential list (`CREDENTIAL_FORMATS`) drives implement-issue's outbound guard, which blocks a delivery instead of
// redacting it; the shapes test fixtures often hold (JWTs, `Bearer` headers) are redacted but do not block.

export const REDACTED = "[REDACTED]";

/** Variables named like this hold secrets. Case-insensitive, anywhere in the name. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;

/**
 * Values shorter than this are not redacted: replacing a 2-letter value (`KEYBOARD_LAYOUT=us`) would mangle ordinary words
 * everywhere. Real credentials are longer.
 */
export const MIN_SECRET_LENGTH = 8;

/** A credential shape. */
export interface CredentialFormat {
  /** What the format is, as the outbound guard reports it: never the matched text. */
  rule: string;
  /** The first capture group, when there is one, is kept on redaction (the word `Bearer`). */
  pattern: RegExp;
  /**
   * Redacted from logs, but not a reason to block a delivery: test fixtures hold these shapes (sample JWTs, `Bearer` headers)
   * far more often than real credentials do, and blocking on them would stop ordinary pull requests.
   */
  redactOnly?: true;
}

/**
 * Credential shapes: the single list both the log redactor and implement-issue's outbound guard use. A distinctive prefix
 * needs no word boundary before it (a token pasted right after other text is still a token); a short one (`sk-`, `AKIA`) does.
 */
export const CREDENTIAL_FORMATS: readonly CredentialFormat[] = [
  { rule: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g }, // a block cut short is redacted to its end
  { rule: "GitHub fine-grained token (github_pat_)", pattern: /github_pat_[A-Za-z0-9_]{22,}/g },
  { rule: "GitHub token (ghp_, gho_, ghu_, ghs_, ghr_)", pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g }, // personal, OAuth, user-to-server, server-to-server, refresh
  { rule: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { rule: "sk- key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g }, // OpenAI, Anthropic and compatible secret keys
  { rule: "Cursor key (crsr_)", pattern: /crsr_[A-Za-z0-9_-]{16,}/g }, // a key read from a file is in no env var
  { rule: "Slack token", pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { rule: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: "npm token", pattern: /npm_[A-Za-z0-9]{36}\b/g },
  { rule: "Stripe key", pattern: /[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { rule: "JWT", pattern: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, redactOnly: true },
  { rule: "Bearer token", pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, redactOnly: true }, // Authorization header
  // The password of a URL's userinfo (`https://user:secret@host`, a git remote's, say): the scheme and user stay. Redact-only:
  // fixtures and docs are full of `postgres://user:pass@localhost`.
  { rule: "password in a URL", pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(?=@)/gi, redactOnly: true },
  // A userinfo that is a token alone (`https://<token>@gitlab.com/...`, as GitLab and others take one): 16 characters or more,
  // so a user name such as `git` or `alice` stays. Redact-only, like the password.
  { rule: "token in a URL", pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]{16,}(?=@)/gi, redactOnly: true },
];

/** The rule of the first credential format in `text` that blocks a delivery (not `redactOnly`), or undefined. Never the match. */
export function findCredential(text: string): string | undefined {
  return CREDENTIAL_FORMATS.find((f) => !f.redactOnly && text.search(f.pattern) !== -1)?.rule;
}

/**
 * The name of a secret-named variable of `env` whose value, `minLength` characters or more, appears in `text`; undefined
 * when none does. Returns the variable's name, never its value.
 */
export function findSecretEnvValue(text: string, env: NodeJS.ProcessEnv, minLength = MIN_SECRET_LENGTH): string | undefined {
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= Math.max(minLength, MIN_SECRET_LENGTH) && SECRET_NAME.test(name) && text.includes(value)) return name;
  }
  return undefined;
}

export interface Redactor {
  /** The text with every secret replaced. */
  text(text: string): string;
  /** A copy of `value` with every string inside it (at any depth) passed through `text`. Numbers, booleans and null are kept. */
  value<T>(value: T): T;
  /** Redacts, from now on, the values of the secret-named variables of `env` too (the environment a command runs with, say). */
  learn(env: Record<string, string | undefined>): void;
}

/** The values to redact: those of the secret-named variables of `env`, and `extra`, longest first (so one never hides inside another). */
export function secretValues(env: NodeJS.ProcessEnv, extra: ReadonlyArray<string | undefined> = []): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) if (value && SECRET_NAME.test(name)) values.add(value);
  for (const value of extra) if (value) values.add(value);
  return [...values].filter((v) => v.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

export function createRedactor(options: { env?: NodeJS.ProcessEnv; extra?: ReadonlyArray<string | undefined> } = {}): Redactor {
  let secrets = secretValues(options.env ?? process.env, options.extra);
  const learn = (env: Record<string, string | undefined>) => {
    secrets = secretValues(env, secrets);
  };
  const text = (input: string): string => {
    let out = input;
    for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    for (const { pattern } of CREDENTIAL_FORMATS) out = out.replace(pattern, (_match, keep: unknown) => (typeof keep === "string" ? `${keep}${REDACTED}` : REDACTED));
    return out;
  };
  const value = <T>(input: T): T => {
    if (typeof input === "string") return text(input) as T;
    if (Array.isArray(input)) return input.map((item) => value(item)) as T;
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, value(item)])) as T;
    }
    return input;
  };
  return { text, value, learn };
}
