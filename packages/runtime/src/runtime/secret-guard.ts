// The guard that keeps a secret from leaving the machine inside a commit: the text of a diff, and the names of the files a change
// adds, are checked against the credential shapes the event-log redactor knows (redaction.ts, one list for both), the Cursor key saved
// by `wf login` or set in CURSOR_API_KEY, and the value of every secret-named environment variable. Two doors use it: implement-issue
// before it commits and pushes a delivery, and the cloud snapshot (cloud-snapshot.ts) before it pushes the worktree's state to a
// remote. It reports the rule that fired, never the text.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { findCredential, findSecretEnvValue } from "./redaction.js";

/** Runs `git <args>` in the checkout the change is in and returns its stdout. */
export type GitReader = (...args: string[]) => Promise<string>;

/** The Cursor key saved by `wf login` and the one in CURSOR_API_KEY, read only into memory, for the comparison. */
export function savedSecrets(): string[] {
  const keys: string[] = [];
  if (process.env.CURSOR_API_KEY) keys.push(process.env.CURSOR_API_KEY);
  try {
    const stored = JSON.parse(readFileSync(join(homedir(), ".cursor", "sdk", "auth.json"), "utf8")) as { apiKey?: unknown };
    if (typeof stored.apiKey === "string") keys.push(stored.apiKey);
  } catch {
    // no saved login
  }
  return keys;
}

/**
 * Rules for any text that leaves the machine. Returns the rule that fired, never the excerpt. The credential formats are the
 * event-log redactor's, plus the saved Cursor key and the value of every secret-named environment variable (16 characters or
 * more) of `env`.
 */
export function findSecretInText(text: string, knownSecrets: string[] = savedSecrets(), env: NodeJS.ProcessEnv = process.env): string | undefined {
  const format = findCredential(text);
  if (format) return format;
  if (knownSecrets.some((k) => k.length >= 16 && text.includes(k))) return "the saved SDK key or CURSOR_API_KEY";
  const variable = findSecretEnvValue(text, env, 16);
  return variable ? `the value of the secret-named environment variable ${variable}` : undefined;
}

/**
 * The secret a change would carry out, or undefined. `range` is what follows `git diff`'s options to say which change: `["--cached", base]`
 * for the staged diff since `base` (HEAD when `base` is left out), `[from, to]` for the difference between two commits. A prompt
 * injection could make a step copy ~/.cursor/sdk/auth.json into the worktree, and the SDK sandbox does not restrict reads, so both
 * the names of the files the change touches (`auth.json`, `.env`, `.env.*`) and the lines it adds are checked. Returns the rule that
 * fired, never the excerpt.
 */
export async function findSecretInChange(git: GitReader, range: string[], knownSecrets: string[] = savedSecrets()): Promise<string | undefined> {
  for (const name of (await git("diff", "--name-only", ...range)).split("\n").filter(Boolean)) {
    const file = basename(name);
    if (file === "auth.json") return "auth.json file in the commit";
    if (file === ".env" || file.startsWith(".env.")) return "a .env file in the commit";
  }
  const added = (await git("diff", "--no-color", "-U0", ...range))
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n");
  const hit = findSecretInText(added, knownSecrets);
  return hit ? `${hit} in the diff` : undefined;
}
