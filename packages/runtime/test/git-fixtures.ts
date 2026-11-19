// SPDX-License-Identifier: MIT
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function repoWithOneCommit(cwd: string): void {
  mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(cwd, "a.txt"), "1");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
}
