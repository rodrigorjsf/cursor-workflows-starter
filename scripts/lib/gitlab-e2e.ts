// WHAT: The pieces the real-GitLab scripts share: the environment scripts/verify/gitlab-e2e.sh hands them, GitLab's REST API as the
//   root user, `git` with the token on one command, `glab` logged in to the local GitLab in a configuration directory of its own,
//   and the process runner that the runtime's `Commands` is built on.
// WHY: the recorder (scripts/verify/record-glab-fixtures.ts) and the prover (scripts/verify/prove-gitlab.ts) both drive the same
//   throwaway GitLab the same way; one copy keeps them alike, and keeps the token off every command line and out of every
//   configuration the user owns (ADR-0009).
// WHEN: imported by those two scripts; not run on its own.
// HOW: `const env = e2eEnv()`; `new GitLabApi(env.url, env.token).call("GET", "/version")`; `git(cwd, basicAuthOf(token), "clone", ...)`;
//   `loginGlab(glab, env, host, token)`; `new Commands(execOf(env), { networkMs })`; `mergeRequestNumber(url)`; `secretsOf(env)`;
//   `await versionsOf(api, env.image)`; `if (isEntryPoint(import.meta.url)) runMain(main)`.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { errorText } from "../../packages/runtime/src/runtime/error-text.js";
import type { ExecResult } from "../../packages/runtime/src/runtime/workflow.js";
import type { Secrets } from "./scrub-recording.js";

/** The value of the environment variable `key`: the scripts are run by scripts/verify/gitlab-e2e.sh, which sets it. */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not set: this script is run by scripts/verify/gitlab-e2e.sh`);
  return value;
}

/** What scripts/verify/gitlab-e2e.sh hands every script it runs against the GitLab it started. */
export interface E2eEnv {
  /** The GitLab's external URL, `http://localhost:8929`. */
  url: string;
  /** A personal access token of the root user. */
  token: string;
  /** The root user's password. */
  password: string;
  /** The image the GitLab runs. */
  image: string;
  /** An empty directory of the script's own, removed when it ends. */
  scratch: string;
}

export function e2eEnv(): E2eEnv {
  return {
    url: requireEnv("GITLAB_E2E_URL"),
    token: requireEnv("GITLAB_E2E_TOKEN"),
    password: requireEnv("GITLAB_E2E_PASSWORD"),
    image: requireEnv("GITLAB_E2E_IMAGE"),
    scratch: requireEnv("GITLAB_E2E_SCRATCH"),
  };
}

/** What the scripts' output must not carry: the token, the root password, the scratch directory and the user's home. */
export const secretsOf = (env: E2eEnv): Secrets => ({ token: env.token, password: env.password, scratch: env.scratch, home: homedir() });

/** The version of the `glab` on the PATH, of the GitLab behind `api`, and the image it runs: what a recording or a proof ran against. */
export async function versionsOf(api: GitLabApi, image: string): Promise<{ glab: string; gitlab: string; image: string }> {
  const glab = /^glab (\S+)/.exec(execFileSync("glab", ["--version"], { encoding: "utf8" }))?.[1] ?? "";
  const gitlab = (await api.call<{ version: string }>("GET", "/version")).version;
  return { glab, gitlab, image };
}

/** Runs a script's `main` as the entry point: its exit code, or 1 with `error: <why>` on stderr when it throws. */
export function runMain(main: () => Promise<number>): void {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`error: ${errorText(err)}\n`);
      process.exitCode = 1;
    },
  );
}

/** The number in the URL of a merge request, wherever it stands in `text` (`glab mr create` prints the URL among other text), or undefined when there is none. */
export function mergeRequestNumber(text: string): number | undefined {
  const digits = /\/-\/merge_requests\/(\d+)/.exec(text)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

/** GitLab refused a call: its status says why (404 not there, 405 or 406 not mergeable yet), which a failure of this code never does. */
export class GitLabHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitLabHttpError";
  }
}

/**
 * GitLab's REST API as the root user, from this process (the token never goes on a command line). `url` is the GitLab's external URL:
 * its `localhost` is reached as `127.0.0.1`, which is where Docker publishes the port, because `localhost` may resolve to `::1` first.
 */
export class GitLabApi {
  private readonly base: string;

  constructor(
    url: string,
    private readonly token: string,
  ) {
    this.base = url.replace("localhost", "127.0.0.1");
  }

  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base}/api/v4${path}`, {
      method,
      headers: { "PRIVATE-TOKEN": this.token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new GitLabHttpError(response.status, `${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    return (await response.json()) as T;
  }

  /** Like `call` for a GET, but a 404 is `undefined`: the answer to "does it exist". */
  async find<T = Record<string, unknown>>(path: string): Promise<T | undefined> {
    try {
      return await this.call<T>("GET", path);
    } catch (err) {
      if (err instanceof GitLabHttpError && err.status === 404) return undefined;
      throw err;
    }
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
