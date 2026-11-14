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
import { createForge, detectForge } from "./forge.js";
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
export type BacklogRead = { kind: "listed"; label: string; issues: BacklogIssue[] } | { kind: "failed"; error: string };

const failed = (error: string): BacklogRead => ({ kind: "failed", error });

/**
 * The open issues of `repo` that carry its backlog label, oldest first, as its forge lists them. They include the ones a run has
 * taken on (`issuesWithRuns` says which). `repo` is a path as `knownRepos` gives it; any other is `failed`, as is anything the
 * forge, the CLI or the config says no to (`error` is the sentence for the user).
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
    const forge = createForge(await detectForge(commands, repo, config.forges ?? {}), commands);
    const issues = (await forge.listIssues(repo, label)).map(({ number, title, url }) => ({ number, title, url })).sort((a, b) => a.number - b.number);
    return { kind: "listed", label, issues };
  } catch (err) {
    // Whatever went wrong asking (a CLI that is missing or not logged in, a host the config does not declare, a bad config) is an
    // answer for this repository alone: the sentence goes to the user as it is.
    return failed(errorText(err));
  }
}

/** The issue a run was started for: the `issue` arg of its job, else the `#<n>` its card starts with, else none. */
function issueOf({ start, card }: RunOrigin): number | undefined {
  if (start !== undefined) {
    // A run with a `repo` arg works on an issue of another repository: its number is not one of this repository's.
    const { issue, repo } = (typeof start.args === "object" && start.args !== null ? start.args : {}) as { issue?: unknown; repo?: unknown };
    return repo === undefined && typeof issue === "number" && Number.isInteger(issue) ? issue : undefined;
  }
  // A run with no job (`wf run` in a terminal) has only its card to say, once the workflow has read the issue.
  const match = /^#(\d+)(?:\s|$)/.exec(card?.title ?? "");
  return match ? Number(match[1]) : undefined;
}

/**
 * The numbers of the issues of `repo` that a run of `implement-issue` was started for, whatever became of the run: a Backlog lists
 * ready issues that nobody started. Only reads the runs index, the logs and the job records.
 */
export function issuesWithRuns(repo: string): Set<number> {
  const taken = new Set<number>();
  for (const origin of runOriginsOf(repo, BACKLOG_WORKFLOW)) {
    const issue = issueOf(origin);
    if (issue !== undefined) taken.add(issue);
  }
  return taken;
}
