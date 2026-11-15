// The text of something a browser page caught. The pages take only types from the runtime (`import type`), so they cannot
// use the runtime's `errorText` (packages/runtime/src/runtime/error-text.ts); this is the same line for them. The Run view
// imports it from here, as it does the formatters, and the error boundary (ErrorBoundary.tsx) shows a crash with it.

/** The text of something thrown: an Error's message, a string as it is, other JSON as JSON, and a thrown nothing as such. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  if (err === undefined || err === null) return "an unknown error (nothing was thrown with it)";
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}
