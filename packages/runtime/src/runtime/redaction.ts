// Secrets never reach the run's event log. Two things are replaced with `[REDACTED]` before an event is written (and before
// any listener sees it):
//   - text that has the shape of a well-known credential (GitHub, AWS, Slack, Google, npm, Stripe and Cursor keys, JWTs,
//     bearer tokens, private key blocks, and the `sk-` keys of the model providers);
//   - the value of any environment variable whose name contains KEY, TOKEN, SECRET or PASSWORD, plus keys handed to the run
//     directly (the Cursor API key arrives this way, as `CURSOR_API_KEY` or the `apiKey` option).
// Best effort, not a guarantee: a secret in a format not listed here, held in a variable not named like one, passes through.

export const REDACTED = "[REDACTED]";

/** Variables named like this hold secrets. Case-insensitive, anywhere in the name. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;

/**
 * Values shorter than this are not redacted: replacing a 2-letter value (`KEYBOARD_LAYOUT=us`) would mangle ordinary words
 * everywhere. Real credentials are longer.
 */
export const MIN_SECRET_LENGTH = 8;

/**
 * Credential shapes. The first capture group, when there is one, is kept (the word `Bearer`). A distinctive prefix needs no
 * word boundary before it (a token pasted right after other text is still a token); a short one (`sk-`, `AKIA`) does.
 */
const FORMATS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, // a block cut short is redacted to its end
  /github_pat_[A-Za-z0-9_]{22,}/g, // GitHub fine-grained token
  /gh[pousr]_[A-Za-z0-9]{36,}/g, // GitHub personal, OAuth, user-to-server, server-to-server and refresh tokens
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key id
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI, Anthropic and compatible secret keys
  /crsr_[A-Za-z0-9_-]{16,}/g, // Cursor API key (the `crsr_` prefix implement-issue's secret guard already looks for; a key read from a file is in no env var)
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /npm_[A-Za-z0-9]{36}\b/g, // npm token
  /[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, // Authorization header
];

export interface Redactor {
  /** The text with every secret replaced. */
  text(text: string): string;
  /** A copy of `value` with every string inside it (at any depth) passed through `text`. Numbers, booleans and null are kept. */
  value<T>(value: T): T;
}

/** The values to redact: those of the secret-named variables of `env`, and `extra`, longest first (so one never hides inside another). */
export function secretValues(env: NodeJS.ProcessEnv, extra: ReadonlyArray<string | undefined> = []): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) if (value && SECRET_NAME.test(name)) values.add(value);
  for (const value of extra) if (value) values.add(value);
  return [...values].filter((v) => v.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

export function createRedactor(options: { env?: NodeJS.ProcessEnv; extra?: ReadonlyArray<string | undefined> } = {}): Redactor {
  const secrets = secretValues(options.env ?? process.env, options.extra);
  const text = (input: string): string => {
    let out = input;
    for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    for (const format of FORMATS) out = out.replace(format, (_match, keep: unknown) => (typeof keep === "string" ? `${keep}${REDACTED}` : REDACTED));
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
  return { text, value };
}
