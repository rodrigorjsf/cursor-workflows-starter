// Is the repository a cloud snapshot is pushed to public? A snapshot holds the worktree's uncommitted and untracked files, and
// deleting its branch afterwards does not unpublish the commits: GitHub keeps them reachable by SHA, and forks keep them too. So
// before a snapshot that differs from HEAD goes to a remote, the GitHub CLI is asked what the repository's visibility is.
//
// The one place in `src/` that runs a forge CLI by name, and only GitHub's: no other forge has a call that answers this here. A host
// the CLI cannot answer for (another forge, no network, no login) comes back as `unknown`, and the caller treats it as a
// refusal (it fails closed), with `cloud.allowPublicRemote` as the opt-in. Standard library only.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorText } from "./error-text.js";

/** What the GitHub CLI said of a repository's visibility, or why it said nothing. */
export type Visibility = { kind: "known"; visibility: "PUBLIC" | "PRIVATE" | "INTERNAL" } | { kind: "unknown"; said: string };

/** The arguments of the call: the repository by its URL, so that a remote that is not `origin` is the one asked about. */
export const visibilityArgs = (repoUrl: string): string[] => ["repo", "view", repoUrl, "--json", "visibility", "-q", ".visibility"];

/** The first line a failed command printed on stderr, else the error's own message. */
function firstLine(err: unknown): string {
  const stderr = (err as { stderr?: unknown } | undefined)?.stderr;
  const text = typeof stderr === "string" && stderr.trim() ? stderr.trim() : errorText(err);
  return text.split("\n")[0]!;
}

/** The visibility of the repository at `repoUrl` (the URL a cloud agent is given: `cloudRepoUrl`), asked of `gh`. Never rejects. */
export async function remoteVisibility(repoUrl: string, { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }): Promise<Visibility> {
  try {
    const { stdout } = await promisify(execFile)("gh", visibilityArgs(repoUrl), {
      encoding: "utf8",
      timeout: timeoutMs,
      signal,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" }, // a question of a terminal would wait for ever
    });
    const answer = stdout.trim();
    return answer === "PUBLIC" || answer === "PRIVATE" || answer === "INTERNAL" ? { kind: "known", visibility: answer } : { kind: "unknown", said: `gh answered "${answer.slice(0, 40)}"` };
  } catch (err) {
    return { kind: "unknown", said: firstLine(err) };
  }
}
