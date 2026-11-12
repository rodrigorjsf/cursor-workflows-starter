// Whether a process exists, shared by the job projection (job-state.ts) and the run lock (run-store.ts) so they agree, and
// whether a pid is still the process a record names (the job, the dashboard) rather than another that got the number.
import { existsSync, readFileSync } from "node:fs";

/** True when `pid` names a running process. EPERM means it exists but belongs to another user: alive. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * True when the command line of `pid` has an argument that `matches`: the process is the one a record names, not another
 * that got the number. Where /proc is missing it cannot tell, and says yes; a process that is gone says no.
 */
export function commandLineHas(pid: number, matches: (arg: string) => boolean): boolean {
  if (!existsSync("/proc/self/cmdline")) return true;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").some(matches);
  } catch {
    return false;
  }
}
