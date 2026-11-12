// How the dashboard's pages write numbers and durations. The Run view (`run-view/`) uses it too.

/** `0.4¢`, `3.5¢`, `$12.35`: a cost under a dollar stays in cents. The Board, the Runs table and the Run view all write costs with it. */
export function formatCents(cents: number): string {
  return cents < 100 ? `${Number(cents.toFixed(2))}¢` : `$${(Math.round(cents) / 100).toFixed(2)}`;
}

/** `7ms`, `4.2s`, `1m 9s`, `1h 2m`. The Board, the Runs table and the Run view all write durations with it. */
export function formatDuration(ms: number): string {
  ms = Math.max(0, ms);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (ms < 3_600_000) return `${minutes}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** How long a run has taken: up to its end, or up to now while it runs. */
export function runDuration(startedAt: string, finishedAt?: string): string {
  return formatDuration((finishedAt ? Date.parse(finishedAt) : Date.now()) - Date.parse(startedAt));
}

/** The last folder of a repo's path. */
export const repoName = (repo: string): string => repo.split(/[\\/]/).filter(Boolean).at(-1) ?? repo;

/** The time of day a run started, or the date when it was not today. */
export function startedLabel(startedAt: string): string {
  const date = new Date(startedAt);
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : date.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

/** The link to the Run view of a run: the page `/runs/<runId>` (read back by `runIdOf` in `run-view/location.ts`). */
export const runHref = (runId: string): string => `/runs/${encodeURIComponent(runId)}`;
