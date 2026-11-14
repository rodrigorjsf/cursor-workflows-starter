// WHAT: Runs the real `glab` against a running GitLab for every command and API route the runtime uses (the forge module,
//   packages/runtime/workflows/implement-issue/forge.ts, and the `wf doctor` login check), and writes what glab printed,
//   scrubbed of the token, the root password and the local host, to packages/runtime/test/fixtures/glab/recordings.json.
//   The fake `glab` of the offline tests reads that file. It makes its own group, project, issues and merge request.
// WHY: the GitLab code paths are tested offline against a fake `glab`; the outputs of that fake must be what a real glab
//   prints for a real GitLab, not what someone wrote down from the docs (ADR-0009).
// WHEN: through scripts/verify/gitlab-e2e.sh, which starts the GitLab, makes the token and removes the container after.
//   Alone only against a throwaway GitLab: it creates a group `owner` in it.
// HOW: `GITLAB_E2E_URL=http://localhost:8929 GITLAB_E2E_TOKEN=<token> GITLAB_E2E_PASSWORD=<root password>
//   GITLAB_E2E_IMAGE=<image> GITLAB_E2E_SCRATCH=<empty dir> npx tsx scripts/verify/record-glab-fixtures.ts`, with the glab of
//   mise.toml on the PATH. Prints where it wrote; exits 1 and writes nothing when a recording still holds a secret.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { Commands } from "../../packages/runtime/workflows/implement-issue/commands.js";
import { createForge, loginOf, type Forge } from "../../packages/runtime/workflows/implement-issue/forge.js";
import type { ExecResult } from "../../packages/runtime/src/runtime/workflow.js";
import { isEntryPoint } from "../lib/cli.js";
import { HOST_PLACEHOLDER, leaksIn, scrubText, type Secrets } from "../lib/scrub-recording.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
/** Where the fake `glab` of the offline tests reads the recordings. */
export const RECORDINGS_PATH = join(ROOT, "packages", "runtime", "test", "fixtures", "glab", "recordings.json");

/** What the recording made, which the fake `glab` swaps for the values of the test that runs it. The numbers are what GitLab numbered them. */
export interface Subjects {
  /** The project, `<group>/<project>`. */
  project: string;
  /** The issue the notes and the merge request are about. */
  issue: number;
  /** The branch, the title and the number of the merge request `glab mr create` opened. */
  branch: string;
  title: string;
  mr: number;
}

/** One run of glab: its arguments, how it ended, and what it printed. */
export interface Recording {
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The file the fake `glab` reads. */
export interface RecordingsFile {
  /** What the recordings came from: the glab, the GitLab and the image. */
  recordedWith: { glab: string; gitlab: string; image: string };
  /** What stands for the local host in the outputs: the fake `glab` swaps it for the host of the test. */
  placeholders: { host: string };
  subjects: Subjects;
  recordings: Record<string, Recording>;
}

const GROUP = "owner";
const PROJECT = "repo";
const ISSUE_TITLE = "Recorded issue";
const ISSUE_BODY = "Export `subtract(a, b)` from src/math.js, which returns a - b.";
const MR_TITLE = "Recorded merge request (#1)";
const MR_BRANCH = "wf/issue-1-recorded";
/** A second issue with more comments than one page of GitLab's notes API holds (20), to record how glab joins the pages. */
const MANY_COMMENTS = 25;

interface Env {
  url: string;
  token: string;
  password: string;
  image: string;
  scratch: string;
}

function envOf(): Env {
  const read = (key: string): string => {
    const value = process.env[key];
    if (!value) throw new Error(`${key} is not set: this script is run by scripts/verify/gitlab-e2e.sh`);
    return value;
  };
  return { url: read("GITLAB_E2E_URL"), token: read("GITLAB_E2E_TOKEN"), password: read("GITLAB_E2E_PASSWORD"), image: read("GITLAB_E2E_IMAGE"), scratch: read("GITLAB_E2E_SCRATCH") };
}

/** GitLab's REST API as the root user, from this process (the token never goes on a command line). */
class GitLabApi {
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
}

/** The glab that wraps the real one: it runs it, keeps what it printed beside the call, and prints the same. The runtime's own code calls it by name. */
const WRAPPER = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { readdirSync, writeFileSync } = require("node:fs");
const dir = process.env.WF_RECORD_DIR;
const args = process.argv.slice(2);
const r = spawnSync(process.env.WF_REAL_GLAB, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["inherit", "pipe", "pipe"] });
const n = readdirSync(dir).length;
writeFileSync(dir + "/" + String(n).padStart(4, "0") + ".json", JSON.stringify({ args, exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }));
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exitCode = r.status ?? 1;
`;

/** The `Exec` the runtime's `Commands` is built on, as a plain process run: the workflow engine is not involved. */
function exec(command: string, args: string[] = [], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<ExecResult> {
  return new Promise((done) => {
    try {
      const output = execFileSync(command, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
      done({ ok: true, exitCode: 0, timedOut: false, tail: output });
    } catch (err) {
      const failure = err as { status?: number | null; stdout?: string; stderr?: string; message: string };
      done({ ok: false, exitCode: failure.status ?? null, timedOut: false, tail: `${failure.stdout ?? ""}${failure.stderr ?? ""}`, error: failure.status === undefined ? failure.message : undefined });
    }
  });
}

/** `git` in `cwd`, with the token as HTTP basic auth on this one command, never stored in the repository's configuration. */
function git(cwd: string, auth: string, ...args: string[]): string {
  return execFileSync("git", ["-c", `http.extraHeader=Authorization: Basic ${auth}`, "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The recorder: it makes the GitLab side, then runs the forge module and the doctor's login check through the wrapper glab. */
class Recorder {
  private readonly recordDir: string;
  private readonly api: GitLabApi;
  private readonly repo: string;
  private readonly bin: string;
  private readonly realGlab: string;
  readonly recordings: Record<string, Recording> = {};

  constructor(private readonly env: Env) {
    this.recordDir = join(env.scratch, "calls");
    this.bin = join(env.scratch, "bin");
    this.repo = join(env.scratch, "repo");
    this.api = new GitLabApi(env.url.replace("localhost", "127.0.0.1"), env.token);
    this.realGlab = execFileSync("which", ["glab"], { encoding: "utf8" }).trim();
  }

  /** The `host:port` glab is told: the one the GitLab's external URL has. */
  private get host(): string {
    return new URL(this.env.url).host;
  }

  /** The environment glab runs in: its own configuration directory (the user's is never touched), the wrapper first on the PATH. */
  private get glabEnv(): Record<string, string> {
    return {
      PATH: `${this.bin}${delimiter}${process.env.PATH ?? ""}`,
      GLAB_CONFIG_DIR: join(this.env.scratch, "glab-config"),
      WF_RECORD_DIR: this.recordDir,
      WF_REAL_GLAB: this.realGlab,
      NO_COLOR: "1",
      GLAB_CHECK_UPDATE: "false",
    };
  }

  private forge(): Forge {
    const commands = new Commands((command, args, opts) => exec(command, args, { cwd: opts?.cwd, env: { ...this.glabEnv, ...opts?.env } }), { networkMs: 120_000 });
    return createForge("gitlab", commands);
  }

  /** Runs `step`, which has to make exactly one glab call, and keeps that call as the recording `name`. */
  private async record<T>(name: string, step: () => Promise<T>): Promise<T> {
    const before = readdirSync(this.recordDir).length;
    const result = await step();
    const calls = readdirSync(this.recordDir).slice(before);
    if (calls.length !== 1) throw new Error(`${name}: expected one glab call, found ${calls.length}`);
    this.recordings[name] = JSON.parse(readFileSync(join(this.recordDir, calls[0]!), "utf8")) as Recording;
    return result;
  }

  async prepare(): Promise<void> {
    mkdirSync(this.recordDir, { recursive: true });
    mkdirSync(this.bin, { recursive: true });
    writeFileSync(join(this.bin, "glab"), WRAPPER);
    chmodSync(join(this.bin, "glab"), 0o755);
  }

  /** The group, the project, the issues and the clone that glab runs in. */
  async seed(): Promise<void> {
    const { api } = this;
    const group = await api.call<{ id: number }>("POST", "/groups", { name: GROUP, path: GROUP, visibility: "private" });
    const project = await api.call<{ id: number }>("POST", "/projects", { name: PROJECT, path: PROJECT, namespace_id: group.id, visibility: "private", initialize_with_readme: true });
    const base = `/projects/${project.id}`;
    const issue = await api.call<{ iid: number }>("POST", `${base}/issues`, { title: ISSUE_TITLE, description: ISSUE_BODY });
    // Labels set after the issue exists make GitLab add a system note, as they do on a real issue that is triaged.
    await api.call("PUT", `${base}/issues/${issue.iid}`, { labels: "complexity:low,ready-for-agent" });
    await api.call("POST", `${base}/issues/${issue.iid}/notes`, { body: "A first comment, written before the recording." });
    const many = await api.call<{ iid: number }>("POST", `${base}/issues`, { title: "Recorded issue with many comments" });
    for (let i = 1; i <= MANY_COMMENTS; i++) await api.call("POST", `${base}/issues/${many.iid}/notes`, { body: `Comment ${i}` });

    const auth = Buffer.from(`oauth2:${this.env.token}`).toString("base64");
    const remote = `${this.env.url}/${GROUP}/${PROJECT}.git`;
    git(this.env.scratch, auth, "clone", "--quiet", remote, this.repo);
    git(this.repo, auth, "config", "user.name", "Recorder");
    git(this.repo, auth, "config", "user.email", "recorder@example.invalid");
    git(this.repo, auth, "checkout", "--quiet", "-b", MR_BRANCH);
    writeFileSync(join(this.repo, "math.js"), "export const subtract = (a, b) => a - b;\n");
    git(this.repo, auth, "add", "-A");
    git(this.repo, auth, "commit", "--quiet", "-m", "Add subtract");
    git(this.repo, auth, "push", "--quiet", "origin", MR_BRANCH);
    // The branch checked out on main again: the run of the workflow starts from there.
    git(this.repo, auth, "checkout", "--quiet", "main");
    execFileSync(this.realGlab, ["config", "set", "api_protocol", "http", "--host", this.host, "--global"], { env: { ...process.env, ...this.glabEnv }, stdio: "ignore" });
    execFileSync(this.realGlab, ["auth", "login", "--hostname", this.host, "--stdin", "--insecure-storage"], {
      env: { ...process.env, ...this.glabEnv },
      input: this.env.token,
      stdio: ["pipe", "ignore", "ignore"],
    });
    // The login and the configuration above are glab calls of the setup, not recordings.
    rmSync(this.recordDir, { recursive: true, force: true });
    mkdirSync(this.recordDir);
  }

  /** Every glab call the forge module and the doctor make, once. */
  async recordAll(): Promise<Subjects> {
    const forge = this.forge();
    const cwd = this.repo;
    const bodyFile = join(this.env.scratch, "body.md");

    await this.record("mr-list-empty", () => forge.prUrl(cwd, MR_BRANCH));
    writeFileSync(bodyFile, "Closes #1\n\nOpened while recording the fixtures of the fake glab.\n");
    const url = await this.record("mr-create", () => forge.openPr(cwd, { branch: MR_BRANCH, title: MR_TITLE, bodyFile }));
    // GitLab notes the merge request on the issue it mentions, a little after it is opened: that is its system note.
    await this.waitForSystemNote();
    await this.record("issue-view", () => forge.issue(cwd, 1));
    await this.record("issue-notes", () => forge.issueComments(cwd, 1));
    await this.record("issue-notes-two-pages", () => forge.issueComments(cwd, 2));
    writeFileSync(bodyFile, "A comment the workflow posted.\n");
    await this.record("note-create", () => forge.commentOnIssue(cwd, 1, bodyFile));
    await this.record("mr-list", () => forge.prUrl(cwd, MR_BRANCH));
    await this.record("repo-view", () => forge.repoUrl(cwd));

    const login = loginOf("gitlab", this.host);
    await this.record("auth-status-logged-in", () => exec("glab", login.args, { cwd, env: this.glabEnv }));
    await this.record("auth-status-logged-out", () => exec("glab", login.args, { cwd, env: { ...this.glabEnv, GLAB_CONFIG_DIR: join(this.env.scratch, "no-login") } }));

    const mr = Number(/\/-\/merge_requests\/(\d+)$/.exec(url)?.[1]);
    if (!Number.isInteger(mr)) throw new Error(`mr-create: no merge request number in ${url}`);
    return { project: `${GROUP}/${PROJECT}`, issue: 1, branch: MR_BRANCH, title: MR_TITLE, mr };
  }

  /** Waits until the issue has a note GitLab wrote itself, or fails: the recording of the notes has to hold one. */
  private async waitForSystemNote(): Promise<void> {
    const deadline = performance.now() + 60_000;
    for (;;) {
      const notes = await this.api.call<Array<{ system: boolean }>>("GET", `/projects/${encodeURIComponent(`${GROUP}/${PROJECT}`)}/issues/1/notes`);
      if (notes.some((note) => note.system)) return;
      if (performance.now() > deadline) throw new Error("GitLab wrote no system note on the issue within 60 seconds of the merge request");
      await new Promise((done) => setTimeout(done, 2000));
    }
  }

  async versions(): Promise<RecordingsFile["recordedWith"]> {
    const glab = /^glab (\S+)/.exec(execFileSync("glab", ["--version"], { encoding: "utf8" }))?.[1] ?? "";
    const gitlab = (await this.api.call<{ version: string }>("GET", "/version")).version;
    return { glab, gitlab, image: this.env.image };
  }
}

/** The recordings with every secret and local detail replaced; a recording that still holds one is an error, and nothing is written. */
export function scrubRecordings(file: RecordingsFile, secrets: Secrets): RecordingsFile {
  const scrub = (text: string): string => scrubText(text, secrets);
  const recordings = Object.fromEntries(
    Object.entries(file.recordings).map(([name, r]) => [name, { args: r.args.map(scrub), exitCode: r.exitCode, stdout: scrub(r.stdout), stderr: scrub(r.stderr) }]),
  );
  const scrubbed: RecordingsFile = { recordedWith: file.recordedWith, placeholders: file.placeholders, subjects: file.subjects, recordings };
  const leaks = leaksIn(JSON.stringify(scrubbed), secrets);
  if (leaks.length > 0) throw new Error(`the recordings still hold ${leaks.join(", ")}: nothing was written`);
  return scrubbed;
}

/** The whole recording; returns the exit code. */
export async function main(): Promise<number> {
  const env = envOf();
  const recorder = new Recorder(env);
  await recorder.prepare();
  await recorder.seed();
  const subjects = await recorder.recordAll();
  const recordedWith = await recorder.versions();
  const secrets: Secrets = { token: env.token, password: env.password, scratch: env.scratch, home: homedir() };
  const file = scrubRecordings({ recordedWith, placeholders: { host: HOST_PLACEHOLDER }, subjects, recordings: recorder.recordings }, secrets);
  mkdirSync(dirname(RECORDINGS_PATH), { recursive: true });
  const partial = `${RECORDINGS_PATH}.partial`;
  writeFileSync(partial, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(partial, RECORDINGS_PATH);
  process.stdout.write(`wrote ${RECORDINGS_PATH} (${Object.keys(file.recordings).length} recordings, glab ${recordedWith.glab}, GitLab ${recordedWith.gitlab}, host placeholder ${HOST_PLACEHOLDER})\n`);
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
