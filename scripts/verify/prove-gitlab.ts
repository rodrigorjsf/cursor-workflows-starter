// WHAT: Proves, on a real GitLab, the behaviours that decide whether `implement-issue` is safe on GitLab: which phrases close an
//   issue when a merge request merges (the question whether GitLab's default pattern matches `Implement(s|ed|ing) #N` among them),
//   whether a quick action (`/close`) in model text runs after `sanitizeModelText`, whether `!12`, `~label` and `%milestone` still
//   link behind the zero-width space, and a real `implement-issue` run with local steps that opens a merge request whose merge
//   closes its issue through `Closes #N`. It makes its own project `owner/proof` in the GitLab and prints the evidence as Markdown.
// WHY: the sanitizer and the quick-action guard were written from GitLab's documentation and source, never against a live instance
//   (ADR-0009). A "no effect" counts only beside a control that did take effect (`Closes #N` closing, a bare `/close` running, the
//   references linking), and every text is posted both as written and sanitized, so what GitLab did with each is on record
//   (scripts/lib/gitlab-proofs.ts holds the verdicts, and test/gitlab-proofs.test.ts pins them offline).
// WHEN: through scripts/verify/gitlab-e2e.sh, after the recorder, which starts the GitLab, makes the token and removes the container
//   after. Alone only against a throwaway GitLab with the environment of that script: it creates a project `owner/proof` and refuses
//   to run when it exists. The last stage runs the real `implement-issue` against the Cursor API: it spends tokens.
// HOW: `GITLAB_E2E_URL=http://localhost:8929 GITLAB_E2E_TOKEN=<token> GITLAB_E2E_PASSWORD=<root password> GITLAB_E2E_IMAGE=<image>
//   GITLAB_E2E_SCRATCH=<empty dir> npx tsx scripts/verify/prove-gitlab.ts`, with the glab of mise.toml on the PATH and `wf login` done.
//   `GITLAB_E2E_STAGES=closing,quick-actions,references` skips the stage that spends tokens (the others are `workflow`);
//   `GITLAB_E2E_MAX_TOKENS` (default 600000) and `GITLAB_E2E_MAX_CENTS` (default 100) are the caps of that run, passed to `wf run` as
//   `--max-tokens` and `--max-cents`; `GITLAB_E2E_WORKFLOW_TIMEOUT_SECONDS` (default 2700) is how long it may take. Prints the
//   evidence on stdout, progress on stderr; exits 1 when a proof did not hold.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { errorText } from "../../packages/runtime/src/runtime/error-text.js";
import { Commands } from "../../packages/runtime/workflows/implement-issue/commands.js";
import { createForge, type Forge } from "../../packages/runtime/workflows/implement-issue/forge.js";
import { sanitizeModelText } from "../../packages/runtime/workflows/implement-issue/pr-body.js";
import { isEntryPoint } from "../lib/cli.js";
import { GitLabApi, GitLabHttpError, basicAuthOf, e2eEnv, execOf, git, loginGlab, mergeRequestNumber, runMain, secretsOf, versionsOf, type E2eEnv } from "../lib/gitlab-e2e.js";
import {
  CLOSING_FORMS,
  QUICK_ACTION_CASES,
  SIGIL_TEXT,
  STAGES,
  SURFACES,
  problems,
  renderEvidence,
  type ClosingOutcome,
  type ClosingResult,
  type ProofReport,
  type QuickActionCase,
  type QuickActionResult,
  type SigilResult,
  type Stage,
  type Surface,
  type Versions,
  type WorkflowResult,
} from "../lib/gitlab-proofs.js";
import { HOST_PLACEHOLDER, leaksIn, scrubText, type Secrets } from "../lib/scrub-recording.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const GROUP = "owner";
const PROJECT = "proof";
const PROJECT_PATH = `${GROUP}/${PROJECT}`;
/** The issue `implement-issue` works on: the first one the project gets. */
const WORKFLOW_ISSUE = 1;
/** The merge request the references point at: the first one the project gets. */
const TARGET_MR = 1;
/** How long GitLab gets to close an issue after a merge, and the least it is given to not close one, in seconds. */
const CLOSE_TIMEOUT_SECONDS = 90;
const MIN_SETTLE_SECONDS = 10;
/** How long a note or a merge request description gets to run its quick actions before the state is read, in milliseconds. */
const QUICK_ACTION_SETTLE_MS = 5_000;
const DEFAULT_MAX_TOKENS = 600_000;
const DEFAULT_MAX_CENTS = 100;
const DEFAULT_WORKFLOW_TIMEOUT_SECONDS = 2_700;

const TEST_FILES: Record<string, string> = {
  "package.json": `${JSON.stringify({ name: "wf-proof", version: "0.0.0", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  "src/math.js": "export function add(a, b) {\n  return a + b;\n}\n",
  "test/math.test.js": 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/math.js";\n\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n});\n',
  ".gitignore": "node_modules/\n.workflows/\n",
};
const ISSUE_TITLE = "Add subtract(a, b) to src/math.js";
const ISSUE_BODY = "Add an exported function `subtract(a, b)` to `src/math.js` that returns `a - b`, and a test for it in `test/math.test.js`. Run the suite with `npm test`.";

interface Env extends E2eEnv {
  stages: Stage[];
  maxTokens: number;
  maxCents: number;
  workflowTimeoutSeconds: number;
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The whole number the environment variable `key` holds, or `fallback`. */
function numberEnv(key: string, fallback: number): number {
  const text = process.env[key];
  if (text === undefined || text === "") return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} is "${text}": it has to be a positive whole number`);
  return value;
}

/** The stages `GITLAB_E2E_STAGES` names (a comma-separated list), or all of them. */
export function stagesOf(text: string | undefined): Stage[] {
  if (text === undefined || text.trim() === "") return [...STAGES];
  const named = text.split(",").map((s) => s.trim());
  const unknown = named.filter((s) => !(STAGES as readonly string[]).includes(s));
  if (unknown.length > 0) throw new Error(`GITLAB_E2E_STAGES names ${unknown.join(", ")}: the stages are ${STAGES.join(", ")}`);
  return STAGES.filter((s) => named.includes(s));
}

function envOf(): Env {
  return {
    ...e2eEnv(),
    stages: stagesOf(process.env.GITLAB_E2E_STAGES),
    maxTokens: numberEnv("GITLAB_E2E_MAX_TOKENS", DEFAULT_MAX_TOKENS),
    maxCents: numberEnv("GITLAB_E2E_MAX_CENTS", DEFAULT_MAX_CENTS),
    workflowTimeoutSeconds: numberEnv("GITLAB_E2E_WORKFLOW_TIMEOUT_SECONDS", DEFAULT_WORKFLOW_TIMEOUT_SECONDS),
  };
}

/** What `until` throws when the thing it waited for did not happen in time: GitLab being slow, which the caller may report, and not a bug of this script. */
class TimedOut extends Error {}

/** Polls `read` every `intervalMs` until it answers something other than `undefined`, or throws `TimedOut` after `timeoutMs`. */
async function until<T>(what: string, read: () => Promise<T | undefined>, timeoutMs: number, intervalMs = 1_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw new TimedOut(`${what}: not within ${Math.round(timeoutMs / 1000)} s`);
    await sleep(intervalMs);
  }
}

interface Issue {
  iid: number;
  web_url: string;
  state: string;
  closed_at: string | null;
}

interface MergeRequest {
  iid: number;
  web_url: string;
  state: string;
  description: string;
  detailed_merge_status: string;
  merged_at: string | null;
  /** When GitLab finished the tasks that follow opening a merge request, among them recording which issues it closes. */
  prepared_at: string | null;
}

/** The text of a piece of model text as the workflow sends it to GitLab: each piece through `sanitizeModelText`, a blank line between. */
const sanitizedBody = (pieces: string[]) => pieces.map((piece) => sanitizeModelText(piece, "gitlab")).join("\n\n");

/** The proof: the GitLab project it works in, the clone of it that `glab` and `wf` run in, and the stages. */
class Prover {
  private readonly api: GitLabApi;
  private readonly host: string;
  private readonly repo: string;
  private readonly glabEnv: Record<string, string>;
  private readonly gitConfig: string;
  private readonly wfHome: string;
  private readonly forge: Forge;
  private projectId = 0;
  private counter = 0;

  constructor(private readonly env: Env) {
    this.api = new GitLabApi(env.url, env.token);
    this.host = new URL(env.url).host;
    this.repo = join(env.scratch, "proof");
    this.gitConfig = join(env.scratch, "proof.gitconfig");
    this.wfHome = join(env.scratch, "wf-home");
    this.glabEnv = { GLAB_CONFIG_DIR: join(env.scratch, "glab-config-proof"), NO_COLOR: "1", GLAB_CHECK_UPDATE: "false" };
    this.forge = createForge("gitlab", new Commands(execOf(this.glabEnv), { networkMs: 120_000 }));
  }

  private get project(): string {
    return `/projects/${this.projectId}`;
  }

  // ── the GitLab side ──────────────────────────────────────────────────────────────────────────────────────────

  /** The group (the recorder may have made it), the project with a small Node project in it, a clone of it, and `glab` and `git` logged in. */
  async seed(): Promise<void> {
    const { api } = this;
    const group = (await api.find<{ id: number }>(`/groups/${GROUP}`)) ?? (await api.call<{ id: number }>("POST", "/groups", { name: GROUP, path: GROUP, visibility: "private" }));
    if ((await api.find(`/projects/${encodeURIComponent(PROJECT_PATH)}`)) !== undefined) {
      throw new Error(`the project ${PROJECT_PATH} exists: this script makes it, and only against a throwaway GitLab (scripts/verify/gitlab-e2e.sh starts one)`);
    }
    const project = await api.call<{ id: number }>("POST", "/projects", { name: PROJECT, path: PROJECT, namespace_id: group.id, visibility: "private", initialize_with_readme: true });
    this.projectId = project.id;
    await api.call("POST", `${this.project}/repository/commits`, {
      branch: "main",
      commit_message: "chore: minimal Node project with one test",
      actions: Object.entries(TEST_FILES).map(([file_path, content]) => ({ action: "create", file_path, content })),
    });
    for (const [name, color] of [["complexity:low", "#0e8a16"], ["bug", "#d73a4a"]] as const) await api.call("POST", `${this.project}/labels`, { name, color });
    await api.call("POST", `${this.project}/milestones`, { title: "v1" });
    // Issue 1 is the one `implement-issue` works on; merge request !1 is what the references point at.
    const issue = await this.issue(ISSUE_TITLE, ISSUE_BODY);
    if (issue.iid !== WORKFLOW_ISSUE) throw new Error(`the first issue of the project is #${issue.iid}, not #${WORKFLOW_ISSUE}`);
    await api.call("PUT", `${this.project}/issues/${issue.iid}`, { labels: "complexity:low" });
    const target = await this.openApiMr("Target of the references", "Nothing here is merged: this is the `!1` that the references point at.");
    if (target.iid !== TARGET_MR) throw new Error(`the first merge request of the project is !${target.iid}, not !${TARGET_MR}`);

    const auth = basicAuthOf(this.env.token);
    git(this.env.scratch, auth, "clone", "--quiet", `${this.env.url}/${PROJECT_PATH}.git`, this.repo);
    // What `git` does inside the workflow run: who commits, no line-ending conversion, and the token for this host only.
    writeFileSync(this.gitConfig, `[user]\n\tname = Prover\n\temail = prover@example.invalid\n[core]\n\tautocrlf = false\n[http "${this.env.url}/"]\n\textraHeader = Authorization: Basic ${auth}\n`, { mode: 0o600 });
    loginGlab("glab", this.glabEnv, this.host, this.env.token);
  }

  private async issue(title: string, description = ""): Promise<Issue> {
    return this.api.call<Issue>("POST", `${this.project}/issues`, { title, description });
  }

  private issueState = async (iid: number): Promise<string> => (await this.api.call<Issue>("GET", `${this.project}/issues/${iid}`)).state;

  /** A new branch off `main` with one file of its own, made through the API: no merge request of these touches another's file. */
  private async branch(): Promise<string> {
    const branch = `proof/${++this.counter}`;
    await this.api.call("POST", `${this.project}/repository/commits`, {
      branch,
      start_branch: "main",
      commit_message: `proof: change ${this.counter}`,
      actions: [{ action: "create", file_path: `proof/${this.counter}.txt`, content: `change ${this.counter}\n` }],
    });
    return branch;
  }

  /** A merge request opened through the API, for the checks where the way it is opened does not matter. */
  private async openApiMr(title: string, description: string): Promise<MergeRequest> {
    const branch = await this.branch();
    return this.api.call<MergeRequest>("POST", `${this.project}/merge_requests`, { source_branch: branch, target_branch: "main", title, description });
  }

  private mergeRequest = (iid: number): Promise<MergeRequest> => this.api.call<MergeRequest>("GET", `${this.project}/merge_requests/${iid}`);

  /**
   * Merges the merge request, once GitLab has prepared it: it records which issues the request closes in a task that runs some seconds
   * after the request is opened (`prepared_at`), and a merge before that closes nothing (measured on 19.5.5: `Fixes #N` merged
   * before `prepared_at` left its issue open). A person merges later; this script has to wait. GitLab also answers 405 or 406 while
   * it checks whether the request can merge, and again each time the target branch moves, so the merge is tried until it is accepted.
   */
  private async merge(iid: number): Promise<void> {
    await until(`!${iid} prepared`, async () => ((await this.mergeRequest(iid)).prepared_at === null ? undefined : true), 120_000);
    await until(
      `!${iid} merged`,
      async () => {
        try {
          await this.api.call("PUT", `${this.project}/merge_requests/${iid}/merge`, {});
          return true;
        } catch (err) {
          if (err instanceof GitLabHttpError && (err.status === 405 || err.status === 406)) return undefined;
          throw err;
        }
      },
      120_000,
      2_000,
    );
  }

  /** How long after the merge request merged GitLab closed the issue, by the timestamps GitLab wrote (not by when this script looked), or undefined while the issue is open. */
  private async closedAfterMerge(issue: number, mr: number): Promise<number | undefined> {
    const closed = await this.api.call<Issue>("GET", `${this.project}/issues/${issue}`);
    if (closed.state !== "closed" || closed.closed_at === null) return undefined;
    const merged = (await this.mergeRequest(mr)).merged_at;
    return merged === null ? 0 : Math.max(0, Math.round((Date.parse(closed.closed_at) - Date.parse(merged)) / 1000));
  }

  /** The text in a file for the forge module, which posts it the way the workflow does (a body file). */
  private withBodyFile<T>(text: string, use: (bodyFile: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(this.env.scratch, "body-"));
    const file = join(dir, "body.md");
    writeFileSync(file, text);
    return use(file).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  // ── closing phrases ──────────────────────────────────────────────────────────────────────────────────────────

  /** Merges one merge request per phrase, its description holding the phrase (sanitized or not), and reads which issues closed, waiting `settleSeconds` after the last merge. */
  private async closingPhase(sanitize: boolean, settleSeconds: number): Promise<Map<string, ClosingOutcome>> {
    const merged: Array<{ form: string; issue: number; mr: number }> = [];
    for (const form of CLOSING_FORMS) {
      const issue = await this.issue(`Closing phrase: ${form.name}`);
      const text = form.text({ number: issue.iid, project: PROJECT_PATH, issueUrl: issue.web_url });
      const mr = await this.openApiMr(`Closing phrase ${this.counter + 1}`, sanitize ? sanitizeModelText(text, "gitlab") : text);
      await this.merge(mr.iid);
      merged.push({ form: form.name, issue: issue.iid, mr: mr.iid });
    }
    const outcomes = new Map<string, ClosingOutcome>();
    const open = new Set(merged);
    const deadline = performance.now() + settleSeconds * 1000;
    for (;;) {
      for (const m of [...open]) {
        const seconds = await this.closedAfterMerge(m.issue, m.mr);
        if (seconds !== undefined) {
          open.delete(m);
          outcomes.set(m.form, { closed: true, seconds });
        }
      }
      if (open.size === 0 || performance.now() > deadline) break;
      await sleep(1_000);
    }
    for (const m of open) outcomes.set(m.form, { closed: false });
    return outcomes;
  }

  async closing(): Promise<ClosingResult[]> {
    log(`closing phrases: ${CLOSING_FORMS.length} merge requests with the phrase as written`);
    const raw = await this.closingPhase(false, CLOSE_TIMEOUT_SECONDS);
    // The sanitized texts wait as long as the slowest raw one took, three times over, and never less than MIN_SETTLE_SECONDS.
    const slowest = Math.max(0, ...[...raw.values()].map((o) => o.seconds ?? 0));
    const settle = Math.max(MIN_SETTLE_SECONDS, slowest * 3);
    log(`closing phrases: ${CLOSING_FORMS.length} merge requests with the phrase through sanitizeModelText (waiting ${settle} s for each to close)`);
    const sanitized = await this.closingPhase(true, settle);
    return CLOSING_FORMS.map((form) => ({ form: form.name, raw: raw.get(form.name)!, sanitized: sanitized.get(form.name)! }));
  }

  // ── quick actions ────────────────────────────────────────────────────────────────────────────────────────────

  async quickActions(): Promise<QuickActionResult[]> {
    log(`quick actions: ${QUICK_ACTION_CASES.length} payloads, raw and sanitized, as a note on an issue and as a merge request description`);
    const posted: Array<{ c: QuickActionCase; surface: Surface; sanitize: boolean; fired: () => Promise<boolean> }> = [];
    for (const sanitize of [false, true]) {
      for (const c of QUICK_ACTION_CASES) {
        const text = sanitize ? sanitizedBody(c.pieces) : c.pieces.join("\n\n");
        const label = `${c.name} (${sanitize ? "sanitized" : "raw"})`;
        const issue = await this.issue(`Quick action in a note: ${label}`);
        await this.withBodyFile(text, (bodyFile) => this.forge.commentOnIssue(this.repo, issue.iid, bodyFile));
        posted.push({ c, surface: "issue note", sanitize, fired: async () => (await this.issueState(issue.iid)) === "closed" });

        const branch = await this.branch();
        const url = await this.withBodyFile(text, (bodyFile) => this.forge.openPr(this.repo, { branch, title: `Quick action in a description ${this.counter}`, bodyFile }));
        const iid = mergeRequestNumber(url);
        if (iid === undefined) throw new Error(`glab mr create: no merge request number in ${url}`);
        posted.push({ c, surface: "merge request description", sanitize, fired: async () => (await this.mergeRequest(iid)).state === "closed" });
      }
    }
    await sleep(QUICK_ACTION_SETTLE_MS);
    const results: QuickActionResult[] = [];
    for (const c of QUICK_ACTION_CASES) {
      for (const surface of SURFACES) {
        const [raw, sanitized] = await Promise.all([false, true].map((sanitize) => posted.find((p) => p.c === c && p.surface === surface && p.sanitize === sanitize)!.fired()));
        results.push({ case: c.name, surface, raw: raw!, sanitized: sanitized! });
      }
    }
    return results;
  }

  // ── references ───────────────────────────────────────────────────────────────────────────────────────────────

  /** Renders `text` as GitLab does and counts the links, then posts it as a note on a new issue. */
  private async postReferences(text: string): Promise<{ links: number; issue: number }> {
    const { html } = await this.api.call<{ html: string }>("POST", "/markdown", { text, gfm: true, project: PROJECT_PATH });
    const issue = await this.issue("References in a note");
    await this.withBodyFile(text, (bodyFile) => this.forge.commentOnIssue(this.repo, issue.iid, bodyFile));
    return { links: (html.match(/<a\s/g) ?? []).length, issue: issue.iid };
  }

  /** Whether GitLab has written a "mentioned in issue" note on `!1` for the issue. It does so some seconds after the note is posted. */
  private async crossReferenced(issue: number): Promise<boolean> {
    const notes = await this.api.call<Array<{ system: boolean; body: string }>>("GET", `${this.project}/merge_requests/${TARGET_MR}/notes`);
    return notes.some((n) => n.system && n.body.includes(`issue #${issue}`));
  }

  async sigils(): Promise<SigilResult> {
    log("references: !1, ~bug and %v1, as written and behind the zero-width space");
    const raw = await this.postReferences(SIGIL_TEXT);
    const sanitized = await this.postReferences(sanitizeModelText(SIGIL_TEXT, "gitlab"));
    // GitLab writes the cross-reference note some seconds after the note. The sanitized one is given three times as long as the raw one took.
    const start = performance.now();
    // A raw note that GitLab never cross-references in time is a result (`false`), and the verdict then calls the control void; any other failure is not.
    const rawNoted = await until(`the cross-reference note for #${raw.issue}`, async () => ((await this.crossReferenced(raw.issue)) ? true : undefined), CLOSE_TIMEOUT_SECONDS * 1000, 2_000).catch((err: unknown) => {
      if (err instanceof TimedOut) return false;
      throw err;
    });
    const settleMs = Math.max(MIN_SETTLE_SECONDS * 1000, 3 * (performance.now() - start));
    await sleep(Math.max(0, settleMs - (performance.now() - start)));
    return { raw: { links: raw.links, crossReferenced: rawNoted }, sanitized: { links: sanitized.links, crossReferenced: await this.crossReferenced(sanitized.issue) } };
  }

  // ── the real run ─────────────────────────────────────────────────────────────────────────────────────────────

  /** `wf run implement-issue` on the clone, with local steps (the default location), under the caps. Returns what it printed. */
  private runWorkflow(): Promise<{ outcome: Record<string, unknown> | undefined; failure?: string }> {
    mkdirSync(this.wfHome, { recursive: true });
    // The kit does not know this host: the config of the run says which forge it is (ADR-0009). Nothing else is configured.
    writeFileSync(join(this.wfHome, "config.json"), `${JSON.stringify({ forges: { [this.host]: "gitlab" } }, null, 2)}\n`);
    const args = ["--import", import.meta.resolve("tsx"), join(ROOT, "packages", "runtime", "src", "cli.ts"), "run", "implement-issue", "--cwd", this.repo, "--args", JSON.stringify({ issue: WORKFLOW_ISSUE, testCommand: "npm test", openPr: true }), "--max-tokens", String(this.env.maxTokens), "--max-cents", String(this.env.maxCents)];
    log(`implement-issue: wf run on issue #${WORKFLOW_ISSUE} (local steps, --max-tokens ${this.env.maxTokens} --max-cents ${this.env.maxCents}); it takes minutes`);
    return new Promise((done) => {
      const child = spawn(process.execPath, args, {
        cwd: ROOT,
        env: { ...process.env, ...this.glabEnv, WF_HOME: this.wfHome, WF_METRICS: "off", GIT_CONFIG_GLOBAL: this.gitConfig, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "pipe", "inherit"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      const timer = setTimeout(() => child.kill("SIGTERM"), this.env.workflowTimeoutSeconds * 1000);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        try {
          done({ outcome: JSON.parse(stdout) as Record<string, unknown> });
        } catch {
          done({ outcome: undefined, failure: `wf run printed no JSON (${signal ? `signal ${signal}` : `exit code ${code}`}): ${stdout.trim().slice(0, 300)}` });
        }
      });
    });
  }

  async workflow(): Promise<WorkflowResult> {
    const caps = { maxTokens: this.env.maxTokens, maxCents: this.env.maxCents };
    const { outcome, failure } = await this.runWorkflow();
    if (outcome === undefined) return { status: "no result", reason: failure, caps };
    const result = (outcome.result ?? {}) as Record<string, unknown>;
    const base: WorkflowResult = {
      status: String(result.status ?? outcome.status),
      runId: typeof outcome.runId === "string" ? outcome.runId : undefined,
      reason: typeof result.reason === "string" ? result.reason : typeof outcome.error === "string" ? outcome.error : undefined,
      tokens: typeof outcome.spentTokens === "number" ? outcome.spentTokens : undefined,
      caps,
    };
    const mrUrl = typeof result.prUrl === "string" ? result.prUrl : undefined;
    const iid = mergeRequestNumber(mrUrl ?? "");
    if (base.status !== "done" || iid === undefined) return { ...base, mrUrl };
    const mr = await this.mergeRequest(iid);
    const report: WorkflowResult = { ...base, mrUrl, mrState: mr.state, closesIssueLine: new RegExp(`^Closes #${WORKFLOW_ISSUE}$`, "m").test(mr.description) };
    // GitLab refusing the merge, or taking too long to close the issue, is the result to report; any other failure is a bug and ends the stage.
    const gitlabSaid = (err: unknown) => err instanceof GitLabHttpError || err instanceof TimedOut;
    try {
      await this.merge(iid);
    } catch (err) {
      if (!gitlabSaid(err)) throw err;
      log(`implement-issue: ${errorText(err)}`);
      return { ...report, merged: false };
    }
    report.merged = true;
    try {
      report.secondsToClose = await until(`issue #${WORKFLOW_ISSUE} closed`, () => this.closedAfterMerge(WORKFLOW_ISSUE, iid), CLOSE_TIMEOUT_SECONDS * 1000);
      report.issueClosed = true;
    } catch (err) {
      if (!gitlabSaid(err)) throw err;
      log(`implement-issue: ${errorText(err)}`);
      report.issueClosed = false;
    }
    return report;
  }

  versions(): Promise<Versions> {
    return versionsOf(this.api, this.env.image);
  }
}

/** The evidence with the token, the root password, the local host and the paths of this machine replaced: it goes in a public pull request. */
export function publishable(evidence: string, secrets: Secrets): string {
  const scrubbed = scrubText(evidence, secrets);
  const leaks = leaksIn(scrubbed, secrets);
  if (leaks.length > 0) throw new Error(`the evidence still holds ${leaks.join(", ")}: nothing was printed`);
  return scrubbed;
}

/** The whole proof; returns the exit code. */
export async function main(): Promise<number> {
  const env = envOf();
  const prover = new Prover(env);
  const report: ProofReport = { versions: await prover.versions() };
  await prover.seed();
  /** Runs one stage: a stage that throws leaves no result, which is a problem of its own, and the others still run. */
  const stage = async <T>(name: Stage, run: () => Promise<T>): Promise<T | undefined> => {
    if (!env.stages.includes(name)) return undefined;
    try {
      return await run();
    } catch (err) {
      log(`error: the stage ${name} failed: ${errorText(err)}`);
      return undefined;
    }
  };
  report.closing = await stage("closing", () => prover.closing());
  report.quickActions = await stage("quick-actions", () => prover.quickActions());
  report.sigils = await stage("references", () => prover.sigils());
  report.workflow = await stage("workflow", () => prover.workflow());

  const found = problems(report, env.stages);
  const secrets = secretsOf(env);
  process.stdout.write(publishable(renderEvidence(report, env.stages), secrets));
  for (const problem of found) log(`problem: ${problem}`);
  log(found.length === 0 ? `every proof held (${HOST_PLACEHOLDER} stands for the local GitLab in the evidence)` : `${found.length} problem(s)`);
  return found.length === 0 ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) runMain(main);
