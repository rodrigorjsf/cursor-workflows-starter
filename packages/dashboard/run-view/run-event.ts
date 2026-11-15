// One message of the event stream, read into a `RunEvent` or dropped with a reason. Pure: no DOM, no React, no clock. The stream is text from outside the page: the
// runtime wrote it, and a kit older or newer than this page may have. `run-graph.ts` reads an event defensively (a field it does not
// know is left alone), but only if it is an object with a `type`; a message that is `null`, a number or an array would throw in the
// code that reads `event.type`, and an error there blanks the whole page. So the page asks here first, and drops what fails.
import { isRecord } from "../app/is-record.js";
import type { RunEvent } from "./run-graph.js";

export type ParsedEvent = { ok: true; event: RunEvent } | { ok: false; why: string };

/** `text` (the `data` of a server-sent message) as an event: an object with a string `type`. An event of a newer schema version is one: the graph leaves it opaque. */
export function parseRunEvent(text: string): ParsedEvent {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, why: "not JSON" };
  }
  if (!isRecord(value)) return { ok: false, why: "not an object" };
  if (typeof value.type !== "string") return { ok: false, why: "no string `type`" };
  return { ok: true, event: value as RunEvent };
}
