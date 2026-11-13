// Seam: how the live views take events and content from a stream. `batcher(deliver, ms)` collects what is pushed and hands it
// over together, so a burst is one render and not one per item.
import assert from "node:assert/strict";
import { test } from "node:test";
import { waitFor } from "../../runtime/test/wait-for.js";
import { batcher } from "../run-view/batch.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("a burst is delivered once, in order, a moment after the first item", async () => {
  const delivered: number[][] = [];
  const batch = batcher<number>((items) => delivered.push(items), 30);
  batch.push(1);
  batch.push(2);
  batch.push(3);
  assert.deepEqual(delivered, [], "nothing yet: the batch is still collecting");
  await waitFor("the first burst", () => delivered.length >= 1);
  assert.deepEqual(delivered, [[1, 2, 3]]);
  batch.push(4);
  await waitFor("the second burst", () => delivered.length >= 2);
  assert.deepEqual(delivered, [[1, 2, 3], [4]], "the next burst is its own batch");
});

test("flush hands over what is waiting at once, and only once", async () => {
  const delivered: number[][] = [];
  const batch = batcher<number>((items) => delivered.push(items), 30);
  batch.push(1);
  batch.flush();
  assert.deepEqual(delivered, [[1]]);
  await sleep(80); // fixed-wait-ok: past the 30 ms timer, a second delivery would have come
  assert.deepEqual(delivered, [[1]], "the timer that was waiting does not deliver it again");
});

test("flushing nothing delivers nothing", async () => {
  const delivered: number[][] = [];
  const batch = batcher<number>((items) => delivered.push(items), 30);
  batch.flush();
  await sleep(50); // fixed-wait-ok: past the 30 ms timer, a delivery would have come
  assert.deepEqual(delivered, []);
});
