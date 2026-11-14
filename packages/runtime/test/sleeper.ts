// Shared by the exec-groups and frozen-cancel tests, and by their child process exec-job.ts: a `sleep` that tells its pid to a
// file once it runs, so a test can find it in the process table, and the cleanup of one a failing test left behind.
import { readFileSync } from "node:fs";
import { waitFor } from "./wait-for.js";

/** The `sh` arguments of a command that writes its own pid to `pidFile` and then becomes `sleep 600`: the pid in the file is the sleep's. */
export const sleepArgs = (pidFile: string): string[] => ["-c", 'echo $$ > "$1"; exec sleep 600', "sh", pidFile];

/** The pid in `pidFile`, once it is written. `check` runs before each look, and may throw to stop waiting (the process that should write it died). */
export const pidIn = (pidFile: string, check: () => void = () => {}): Promise<number> =>
  waitFor(`the sleep that writes ${pidFile}`, () => {
    check();
    try {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      return Number.isInteger(pid) && pid > 1 ? pid : undefined;
    } catch {
      return undefined; // not written yet
    }
  });

/** SIGKILL to the process group `pid` leads: a sleep a failing test left running. */
export function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}
