// The durable state of one run, behind one door: the append-only event log (the run's source of truth), the journal and
// the run lock.
//
// Layout, under `<cwd>/.workflows/runs/<runId>/`:
//   events.jsonl   every event of every execution of the run, one JSON object per line
//   journal.jsonl  the results of the finished steps, for resume
//   run.lock       present while a process executes the run: who holds it
//
// Under `<cwd>/.workflows/locks/<name>.lock` live the repo-wide named locks a run can hold (`acquireNamedLock`): the
// same kind of lock as `run.lock`, but on a resource the run works on (an issue) instead of on the run itself.
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EVENT_SCHEMA_VERSION, type RunStartEvent, type RunStatus, type WorkflowEvent, isContentLine } from "./events.js";
import { Journal } from "./journal.js";
import { isAlive } from "./pid.js";
import { type InterruptedCloudStep, type Ledger, interruptedCloudSteps, replayLedger } from "./projection.js";
import { type Redactor, createRedactor } from "./redaction.js";
import { type RetentionPolicy, pruneContent } from "./retention.js";
import { plainName, stateDir } from "./state.js";
import { appendJsonl, hasTornTail, readJsonl } from "./state-files.js";

export const EVENTS_FILE = "events.jsonl";
export const JOURNAL_FILE = "journal.jsonl";
export const LOCK_FILE = "run.lock";
/** The longest content text a log event keeps. A transcript is not a log line: the rest is cut and `truncated` says so. */
export const CONTENT_MAX_CHARS = 32_768;

/** Another process (or another execution in this one) is already executing the run. */
export class RunLockedError extends Error {}

/** Another run holds the named lock (`acquireNamedLock`). `holderRunId` is that run's id; absent for a lock written without one. */
export class NamedLockedError extends Error {
  constructor(
    message: string,
    readonly holderRunId: string | undefined,
  ) {
    super(message);
  }
}

interface LockContent {
  pid: number;
  token: string;
  startedAt: string;
  /** The run that holds the lock. */
  runId?: string;
  /** Who the pid was when it took the lock (see `processIdentity`). Absent where the platform cannot tell. */
  identity?: string;
}

/**
 * Locks held by this process, by lock file, with the function that releases each. Tells our own live lock from one left
 * by an earlier process that had the same pid, and lets a process that exits without closing its stores release them.
 */
const heldLocks = new Map<string, () => void>();
let exitHookInstalled = false;

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
 * Takes the lock file `file` for run `runId`, or throws what `refuse` makes of the holder. The lock file is created complete
 * and atomically (written aside, then hard-linked into place: `link` fails when the target exists), so nobody ever reads
 * a half-written lock. A lock whose process is gone is stale and is taken over. Returns the release function.
 *
 * Known limit: two processes that find the same stale lock at the same instant can both take it over. Where the
 * platform cannot tell a recycled pid from the original process (no /proc), a leftover lock whose pid is alive again
 * keeps the run locked until that process ends or the lock file is deleted (the refusal message says so).
 */
function takeLock(file: string, runId: string, refuse: (holder: LockContent | undefined) => Error): () => void {
  const content: LockContent = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString(), runId, identity: processIdentity(process.pid) };
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
      if (holder && isHeld(holder, file)) throw refuse(holder);
      rmSync(file, { force: true }); // stale (dead holder) or unreadable: take it over
    }
    throw refuse(undefined);
  } finally {
    rmSync(aside, { force: true });
  }
}

/** Takes the lock of the run in `dir`, or throws `RunLockedError` naming the holder. Returns the release function. */
function acquireLock(dir: string, runId: string): () => void {
  const file = join(dir, LOCK_FILE);
  return takeLock(file, runId, (holder) =>
    new RunLockedError(
      holder
        ? `already running: run ${runId} belongs to process ${holder.pid} (since ${holder.startedAt}); wait for it to end, or delete ${file} if that process no longer exists`
        : `already running: another process claimed run ${runId} at the same time`,
    ),
  );
}

/** The pid of the live process executing run `runId` of the repo `cwd`, or undefined when none holds its lock. Only reads: it neither creates the run's directory nor takes its lock. */
export function runLockHolder(cwd: string, runId: string): number | undefined {
  const file = join(runDirIn(cwd, runId), LOCK_FILE);
  const holder = readLock(file);
  return holder !== undefined && isHeld(holder, file) ? holder.pid : undefined;
}

/** Is a live process executing run `runId` of the repo `cwd`? Only reads: it neither creates the run's directory nor takes its lock. */
export function isRunExecuting(cwd: string, runId: string): boolean {
  return runLockHolder(cwd, runId) !== undefined;
}

/**
 * Takes the lock of run `runId` of the repo `cwd`, or returns undefined when a process is executing it. For work on a run's
 * leftovers (`wf gc`) that must not overlap an execution: while it holds the lock, a resume of the run is refused. Returns the
 * release function.
 */
export function tryAcquireRunLock(cwd: string, runId: string): (() => void) | undefined {
  try {
    return acquireLock(runDirPath(cwd, runId), runId);
  } catch (err) {
    if (err instanceof RunLockedError) return undefined;
    throw err;
  }
}

/**
 * Takes the repo-wide lock `name` for run `runId`, or throws `NamedLockedError` naming the run that holds it. It is how a
 * workflow keeps two runs from working on the same thing at once (`implement-issue` locks `issue-<n>`). Held until the
 * returned function is called or the process ends; the lock of a process that died is stale and is taken over.
 */
export function acquireNamedLock(cwd: string, name: string, runId: string): () => void {
  plainName(name, "lock name"); // it becomes a file name
  const file = join(stateDir(cwd, "locks"), `${name}.lock`);
  return takeLock(file, runId, (holder) =>
    new NamedLockedError(
      holder
        ? `${name} already has an active run: ${holder.runId ?? "unknown"} (process ${holder.pid}, since ${holder.startedAt}); wait for it to end, or delete ${file} if that process no longer exists`
        : `${name} was claimed by another run at the same time`,
      holder?.runId,
    ),
  );
}

/** Where the runs' state is in the target repo (one directory per run), whether or not it exists: nothing is created. */
export function runsDirIn(cwd: string): string {
  return join(cwd, ".workflows", "runs");
}

/** Where a run's state is in the target repo, whether or not it exists: nothing is created. */
export function runDirIn(cwd: string, runId: string): string {
  return join(runsDirIn(cwd), runId);
}

/** Directory of a run's state in the target repo; makes `.workflows/runs/` if it is not there. */
export function runDirPath(cwd: string, runId: string): string {
  stateDir(cwd, "runs");
  return runDirIn(cwd, runId);
}

export function eventLogPath(cwd: string, runId: string): string {
  return join(runDirPath(cwd, runId), EVENTS_FILE);
}

/** A log line is an event when it is an object with a string `type`. Nothing else is required: an event of another schema version, or of a type this code does not know, is still one (readers treat it as opaque). */
export const isEvent = (v: unknown): v is WorkflowEvent =>
  typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

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
 * Ends every run this process is executing, in its event log: a `run-end` with this status (`failed` by default) and this
 * error. For a crash handler (`uncaughtException`) and for a second SIGINT/SIGTERM: the process is about to exit, and the
 * log must say why, since a job's state is read from it. A run that already wrote its `run-end` is left as it is.
 */
export function abortOpenRuns(error: (runId: string) => string, status: Exclude<RunStatus, "finished"> = "failed"): void {
  for (const store of [...openStores]) store.abort(error(store.runId), status);
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
  /**
   * The cloud steps an earlier execution left without an end, by `stepId`, replayed from the event log when the store was
   * opened. A resume reattaches to their agents instead of creating new ones, unless an agent's newest run was cancelled
   * (a cancel of the run, whatever state its job was in): then it starts a new agent.
   */
  readonly interruptedCloud: ReadonlyMap<string, InterruptedCloudStep>;
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
      this.interruptedCloud = interruptedCloudSteps(events);
    } catch (err) {
      this.releaseLock();
      throw err;
    }
    openStores.add(this);
  }

  /**
   * Opens the state of the run in `dir` (created when new) and locks it. Throws `RunLockedError` when another execution holds
   * it, and an `invalid runId` error, before anything is created, when the run id is not a plain name (`isPlainName`): a run
   * id to resume comes from the chat or the command line, and the run's folder is named after it.
   */
  static open(dir: string, runId: string, options: RunStoreOptions = {}): RunStore {
    return new RunStore(dir, plainName(runId, "runId"), options);
  }

  /**
   * The event with every secret in it replaced (see redaction.ts). Every event goes through this before it is written or
   * delivered to anyone: the log, the metrics recorder and the listeners all get the redacted one.
   */
  redact<E extends WorkflowEvent>(event: E): E {
    return this.redactor.value(event);
  }

  /**
   * A step result with every secret in it replaced, the same way as an event's. A result goes through this before it is stored
   * (journal, memo) and before the workflow gets it, so a resume replays exactly what the first execution saw.
   */
  redactResult<T>(result: T): T {
    return this.redactor.value(result);
  }

  /** Redacts, from now on, the values of the secret-named variables of `env` too: the environment a command is about to run with. */
  learnSecrets(env: Record<string, string | undefined>): void {
    this.redactor.learn(env);
  }

  appendEvent(event: WorkflowEvent): void {
    appendJsonl(this.eventsFile, event);
    if (event.type === "run-end") this.ended = true;
  }

  /** Writes the `run-end` of an execution that cannot finish (see `abortOpenRuns`). Never throws. */
  abort(error: string, status: Exclude<RunStatus, "finished"> = "failed"): void {
    if (this.ended) return;
    try {
      this.appendEvent(this.redact({ v: EVENT_SCHEMA_VERSION, ts: new Date().toISOString(), runId: this.runId, type: "run-end", status, error }));
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
