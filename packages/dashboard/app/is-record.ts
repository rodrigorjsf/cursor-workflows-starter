// The narrowings every browser page uses for a JSON value whose shape it checks field by field. The pages take only types from
// the runtime, so they cannot import its `isRecord` (packages/runtime/src/runtime/parse-json.ts); these are the same tests for them.

/** A plain object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A list of strings, and nothing else. */
export function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
