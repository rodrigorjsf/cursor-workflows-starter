// How the views write numbers and durations.

/** Cents as the Board shows a run's cost: `0.4¢`, `12¢`, `$1.24`. */
export function money(cents: number): string {
  if (cents >= 100) return `$${(cents / 100).toFixed(2)}`;
  return `${cents >= 10 ? Math.round(cents) : Math.round(cents * 10) / 10}¢`;
}

/** A length of time: `42s`, `3m 05s`, `1h 02m`. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** How long a run has taken: up to its end, or up to now while it runs. */
export function runDuration(startedAt: string, finishedAt?: string): string {
  return duration((finishedAt ? Date.parse(finishedAt) : Date.now()) - Date.parse(startedAt));
}

/** The last folder of a repo's path. */
export const repoName = (repo: string): string => repo.split(/[\\/]/).filter(Boolean).at(-1) ?? repo;

/** The time of day a run started, or the date when it was not today. */
export function startedLabel(startedAt: string): string {
  const date = new Date(startedAt);
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : date.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

/** The link to the Run view of a run: the page `/runs/<runId>` (read back by `runIdOf` in `src/ui/location.ts`). */
export const runHref = (runId: string): string => `/runs/${encodeURIComponent(runId)}`;
