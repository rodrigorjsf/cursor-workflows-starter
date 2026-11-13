// The forge seam (ADR-0009): everything `implement-issue` and `wf gc` ask of the service that hosts the repository (read an
// issue, list and post its comments, open a PR, find a branch's PR and its state, name a repository), behind one interface.
// This file is the only one that names a forge's CLI (`test/forge-seam.test.ts` enforces it); GitHub, through `gh`, is the only
// implementation so far. Every call goes through `Commands`, so its timeout, its `CommandError` and its node in the run's log
// are those of every other command the workflow runs.
//
// A run records the forge it started on (`Progress.forge`), and `wf gc` asks the forge a record names, never one detected
// again; a record without the field is GitHub (`forgeNameOf`), as every run before the field existed was.
import type { Commands } from "./commands.js";

/** The state of a PR, as the forge reports it. */
export type PrState = "OPEN" | "MERGED" | "CLOSED";

/** The forges the runtime can speak to: the value a run's progress record keeps. */
export type ForgeName = "github";

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

/**
 * The forge `name` (as a record keeps it), speaking through `commands`. A record can name a forge this version does not know
 * (the run was recorded by a newer kit): that is an error, never a fall back to another forge's CLI.
 */
export function createForge(name: string, commands: Commands): Forge {
  if (name === "github") return new GithubForge(commands);
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
