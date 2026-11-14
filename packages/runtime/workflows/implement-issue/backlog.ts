// The Backlog of a repository: the open issues that carry the backlog label (the `backlogLabel` setting of `implement-issue`, default
// `ready-for-agent`) and that no run of `implement-issue` has taken on. It is what the dashboard's Backlog column lists, and its
// "run" button starts `implement-issue` for one of them (`startRun`, observe).
//
// The issues are read through the forge seam (`forge.ts`, ADR-0009), so GitHub and GitLab repositories alike are asked through
// their own CLI, in the repository's folder, with the settings and the `forges` map of that repository's config. There is no run
// and no checkout to work in here: the commands are `wf gc`'s (`directCommands`), the forge is the one the repository's `origin`
// names. Like `startRun`, it asks only about a repository the global runs index names, and it imports no engine, so the dashboard
// process that calls it does not load the Cursor SDK.
//
// - `readBacklog` never rejects: a repository whose forge cannot say (no CLI, no login, no network, an unknown host, an unusable
//   config) is an answer that holds the reason, so one repository cannot take the others' Backlog down.
// - Which issues have a run (`issuesWithRuns`) is asked apart from the listing, because the listing is what costs a forge call and
//   a caller keeps it for a while, while a run started a moment ago must take its issue off the Backlog at once.
import { loadEffectiveConfig } from "../../src/config/index.js";
import { errorText } from "../../src/runtime/error-text.js";
import { discoverWorkflows } from "../../src/runtime/registry.js";
import { type RunOrigin, runOriginsOf } from "../../src/runtime/run-view.js";
import { knownRepos } from "../../src/runtime/run-start.js";
import { type RemoteName, createForge, detectForge, parseRemote, trimmedPath } from "./forge.js";
import { directCommands } from "./gc.js";

/** The workflow a Backlog card starts, and whose runs take an issue off the Backlog. */
export const BACKLOG_WORKFLOW = "implement-issue";

/** An open issue of the Backlog. */
export interface BacklogIssue {
  number: number;
  title: string;
  /** The address of the issue's page, as the forge printed it. */
  url: string;
}

/** What asking a repository's forge came to: the issues that carry the label, or why it could not say. */
export type BacklogRead =
  | {
      kind: "listed";
      label: string;
      issues: BacklogIssue[];
      /** Which repository the `origin` remote names, as `host/path` in lower case: what a run's `repo` arg is compared with to tell whether it names this repository. Absent when the origin names none (a local path), or there is no origin. */
      repository?: string;
    }
  | { kind: "failed"; error: string };

const failed = (error: string): BacklogRead => ({ kind: "failed", error });

/**
 * The open issues of `repo` that carry its backlog label, oldest first, as its forge lists them. They include the ones a run has
 * taken on (`issuesWithRuns` says which). `repo` is a path as `knownRepos` gives it; any other is `failed`, as is anything the
 * forge, the CLI or the config says no to (`error` is the sentence for the user). A repository with no `origin` remote has no forge
 * to ask: it lists nothing, and that is no error (a scratch repository is not a broken one).
 */
export async function readBacklog(repo: string): Promise<BacklogRead> {
  if (!knownRepos().includes(repo)) return failed(`unknown repository: ${repo}`);
  try {
    const def = (await discoverWorkflows(repo, { fresh: true })).workflows.get(BACKLOG_WORKFLOW);
    if (!def) return failed(`unknown workflow: ${BACKLOG_WORKFLOW}: the repository lists no such workflow, so it has no backlog label`);
    const { config } = loadEffectiveConfig(def, { cwd: repo });
    const { backlogLabel: label, networkTimeoutSec } = config.settings;
    if (typeof label !== "string" || label === "") return failed(`workflows.${BACKLOG_WORKFLOW}.settings.backlogLabel must be the name of a label`);
    if (typeof networkTimeoutSec !== "number") return failed(`workflows.${BACKLOG_WORKFLOW}.settings.networkTimeoutSec must be a number of seconds`);
    const commands = directCommands(networkTimeoutSec);
    const originUrl = await commands.remoteUrl(repo);
    if (originUrl === undefined) return { kind: "listed", label, issues: [] };
    const forge = createForge(await detectForge(commands, repo, config.forges ?? {}), commands);
    const issues = (await forge.listIssues(repo, label)).map(({ number, title, url }) => ({ number, title, url })).sort((a, b) => a.number - b.number);
    const origin = parseRemote(originUrl);
    return { kind: "listed", label, issues, ...(origin === undefined ? {} : { repository: identityOf(origin) }) };
  } catch (err) {
    // Whatever went wrong asking (a CLI that is missing or not logged in, a host the config does not declare, a bad config) is an
    // answer for this repository alone: the sentence goes to the user as it is.
    return failed(errorText(err));
  }
}

/** `remote` as `host/path` in lower case (GitHub ignores case, and GitLab's paths are lower case): the form two spellings of one repository agree on. */
const identityOf = (remote: RemoteName): string => `${remote.host}/${remote.path}`.toLowerCase();

/**
 * Whether the `repo` arg of a run names the repository whose `origin` is `repository` (`identityOf`), in any form the forge's CLI
 * takes: a URL, an ssh remote, `owner/repo` (on the host of the origin) or `host/owner/repo`. `implement-issue` treats such a run
 * as one on the cwd's own issue (`issueLockName`), and so does the Backlog.
 */
function namesRepository(arg: string, repository: string | undefined): boolean {
  if (repository === undefined) return false;
  const remote = parseRemote(arg);
  if (remote !== undefined) return identityOf(remote) === repository;
  const path = trimmedPath(arg.trim()).toLowerCase();
  return path === repository || `${repository.split("/")[0]}/${path}` === repository;
}

/**
 * The issue a run was started for: the `issue` arg of its job, else the `#<n>` its card starts with, else none. A job with a `repo`
 * arg that names another repository is for an issue of that one, whose number is not one of this repository's. A run with no job
 * (`wf run` in a terminal) has only its card to say, once the workflow has read the issue, and the card does not say which
 * repository the issue is of: such a run on another repository's issue takes the same number off this Backlog.
 */
function issueOf({ start, card }: RunOrigin, repository: string | undefined): number | undefined {
  if (start !== undefined) {
    const { issue, repo } = (typeof start.args === "object" && start.args !== null ? start.args : {}) as { issue?: unknown; repo?: unknown };
    if (repo !== undefined && !(typeof repo === "string" && namesRepository(repo, repository))) return undefined;
    return typeof issue === "number" && Number.isInteger(issue) ? issue : undefined;
  }
  const match = /^#(\d+)(?:\s|$)/.exec(card?.title ?? "");
  return match ? Number(match[1]) : undefined;
}

/**
 * The numbers of the issues of `repo` that a run of `implement-issue` was started for, whatever became of the run: a Backlog lists
 * ready issues that nobody started. `repository` is what `readBacklog` said the repository's origin names (`BacklogRead`), to tell
 * a run with a `repo` arg that names this repository from one that names another. Only reads the runs index, the logs and the job records.
 */
export function issuesWithRuns(repo: string, repository?: string): Set<number> {
  const taken = new Set<number>();
  for (const origin of runOriginsOf(repo, BACKLOG_WORKFLOW)) {
    const issue = issueOf(origin, repository);
    if (issue !== undefined) taken.add(issue);
  }
  return taken;
}
