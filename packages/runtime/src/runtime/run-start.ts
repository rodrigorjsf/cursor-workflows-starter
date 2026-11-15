// Starting a run from outside the process that will execute it, for a tool that sits next to the runtime: the dashboard's Start
// action (and, through `launchJob`, its Resume button: run-resume.ts). It starts a job the way `wf start` and `start_workflow` do
// (a detached process, `spawnJob`), after the same checks (the kit fits the repo, the config is usable, the args fit the workflow's
// `argsSchema`, the caps are within the global ones), and adds the one rule this door exists for: the repository must be one the
// global runs index already names, and the workflow one the runtime lists for it. A Start hands over a path and a name the user typed in
// a browser, and a free path would let the browser run code in any folder; a Resume takes them from the run's own index entry and job record.
//
// Like job-state.ts and run-cancel.ts, it imports no engine, so the dashboard process that calls it does not load the Cursor SDK.
// Nothing is created in a repository until every check has passed.
import { statSync } from "node:fs";
import { ConfigError, type LimitOverrides, loadEffectiveConfig } from "../config/index.js";
import { kitCompatibility } from "../kit-version.js";
import { argsError } from "./args-schema.js";
import { errorText } from "./error-text.js";
import { INSIDE_WORKFLOW_ENV } from "./inside-workflow.js";
import { JobRefusedError, spawnJob } from "./job-spawn.js";
import { type BrokenWorkflow, discoverWorkflows } from "./registry.js";
import { readRunsIndex } from "./runs-index.js";
import type { ConfigViolation } from "./events.js";
import type { JsonSchema, WorkflowMeta } from "./workflow.js";

/** A workflow a repository lists, as the start form needs it: what it is and what args it takes. */
export interface StartableWorkflow {
  name: string;
  description: string;
  whenToUse?: string;
  /** The JSON Schema of its args, when it declares one. */
  argsSchema?: JsonSchema;
}

/** What a repository lists: the workflows that loaded, and the files that did not, each with its error. */
export interface RepoWorkflows {
  workflows: StartableWorkflow[];
  broken: BrokenWorkflow[];
}

/** What a start is asked to do. Both caps are required: a start from a browser is never uncapped. */
export interface StartRunRequest {
  /** The repository's path, exactly as `knownRepos` gives it. */
  repo: string;
  /** The workflow's `meta.name`. */
  workflow: string;
  args: unknown;
  maxTokens: number;
  maxCents: number;
}

export type StartRunOutcome =
  /** The job was started; its run registers itself in a moment. `violations` are the layers of the config that asked for more than the global caps allow, and were cut. */
  | { kind: "started"; jobId: string; runId: string; violations: ConfigViolation[] }
  /** The runs index does not name the repository (or its folder is gone). */
  | { kind: "unknown-repo" }
  /** The repository does not list the workflow. `available` are the names it lists. */
  | { kind: "unknown-workflow"; available: string[] }
  /** The args do not fit the workflow's `argsSchema`; `error` starts with `invalid args:` and names the field. */
  | { kind: "invalid-args"; error: string }
  /** The runtime would not start it: inside a workflow step, a kit outside the repo's range, an unusable config. `error` says why. */
  | { kind: "refused"; error: string };

/** Every repository the runs index names whose folder is still there, the one a run started in most recently first. */
export function knownRepos(): string[] {
  const repos = new Set<string>();
  for (const { repo } of readRunsIndex().reverse()) repos.add(repo);
  return [...repos].filter((repo) => statSync(repo, { throwIfNoEntry: false })?.isDirectory());
}

const startable = ({ name, description, whenToUse, argsSchema }: WorkflowMeta): StartableWorkflow => ({
  name,
  description,
  ...(whenToUse === undefined ? {} : { whenToUse }),
  ...(argsSchema === undefined ? {} : { argsSchema }),
});

/**
 * The workflows `repo` lists, as `list_workflows` does for the chat: the kit's own, the repository's `.agents/workflows/` and
 * `$WORKFLOWS_DIR`. Undefined when `repo` is not a repository `knownRepos` names. Loading a workflow file imports it into this
 * process, as the MCP server does for its repository (again when the file changed: this process outlives an edit); nothing is written.
 */
export async function listRepoWorkflows(repo: string): Promise<RepoWorkflows | undefined> {
  if (!knownRepos().includes(repo)) return undefined;
  const { workflows, broken } = await discoverWorkflows(repo, { fresh: true });
  return { workflows: [...workflows.values()].map((def) => startable(def.meta)), broken };
}

/** What `launchJob` starts a job with, beyond where and what: the args, the caps of the flag layer, the chat's overrides, and the run to resume. */
export interface JobLaunch {
  args: unknown;
  maxTokens?: number;
  maxCents?: number;
  overrides?: LimitOverrides;
  /** The run to resume: a new job over an existing run. Absent for a new run. */
  resumeRunId?: string;
}

/**
 * The start path both doors share (`startRun`, and `resumeRun` in run-resume.ts): the checks every start passes (not inside a workflow step,
 * a repository the runs index names, a workflow it lists, args that fit the `argsSchema`, a kit that fits the repo, a usable config, caps
 * within the global ones), then `spawnJob`. Nothing is created in the repository until every check has passed.
 */
export async function launchJob(repo: string, workflow: string, { args, maxTokens, maxCents, overrides, resumeRunId }: JobLaunch): Promise<StartRunOutcome> {
  if (process.env[INSIDE_WORKFLOW_ENV] === "1") return { kind: "refused", error: "workflows cannot be started from inside a workflow step" };
  if (!knownRepos().includes(repo)) return { kind: "unknown-repo" };
  const { workflows } = await discoverWorkflows(repo, { fresh: true });
  const def = workflows.get(workflow);
  if (!def) return { kind: "unknown-workflow", available: [...workflows.keys()] };
  const invalid = argsError(def.meta.argsSchema, args);
  if (invalid) return { kind: "invalid-args", error: invalid };
  const { problem } = kitCompatibility(repo);
  if (problem) return { kind: "refused", error: `${problem.message}. ${problem.hint}` };
  const flags = { ...(maxTokens === undefined ? {} : { maxTokens }), ...(maxCents === undefined ? {} : { maxCents }) };
  let violations: ConfigViolation[];
  let maxRunningJobs: number | null;
  try {
    // Read afresh, so an unusable config is refused before a job exists, and a cap the global ones cut is reported now.
    const resolved = loadEffectiveConfig(def, { cwd: repo, flags, mcpOverrides: overrides });
    violations = resolved.violations;
    maxRunningJobs = resolved.config.caps.maxRunningJobs;
  } catch (err) {
    if (err instanceof ConfigError) return { kind: "refused", error: errorText(err) };
    throw err;
  }
  try {
    const { job } = spawnJob({ cwd: repo, workflow: def.meta.name, args, maxRunningJobs, resumeRunId, overrides, ...flags });
    return { kind: "started", jobId: job.jobId, runId: job.runId, violations };
  } catch (err) {
    if (err instanceof JobRefusedError) return { kind: "refused", error: err.message };
    throw err;
  }
}

/** Starts `request.workflow` in `request.repo` as a job, or says why not (see `StartRunOutcome`). */
export function startRun({ repo, workflow, args, maxTokens, maxCents }: StartRunRequest): Promise<StartRunOutcome> {
  return launchJob(repo, workflow, { args, maxTokens, maxCents });
}
