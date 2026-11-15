// Where a JSON text becomes a typed value. `JSON.parse` answers `any`, and a cast (`JSON.parse(text) as T`) only tells the
// compiler what the author hopes: a file a crash left half written, a record an older kit wrote, or the output of a forge CLI
// that changed would reach the code as a `T` it is not, and fail further on with a TypeError or a wrong decision. Every
// place the kit reads data it did not just build in memory goes through here instead: the text is checked against a zod
// schema, and a text that fails is an error that names where it came from and the field that is wrong.
// A schema for a record the kit writes and reads back is a `z.looseObject`: a field a newer kit adds is kept as it was,
// so a reader that writes the record again does not drop it (CODING_STANDARDS: the event schema grows additively).
// `test/typescript-strictness.test.ts` fails on a new `JSON.parse(...) as T` in the shipped code.

import type { z } from "zod";
import { errorText } from "./error-text.js";

/** A plain object: not null, not an array. The narrowing for a JSON value whose shape the reader only peeks at. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The most fields of a wrong shape an error names: the first ones say what kind of answer it was. */
const MAX_ISSUES_NAMED = 3;

/** Checks `value` (already parsed) against `schema`. Throws an Error that starts with `source` and names each field that is wrong. */
export function checkShape<S extends z.ZodType>(value: unknown, schema: S, source: string): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const { issues } = result.error;
  const named = issues.slice(0, MAX_ISSUES_NAMED).map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`);
  throw new Error(`${source}: ${named.join("; ")}${issues.length > MAX_ISSUES_NAMED ? `; and ${issues.length - MAX_ISSUES_NAMED} more` : ""}`);
}

/** Parses `text` as JSON and checks it against `schema`. Throws an Error that starts with `source` (a file, or the command that printed `text`). */
export function parseJson<S extends z.ZodType>(text: string, schema: S, source: string): z.output<S> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source}: not valid JSON (${errorText(err)})`);
  }
  return checkShape(value, schema, source);
}

/** `parseJson` for a state file whose reader treats one it cannot use as absent: undefined where `parseJson` throws. */
export function tryParseJson<S extends z.ZodType>(text: string, schema: S): z.output<S> | undefined {
  const result = schema.safeParse(parseOrUndefined(text));
  return result.success ? result.data : undefined;
}

function parseOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
