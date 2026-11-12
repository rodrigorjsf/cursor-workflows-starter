// The durable state of one run, behind one door: the append-only event log (the run's source of truth), the journal and
// the run lock.
//
// Layout, under `<cwd>/.workflows/runs/<runId>/`:
//   events.jsonl   every event of every execution of the run, one JSON object per line
//   journal.jsonl  the results of the finished steps, for resume
//   run.lock       present while a process executes the run: who holds it
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EVENT_SCHEMA_VERSION, type RunStartEvent, type WorkflowEvent } from "./events.js";
import { Journal } from "./journal.js";
import { type Ledger, replayLedger } from "./projection.js";
import { type Redactor, createRedactor } from "./redaction.js";
import { type RetentionPolicy, pruneContent } from "./retention.js";
import { stateDir } from "./state.js";
import { appendJsonl, hasTornTail, readJsonl } from "./state-files.js";

export const EVENTS_FILE = "events.jsonl";
export const JOURNAL_FILE = "journal.jsonl";
export const LOCK_FILE = "run.lock";
/** The longest content text a log event keeps. A transcript is not a log line: the rest is cut and `truncated` says so. */
export const CONTENT_MAX_CHARS = 32_768;

/** Another process (or another execution in this one) is already executing the run. */
export class RunLockedError extends Error {}

interface LockContent {
  pid: number;
  token: string;
  startedAt: string;
  /** Who the pid was when it took the lock (see `processIdentity`). Absent where the platform cannot tell. */
  identity?: string;
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

/**
 * What makes a pid this process and not another one that got the same number later: the boot id plus the process start
 * time (Linux). A lock left by a crash or a reboot can name a pid that now belongs to an unrelated process; without
 * this the run would stay locked for as long as that process lives. Undefined where /proc is not available.
 */
export function processIdentity(pid: number): string | undefined {
  try {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // after "pid (comm) ": field 3 (state) comes first
    return fields[19] ? `${boot}:${fields[19]}` : undefined; // field 22: start time, in ticks since boot
  } catch {
    return undefined;
  }
}

/** Is the process that wrote this lock still the one executing the run? */
function isHeld(holder: LockContent, file: string): boolean {
  if (!isAlive(holder.pid)) return false;
  if (holder.pid === process.pid && !heldLocks.has(file)) return false; // our own pid, but not a lock this process took
  const now = holder.identity ? processIdentity(holder.pid) : undefined;
  return now === undefined || now === holder.identity; // unknown identity: assume it is the same process
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
 * Known limit: two processes that find the same stale lock at the same instant can both take it over. Where the
 * platform cannot tell a recycled pid from the original process (no /proc), a leftover lock whose pid is alive again
 * keeps the run locked until that process ends or the lock file is deleted (the refusal message says so).
 */
function acquireLock(dir: string, runId: string): () => void {
  const file = join(dir, LOCK_FILE);
  const content: LockContent = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString(), identity: processIdentity(process.pid) };
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
      if (holder && isHeld(holder, file)) {
        throw new RunLockedError(
          `já está em execução: o run ${runId} pertence ao processo ${holder.pid} (desde ${holder.startedAt}); espere terminar, ou apague ${file} se esse processo não existe mais`,
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

/** True for a `content` line, by its serialized form: `"type":"content"` cannot occur inside a JSON string (quotes are escaped there). */
const isContentLine = (line: string) => line.includes('"type":"content"');

/**
 * Reads an event log. A torn last line, or any line that is not an event, is skipped and counted. `content: false` leaves
 * the `content` events out without parsing them: they are the bulk of a log, and status, projection and the budget
 * ledger never need them.
 */
export function readEventLog(file: string, options: { content?: boolean } = {}): { events: WorkflowEvent[]; skipped: number } {
  const { records, skipped } = readJsonl(file, isEvent, options.content === false ? isContentLine : undefined);
  return { events: records, skipped };
}

/** Stores that are open in this process. A crash handler uses it to end their runs. */
const openStores = new Set<RunStore>();

/**
 * Ends every run this process is executing, in its event log: a `run-end` with status `failed` and this error. For a
 * crash handler (`uncaughtException`): the process is about to exit, and the log must say why, since a job's state is read
 * from it. A run that already wrote its `run-end` is left as it is.
 */
export function abortOpenRuns(error: (runId: string) => string): void {
  for (const store of [...openStores]) store.abort(error(store.runId));
}

export interface RunStoreOptions {
  /** Secrets to keep out of the log that are not in the environment: the API key handed to the run. */
  secrets?: ReadonlyArray<string | undefined>;
}

export class RunStore {
  readonly journal: Journal;
  /** The run-start of the latest earlier execution of this run, or undefined when the run is new. */
  readonly previousStart: RunStartEvent | undefined;
  /**
   * What the run has spent so far, replayed from its event log when the store was opened: every execution before this one,
   * failed attempts included. The budget starts from here, so a resume never starts from zero.
   */
  readonly ledger: Ledger;
  /** Which files ended in a torn line (a crash mid-append) when the run was opened. */
  readonly tornTail: { events: boolean; journal: boolean };
  private readonly dir: string;
  private readonly eventsFile: string;
  readonly runId: string;
  private readonly redactor: Redactor;
  private readonly releaseLock: () => void;
  private ended = false;

  private constructor(dir: string, runId: string, options: RunStoreOptions) {
    mkdirSync(dir, { recursive: true });
    this.releaseLock = acquireLock(dir, runId);
    this.dir = dir;
    this.runId = runId;
    this.redactor = createRedactor({ extra: options.secrets });
    this.eventsFile = join(dir, EVENTS_FILE);
    try {
      this.journal = new Journal(join(dir, JOURNAL_FILE));
      this.tornTail = { events: hasTornTail(this.eventsFile), journal: hasTornTail(join(dir, JOURNAL_FILE)) };
      const { events } = readEventLog(this.eventsFile, { content: false });
      this.previousStart = events.findLast((e): e is RunStartEvent => e.type === "run-start");
      this.ledger = replayLedger(events);
    } catch (err) {
      this.releaseLock();
      throw err;
    }
    openStores.add(this);
  }

  /** Opens the state of the run in `dir` (created when new) and locks it. Throws `RunLockedError` when another execution holds it. */
  static open(dir: string, runId: string, options: RunStoreOptions = {}): RunStore {
    return new RunStore(dir, runId, options);
  }

  /**
   * The event with every secret in it replaced (see redaction.ts). Every event goes through this before it is written or
   * delivered to anyone: the log, the metrics recorder and the listeners all get the redacted one.
   */
  redact<E extends WorkflowEvent>(event: E): E {
    return this.redactor.value(event);
  }

  appendEvent(event: WorkflowEvent): void {
    appendJsonl(this.eventsFile, event);
    if (event.type === "run-end") this.ended = true;
  }

  /** Writes the failed `run-end` of an execution that cannot finish (see `abortOpenRuns`). Never throws. */
  abort(error: string): void {
    if (this.ended) return;
    try {
      this.appendEvent(this.redact({ v: EVENT_SCHEMA_VERSION, ts: new Date().toISOString(), runId: this.runId, type: "run-end", status: "failed", error }));
    } catch {
      /* the process is going down and the disk refused: nothing else to do */
    }
  }

  /**
   * Content ready to be written to the log: secrets replaced first, then cut at `CONTENT_MAX_CHARS` (the other way round
   * could cut a secret in half and leave its start behind). `chars` is the size before the cut.
   */
  prepareContent(raw: string): { text: string; chars: number; truncated: boolean } {
    const clean = this.redactor.text(raw);
    const truncated = clean.length > CONTENT_MAX_CHARS;
    return { text: truncated ? clean.slice(0, CONTENT_MAX_CHARS) : clean, chars: clean.length, truncated };
  }

  /**
   * Prunes the content of the repo's other runs that fall outside `policy` (see retention.ts). Call it when the run starts.
   * A run another process is executing is skipped. Never throws.
   */
  pruneOldContent(policy?: RetentionPolicy): ReturnType<typeof pruneContent> {
    return pruneContent({
      runsDir: dirname(this.dir),
      logFile: EVENTS_FILE,
      current: this.runId,
      policy,
      tryLock: (dir, runId) => {
        try {
          return acquireLock(dir, runId);
        } catch (err) {
          if (err instanceof RunLockedError) return undefined;
          throw err;
        }
      },
    });
  }

  /** Releases the lock. */
  close(): void {
    openStores.delete(this);
    this.releaseLock();
  }
}
