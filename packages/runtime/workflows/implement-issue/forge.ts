// The forge seam (ADR-0009): everything `implement-issue` and `wf gc` ask of the service that hosts the repository (read an
// issue, list and post its comments, open a PR, find a branch's PR and its state, name a repository), behind one interface.
// This file is the only one that names a forge's CLI (`test/forge-seam.test.ts` enforces it): GitHub through `gh`, GitLab through
// `glab`, and `glab api` (the REST API) where glab's own commands fall short. Every call goes through `Commands`, so its timeout,
// its `CommandError` and its node in the run's log are those of every other command the workflow runs.
//
// A fresh run detects its forge from the host of the `origin` remote (`detectForge`) and records it (`Progress.forge`); `wf gc`
// asks the forge a record names, never one detected again, and a record without the field is GitHub (`forgeNameOf`), as every run
// before the field existed was. Detection knows github.com and gitlab.com only for now: ADR-0009's `forges` map, the error for an
// unknown host and the `repo` argument's host are not built yet, and until they are every other host is GitHub, as it was.
// What a forge makes of the text a model wrote for it (GitLab runs quick actions) is here too: `neutralizeGitlabText`.
import { readFileSync } from "node:fs";
import type { Commands } from "./commands.js";

/** The state of a PR, as the forge reports it. */
export type PrState = "OPEN" | "MERGED" | "CLOSED";

/** The forges the runtime can speak to: the value a run's progress record keeps. */
export type ForgeName = "github" | "gitlab";

/** The forge of a record that names none: the only one that existed before the field did. */
export const DEFAULT_FORGE: ForgeName = "github";

/** An issue as the workflow reads it, whatever the forge. Labels are `{ name }` objects. */
export interface ForgeIssue {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
}

/** What the workflow asks of a forge. `repo` (owner/repo): where the issue or the PR lives; absent, the repository of `cwd`. */
export interface Forge {
  readonly name: ForgeName;
  /** The issue `number`. */
  issue(cwd: string, number: number, repo?: string): Promise<ForgeIssue>;
  /** The bodies of the issue's comments, all of them. */
  issueComments(cwd: string, number: number, repo?: string): Promise<string[]>;
  /** Posts the text of the file `bodyFile` as a comment on the issue. */
  commentOnIssue(cwd: string, number: number, bodyFile: string, repo?: string): Promise<void>;
  /** Opens a PR from `branch`, with the text of `bodyFile` as its description; returns its URL. */
  openPr(cwd: string, pr: { branch: string; title: string; bodyFile: string; repo?: string }): Promise<string>;
  /** The URL of the PR whose head is `branch` (the latest one, when there are several), or undefined when the branch has none. A failure that is no "not found" is an error. */
  prUrl(cwd: string, branch: string, repo?: string): Promise<string | undefined>;
  /** The state of that same PR, or undefined when the branch has none. A failure that is no "not found" is an error, never "no PR". */
  prState(cwd: string, branch: string, repo?: string): Promise<PrState | undefined>;
  /** The URL of the repository: `repo`, or the one `cwd` belongs to. */
  repoUrl(cwd: string, repo?: string): Promise<string>;
}

/** The forge a record (a run's progress) names; a record without one is GitHub. */
export const forgeNameOf = (record: { forge?: string }): string => record.forge ?? DEFAULT_FORGE;

/** The forge of each host the kit knows without being told. */
const KNOWN_HOSTS: ReadonlyMap<string, ForgeName> = new Map([
  ["github.com", "github"],
  ["gitlab.com", "gitlab"],
]);

/** The host of a git remote URL (`https://…`, `ssh://…` or scp-like `git@host:path`), in lower case; undefined for a local path. */
export function hostOfRemote(url: string): string | undefined {
  const trimmed = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname.toLowerCase() || undefined;
    } catch {
      return undefined;
    }
  }
  return /^(?:[^@/:]+@)?([^@/:]+):(?!\/\/)/.exec(trimmed)?.[1]?.toLowerCase();
}

/**
 * The forge a fresh run starts on: the one of the host of the cwd's `origin` remote, as the repository's configuration spells it
 * (a `url.<base>.insteadOf` rewrite is not applied: the name the user cloned from decides). Interim, until the `forges` map exists
 * (ADR-0009): a host the kit does not know, a local path and a repository with no `origin` are GitHub, as before GitLab was
 * supported; the decided behaviour for an unknown host is an error.
 */
export async function detectForge(commands: Commands, cwd: string): Promise<ForgeName> {
  const url = await commands.remoteUrl(cwd);
  const host = url === undefined ? undefined : hostOfRemote(url);
  return (host === undefined ? undefined : KNOWN_HOSTS.get(host)) ?? DEFAULT_FORGE;
}

/**
 * The forge `name` (as a record keeps it), speaking through `commands`. A record can name a forge this version does not know
 * (the run was recorded by a newer kit): that is an error, never a fall back to another forge's CLI.
 */
export function createForge(name: string, commands: Commands): Forge {
  if (name === "github") return new GithubForge(commands);
  if (name === "gitlab") return new GitlabForge(commands);
  throw new Error(`forge ${JSON.stringify(name)} (named by the run's record): this version of the kit does not know it. Upgrade the kit`);
}

const NO_PR_FOUND = /no pull requests? found/i;
const repoFlag = (repo: string | undefined): string[] => (repo ? ["--repo", repo] : []);

/** GitHub, through `gh`. */
class GithubForge implements Forge {
  readonly name = "github";
  constructor(private readonly commands: Commands) {}

  async issue(cwd: string, number: number, repo?: string): Promise<ForgeIssue> {
    return JSON.parse(await this.gh(cwd, "issue", "view", String(number), ...repoFlag(repo), "--json", "number,title,body,labels")) as ForgeIssue;
  }

  async issueComments(cwd: string, number: number, repo?: string): Promise<string[]> {
    const { comments } = JSON.parse(await this.gh(cwd, "issue", "view", String(number), ...repoFlag(repo), "--json", "comments")) as { comments: Array<{ body: string }> };
    return comments.map((c) => c.body);
  }

  async commentOnIssue(cwd: string, number: number, bodyFile: string, repo?: string): Promise<void> {
    await this.gh(cwd, "issue", "comment", String(number), ...repoFlag(repo), "--body-file", bodyFile);
  }

  async openPr(cwd: string, pr: { branch: string; title: string; bodyFile: string; repo?: string }): Promise<string> {
    return (await this.gh(cwd, "pr", "create", "--head", pr.branch, "--title", pr.title, "--body-file", pr.bodyFile, ...repoFlag(pr.repo))).trim();
  }

  async prUrl(cwd: string, branch: string, repo?: string): Promise<string | undefined> {
    const url = await this.commands.forgeReadOrNothing("gh", cwd, NO_PR_FOUND, "pr", "view", branch, "--json", "url", "-q", ".url", ...repoFlag(repo));
    return url?.trim() || undefined;
  }

  async prState(cwd: string, branch: string, repo?: string): Promise<PrState | undefined> {
    const out = await this.commands.forgeReadOrNothing("gh", cwd, NO_PR_FOUND, "pr", "view", branch, "--json", "state", "-q", ".state", ...repoFlag(repo));
    const state = out?.trim().toUpperCase();
    if (state === undefined || state === "") return undefined;
    if (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED") throw new Error(`gh pr view ${branch}: unexpected state ${JSON.stringify(out?.trim())}`);
    return state;
  }

  async repoUrl(cwd: string, repo?: string): Promise<string> {
    return (await this.gh(cwd, "repo", "view", ...(repo ? [repo] : []), "--json", "url", "-q", ".url")).trim();
  }

  private gh(cwd: string, ...args: string[]): Promise<string> {
    return this.commands.forgeRead("gh", cwd, ...args);
  }
}

/** What GitLab's REST API calls a merge request that is still being worked on or is being merged: both are a live PR. */
const MR_STATES: Readonly<Record<string, PrState>> = { opened: "OPEN", locked: "OPEN", merged: "MERGED", closed: "CLOSED" };
/** The URL of a merge request in the output of `glab mr create`, which prints a line of text around it. */
const MR_URL = /https?:\/\/\S+\/-\/merge_requests\/\d+/;
/** The number in the URL of a GitLab merge request, and in the URL of a GitHub pull request. */
const MR_NUMBER = /\/-\/merge_requests\/(\d+)/;
const PULL_NUMBER = /\/pull\/(\d+)/;

/** The link text of a PR, as its forge writes it: `PR #9` for `https://github.com/o/r/pull/9`, `MR !9` for `https://gitlab.com/g/p/-/merge_requests/9`. */
export function prLabel(url: string): string {
  const merge = MR_NUMBER.exec(url)?.[1];
  if (merge) return `MR !${merge}`;
  const pull = PULL_NUMBER.exec(url)?.[1];
  return pull ? `PR #${pull}` : "Pull request";
}

// ── Model text on GitLab ──────────────────────────────────────────────────────────────────────────────────────────────────────
// GitLab acts on text the account that posts it did not mean as a command: a line of an MR description or a note that starts with
// `/close`, `/merge` or another quick action runs it as that account, and `!12`, `~label` and `%milestone` turn into links and
// cross-reference notes on other objects. `neutralizeGitlabText` defuses both in text a model wrote; `sanitizeModelText`
// (`pr-body.ts`) is where every piece of model text goes through it.

/**
 * The quick actions GitLab runs: the "Quick actions" page of its documentation (read on 2026-11-13, GitLab 18.x), plus the names
 * of older releases that a self-managed instance may still run (`wip`, the epic ones, `promote`). A name that is not here is a
 * name this guard does not know. GitLab matches a name without regard to case, and so does the pattern below.
 */
const GITLAB_QUICK_ACTIONS = [
  "add_child", "add_contacts", "add_email", "approve", "assign", "assign_reviewer", "award", "blocked_by", "blocks", "board_move",
  "checkin_reminder", "child_epic", "clear_health_status", "clear_weight", "clone", "close", "confidential", "convert_to_ticket",
  "copy_metadata", "create_merge_request", "done", "draft", "due", "duplicate", "epic", "estimate", "estimate_time", "health_status",
  "internal_note", "invite_email", "iteration", "label", "labels", "link", "lock", "merge", "milestone", "move", "page", "parent_epic",
  "promote", "promote_to", "promote_to_incident", "publish", "react", "ready", "reassign", "reassign_reviewer", "rebase", "relabel",
  "relate", "remove_child", "remove_child_epic", "remove_contacts", "remove_due_date", "remove_email", "remove_epic", "remove_estimate",
  "remove_iteration", "remove_label", "remove_milestone", "remove_parent", "remove_parent_epic", "remove_reviewer",
  "remove_time_estimate", "remove_time_spent", "remove_zoom", "reopen", "request_review", "reviewer", "run_pipeline", "set_parent",
  "severity", "shrug", "spend", "spend_time", "status", "submit_review", "subscribe", "tableflip", "tag", "target_branch", "timeline",
  "title", "todo", "type", "unapprove", "unassign", "unassign_reviewer", "unlabel", "unlink", "unlock", "unsubscribe", "weight", "wip",
  "zoom",
];
/** A line that is a quick action to GitLab: a slash and a known name at the start, then a space or the end of the line. */
const QUICK_ACTION_LINE = new RegExp(`^/(${GITLAB_QUICK_ACTIONS.join("|")})(?=\\s|$)`, "i");
/** The sigil of a reference only GitLab has: `!12` (a merge request), `~label` and `%milestone` (also `~"two words"`). */
const REFERENCE_SIGIL = /(?<![\w~])~(?=[\w"])|(?<![\w%])%(?=[\w"])|!(?=\d)/g;
const ZERO_WIDTH_SPACE = "\u200B";
/** A line a Markdown parser may read as the edge of a fenced code block: up to 3 spaces, then 3 or more backticks or tildes. */
const FENCE_LIKE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** The one opening line every GitLab version reads as a fence: three backticks at column 0, then an info string with no backtick. */
const FENCE_OPEN = /^```[^`]*$/;
const FENCE_CLOSE = "```";
/** A line that closes a fence for a CommonMark parser though it is no bare closer (more backticks, an indent, trailing blanks). */
const AMBIGUOUS_FENCE_CLOSE = /^ {0,3}`{3,}[ \t]*$/;
/** A line that starts an HTML block, a quote (`>>>` too) or a `$$` math block: structures that can swallow a fence's opening line. */
const BLOCK_START = /^ {0,3}(?:[<>]|\$\$)/;

/**
 * `text`, a model's, made unable to act on a GitLab project: a line that starts with a quick action is shown as code (`/close`
 * becomes `` `/close` ``, no longer a command), and the sigil of `!12`, `~label` and `%milestone` is followed by a zero-width
 * space (as `sanitizeModelText` does for a mention). A path (`/usr/bin/env`) and a line inside a fenced code block stay as they are.
 *
 * What a fence protects is a judgement GitLab makes over the whole description, not over this piece, and GitLab versions differ:
 * the current one reads Markdown (any CommonMark fence), an older one matched a regular expression (three backticks, a bare
 * closer). So a fence is trusted only in the form both agree on: opened at column 0 with three backticks, closed by a bare
 * three-backtick line, and with nothing in the text that could hide the opening line from the parser (an HTML block, a quote,
 * `$$`). Every other fence-like line (tildes, more backticks, an indent: it may sit in a list item that ends before the fence
 * does) is made plain text with a zero-width space, closers that only one parser would accept included, so that no line of this
 * text leaves a fence open for the next piece to close, which would put that piece's code block outside a fence. A fence left
 * open is closed, and a fence on the first or last line gets a line break beside it, so the text around the piece cannot join it.
 * GitLab drops carriage returns before it looks for a command, so they go here too.
 */
export function neutralizeGitlabText(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  if (FENCE_OPEN.test(lines[0]!)) lines.unshift("");
  const code = new Set<number>(); // the lines inside a trusted fence
  let trusted = true;
  let fenceStart: number | undefined; // the line that opened the fence being read
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fenceStart !== undefined) {
      if (line === FENCE_CLOSE) {
        for (let j = fenceStart + 1; j < i; j++) code.add(j);
        fenceStart = undefined;
      } else if (AMBIGUOUS_FENCE_CLOSE.test(line)) lines[i] = ZERO_WIDTH_SPACE + line;
    } else if (FENCE_OPEN.test(line)) fenceStart = i;
    else if (FENCE_LIKE.test(line)) lines[i] = ZERO_WIDTH_SPACE + line;
    else if (BLOCK_START.test(line)) trusted = false;
  }
  if (fenceStart !== undefined) {
    for (let j = fenceStart + 1; j < lines.length; j++) code.add(j);
    lines.push(FENCE_CLOSE);
  }
  if (lines[lines.length - 1] === FENCE_CLOSE) lines.push("");
  return lines
    .map((line, i) => (trusted && code.has(i) ? line : line.replace(QUICK_ACTION_LINE, (_m, name: string) => `\`/${name}\``).replace(REFERENCE_SIGIL, (sigil) => sigil + ZERO_WIDTH_SPACE)))
    .join("\n");
}

/** The path of a repository as the REST API takes it, from what the `repo` argument holds: `group/sub/project`, or a URL of it. */
const repoPathOf = (repo: string): string => repo.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, "").replace(/\/+$/, "").replace(/\.git$/, "");
/** `projects/<repository>` in the REST API: `repo`'s path, or glab's placeholder for the repository of the cwd. */
const projectOf = (repo: string | undefined): string => `projects/${repo ? encodeURIComponent(repoPathOf(repo)) : ":fullpath"}`;

/**
 * The JSON arrays and objects `text` holds, one after the other: `glab api --paginate` prints one array per page, or one array
 * for all of them, and this reads both. Output that stops in the middle of a value is an error, never a shorter list.
 */
function jsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "[" || c === "{") {
      if (depth++ === 0) start = i;
    } else if ((c === "]" || c === "}") && --depth === 0) values.push(JSON.parse(text.slice(start, i + 1)));
  }
  if (depth !== 0 || values.length === 0) throw new Error(`glab api: the output is not complete JSON: ${text.trim().slice(0, 200) || "(empty)"}`);
  return values;
}

interface GitlabMr {
  web_url: string;
  state: string;
}

/** GitLab, through `glab`. */
class GitlabForge implements Forge {
  readonly name = "gitlab";
  constructor(private readonly commands: Commands) {}

  async issue(cwd: string, number: number, repo?: string): Promise<ForgeIssue> {
    const issue = JSON.parse(await this.glab(cwd, "issue", "view", String(number), ...repoFlag(repo), "--output", "json")) as {
      iid: number;
      title: string;
      description?: string | null;
      labels?: string[];
    };
    return { number: issue.iid, title: issue.title, body: issue.description ?? "", labels: (issue.labels ?? []).map((name) => ({ name })) };
  }

  async issueComments(cwd: string, number: number, repo?: string): Promise<string[]> {
    const pages = jsonValues(await this.glab(cwd, "api", "--paginate", `${projectOf(repo)}/issues/${number}/notes`));
    const notes = pages.flat() as Array<{ body: string; system?: boolean }>;
    return notes.filter((note) => !note.system).map((note) => note.body);
  }

  async commentOnIssue(cwd: string, number: number, bodyFile: string, repo?: string): Promise<void> {
    await this.glab(cwd, "api", "--method", "POST", `${projectOf(repo)}/issues/${number}/notes`, "-F", `body=@${bodyFile}`);
  }

  async openPr(cwd: string, pr: { branch: string; title: string; bodyFile: string; repo?: string }): Promise<string> {
    // `glab mr create` has no body-file flag: the text goes as one argument (never through a shell). `--source-branch` names the
    // branch; `-H` would name the head repository.
    const description = readFileSync(pr.bodyFile, "utf8");
    const out = await this.glab(cwd, "mr", "create", "--source-branch", pr.branch, "--title", pr.title, "--description", description, "--yes", ...repoFlag(pr.repo));
    const url = MR_URL.exec(out)?.[0];
    if (!url) throw new Error(`glab mr create: no merge request URL in its output: ${out.trim().slice(0, 200)}`);
    return url;
  }

  async prUrl(cwd: string, branch: string, repo?: string): Promise<string | undefined> {
    return (await this.latestMr(cwd, branch, repo))?.web_url;
  }

  async prState(cwd: string, branch: string, repo?: string): Promise<PrState | undefined> {
    const mr = await this.latestMr(cwd, branch, repo);
    if (mr === undefined) return undefined;
    const state = MR_STATES[mr.state];
    if (state === undefined) throw new Error(`glab api merge_requests (${branch}): unexpected state ${JSON.stringify(mr.state)}`);
    return state;
  }

  async repoUrl(cwd: string, repo?: string): Promise<string> {
    const project = JSON.parse(await this.glab(cwd, "api", projectOf(repo))) as { web_url: string };
    return project.web_url.trim();
  }

  /** The latest merge request (by creation date, in any state) whose source branch is `branch`; `glab mr view` would fail when there are several. */
  private async latestMr(cwd: string, branch: string, repo?: string): Promise<GitlabMr | undefined> {
    const query = `source_branch=${encodeURIComponent(branch)}&order_by=created_at&sort=desc&per_page=1`;
    const [page] = jsonValues(await this.glab(cwd, "api", `${projectOf(repo)}/merge_requests?${query}`));
    if (!Array.isArray(page)) throw new Error(`glab api merge_requests (${branch}): expected a list`);
    return (page as GitlabMr[])[0];
  }

  private glab(cwd: string, ...args: string[]): Promise<string> {
    return this.commands.forgeRead("glab", cwd, ...args);
  }
}
