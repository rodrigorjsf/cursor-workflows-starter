// What the runtime offers to a tool that sits next to it (the dashboard): the runs of every repo and the metrics, read from
// the files the runtime writes, the state of a PR or MR by its URL (asked of the forge's CLI, ADR-0009), the repositories and
// workflows it may start a run in and the start itself (`startRun`, which starts a detached job) or the resume of a stopped run
// (`resumeRun`, a new job over the same run with the args and caps of its latest start), the proposal of seams an `implement-issue`
// run waits on and the decision on it (`seamsProposalOf`, `approveSeams` and `replaceSeams`: a resume with other args), the Backlog of a repository
// (the open issues ready for `implement-issue` that no run has taken on, asked of the forge through its seam, ADR-0009), and the dashboard process's own contract (its port, its pid file, how to tell it is the one
// answering). This is the one entry point other workspace packages import (`@cursor-workflows/runtime/observe`); everything
// else in the runtime stays private to it.
export { defaultDbPath, openDb, type Db } from "./observability/db.js";
export { summary } from "./observability/queries.js";
export { type OutcomeClass } from "./runtime/outcome.js";
export { type RunCard, type RunCardLink } from "./runtime/projection.js";
export { type CancelRunOutcome, cancelRun } from "./runtime/run-cancel.js";
export { type ResumeRunOutcome, resumeRun } from "./runtime/run-resume.js";
export { leftAgentsNote } from "./runtime/cloud-cancel.js";
export { errorText } from "./runtime/error-text.js";
export { type BacklogIssue, type BacklogRead, BACKLOG_WORKFLOW, issuesWithRuns, readBacklog } from "../workflows/implement-issue/backlog.js";
export { type SeamsActionOutcome, type SeamsProposal, approveSeams, replaceSeams, seamsProposalOf } from "../workflows/implement-issue/seams-approval.js";
export { type RepoWorkflows, type StartRunOutcome, type StartRunRequest, type StartableWorkflow, knownRepos, listRepoWorkflows, startRun } from "./runtime/run-start.js";
export { type PrState as ForgePrState, isPrUrl, prStateOfUrl } from "./runtime/pr-by-url.js";
export { type JobStart } from "./runtime/job-state.js";
export { type RunDetail, type RunSummary, type RunViewStatus, listRuns, readRun } from "./runtime/run-view.js";
export { type LoggedEvent, type RunTail, type StepContent, type StepContentItem, type TailOptions, readStepContent, tailRun } from "./runtime/run-tail.js";
export {
  DASHBOARD_APP,
  DASHBOARD_HOST,
  HEALTH_PATH,
  dashboardCacheDir,
  dashboardPort,
  dashboardUrl,
  probeDashboard,
  removeInstance,
  writeInstance,
} from "./runtime/dashboard-instance.js";
