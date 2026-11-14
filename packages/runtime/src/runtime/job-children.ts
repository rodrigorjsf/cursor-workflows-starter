// What a job's process leaves running when it is killed, and the kill of a frozen job that takes it along. Each `ctx.exec`
// command runs in a process group of its own, and the process cleans up from an exit hook (command-runner.ts) that a SIGKILL
// skips: when `cancelJob` kills a frozen job, those commands keep running. So the job records the group of each live command
// in a file beside its record (`<jobId>.exec-group.<pgid>`: written when the command starts, removed when it ends), and the
// cancel reads them.
//
// It is neither run state (the run's progress is its event log, ADR-0008) nor a field of the job record (the heartbeat worker
// rewrites the record from a snapshot, and a record field needs an ADR): it is the job process's own transient state, like its
// log file.
//
// The Cursor SDK's local agent is not a child process: it runs inside the job's process, so the kill ends it. What it starts
// are children the process cannot record: the shell commands of its tools, spawned detached in a group of their own, and the
// MCP servers of the project's config, spawned in the job's own group (a job runs detached, so it leads one). The kill finds
// the first in the process table and signals the second with the job's group. Where there is no /proc, only the recorded
// commands and the job's group are reached.
//
// No engine and no SDK here: the dashboard cancels through job-state.ts, which imports this.
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plainName } from "./state.js";

const GROUP_INFIX = ".exec-group.";
const isGroupId = (n: number): boolean => Number.isInteger(n) && n > 1;
const groupFile = (jobsDir: string, jobId: string, pgid: number): string => join(jobsDir, `${plainName(jobId, "jobId")}${GROUP_INFIX}${pgid}`);

/** Removes a record. One that cannot be removed only makes a later cancel signal a group that is gone, so it is left. */
function forget(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    /* left in place: harmless, see above */
  }
}

/**
 * Records process group `pgid` as one of the live commands of job `jobId`, in `jobsDir` (the folder of the job records), and
 * returns what removes the record again. Throws when the record cannot be written (the caller reports it: the command then
 * runs out of the cancel's reach).
 */
export function recordExecGroup(jobsDir: string, jobId: string, pgid: number): () => void {
  const file = groupFile(jobsDir, jobId, pgid);
  writeFileSync(file, "");
  return () => forget(file);
}

/** The process groups job `jobId` has recorded as live commands. Only reads: nothing is created, and a missing folder records nothing. */
export function recordedExecGroups(jobsDir: string, jobId: string): number[] {
  let names: string[];
  try {
    names = readdirSync(jobsDir);
  } catch {
    return [];
  }
  const prefix = `${plainName(jobId, "jobId")}${GROUP_INFIX}`;
  return names.filter((name) => name.startsWith(prefix)).map((name) => Number(name.slice(prefix.length))).filter(isGroupId);
}

/**
 * The direct children of process `pid` that lead a process group of their own: what a process spawns detached. Empty where
 * /proc is not there.
 */
function detachedChildGroups(pid: number): number[] {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const groups: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue; // it ended since the listing
    }
    // `<pid> (<command>) <state> <ppid> <pgrp> ...`: the command may hold spaces and parentheses, so read after the last `)`.
    const [, ppid, pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(ppid) === pid && Number(pgrp) === Number(entry) && isGroupId(Number(entry))) groups.push(Number(entry));
  }
  return groups;
}

/** Sends SIGKILL to each process group. A group that is already gone is not an error. */
function killGroups(groups: number[]): void {
  for (const pgid of groups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Kills the frozen process `pid` of job `jobId` and what it started: the commands it recorded, its detached children, and the
 * rest of its own process group. Throws what `process.kill` throws when the process cannot be killed.
 *
 * The process is stopped first (SIGSTOP; a frozen one may be running yet, with only its heartbeat dead): a stopped process
 * starts no command and reaps no child, so the groups read next are the ones signalled, and their numbers cannot have been
 * reused. They are signalled before the process dies, because a child that loses its parent is no longer found by it.
 */
export function killFrozenJob(jobsDir: string, jobId: string, pid: number): void {
  try {
    process.kill(pid, "SIGSTOP");
  } catch {
    /* gone, or not ours to stop: the kill below says which */
  }
  killGroups([...new Set([...recordedExecGroups(jobsDir, jobId), ...detachedChildGroups(pid)])]);
  process.kill(pid, "SIGKILL");
  killGroups([pid]); // the job's own group: its children that did not leave it (a group that does not exist is not an error)
  for (const pgid of recordedExecGroups(jobsDir, jobId)) forget(groupFile(jobsDir, jobId, pgid)); // the killed process cannot drop its records
}
