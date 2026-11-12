// Whether a process exists, shared by the job projection (jobs.ts) and the run lock (run-store.ts) so they agree.

/** True when `pid` names a running process. EPERM means it exists but belongs to another user: alive. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
