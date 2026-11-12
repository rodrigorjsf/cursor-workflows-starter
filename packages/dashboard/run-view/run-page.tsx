// The entry of the Run view page (`/runs/<runId>`): reads the run id from the address and mounts the view.
import "@xyflow/react/dist/style.css";
import { createRoot } from "react-dom/client";
import "../app/tokens.css";
import "./run-view.css";
import { runIdOf } from "./location.js";
import { RunView } from "./RunView.js";

const runId = runIdOf(location.pathname);
createRoot(document.getElementById("root")!).render(<RunView runId={runId} />);
