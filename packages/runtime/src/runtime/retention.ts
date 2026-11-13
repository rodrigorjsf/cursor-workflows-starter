// How long the content of a run stays in its event log. The content (prompts, agent messages, tool calls, command output)
// is the part of the log that can hold private data and that grows without bound, so it is kept for a while and then pruned:
// the `text` of every `content` event is removed from the logs of runs that fall outside the retention. Everything else in
// the log stays, so the history of runs (what ran, how long, what it cost) is never lost.
//
// Pruning runs when a run starts, for the other runs of the same repo.
//
// A job's log (`.workflows/jobs/<jobId>.log`) needs no pruning: it is the job process's stdout and stderr, and `wf run`
// copies there only what reaches `onEvent`. Content events never do (the engine appends them to the event log alone), so
// a job log holds the run's other events, which the event log keeps too. `test/job-log-content.process.test.ts` pins it.

import { readFileSync, readdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { isContentLine } from "./events.js";
import { writeFileAtomic } from "./state-files.js";

/** What to keep. A limit left out takes the default; `null` turns that limit off. */
export interface RetentionPolicy {
  /** Keep the content of this many of the repo's most recent runs, counting the run that is starting. */
  runs?: number | null;
  /** Keep the content of runs whose last activity was at most this many days ago. */
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
      const event = JSON.parse(line) as { type?: string; text?: unknown };
      if (event.type !== "content" || event.text === undefined) return line;
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
 * Prunes the content of the runs of `runsDir` that are outside `policy`, except `current` (the run that is starting) and
 * any run another process is executing. A run is outside the retention when more recent runs fill it up (`runs`) or when its
 * last activity (the modification time of its log) is older than `days`. A pruned log keeps its modification time, so it
 * does not look fresh afterwards and is not rewritten again. `tryLock` takes a run's lock, or returns undefined when
 * another process holds it. Never throws: what could not be pruned is returned as `failed`.
 */
export function pruneContent(options: {
  runsDir: string;
  /** The name of the event log inside a run's directory. */
  logFile: string;
  current: string;
  policy?: RetentionPolicy;
  now?: number;
  tryLock: (runDir: string, runId: string) => (() => void) | undefined;
}): { pruned: string[]; failed: Array<{ runId: string; error: string }> } {
  const { runsDir, logFile, current, tryLock } = options;
  const maxRuns = options.policy?.runs === undefined ? DEFAULT_RETENTION.runs : options.policy.runs;
  const maxDays = options.policy?.days === undefined ? DEFAULT_RETENTION.days : options.policy.days;
  const now = options.now ?? Date.now();
  const result = { pruned: [] as string[], failed: [] as Array<{ runId: string; error: string }> };
  if (maxRuns === null && maxDays === null) return result;

  let others: Array<{ runId: string; mtimeMs: number; atimeMs: number }>;
  try {
    others = readdirSync(runsDir)
      .filter((runId) => runId !== current)
      .flatMap((runId) => {
        try {
          const { mtimeMs, atimeMs } = statSync(join(runsDir, runId, logFile));
          return [{ runId, mtimeMs, atimeMs }];
        } catch {
          return []; // not a run directory, or a run with no log
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return result;
  }

  others.forEach(({ runId, mtimeMs, atimeMs }, index) => {
    const rank = index + 1; // the current run is the most recent one
    const tooMany = maxRuns !== null && rank >= maxRuns;
    const tooOld = maxDays !== null && now - mtimeMs > maxDays * DAY_MS;
    if (!tooMany && !tooOld) return;
    const dir = join(runsDir, runId);
    const file = join(dir, logFile);
    let release: (() => void) | undefined;
    try {
      release = tryLock(dir, runId);
      if (!release) return; // another process is executing this run: its log is not ours to rewrite
      const pruned = withoutContentText(readFileSync(file, "utf8"));
      if (pruned === undefined) return;
      writeFileAtomic(file, pruned);
      utimesSync(file, atimeMs / 1000, mtimeMs / 1000);
      result.pruned.push(runId);
    } catch (err) {
      result.failed.push({ runId, error: err instanceof Error ? err.message : String(err) });
    } finally {
      release?.();
    }
  });
  return result;
}
