// Seam: how the live views take events and content from a stream. `batcher(deliver, ms)` collects what is pushed and hands it
// over together, so a burst is one render and not one per item.
import assert from "node:assert/strict";
import { test } from "node:test";
import { batcher } from "../src/ui/batch.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("a burst is delivered once, in order, a moment after the first item", async () => {
  const delivered: number[][] = [];
  const batch = batcher<number>((items) => delivered.push(items), 30);
  batch.push(1);
  batch.push(2);
  batch.push(3);
  assert.deepEqual(delivered, [], "nothing yet: the batch is still collecting");
  await sleep(80);
  assert.deepEqual(delivered, [[1, 2, 3]]);
  batch.push(4);
  await sleep(80);
  assert.deepEqual(delivered, [[1, 2, 3], [4]], "the next burst is its own batch");
});

test("flush hands over what is waiting at once, and only once", async () => {
  const delivered: number[][] = [];
  const batch = batcher<number>((items) => delivered.push(items), 30);
  batch.push(1);
  batch.flush();
  assert.deepEqual(delivered, [[1]]);
  await sleep(80);
  assert.deepEqual(delivered, [[1]], "the timer that was waiting does not deliver it again");
});

test("flushing nothing delivers nothing", async () => {
  const delivered: number[][] = [];
  const batch = batcher<number>((items) => delivered.push(items), 30);
  batch.flush();
  await sleep(50);
  assert.deepEqual(delivered, []);
});
