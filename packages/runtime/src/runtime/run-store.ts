// The durable state of one run, behind one door: the append-only event log (the run's source of truth), the journal and
// the run lock.
//
// Layout, under `<cwd>/.workflows/runs/<runId>/`:
//   events.jsonl   every event of every execution of the run, one JSON object per line
//   journal.jsonl  the results of the finished steps, for resume
//   run.lock       present while a process executes the run: who holds it
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunStartEvent, WorkflowEvent } from "./events.js";
import { Journal } from "./journal.js";
import { stateDir } from "./state.js";
import { appendJsonl, hasTornTail, readJsonl } from "./state-files.js";

export const EVENTS_FILE = "events.jsonl";
export const JOURNAL_FILE = "journal.jsonl";
export const LOCK_FILE = "run.lock";

/** Another process (or another execution in this one) is already executing the run. */
export class RunLockedError extends Error {}

interface LockContent {
  pid: number;
  token: string;
  startedAt: string;
}

/**
 * Locks held by this process, by lock file, with the function that releases each. Tells our own live lock from one left
 * by an earlier process that had the same pid, and lets a process that exits without closing its stores release them.
 */
const heldLocks = new Map<string, () => void>();
let exitHookInstalled = false;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, but belongs to someone else
  }
}

function readLock(file: string): LockContent | undefined {
  try {
    const lock = JSON.parse(readFileSync(file, "utf8")) as Partial<LockContent>;
    return typeof lock.pid === "number" ? (lock as LockContent) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes the lock of the run in `dir`, or throws `RunLockedError` naming the holder. The lock file is created complete
 * and atomically (written aside, then hard-linked into place: `link` fails when the target exists), so nobody ever reads
 * a half-written lock. A lock whose process is gone is stale and is taken over. Returns the release function.
 *
 * Known limit: two processes that find the same stale lock at the same instant can both take it over.
 */
function acquireLock(dir: string, runId: string): () => void {
  const file = join(dir, LOCK_FILE);
  const content: LockContent = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() };
  const aside = `${file}.${process.pid}.${content.token.slice(0, 8)}.tmp`;
  writeFileSync(aside, JSON.stringify(content));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(aside, file);
        const release = () => {
          heldLocks.delete(file);
          if (readLock(file)?.token === content.token) rmSync(file, { force: true });
        };
        heldLocks.set(file, release);
        if (!exitHookInstalled) {
          exitHookInstalled = true;
          process.on("exit", () => [...heldLocks.values()].forEach((r) => r()));
        }
        return release;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const holder = readLock(file);
      const live = holder && isAlive(holder.pid) && (holder.pid !== process.pid || heldLocks.has(file));
      if (holder && live) {
        throw new RunLockedError(
          `já está em execução: o run ${runId} pertence ao processo ${holder.pid} (desde ${holder.startedAt}); espere terminar ou cancele-o antes de executá-lo de novo`,
        );
      }
      rmSync(file, { force: true }); // stale (dead holder) or unreadable: take it over
    }
    throw new RunLockedError(`já está em execução: o run ${runId} foi disputado por outro processo ao mesmo tempo`);
  } finally {
    rmSync(aside, { force: true });
  }
}

/** Directory of a run's state in the target repo. */
export function runDirPath(cwd: string, runId: string): string {
  return join(stateDir(cwd, "runs"), runId);
}

export function eventLogPath(cwd: string, runId: string): string {
  return join(runDirPath(cwd, runId), EVENTS_FILE);
}

const isEvent = (v: unknown): v is WorkflowEvent =>
  typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

/** Reads an event log. A torn last line, or any line that is not an event, is skipped and counted. */
export function readEventLog(file: string): { events: WorkflowEvent[]; skipped: number } {
  const { records, skipped } = readJsonl(file, isEvent);
  return { events: records, skipped };
}

export class RunStore {
  readonly journal: Journal;
  /** The run-start of the latest earlier execution of this run, or undefined when the run is new. */
  readonly previousStart: RunStartEvent | undefined;
  /** Which files ended in a torn line (a crash mid-append) when the run was opened. */
  readonly tornTail: { events: boolean; journal: boolean };
  private readonly eventsFile: string;
  private readonly releaseLock: () => void;

  private constructor(dir: string, runId: string) {
    mkdirSync(dir, { recursive: true });
    this.releaseLock = acquireLock(dir, runId);
    this.eventsFile = join(dir, EVENTS_FILE);
    try {
      this.journal = new Journal(join(dir, JOURNAL_FILE));
      this.tornTail = { events: hasTornTail(this.eventsFile), journal: hasTornTail(join(dir, JOURNAL_FILE)) };
      this.previousStart = readEventLog(this.eventsFile).events.findLast((e): e is RunStartEvent => e.type === "run-start");
    } catch (err) {
      this.releaseLock();
      throw err;
    }
  }

  /** Opens the state of the run in `dir` (created when new) and locks it. Throws `RunLockedError` when another execution holds it. */
  static open(dir: string, runId: string): RunStore {
    return new RunStore(dir, runId);
  }

  appendEvent(event: WorkflowEvent): void {
    appendJsonl(this.eventsFile, event);
  }

  /** Releases the lock. */
  close(): void {
    this.releaseLock();
  }
}
