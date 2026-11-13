// The forge seam (ADR-0009): everything `implement-issue` and `wf gc` ask of the service that hosts the repository (read an
// issue, list and post its comments, open a PR, find a branch's PR and its state, name a repository), behind one interface.
// This file is the only one that names a forge's CLI (`test/forge-seam.test.ts` enforces it): GitHub through `gh`, GitLab through
// `glab`, and `glab api` (the REST API) where glab's own commands fall short. Every call goes through `Commands`, so its timeout,
// its `CommandError` and its node in the run's log are those of every other command the workflow runs.
//
// A fresh run detects its forge (`detectForge`) from the host of the `repo` argument when that names one, else from the host of the
// `origin` remote: github.com is GitHub, gitlab.com is GitLab, any other host is the one the config's `forges` map declares, and
// one it does not is an error that names the host and the key (ADR-0009). The run records the forge (`Progress.forge`); `wf gc` asks
// the forge a record names, never one detected again, and a record without the field is GitHub (`forgeNameOf`), as every run before
// the field existed was.
import { readFileSync } from "node:fs";
import { KNOWN_FORGE_HOSTS } from "../../src/config/file.js";
import type { ForgeName } from "../../src/runtime/workflow.js";
import type { Commands } from "./commands.js";

export type { ForgeName };

/** The state of a PR, as the forge reports it. */
export type PrState = "OPEN" | "MERGED" | "CLOSED";

/** The forge of a record that names none: the only one that existed before the field did. */
export const DEFAULT_FORGE: ForgeName = "github";

/** An issue as the workflow reads it, whatever the forge. Labels are `{ name }` objects. */
export interface ForgeIssue {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
}

/** What the workflow asks of a forge. `repo` (`owner/repo`, `group/sub/project`, or a repository URL): where the issue or the PR lives; absent, the repository of `cwd`. */
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

/** What a git remote URL or a `repo` argument spells: the host in lower case, its port when it has one, and the path of the repository on it (no `.git`, no slash at either end). */
export interface RemoteName {
  host: string;
  port?: string;
  /** An http(s) URL: its port, when it has one, is the web port. An ssh remote's port is the ssh port. */
  web: boolean;
  path: string;
}

const trimmedPath = (path: string): string => path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");

/** The host and path of a git remote URL (`https://…`, `ssh://…` or scp-like `git@host:path`); undefined for text that names no host: a local path, `owner/repo`, `group/sub/project`. */
export function parseRemote(text: string): RemoteName | undefined {
  const trimmed = text.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const host = url.hostname.toLowerCase();
      return host ? { host, ...(url.port ? { port: url.port } : {}), web: url.protocol === "https:" || url.protocol === "http:", path: trimmedPath(url.pathname) } : undefined;
    } catch {
      return undefined;
    }
  }
  if (/^[a-z]:[\\/]/i.test(trimmed)) return undefined; // a drive path, not `host:path`
  const scp = /^(?:[^@/:]+@)?([^@/:]+):(?!\/\/)(.*)$/.exec(trimmed);
  return scp ? { host: scp[1]!.toLowerCase(), web: false, path: trimmedPath(scp[2]!) } : undefined;
}

/** The value `key` has in `map` itself: a host named `constructor` is no entry of Object.prototype. */
const ownEntry = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

/**
 * The forge of a host: github.com and gitlab.com (on any port) are known; any other is looked up in `forges` by `host:port` when the
 * URL has a port, then by the bare host (an ssh remote's port is not the web port, so a declaration without one matches any port).
 * A host that is none of these is an error naming it and the key: the kit never guesses which CLI to use. `source` says where the host came from.
 */
function forgeOfHost(remote: RemoteName, forges: Readonly<Record<string, ForgeName>>, source: string): ForgeName {
  const forge = ownEntry(KNOWN_FORGE_HOSTS, remote.host) ?? (remote.port ? ownEntry(forges, `${remote.host}:${remote.port}`) : undefined) ?? ownEntry(forges, remote.host);
  if (forge !== undefined) return forge;
  throw new Error(
    `${source} names the host ${remote.port ? `${remote.host}:${remote.port}` : remote.host}, which is not a known forge (the kit knows github.com as GitHub and gitlab.com as GitLab): declare it under "forges" in the config (the global file or the repo file), for example { "forges": { ${JSON.stringify(remote.host)}: "gitlab" } }`,
  );
}

/**
 * The forge a fresh run starts on: the one of the host the `repo` argument names (a URL: another host than the origin's is a
 * cross-repository run), else the one of the host of the cwd's `origin` remote, as the repository's configuration spells it (a
 * `url.<base>.insteadOf` rewrite is not applied: the name the user cloned from decides). `forges` is the config's host map. A
 * repository whose origin names no host (a local path, no `origin`) is GitHub, as before GitLab was supported.
 */
export async function detectForge(commands: Commands, cwd: string, forges: Readonly<Record<string, ForgeName>>, repo?: string): Promise<ForgeName> {
  const named = repo === undefined ? undefined : parseRemote(repo);
  if (named) return forgeOfHost(named, forges, "the `repo` argument");
  const url = await commands.remoteUrl(cwd);
  const origin = url === undefined ? undefined : parseRemote(url);
  return origin === undefined ? DEFAULT_FORGE : forgeOfHost(origin, forges, "the origin remote");
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

/** The path of a repository as the REST API takes it, from what the `repo` argument holds: `group/sub/project`, or a URL of it. */
const repoPathOf = (repo: string): string => parseRemote(repo)?.path ?? trimmedPath(repo.trim());
/** `glab api` takes the host of a request apart from its path: the one a URL `repo` names (with its port, when the URL is a web one), else the cwd's own. */
function hostFlag(repo: string | undefined): string[] {
  const named = repo === undefined ? undefined : parseRemote(repo);
  if (!named) return [];
  return ["--hostname", named.web && named.port ? `${named.host}:${named.port}` : named.host];
}
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
    const pages = jsonValues(await this.api(cwd, repo, "--paginate", `${projectOf(repo)}/issues/${number}/notes`));
    const notes = pages.flat() as Array<{ body: string; system?: boolean }>;
    return notes.filter((note) => !note.system).map((note) => note.body);
  }

  async commentOnIssue(cwd: string, number: number, bodyFile: string, repo?: string): Promise<void> {
    await this.api(cwd, repo, "--method", "POST", `${projectOf(repo)}/issues/${number}/notes`, "-F", `body=@${bodyFile}`);
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
    const project = JSON.parse(await this.api(cwd, repo, projectOf(repo))) as { web_url: string };
    return project.web_url.trim();
  }

  /** The latest merge request (by creation date, in any state) whose source branch is `branch`; `glab mr view` would fail when there are several. */
  private async latestMr(cwd: string, branch: string, repo?: string): Promise<GitlabMr | undefined> {
    const query = `source_branch=${encodeURIComponent(branch)}&order_by=created_at&sort=desc&per_page=1`;
    const [page] = jsonValues(await this.api(cwd, repo, `${projectOf(repo)}/merge_requests?${query}`));
    if (!Array.isArray(page)) throw new Error(`glab api merge_requests (${branch}): expected a list`);
    return (page as GitlabMr[])[0];
  }

  private glab(cwd: string, ...args: string[]): Promise<string> {
    return this.commands.forgeRead("glab", cwd, ...args);
  }

  /** `glab api`, on the host of `repo` when it names one. */
  private api(cwd: string, repo: string | undefined, ...args: string[]): Promise<string> {
    return this.glab(cwd, "api", ...hostFlag(repo), ...args);
  }
}
