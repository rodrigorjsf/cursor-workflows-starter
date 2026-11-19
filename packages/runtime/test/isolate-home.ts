// Imported by every test file that runs a workflow: the per-user state (global runs index, metrics database) goes to a
// throwaway directory instead of the real `~/.cursor-workflows`. `WF_HOME` overrides that directory.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.WF_HOME) {
  const home = mkdtempSync(join(tmpdir(), "wf-home-"));
  process.env.WF_HOME = home;
  process.on("exit", () => rmSync(home, { recursive: true, force: true }));
}

export function blockedUserDir(dir: string): string {
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "x");
  return join(blocker, "home");
}

export async function withUserDir<T>(env: Record<string, string | undefined>, userDir: string, use: () => T | Promise<T>): Promise<T> {
  const previous = env.WF_HOME;
  env.WF_HOME = userDir;
  try {
    return await use();
  } finally {
    if (previous === undefined) delete env.WF_HOME;
    else env.WF_HOME = previous;
  }
}
