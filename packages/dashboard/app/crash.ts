// What the pages say when they fail, as plain values: the words (what a thrown value says is `errorText`). Pure: no DOM, no React. The error boundary
// (ErrorBoundary.tsx, a component) and the plain-DOM fallback for an error no boundary caught (`showCrashIn`) both read it, so the
// two cannot say different things.

export const CRASH_TITLE = "The dashboard hit an error";
export const RELOAD_LABEL = "Reload the page";
