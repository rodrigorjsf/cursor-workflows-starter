// What a run keeps of its private data, and for how long. A run holds three kinds of it: the content of its steps (prompts, agent
// messages, tool calls, command output) in the event log, the result of each step in the journal and in the memo. All three are
// private source code, they grow without bound, and none of them is run history, so each is kept for a while and then pruned:
//
// - the `text` of every `content` event is removed from the event log of a run that falls outside the retention;
// - the `result` of every line of that run's journal is removed too, and each line is marked `pruned` (journal.ts). Everything
//   else in the log and in the journal stays, so the history of runs (what ran, how long, what it cost) is never lost. A pruned
//   journal can no longer serve a resume, so the run is refused when someone resumes it (`RunPrunedError`, run-store.ts);
// - a memo entry (`<repo>/.workflows/memo/<key>.json`, one step's result for one state of the repository) older than `days` is
//   deleted. The memo belongs to the repo, not to a run, so the `runs` limit does not apply to it.
//
// A run is outside the retention when more recent runs fill it up (`runs`) or when its last activity is older than `days`.
// Pruning runs when a run starts, for the other runs of the same repo.
//
// A job's log (`.workflows/jobs/<jobId>.log`) needs no pruning: it is the job process's stdout and stderr, and `wf run`
// copies there only what reaches `onEvent`. Content events never do (the engine appends them to the event log alone), so
// a job log holds the run's other events, which the event log keeps too. `test/job-log-content.process.test.ts` pins it.

import { readFileSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { isContentLine } from "./events.js";
import { withoutResults } from "./journal.js";
import { isRecord } from "./parse-json.js";
import { writeFileAtomic } from "./state-files.js";

/** What to keep. A limit left out takes the default; `null` turns that limit off. */
export interface RetentionPolicy {
  /** Keep the content and the journal results of this many of the repo's most recent runs, counting the run that is starting. */
  runs?: number | null;
  /** Keep the content and the journal results of runs whose last activity was at most this many days ago, and the memo entries written at most this many days ago. */
  days?: number | null;
}

/** Content is kept for the last 30 runs of a repo, and for no longer than 14 days. A run outside either limit is pruned. */
export const DEFAULT_RETENTION = { runs: 30, days: 14 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The log text with the `text` of every content event removed, or undefined when there was nothing to remove. Other lines stay byte for byte. */
function withoutContentText(log: string): string | undefined {
  let changed = false;
  const lines = log.split("\n").map((line) => {
    if (!isContentLine(line)) return line;
    try {
      const event: unknown = JSON.parse(line);
      if (!isRecord(event) || event.type !== "content" || event.text === undefined) return line;
      delete event.text;
      changed = true;
      return JSON.stringify(event);
    } catch {
      return line; // a torn line: not ours to repair here
    }
  });
  return changed ? lines.join("\n") : undefined;
}

/**
 * Rewrites `file` as `prune` makes it, when `prune` changes anything. The file keeps its modification time, so it does not look
 * fresh afterwards and is not rewritten again. A file that is not there has nothing to prune. Returns whether it was rewritten.
 */
function rewritePruned(file: string, prune: (text: string) => string | undefined): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  const pruned = prune(text);
  if (pruned === undefined) return false;
  const { atimeMs, mtimeMs } = statSync(file);
  writeFileAtomic(file, pruned);
  utimesSync(file, atimeMs / 1000, mtimeMs / 1000);
  return true;
}

/**
 * Prunes the runs of `runsDir` that are outside `policy`, except `current` (the run that is starting) and any run another
 * process is executing: the `text` of the content events of their event logs, and the results of their journals. A run is
 * outside the retention when more recent runs fill it up (`runs`) or when its last activity (the modification time of its event
 * log) is older than `days`. A pruned file keeps its modification time. `tryLock` takes a run's lock, or returns undefined when
 * another process holds it. Never throws: what could not be pruned is returned as `failed`.
 */
export function pruneRuns(options: {
  runsDir: string;
  /** The name of the event log inside a run's directory. */
  logFile: string;
  /** The name of the journal inside a run's directory. */
  journalFile: string;
  current: string;
  policy?: RetentionPolicy;
  now?: number;
  tryLock: (runDir: string, runId: string) => (() => void) | undefined;
}): { pruned: string[]; failed: Array<{ runId: string; error: string }> } {
  const { runsDir, logFile, journalFile, current, tryLock } = options;
  const maxRuns = options.policy?.runs === undefined ? DEFAULT_RETENTION.runs : options.policy.runs;
  const maxDays = options.policy?.days === undefined ? DEFAULT_RETENTION.days : options.policy.days;
  const now = options.now ?? Date.now();
  const result = { pruned: [] as string[], failed: [] as Array<{ runId: string; error: string }> };
  if (maxRuns === null && maxDays === null) return result;

  let others: Array<{ runId: string; mtimeMs: number }>;
  try {
    others = readdirSync(runsDir)
      .filter((runId) => runId !== current)
      .flatMap((runId) => {
        try {
          return [{ runId, mtimeMs: statSync(join(runsDir, runId, logFile)).mtimeMs }];
        } catch {
          return []; // not a run directory, or a run with no log
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return result;
  }

  others.forEach(({ runId, mtimeMs }, index) => {
    const rank = index + 1; // the current run is the most recent one
    const tooMany = maxRuns !== null && rank >= maxRuns;
    const tooOld = maxDays !== null && now - mtimeMs > maxDays * DAY_MS;
    if (!tooMany && !tooOld) return;
    const dir = join(runsDir, runId);
    let release: (() => void) | undefined;
    try {
      release = tryLock(dir, runId);
      if (!release) return; // another process is executing this run: its files are not ours to rewrite
      const logPruned = rewritePruned(join(dir, logFile), withoutContentText);
      const journalPruned = rewritePruned(join(dir, journalFile), withoutResults);
      if (logPruned || journalPruned) result.pruned.push(runId);
    } catch (err) {
      result.failed.push({ runId, error: err instanceof Error ? err.message : String(err) });
    } finally {
      release?.();
    }
  });
  return result;
}

/**
 * Deletes the memo entries of `memoDir` (`<key>.json`, written by `MemoStore`) whose last write is older than `policy.days`. The
 * memo belongs to the repo and not to a run, so only the days limit applies, and `null` keeps every entry. A file that is not an
 * entry (the temporary file of a write in progress) is left. Never throws: what could not be deleted is returned as `failed`.
 */
export function pruneMemo(options: { memoDir: string; policy?: RetentionPolicy; now?: number }): { pruned: string[]; failed: Array<{ key: string; error: string }> } {
  const maxDays = options.policy?.days === undefined ? DEFAULT_RETENTION.days : options.policy.days;
  const now = options.now ?? Date.now();
  const result = { pruned: [] as string[], failed: [] as Array<{ key: string; error: string }> };
  if (maxDays === null) return result;

  let names: string[];
  try {
    names = readdirSync(options.memoDir).filter((name) => name.endsWith(".json") && !name.startsWith("."));
  } catch {
    return result; // no memo yet
  }
  for (const name of names) {
    const key = name.slice(0, -".json".length);
    try {
      if (now - statSync(join(options.memoDir, name)).mtimeMs <= maxDays * DAY_MS) continue;
      rmSync(join(options.memoDir, name), { force: true });
      result.pruned.push(key);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // another process deleted it first
      result.failed.push({ key, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
