// WHAT: Runs the real `glab` against a running GitLab for every command and API route the runtime uses (the forge module,
//   packages/runtime/workflows/implement-issue/forge.ts, with and without a `repo` argument; the `wf doctor` login check; and the
//   dashboard's merge request by URL, packages/runtime/src/runtime/pr-by-url.ts; `glab api` both with `GITLAB_HOST=<host:port>` and
//   with `--hostname <host>`, the form a host with no port gets), and writes what glab printed,
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
import { delimiter, dirname, join, resolve } from "node:path";
import { prStateOfUrl } from "../../packages/runtime/src/runtime/pr-by-url.js";
import { loginOf } from "../../packages/runtime/workflows/implement-issue/forge.js";
import { isEntryPoint } from "../lib/cli.js";
import {
  GLAB_QUIET,
  GitLabApi,
  basicAuthOf,
  createProject,
  e2eEnv,
  execOf,
  git,
  gitlabForge,
  groupOf,
  loginGlab,
  mergeRequestNumber,
  runMain,
  secretsOf,
  until,
  versionsOf,
  type E2eEnv,
} from "../lib/gitlab-e2e.js";
import type { Versions } from "../lib/gitlab-proofs.js";
import { HOST_PLACEHOLDER, refuseLeaks, scrubText, type Secrets } from "../lib/scrub-recording.js";

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

/** One run of glab: its arguments, the host it was pointed at through `GITLAB_HOST` when it was, how it ended, and what it printed. */
export interface Recording {
  args: string[];
  env?: { GITLAB_HOST: string };
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The file the fake `glab` reads. */
export interface RecordingsFile {
  /** What the recordings came from: the glab, the GitLab and the image. */
  recordedWith: Versions;
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
/** The branch of the merge request opened with a `repo` argument: one branch has one open merge request. */
const MR_REPO_BRANCH = "wf/issue-1-recorded-repo";
/** The host with no port that glab's configuration maps to the GitLab's `host:port` (`Recorder.aliasGlab`). */
const PORTLESS_HOST = HOST_PLACEHOLDER;
/** A second issue with more comments than one page of GitLab's notes API holds (20), to record how glab joins the pages. */
const MANY_COMMENTS = 25;

/** The glab that wraps the real one: it runs it, keeps what it printed beside the call, and prints the same. The runtime's own code calls it by name. */
const WRAPPER = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { readdirSync, writeFileSync } = require("node:fs");
const dir = process.env.WF_RECORD_DIR;
const args = process.argv.slice(2);
const r = spawnSync(process.env.WF_REAL_GLAB, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["inherit", "pipe", "pipe"] });
const n = readdirSync(dir).length;
const env = process.env.GITLAB_HOST === undefined ? undefined : { GITLAB_HOST: process.env.GITLAB_HOST };
writeFileSync(dir + "/" + String(n).padStart(4, "0") + ".json", JSON.stringify({ args, env, exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }));
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exitCode = r.status ?? 1;
`;

/** The recorder: it makes the GitLab side, then runs the forge module, the doctor's login check and the dashboard's PR-state source through the wrapper glab. */
class Recorder {
  private readonly recordDir: string;
  private readonly api: GitLabApi;
  private readonly repo: string;
  private readonly bin: string;
  private readonly realGlab: string;
  readonly recordings: Record<string, Recording> = {};

  constructor(private readonly env: E2eEnv) {
    this.recordDir = join(env.scratch, "calls");
    this.bin = join(env.scratch, "bin");
    this.repo = join(env.scratch, "repo");
    this.api = new GitLabApi(env.url, env.token);
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
      ...GLAB_QUIET,
    };
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
    const group = await groupOf(api, GROUP);
    const project = await createProject(api, group.id, PROJECT);
    const base = `/projects/${project.id}`;
    const issue = await api.call<{ iid: number }>("POST", `${base}/issues`, { title: ISSUE_TITLE, description: ISSUE_BODY });
    // Labels set after the issue exists make GitLab add a system note, as they do on a real issue that is triaged.
    await api.call("PUT", `${base}/issues/${issue.iid}`, { labels: "complexity:low,ready-for-agent" });
    await api.call("POST", `${base}/issues/${issue.iid}/notes`, { body: "A first comment, written before the recording." });
    const many = await api.call<{ iid: number }>("POST", `${base}/issues`, { title: "Recorded issue with many comments" });
    for (let i = 1; i <= MANY_COMMENTS; i++) await api.call("POST", `${base}/issues/${many.iid}/notes`, { body: `Comment ${i}` });

    const auth = basicAuthOf(this.env.token);
    const remote = `${this.env.url}/${GROUP}/${PROJECT}.git`;
    git(this.env.scratch, auth, "clone", "--quiet", remote, this.repo);
    git(this.repo, auth, "config", "user.name", "Recorder");
    git(this.repo, auth, "config", "user.email", "recorder@example.invalid");
    git(this.repo, auth, "checkout", "--quiet", "-b", MR_BRANCH);
    writeFileSync(join(this.repo, "math.js"), "export const subtract = (a, b) => a - b;\n");
    git(this.repo, auth, "add", "-A");
    git(this.repo, auth, "commit", "--quiet", "-m", "Add subtract");
    git(this.repo, auth, "push", "--quiet", "origin", MR_BRANCH);
    git(this.repo, auth, "push", "--quiet", "origin", `${MR_BRANCH}:${MR_REPO_BRANCH}`);
    // The branch checked out on main again: the run of the workflow starts from there.
    git(this.repo, auth, "checkout", "--quiet", "main");
    loginGlab(this.realGlab, this.glabEnv, this.host, this.env.token);
    this.aliasGlab();
    // The login and the configuration above are glab calls of the setup, not recordings.
    rmSync(this.recordDir, { recursive: true, force: true });
    mkdirSync(this.recordDir);
  }

  /**
   * A host with no port for the same GitLab, as gitlab.com and most self-managed hosts are: glab's own `api_host` setting sends the
   * API calls of `PORTLESS_HOST` to the GitLab's `host:port`, so `glab api --hostname <host>` runs on the real glab. The name is the
   * placeholder the scrubbing writes for the local host, so the recorded arguments read the same as the other recordings'.
   */
  private aliasGlab(): void {
    const env = { ...process.env, ...this.glabEnv };
    for (const [key, value] of [["api_protocol", "http"], ["api_host", this.host], ["token", this.env.token]] as const) {
      execFileSync(this.realGlab, ["config", "set", key, value, "--host", PORTLESS_HOST, "--global"], { env, stdio: "ignore" });
    }
  }

  /** Every glab call the forge module, the doctor and the dashboard's PR-state source make, once. */
  async recordAll(): Promise<Subjects> {
    const forge = gitlabForge(this.glabEnv);
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
    await this.record("auth-status-logged-in", () => execOf(this.glabEnv)("glab", login.args, { cwd }));
    await this.record("auth-status-logged-out", () => execOf({ ...this.glabEnv, GLAB_CONFIG_DIR: join(this.env.scratch, "no-login") })("glab", login.args, { cwd }));

    const mr = mergeRequestNumber(url);
    if (mr === undefined) throw new Error(`mr-create: no merge request number in ${url}`);
    // The dashboard's question, which the runtime answers through `observe`: the state of a merge request named by its URL, from
    // no checkout. The URL is https, as GitLab links are; glab asks this host over http, as its configuration says. The host has a
    // port, so glab is pointed at it through GITLAB_HOST (glab-host.ts).
    const mrUrl = `https://${this.host}/${GROUP}/${PROJECT}/-/merge_requests/${mr}`;
    const state = await this.record("mr-api", () => this.inGlabEnv(() => prStateOfUrl(mrUrl)));
    if (state !== "OPEN") throw new Error(`mr-api: the dashboard read ${state ?? "no state"} for ${mrUrl}, not OPEN`);
    // The same question for a host with no port, which glab is told through `--hostname` (glab-host.ts).
    const portlessUrl = `https://${PORTLESS_HOST}/${GROUP}/${PROJECT}/-/merge_requests/${mr}`;
    const portlessState = await this.record("mr-api-hostname", () => this.inGlabEnv(() => prStateOfUrl(portlessUrl)));
    if (portlessState !== "OPEN") throw new Error(`mr-api-hostname: the dashboard read ${portlessState ?? "no state"} for ${portlessUrl}, not OPEN`);

    // The forge module with a `repo` argument, as a cross-repository run calls it: the project's URL.
    const named = `${this.env.url}/${GROUP}/${PROJECT}`;
    await this.record("issue-view-repo", () => forge.issue(cwd, 1, named));
    await this.record("repo-view-repo", () => forge.repoUrl(cwd, named));
    await this.record("repo-view-hostname", () => forge.repoUrl(cwd, `http://${PORTLESS_HOST}/${GROUP}/${PROJECT}`));
    // Last, so that the notes recorded above hold one merge request: this one mentions no issue.
    writeFileSync(bodyFile, "Opened with a repo argument while recording the fixtures of the fake glab.\n");
    await this.record("mr-create-repo", () => forge.openPr(cwd, { branch: MR_REPO_BRANCH, title: MR_TITLE, bodyFile, repo: named }));
    return { project: `${GROUP}/${PROJECT}`, issue: 1, branch: MR_BRANCH, title: MR_TITLE, mr };
  }

  /**
   * Runs `read` with glab's environment in this process's own: the dashboard's PR-state source runs glab with the process's
   * environment and reads glab's configuration from `GLAB_CONFIG_DIR`, so the wrapper and the scratch configuration go there.
   */
  private async inGlabEnv<T>(read: () => Promise<T>): Promise<T> {
    const previous = Object.fromEntries(Object.keys(this.glabEnv).map((key) => [key, process.env[key]]));
    Object.assign(process.env, this.glabEnv);
    try {
      return await read();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  /** Waits until the issue has a note GitLab wrote itself, or fails: the recording of the notes has to hold one. */
  private async waitForSystemNote(): Promise<void> {
    const notes = `/projects/${encodeURIComponent(`${GROUP}/${PROJECT}`)}/issues/1/notes`;
    const hasSystemNote = async () => ((await this.api.call<Array<{ system: boolean }>>("GET", notes)).some((note) => note.system) ? true : undefined);
    await until("GitLab's system note on issue #1 about the merge request", hasSystemNote, 60_000, 2_000);
  }

  versions(): Promise<Versions> {
    return versionsOf(this.api, this.env.image);
  }
}

/** The recordings with every secret and local detail replaced; a recording that still holds one is an error, and nothing is written. */
export function scrubRecordings(file: RecordingsFile, secrets: Secrets): RecordingsFile {
  const scrub = (text: string): string => scrubText(text, secrets);
  const recordings = Object.fromEntries(
    Object.entries(file.recordings).map(([name, r]) => [
      name,
      { args: r.args.map(scrub), ...(r.env ? { env: { GITLAB_HOST: scrub(r.env.GITLAB_HOST) } } : {}), exitCode: r.exitCode, stdout: scrub(r.stdout), stderr: scrub(r.stderr) },
    ]),
  );
  const scrubbed: RecordingsFile = { recordedWith: file.recordedWith, placeholders: file.placeholders, subjects: file.subjects, recordings };
  refuseLeaks(JSON.stringify(scrubbed), secrets, "the recording file", "written");
  return scrubbed;
}

/** The whole recording; returns the exit code. */
export async function main(): Promise<number> {
  const env = e2eEnv();
  const recorder = new Recorder(env);
  await recorder.prepare();
  await recorder.seed();
  const subjects = await recorder.recordAll();
  const recordedWith = await recorder.versions();
  const secrets = secretsOf(env);
  const file = scrubRecordings({ recordedWith, placeholders: { host: HOST_PLACEHOLDER }, subjects, recordings: recorder.recordings }, secrets);
  mkdirSync(dirname(RECORDINGS_PATH), { recursive: true });
  const partial = `${RECORDINGS_PATH}.partial`;
  writeFileSync(partial, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(partial, RECORDINGS_PATH);
  process.stdout.write(`wrote ${RECORDINGS_PATH} (${Object.keys(file.recordings).length} recordings, glab ${recordedWith.glab}, GitLab ${recordedWith.gitlab}, host placeholder ${HOST_PLACEHOLDER})\n`);
  return 0;
}

if (isEntryPoint(import.meta.url)) runMain(main);
