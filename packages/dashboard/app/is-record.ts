// The narrowing every browser page uses for a JSON value whose shape it checks field by field. The pages take only types from
// the runtime, so they cannot import its `isRecord` (packages/runtime/src/runtime/parse-json.ts); this is the same test for them.

/** A plain object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
