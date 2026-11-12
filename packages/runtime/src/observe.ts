// What the runtime offers to a tool that only watches it (the dashboard): the runs of every repo and the metrics, read
// from the files the runtime writes. This is the one entry point other workspace packages import
// (`@cursor-workflows/runtime/observe`); everything else in the runtime stays private to it.
export { defaultDbPath, openDb, type Db } from "./observability/db.js";
export { summary } from "./observability/queries.js";
export { type RunDetail, type RunSummary, type RunViewStatus, listRuns, readRun } from "./runtime/run-view.js";
export {
  DASHBOARD_APP,
  DASHBOARD_HOST,
  HEALTH_PATH,
  dashboardPort,
  probeDashboard,
  removeInstance,
  writeInstance,
} from "./runtime/dashboard-instance.js";
