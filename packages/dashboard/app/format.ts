// How the dashboard's pages write numbers, costs, durations and dates: the one place that does, for both pages (the Run view,
// `run-view/`, imports it too). Everything is written in en-US whatever the browser's locale, so the same quantity reads the
// same on every page (`test/numbers.test.ts` keeps any other file from formatting a number itself).

const LOCALE = "en-US";
const counts = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const decimals = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });
const percents = new Intl.NumberFormat(LOCALE, { style: "percent", maximumFractionDigits: 1 });

/** `0.4¢`, `3.5¢`, `$12.35`, `$1,234.00`: a cost under a dollar stays in cents. Every page writes costs with it. */
export function formatCents(cents: number): string {
  if (cents < 100) return `${Number(cents.toFixed(2))}¢`;
  return `$${(Math.round(cents) / 100).toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** `453,200`: a whole count, grouped by thousands. */
export const formatCount = (n: number): string => counts.format(n);

/** `1.25`, `18,400`: a measure, with at most two decimals. */
export const formatNumber = (n: number): string => decimals.format(n);

/** `65.2%`: a share (0–1) as a percentage. */
export const formatPercent = (ratio: number): string => percents.format(ratio);

/** `7ms`, `4.2s`, `1m 9s`, `1h 2m`. Every page writes durations with it. */
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

/** The time of day a run started (`14:05`), or the date too when it was not today (`Nov 11, 14:05`). */
export function startedLabel(startedAt: string): string {
  const date = new Date(startedAt);
  const time = date.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString(LOCALE, { month: "short", day: "numeric" })}, ${time}`;
}

/** `Nov 12`: a day of the Metrics charts (`2026-11-12`), read as a calendar day. */
export function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString(LOCALE, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The link to the Run view of a run: the page `/runs/<runId>` (read back by `runIdOf` in `run-view/location.ts`). */
export const runHref = (runId: string): string => `/runs/${encodeURIComponent(runId)}`;
