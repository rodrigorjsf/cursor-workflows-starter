import { writeFileSync } from "node:fs";
import { join } from "node:path";

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
