// The decision on the seams an `implement-issue` run proposed, taken from outside the process that ran it: the dashboard's Approve and
// Replace buttons. A MED or HIGH run that is not told which seams to test stops, ends `finished` with a result whose status is
// `seams-proposed`, and keeps its plan in its progress file; a run given `seams` and no `testCommand` stops the same way at
// `test-command-proposed`, because a command a model wrote runs only after a person saw it. Either stop is decided by a resume of the run:
// `approveSeams: true` (run exactly the stored plan) or `seams: [...]` (plan again with these seams). This module reads the proposal a
// run waits on and starts that resume, as the person would from the chat or the terminal; it posts nothing, because the workflow posts
// the decision on the issue itself when it resumes (`decideSeams`, implement-issue.ts).
//
// - A proposal is read from two places: the run's latest result says that the run is waiting (and for what), and its progress file
//   holds the plan, which is what an approval executes. A run that went on after the decision, or whose latest execution is running
//   again, waits for nothing.
// - Approve carries the proposal's `digest`, the hash of what the page showed (the seams, the slices, the test command and which stop
//   it was): the plan can change between the page and the click (another resume, a re-plan), and a person who read one plan must not
//   approve another, whose test command runs through `bash -c`. A digest that no longer matches is refused.
// - Both actions resume with the caps and overrides of the run's latest job and its args, changed only by the decision. A run no job
//   started (`wf run` in a terminal) has no record of its args and is refused.
//
// Like run-resume.ts, it imports no engine, so the dashboard process that calls it does not load the Cursor SDK.
import { createHash } from "node:crypto";
import { isRecord } from "../../src/runtime/parse-json.js";
import { type LaunchResumeOutcome, launchResume } from "../../src/runtime/run-resume.js";
import { type RunDetail, readRun } from "../../src/runtime/run-view.js";
import { BACKLOG_WORKFLOW as IMPLEMENT_ISSUE } from "./backlog.js";
import { PLAN, type Plan, testCommandOf } from "./plan.js";
import { ProgressStore } from "./tdd.js";

/** The two results of `implement-issue` that wait for a person's decision on the plan. */
const STOPS = ["seams-proposed", "test-command-proposed"] as const;
export type SeamsStop = (typeof STOPS)[number];

/** What a run waits for a decision on: the plan it stored, and which stop it made. */
export interface SeamsProposal {
  stop: SeamsStop;
  seams: Plan["seams"];
  slices: Plan["slices"];
  /** The command the run executes once the plan is approved: the one typed when the run started, else the planner's, else the kit's `npm test`. */
  testCommand: string;
  /** Hash of everything above: what an approval names, so that it applies only to the proposal a person saw. */
  digest: string;
}

const isStop = (value: unknown): value is SeamsStop => STOPS.some((stop) => stop === value);

/** The plan the run stored when it stopped. Undefined when there is none, or the file cannot be read (nothing to show then, and a resume would fail on it). */
function storedPlan(repo: string, runId: string): Plan | undefined {
  try {
    const parsed = PLAN.safeParse(new ProgressStore(repo, runId).data.proposedPlan);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined; // an unreadable progress file: the run's own resume reports it
  }
}

/** The proposal `run` waits on, or undefined when it waits on none: not an `implement-issue` run, not stopped at a proposal, or its latest execution went on. */
export function seamsProposalOf(run: RunDetail): SeamsProposal | undefined {
  if (run.workflow !== IMPLEMENT_ISSUE || run.status !== "finished" || !isRecord(run.result) || !isStop(run.result.status)) return undefined;
  const plan = storedPlan(run.repo, run.runId);
  if (!plan) return undefined;
  const typed = isRecord(run.start?.args) && typeof run.start.args.testCommand === "string" ? run.start.args.testCommand : undefined;
  const stop = run.result.status;
  const { seams, slices } = plan;
  const testCommand = testCommandOf(plan, typed);
  const digest = createHash("sha256").update(JSON.stringify({ stop, seams, slices, testCommand })).digest("hex").slice(0, 16);
  return { stop, seams, slices, testCommand, digest };
}

/** What a decision on a run's seams came to: why nothing was started, or what starting the resume came to (`LaunchResumeOutcome`). */
export type SeamsActionOutcome =
  /** The runs index has no such run. */
  | { kind: "unknown-run" }
  /** The run waits for no decision: it did not stop at a proposal, or went on since. */
  | { kind: "no-proposal" }
  /** The run waits for a decision, but not on the proposal the approval names (its `digest` is another): the page showed a plan that is no longer the run's. */
  | { kind: "proposal-changed" }
  | LaunchResumeOutcome;

/** `args` without the keys in `names`, as an object (a recorded start that holds no object has no args to keep). */
function without(args: unknown, ...names: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(isRecord(args) ? args : {}).filter(([name]) => !names.includes(name)));
}

/**
 * Approves the plan run `runId` stored, if the proposal it waits on is the one `digest` names: resumes it with its recorded start and
 * `approveSeams: true`, so it executes exactly that plan. A proposal at the test command has the `seams` of the first start dropped, as the
 * workflow's own relaunch line does: with `seams` the stored plan would not be taken, and the planner would run again.
 */
export async function approveSeams(runId: string, digest: string): Promise<SeamsActionOutcome> {
  const run = readRun(runId);
  if (!run) return { kind: "unknown-run" };
  const proposal = seamsProposalOf(run);
  if (!proposal) return { kind: "no-proposal" };
  if (proposal.digest !== digest) return { kind: "proposal-changed" };
  return launchResume(run, (recorded) => ({ ...without(recorded, "seams"), approveSeams: true }));
}

/**
 * Replaces the seams of the plan run `runId` waits on with `seams` (not empty; the caller checked): resumes it with its recorded start and
 * `seams`, so the run plans again with them. Needs no digest, because it executes nothing the person did not write: a run that
 * stopped again at the planner's test command shows that command for a decision of its own.
 */
export async function replaceSeams(runId: string, seams: string[]): Promise<SeamsActionOutcome> {
  const run = readRun(runId);
  if (!run) return { kind: "unknown-run" };
  if (!seamsProposalOf(run)) return { kind: "no-proposal" };
  return launchResume(run, (recorded) => ({ ...without(recorded, "approveSeams"), seams }));
}
