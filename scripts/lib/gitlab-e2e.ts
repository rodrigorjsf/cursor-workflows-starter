// WHAT: The pieces the real-GitLab scripts share: the environment scripts/verify/gitlab-e2e.sh hands them, GitLab's REST API as the
//   root user, `git` with the token on one command, `glab` logged in to the local GitLab in a configuration directory of its own,
//   and the process runner that the runtime's `Commands` is built on.
// WHY: the recorder (scripts/verify/record-glab-fixtures.ts) and the prover (scripts/verify/prove-gitlab.ts) both drive the same
//   throwaway GitLab the same way; one copy keeps them alike, and keeps the token off every command line and out of every
//   configuration the user owns (ADR-0009).
// WHEN: imported by those two scripts; not run on its own.
// HOW: `requireEnv("GITLAB_E2E_URL")`; `new GitLabApi(url, token).call("GET", "/version")`; `git(cwd, basicAuthOf(token), "clone", ...)`;
//   `loginGlab(glab, env, host, token)`; `new Commands(execOf(env), { networkMs })`.
import { execFileSync } from "node:child_process";
import type { ExecResult } from "../../packages/runtime/src/runtime/workflow.js";

/** The value of the environment variable `key`: the scripts are run by scripts/verify/gitlab-e2e.sh, which sets it. */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not set: this script is run by scripts/verify/gitlab-e2e.sh`);
  return value;
}

/** GitLab's REST API as the root user, from this process (the token never goes on a command line). */
export class GitLabApi {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base}/api/v4${path}`, {
      method,
      headers: { "PRIVATE-TOKEN": this.token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    return (await response.json()) as T;
  }

  /** Like `call`, but a 404 is `undefined`: the answer to "does it exist". */
  async find<T = Record<string, unknown>>(path: string): Promise<T | undefined> {
    const response = await fetch(`${this.base}/api/v4${path}`, { headers: { "PRIVATE-TOKEN": this.token } });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    return (await response.json()) as T;
  }
}

/** The `Authorization: Basic` value for the token as GitLab's git over http takes it. */
export const basicAuthOf = (token: string): string => Buffer.from(`oauth2:${token}`).toString("base64");

/** `git` in `cwd`, with the token as HTTP basic auth on this one command, never stored in the repository's configuration. */
export function git(cwd: string, auth: string, ...args: string[]): string {
  return execFileSync("git", ["-c", `http.extraHeader=Authorization: Basic ${auth}`, "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Logs `glab` in to the GitLab at `host` (`localhost:8929`): plain http for that host, and the token stored in the configuration
 * directory `env` names (`GLAB_CONFIG_DIR`), which is the scratch one and never the user's.
 */
export function loginGlab(glab: string, env: Record<string, string | undefined>, host: string, token: string): void {
  const processEnv = { ...process.env, ...env };
  execFileSync(glab, ["config", "set", "api_protocol", "http", "--host", host, "--global"], { env: processEnv, stdio: "ignore" });
  execFileSync(glab, ["auth", "login", "--hostname", host, "--stdin", "--insecure-storage"], { env: processEnv, input: token, stdio: ["pipe", "ignore", "ignore"] });
}

/** The `Exec` the runtime's `Commands` is built on, as a plain process run: the workflow engine is not involved. */
export function execOf(env: Record<string, string | undefined>) {
  return (command: string, args: string[] = [], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<ExecResult> =>
    new Promise((done) => {
      try {
        const output = execFileSync(command, args, { cwd: opts.cwd, env: { ...process.env, ...env, ...opts.env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
        done({ ok: true, exitCode: 0, timedOut: false, tail: output });
      } catch (err) {
        const failure = err as { status?: number | null; stdout?: string; stderr?: string; message: string };
        done({ ok: false, exitCode: failure.status ?? null, timedOut: false, tail: `${failure.stdout ?? ""}${failure.stderr ?? ""}`, error: failure.status === undefined ? failure.message : undefined });
      }
    });
}
