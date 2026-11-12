/** The text of something thrown: an Error's message, or the value as a string. */
export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
