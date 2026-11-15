// The entry of the app page (`/`: the Runs, Board and Metrics menus): mounts the app inside the error boundary, so a component that throws
// shows the error instead of a blank page. esbuild bundles this file, with React and the styles, when the dashboard starts.
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ErrorBoundary, showCrashIn } from "./ErrorBoundary.js";
import "./tokens.css";
import "./crash.css";
import "./styles.css";

const container = document.getElementById("root")!;
createRoot(container, { onUncaughtError: showCrashIn(container) }).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
