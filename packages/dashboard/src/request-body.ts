// What the dashboard's POST actions that take a body share: the body is a JSON object, and anything else is refused with a sentence. Pure:
// the request has been read (server.ts) and nothing here touches the runtime, a clock or a disk.
import { errorText } from "@cursor-workflows/runtime/observe";

/** Whether `value` is a JSON object: not `null`, not a list. */
export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export type JsonObject = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

/** The JSON object `raw` (the text received) holds, or the sentence that says why it is none: `shape` says what the body must be, for a body that is empty or is not an object. */
export function jsonObjectOf(raw: string, shape: string): JsonObject {
  if (raw.trim() === "") return { ok: false, error: shape };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `the request body is not valid JSON: ${errorText(err)}` };
  }
  return isObject(body) ? { ok: true, body } : { ok: false, error: shape };
}
