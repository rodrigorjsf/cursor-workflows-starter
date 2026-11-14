// What a job's process leaves running when it is killed. Each `ctx.exec` command runs in a process group of its own, and the
// process cleans up from an exit hook (command-runner.ts) that a SIGKILL skips: when `cancelJob` kills a frozen job, those
// commands keep running. So the job records the group of each live command in a file beside its record
// (`<jobId>.exec-group.<pgid>`: written when the command starts, removed when it ends), and the cancel reads them.
//
// It is neither run state (the run's progress is its event log, ADR-0008) nor a field of the job record (the heartbeat worker
// rewrites the record from a snapshot, and a record field needs an ADR): it is the job process's own transient state, like its
// log file.
//
// No engine and no SDK here: the dashboard cancels through job-state.ts, which imports this.
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPlainName } from "./state.js";

const GROUP_INFIX = ".exec-group.";
const isGroupId = (n: number): boolean => Number.isInteger(n) && n > 1;

/**
 * Records process group `pgid` as one of the live commands of job `jobId`, in `jobsDir` (the folder of the job records), and
 * returns what removes the record again. A record that cannot be written leaves the command out of the cancel's reach and
 * nothing else: it runs and ends as any command does, so the failure is swallowed.
 */
export function recordExecGroup(jobsDir: string, jobId: string, pgid: number): () => void {
  if (!isPlainName(jobId) || !isGroupId(pgid)) return () => {}; // the id becomes a file name
  const file = join(jobsDir, `${jobId}${GROUP_INFIX}${pgid}`);
  try {
    writeFileSync(file, "");
  } catch {
    return () => {}; // nothing was written, so there is nothing to remove
  }
  return () => {
    try {
      rmSync(file, { force: true });
    } catch {
      /* a stale record only makes a later cancel signal a group that is gone */
    }
  };
}

/** The process groups job `jobId` has recorded as live commands. Only reads: nothing is created, and a missing folder records nothing. */
export function recordedExecGroups(jobsDir: string, jobId: string): number[] {
  if (!isPlainName(jobId)) return [];
  let names: string[];
  try {
    names = readdirSync(jobsDir);
  } catch {
    return [];
  }
  const prefix = `${jobId}${GROUP_INFIX}`;
  return names.filter((name) => name.startsWith(prefix)).map((name) => Number(name.slice(prefix.length))).filter(isGroupId);
}

/** Sends SIGKILL to each process group. A group that is already gone is not an error. */
export function killGroups(groups: number[]): void {
  for (const pgid of groups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
