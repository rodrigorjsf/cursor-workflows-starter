#!/usr/bin/env node
// The dashboard process: `npm run dash`, and what `start_workflow` starts detached. It serves http://127.0.0.1:<port>, the
// port being WF_DASH_PORT (default 4317), and records itself in the pid file while it listens.
//
// Only one dashboard can hold the port. A second one finds the first answering and exits quietly; a port taken by some
// other program is an error that names the variable to change.
import { defaultDbPath, dashboardPort, probeDashboard, removeInstance, writeInstance } from "@cursor-workflows/runtime/observe";
import { startDashboard } from "./server.js";
import { uiBundle } from "./ui-bundle.js";

const say = (line: string) => process.stderr.write(`${line}\n`);
const port = dashboardPort();

let dashboard;
try {
  dashboard = await startDashboard({ port });
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
  if (await probeDashboard(port)) {
    say(`the dashboard is already running on port ${port}`);
    process.exit(0);
  }
  say(`port ${port} is in use by another program; set WF_DASH_PORT to a free port`);
  process.exit(1);
}

writeInstance({ pid: process.pid, port, startedAt: new Date().toISOString() });
say(`dashboard listening on ${dashboard.url} (metrics database: ${defaultDbPath()})`);

// Build the web app now, so the first page does not wait for it. A page asked for sooner shares this build. A failure is
// reported, and the next page tries again.
uiBundle().then(
  (ui) => say(`web app built (${ui.script.name}, ${ui.style.name})`),
  (err: unknown) => say(`the web app could not be built: ${err instanceof Error ? err.message : String(err)}`),
);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  removeInstance(process.pid);
  void dashboard.close().finally(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("exit", () => removeInstance(process.pid));
