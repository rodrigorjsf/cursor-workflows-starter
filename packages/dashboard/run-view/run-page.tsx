// The entry of the Run view page (`/runs/<runId>`): reads the run id from the address and mounts the view inside the error boundary, so a
// component that throws (on an event of a shape this page does not know) shows the error instead of a blank page.
import "@xyflow/react/dist/style.css";
import { createRoot } from "react-dom/client";
import { ErrorBoundary, showCrashIn } from "../app/ErrorBoundary.js";
import "../app/tokens.css";
import "../app/crash.css";
import "./run-view.css";
import { runIdOf } from "./location.js";
import { RunView } from "./RunView.js";

const runId = runIdOf(location.pathname);
const container = document.getElementById("root")!;
createRoot(container, { onUncaughtError: showCrashIn(container) }).render(
  <ErrorBoundary>
    <RunView runId={runId} />
  </ErrorBoundary>,
);
