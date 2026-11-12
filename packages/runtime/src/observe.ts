// What the runtime offers to a tool that sits next to it (the dashboard): the runs of every repo and the metrics, read from
// the files the runtime writes, and the dashboard process's own contract (its port, its pid file, how to tell it is the one
// answering). This is the one entry point other workspace packages import (`@cursor-workflows/runtime/observe`); everything
// else in the runtime stays private to it.
export { defaultDbPath, openDb, type Db } from "./observability/db.js";
export { summary } from "./observability/queries.js";
export { type OutcomeClass } from "./runtime/outcome.js";
export { type RunCard, type RunCardLink } from "./runtime/projection.js";
export { type CancelRunOutcome, cancelRun } from "./runtime/run-cancel.js";
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
