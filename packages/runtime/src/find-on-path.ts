// The first executable called `name` on a PATH string: `wf doctor` looks for `node`, `git`, the forge CLI and `bwrap` with it, and
// the `verify-sandbox` workflow looks for `bwrap`. Standard library only.

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** The first executable file called `name` on `path`, the way `/usr/bin/env node` (the shebang of the MCP command) finds it; undefined when there is none. */
export function findOnPath(name: string, path: string | undefined): string | undefined {
  for (const dir of (path ?? "").split(delimiter).filter(Boolean)) {
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {
      // not in this directory
    }
  }
  return undefined;
}
