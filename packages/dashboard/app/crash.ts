// What the pages say when they fail, as plain values: the words, and what a thrown value says. Pure: no DOM, no React. The error boundary
// (ErrorBoundary.tsx, a component) and the plain-DOM fallback for an error no boundary caught (`showCrashIn`) both read it, so the
// two cannot say different things.

export const CRASH_TITLE = "The dashboard hit an error";
export const RELOAD_LABEL = "Reload the page";

/** What a thrown value says, for the page: an Error's message, a string as it is, other JSON as JSON, and a thrown nothing as such. */
export function crashText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  if (error === undefined || error === null) return "an unknown error (nothing was thrown with it)";
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
