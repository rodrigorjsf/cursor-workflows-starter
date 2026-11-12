// How the runtime touches its state files, so a crash never leaves one unreadable.
//
// - Whole-file state (job records, memo entries, workflow progress) is replaced atomically: written to a temp file next
//   to the target, then renamed over it. A reader sees the old content or the new content, never half of it.
// - Append-only state (the event log, the journal, the global runs index) is JSON Lines. A crash mid-append can leave a
//   torn last line. Readers skip any line that is not a valid record, and the next append starts on a fresh line.

import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Writes `data` to `file` atomically (temp file + rename in the same directory). The directory must exist. */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Appends one record as one line. A torn last line (no trailing newline) is closed first, so the record stays parseable. */
export function appendJsonl(file: string, record: unknown): void {
  const line = `${JSON.stringify(record)}\n`;
  const fd = openSync(file, "a+");
  try {
    const { size } = fstatSync(fd);
    let prefix = "";
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = "\n";
    }
    writeSync(fd, prefix + line); // one write: a record is never interleaved with another process's append
  } finally {
    closeSync(fd);
  }
}

/** True when the file ends in an unterminated line that is not valid JSON: the sign of a crash in the middle of an append. */
export function hasTornTail(file: string): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  if (!text || text.endsWith("\n")) return false;
  try {
    JSON.parse(text.slice(text.lastIndexOf("\n") + 1));
    return false;
  } catch {
    return true;
  }
}

export interface JsonlRead<T> {
  records: T[];
  /** Lines that were not a valid record: a torn last line after a crash, or damage elsewhere in the file. */
  skipped: number;
}

/** Reads a JSON Lines file, skipping blank lines and anything that does not parse or fails `isRecord`. A missing file is empty. */
export function readJsonl<T>(file: string, isRecord: (value: unknown) => value is T): JsonlRead<T> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { records: [], skipped: 0 };
    throw err;
  }
  const records: T[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) records.push(value);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}
