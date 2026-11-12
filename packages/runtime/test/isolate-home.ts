// Imported by every test file that runs a workflow: the per-user state (global runs index, metrics database) goes to a
// throwaway directory instead of the real `~/.cursor-workflows`. `WF_HOME` overrides that directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.WF_HOME) {
  const home = mkdtempSync(join(tmpdir(), "wf-home-"));
  process.env.WF_HOME = home;
  process.on("exit", () => rmSync(home, { recursive: true, force: true }));
}
