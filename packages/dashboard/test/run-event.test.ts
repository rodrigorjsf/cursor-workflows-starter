// Seam: the run's event stream as the Run view reads it. The stream is text from outside the page (the runtime wrote it, an older or
// newer kit may have), so each message is parsed through `parseRunEvent`, and what the page then does with the events it kept
// (`buildRunGraph`, `argsHashOf`) is called on them directly, with nothing stubbed. A message that is not an event is dropped,
// with the reason for the console; it never reaches the code that reads events, where it would throw and blank the page.
import assert from "node:assert/strict";
import { test } from "node:test";
import { argsHashOf } from "../run-view/resume-command.js";
import { buildRunGraph } from "../run-view/run-graph.js";
import { type RunEvent } from "../run-view/run-graph.js";
import { parseRunEvent } from "../run-view/run-event.js";

/** What a malformed stream can hold: JSON that is not an event, and text that is not JSON. */
const MALFORMED = ["null", "42", '"text"', "true", "[]", "[1,2]", "{}", '{"type": 7}', '{"type": null}', '{"v": 1}', "not json", "", "{", '{"type":'];

test("a message that is not an event is dropped with a reason, whatever it holds", () => {
  for (const text of MALFORMED) {
    const parsed = parseRunEvent(text);
    assert.equal(parsed.ok, false, `kept: ${text}`);
    assert.ok(!parsed.ok && parsed.why.length > 0);
  }
});

test("an object with a string type is an event, and one of a newer schema version is kept for the graph to leave opaque", () => {
  for (const text of ['{"type":"run-start","v":1,"argsHash":"h"}', '{"type":"something-new"}', '{"type":"run-start","v":99,"argsHash":"later"}']) {
    const parsed = parseRunEvent(text);
    assert.ok(parsed.ok, text);
    assert.equal(parsed.ok && parsed.event.type, (JSON.parse(text) as { type: string }).type);
  }
});

test("the events a malformed stream leaves are read without an exception: the graph and the resume check", () => {
  const stream = [...MALFORMED, '{"type":"run-start","v":99,"argsHash":"from-the-future"}', '{"type":"run-start","v":1,"argsHash":"known","workflow":"w","phases":[]}', '{"type":"step-start"}', '{"type":"unheard-of","x":1}'];
  const kept: RunEvent[] = stream.flatMap((text) => {
    const parsed = parseRunEvent(text);
    return parsed.ok ? [parsed.event] : [];
  });
  assert.deepEqual(kept.map((e) => e.type), ["run-start", "run-start", "step-start", "unheard-of"], "only the objects with a type are kept");
  assert.doesNotThrow(() => buildRunGraph(kept));
  assert.equal(argsHashOf(kept), "known", "the newer version's hash is another hash: the resume check keeps the one it can read");
});
