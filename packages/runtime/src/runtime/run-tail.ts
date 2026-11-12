// The event log of a run, read by position: what a tool outside the run's process (the dashboard) follows while the run
// appends to it, and what it asks for when it wants one step's content. Nothing here writes, locks or creates a directory.
//
// Every line of the log has an id: its line number, counting from 1. Blank and damaged lines count too, so an id never
// changes while the log grows, nor when the retention pass rewrites the log (it removes the `text` of content events and
// keeps every line). A reader that has seen up to id N resumes with `after: N`.
//
// Events of another schema version, or of a type this code does not know, are passed through untouched (see `isEvent`).
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { ContentEvent, WorkflowEvent } from "./events.js";
import { isContentLine } from "./events.js";
import { isEvent } from "./run-store.js";
import { eventLogOf } from "./run-view.js";

export interface LoggedEvent {
  /** The line number of the event in the log, from 1. */
  id: number;
  event: WorkflowEvent;
}

export interface TailOptions {
  /** Skip every line up to and including this id: the last one the reader has seen. Default 0, the whole log. */
  after?: number;
  /** `false` leaves the `content` events out (the bulk of a log) without parsing them. Default true. */
  content?: boolean;
}

export interface RunTail {
  /**
   * The events appended since the previous call; the first call returns everything after `options.after`. A line that is not
   * complete yet (its newline has not been written) is left for the next call. Empty while the log does not exist.
   */
  poll(): LoggedEvent[];
  /** The id of the last line `poll` has gone through, 0 before the first. */
  readonly lastId: number;
}

/** The offset just past the first `lines` lines of the file, and how many lines it really has up to there. */
function pastLines(file: string, lines: number): { offset: number; line: number } {
  const bytes = readFileSync(file);
  let offset = 0;
  let line = 0;
  while (line < lines) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) break;
    offset = newline + 1;
    line++;
  }
  return { offset, line };
}

class LogTail implements RunTail {
  private offset = 0;
  private line = 0;
  private inode: number | undefined;

  constructor(
    private readonly file: string,
    private readonly after: number,
    private readonly content: boolean,
  ) {}

  get lastId(): number {
    return this.line;
  }

  poll(): LoggedEvent[] {
    let stat;
    try {
      stat = statSync(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    // The retention pass replaces the file (new inode, shorter): the lines are the same, their offsets are not.
    if ((this.inode !== undefined && stat.ino !== this.inode) || stat.size < this.offset) ({ offset: this.offset, line: this.line } = pastLines(this.file, this.line));
    this.inode = stat.ino;
    if (stat.size <= this.offset) return [];

    const chunk = Buffer.alloc(stat.size - this.offset);
    const fd = openSync(this.file, "r");
    let read = 0;
    try {
      while (read < chunk.length) {
        const n = readSync(fd, chunk, read, chunk.length - read, this.offset + read);
        if (n === 0) break;
        read += n;
      }
    } finally {
      closeSync(fd);
    }
    const end = chunk.subarray(0, read).lastIndexOf(0x0a);
    if (end < 0) return []; // not a whole line yet
    this.offset += end + 1;

    const events: LoggedEvent[] = [];
    for (const text of chunk.toString("utf8", 0, end).split("\n")) {
      const id = ++this.line;
      if (id <= this.after || !text.trim()) continue;
      if (!this.content && isContentLine(text)) continue;
      try {
        const event: unknown = JSON.parse(text);
        if (isEvent(event) && (this.content || event.type !== "content")) events.push({ id, event });
      } catch {
        /* a line a crash cut short, or damage: it keeps its id and is not an event */
      }
    }
    return events;
  }
}

/** Follows the event log of run `runId`. Undefined when the runs index has no such run. */
export function tailRun(runId: string, options: TailOptions = {}): RunTail | undefined {
  const file = eventLogOf(runId);
  return file === undefined ? undefined : new LogTail(file, options.after ?? 0, options.content ?? true);
}

/** A `content` event of a step, with its id. */
export type StepContentItem = ContentEvent & { id: number };

export interface StepContent {
  runId: string;
  stepId: string;
  /** The id of the last line of the log when it was read: a stream opened with `after` = this id continues without a gap or a repeat. */
  lastEventId: number;
  /** Every `content` event of the step, in log order: its prompt, what the agent said, its tool calls and their output, or a command's output. Several attempts and executions interleave only by order; `attemptId` tells them apart. A run past its retention keeps the events but not their `text`. */
  content: StepContentItem[];
}

/**
 * The content of one step of a run (an `agent()` call or a `ctx.exec` command), as the log holds it: already redacted when
 * it was written. Undefined when the runs index has no such run, or the log has no event of that step.
 */
export function readStepContent(runId: string, stepId: string): StepContent | undefined {
  const tail = tailRun(runId);
  if (!tail) return undefined;
  const content: StepContentItem[] = [];
  let known = false;
  for (const { id, event } of tail.poll()) {
    if ((event as { stepId?: unknown }).stepId !== stepId) continue;
    known = true;
    if (event.type === "content") content.push({ ...event, id });
  }
  return known ? { runId, stepId, lastEventId: tail.lastId, content } : undefined;
}
