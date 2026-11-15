// The text of something a browser page caught. The pages take only types from the runtime (`import type`), so they cannot
// use the runtime's `errorText` (packages/runtime/src/runtime/error-text.ts); this is the same line for them. The Run view
// imports it from here, as it does the formatters.

/** The text of something thrown: an Error's message, or the value as a string. */
export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
