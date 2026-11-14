// Seam: what `verify-turn-granularity` concludes from a measurement. `sumAgainstUsage` and `turnRule` (scripts/verify/verify-turn-granularity.ts)
// are called with the figures of a run as plain data: nothing is stubbed. What the real SDK emits is the workflow's own job (opt-in, capped,
// scripts/verify/README.md), so the figures here are written down: this file pins what a measurement has to say for the issue #37 rule to pick
// rule 1, 2 or 3, not what the SDK does. The expected ratios are worked by hand from the measured run of 2026-11-14.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import { test } from "node:test";
import { sumAgainstUsage, turnRule } from "../scripts/verify/verify-turn-granularity.js";

/** The `RunResult.usage` of the long direct send measured on 2026-11-14 (run 1). */
const MEASURED_USAGE = { inputTokens: 124_436, outputTokens: 3_655, cacheReadTokens: 111_296, cacheWriteTokens: 0, totalTokens: 128_091 };

test("a token-delta total of 5596 against 3655 output tokens is not a sum of the usage: it is 1.531 times the output and 4.4% of the total", () => {
  const sum = sumAgainstUsage(5_596, MEASURED_USAGE);
  assert.equal(sum.summable, false);
  assert.equal(sum.closest, "outputTokens");
  assert.deepEqual(sum.ratios, { outputTokens: 1.531, outputPlusReasoning: 1.531, inputPlusOutput: 0.044 });
});

test("a token-delta total within 10% of the output tokens counts as summing to the usage", () => {
  const sum = sumAgainstUsage(1_050, { inputTokens: 9_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10_000 });
  assert.equal(sum.summable, true);
  assert.equal(sum.closest, "outputTokens");
});

test("a run that reported no usage has nothing a token-delta total could sum to", () => {
  assert.deepEqual(sumAgainstUsage(500, undefined), { summable: false, closest: "no usage reported" });
});

test("rule 1: a long send that emits several turn-ended updates changes only the docs, whatever the token-delta says", () => {
  assert.equal(turnRule({ turnEndedPerSend: [1, 3], tokenDeltaCount: 149, summable: true }), 1);
  assert.equal(turnRule({ turnEndedPerSend: [2, 1], tokenDeltaCount: 0, summable: false }), 1);
});

test("rule 2: one turn-ended per long send and a token-delta that sums to the usage asks for a mid-turn estimate", () => {
  assert.equal(turnRule({ turnEndedPerSend: [1, 1], tokenDeltaCount: 40, summable: true }), 2);
});

test("rule 3: one turn-ended per long send and a token-delta that does not sum is documented as bounded by one send", () => {
  assert.equal(turnRule({ turnEndedPerSend: [1, 1], tokenDeltaCount: 149, summable: false }), 3);
});

test("rule 3: a single token-delta update is no evidence of a sum, even when it matches", () => {
  assert.equal(turnRule({ turnEndedPerSend: [1, 1], tokenDeltaCount: 1, summable: true }), 3);
});
