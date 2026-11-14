// WHAT: Workflow that measures how the real SDK reports one long local write step: how many `turn-ended` updates a long
//   `send` emits, whether its `token-delta` updates add up to `RunResult.usage`, and whether `Run.cancel()` stops a run in
//   the middle of a turn (and how long `wait()` takes to settle afterwards). The engine step is read back from the run's own
//   event log; the two direct sends use the SDK itself, because the engine does not pass `token-delta` on.
// WHY: The live token caps (`maxTokens`, `maxTokensPerStep`) check usage only when the SDK delivers `turn-ended`. If a long
//   send gives one, a runaway step is never cut before it ends. The fake SDK emits whatever turns a test scripts, so only
//   a real run answers it (issue #37).
// WHEN: On a new account or after an SDK upgrade, to refresh the bound the cap docs state (docs/usage/02-configuracao-inicial.md).
// HOW: see scripts/verify/README.md ("verify-turn-granularity"): `scripts/verify/setup-probe-repo.sh <new-dir>`, then
//   `WORKFLOWS_DIR=scripts/verify npm run wf -- run verify-turn-granularity --cwd <probe-repo> --args '{}' --max-tokens 400000 --max-cents 40`.
//   Refuses a repository that already holds the `lib/` folder the engine step writes, and a run without both caps. The two
//   direct sends write in temporary folders it removes at the end.
// COST: measured 2026-11-14 on composer-2.5, two runs: 134 to 268 thousand tokens for the engine step and about 128 thousand
//   for the long direct send, so about 10 cents a run at list price and 0 charged (usage included in the plan). Only the
//   engine step is under `--max-tokens`: each direct send is bounded by `SEND_TIMEOUT_MS` alone.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractionUpdate, Run, RunResult } from "@cursor/sdk";
import { defineWorkflow } from "../../packages/runtime/src/runtime/workflow.js";
import { readJsonl } from "../../packages/runtime/src/runtime/state-files.js";
import { EVENTS_FILE, runDirIn } from "../../packages/runtime/src/runtime/run-store.js";

const MODEL = { id: process.env.WF_VERIFY_MODEL ?? "composer-2.5" };
const TOOLS = ["read", "edit", "shell", "ls", "glob"];
/** The same long write task for the engine step and both direct sends: many tool calls and model calls in one send. */
const LONG_PROMPT =
  "In this directory, build a small utility library and prove it works. " +
  "1) Create the folder `lib/` with six ES modules, one per file: `stack.js`, `queue.js`, `counter.js`, `slug.js`, `chunk.js` and `deepEqual.js`. Each exports one well-named function or class with at least 12 lines of real code. " +
  "2) For each module add `test/<name>.test.js` that uses `node:test` and `node:assert/strict`, with at least three cases. " +
  "3) Add the modules one at a time: after each module and its test, run `node --test` and fix any failure before you start the next one. " +
  "4) Finish with one line: the final `node --test` result. " +
  "Do not touch any file outside `lib/` and `test/`, and do not use git."; // the last rule is a request to the agent, not a lock: nothing stops a shell command from breaking it
/** The cap of the cancel probe: what a tight `maxTokensPerStep` would be. */
const LOW_CAP_TOKENS = 3000;
/** The cancel probe's fallback trigger, for an SDK that sends no `token-delta` at all. */
const CANCEL_AFTER_TOOL_CALLS = 3;
/** The bound of every send here: the engine step's `timeoutMs`, and the time after which a direct send is cancelled (its measurement says so). */
const SEND_TIMEOUT_MS = 8 * 60_000;
/** How close, as a fraction, the `token-delta` total must be to a figure of `RunResult.usage` to count as summing to it. */
const SUM_TOLERANCE = 0.1;

interface Counted {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
}

/** The usage a `step-end` or a `turn` line of the event log carries. */
interface LoggedUsage extends Counted {
  totalTokens?: number;
}

interface EventLine {
  type: string;
  label?: string;
  attemptId?: string;
  usage?: LoggedUsage;
  turns?: number;
  steps?: number;
  ok?: boolean;
  errorKind?: string;
  durationMs?: number;
}

const isEventLine = (value: unknown): value is EventLine => typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

/** What the engine's own log says about the step `label`: its `turn` events against the `step-end` the engine wrote. It only reads the log, which the run's store keeps writing. */
function engineReport(cwd: string, runId: string, label: string) {
  const events = readJsonl(join(runDirIn(cwd, runId), EVENTS_FILE), isEventLine).records;
  const end = events.findLast((e) => e.type === "step-end" && e.label === label);
  if (!end) throw new Error(`verify-turn-granularity: the event log of run ${runId} has no step-end for step "${label}".`);
  const turns = events.filter((e) => e.type === "turn" && e.attemptId === end.attemptId);
  const sum = (pick: (u: LoggedUsage) => number) => turns.reduce((total, t) => total + (t.usage ? pick(t.usage) : 0), 0);
  return {
    ok: end.ok,
    errorKind: end.errorKind,
    durationMs: end.durationMs,
    turnEvents: turns.length,
    turnEventTokens: sum((u) => u.inputTokens + u.outputTokens),
    stepEndTurns: end.turns,
    stepEndSteps: end.steps,
    stepEndTotalTokens: end.usage?.totalTokens,
    stepEndInputTokens: end.usage?.inputTokens,
    stepEndOutputTokens: end.usage?.outputTokens,
    reasoningTokens: end.usage && "reasoningTokens" in end.usage ? end.usage.reasoningTokens : undefined,
  };
}

interface DirectSend {
  /** How many updates of each type the send delivered. */
  updates: Record<string, number>;
  turnEnded: number;
  tokenDeltas: { count: number; total: number; values: number[] };
  result: { status: string; usage?: RunResult["usage"]; durationMs?: number; error?: string };
  wallMs: number;
  timedOut: boolean;
  cancel?: {
    why: string;
    /** Milliseconds from the start of the send to the moment the cap was crossed. */
    triggeredAtMs: number;
    /** `turn-ended` updates already seen when the cancel was called. */
    turnEndedBefore: number;
    /** Milliseconds `Run.cancel()` took to resolve. */
    cancelReturnedMs: number;
    /** Milliseconds from the `Run.cancel()` call until `wait()` settled. */
    waitSettledMs: number;
    /** Updates that still arrived after the `Run.cancel()` call. */
    updatesAfter: Record<string, number>;
  };
}

/** Decides, after each update, whether the cancel probe stops the run now: the reason, or undefined. */
type CancelTrigger = (seen: { tokenDeltaTotal: number; toolCalls: number }) => string | undefined;

const lowCapTrigger: CancelTrigger = ({ tokenDeltaTotal, toolCalls }) => {
  if (tokenDeltaTotal >= LOW_CAP_TOKENS) return `token-delta total ${tokenDeltaTotal} reached the cap of ${LOW_CAP_TOKENS}`;
  if (toolCalls >= CANCEL_AFTER_TOOL_CALLS) return `tool call ${toolCalls} started with no token-delta total at the cap (${tokenDeltaTotal} of ${LOW_CAP_TOKENS})`;
  return undefined;
};

const tally = (counts: Record<string, number>, key: string) => void (counts[key] = (counts[key] ?? 0) + 1);

/** One send of the long task straight through the SDK, in `cwd`, watching every update. With `trigger`, cancels the run when it says so. */
async function directSend(cwd: string, trigger?: CancelTrigger): Promise<DirectSend> {
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "package.json"), '{ "name": "wf-turn-granularity", "private": true, "type": "module" }\n');
  const { Agent } = await import("@cursor/sdk"); // lazy, so the helpers below load without the SDK (test/verify-turn-granularity.test.ts)
  const agent = await Agent.create({ model: MODEL, tools: TOOLS, local: { cwd, settingSources: [] } });
  const startedAt = performance.now();
  const updates: Record<string, number> = {};
  const deltaValues: number[] = [];
  let turnEnded = 0;
  let toolCalls = 0;
  let tokenDeltaTotal = 0;
  let run: Run | undefined;
  let fired: { why: string; atMs: number; turnEndedBefore: number } | undefined;
  let cancelCalledAt: number | undefined;
  let cancelReturnedMs: number | undefined;
  const updatesAfter: Record<string, number> = {};
  let timedOut = false;
  const cancelNow = () => {
    if (!run || cancelCalledAt !== undefined) return;
    const bound = run;
    cancelCalledAt = performance.now();
    void bound.cancel().then(() => (cancelReturnedMs = performance.now() - cancelCalledAt!), () => (cancelReturnedMs = -1)); // a failed cancel shows as -1 and in the run's status
  };
  const timer = setTimeout(() => {
    timedOut = true;
    cancelNow();
  }, SEND_TIMEOUT_MS);
  timer.unref();
  const onUpdate = (update: InteractionUpdate) => {
    tally(updates, update.type);
    if (cancelCalledAt !== undefined) tally(updatesAfter, update.type);
    if (update.type === "turn-ended") turnEnded++;
    if (update.type === "tool-call-started") toolCalls++;
    if (update.type === "token-delta") {
      tokenDeltaTotal += update.tokens;
      deltaValues.push(update.tokens);
    }
    if (trigger && !fired) {
      const why = trigger({ tokenDeltaTotal, toolCalls });
      if (why) fired = { why, atMs: performance.now() - startedAt, turnEndedBefore: turnEnded };
    }
    if (fired) cancelNow();
  };
  try {
    run = await agent.send(LONG_PROMPT, { onDelta: ({ update }) => onUpdate(update) });
    if (fired || timedOut) cancelNow(); // the cap was crossed before `send()` handed the run back
    const result = await run.wait();
    const settledAt = performance.now();
    return {
      updates,
      turnEnded,
      tokenDeltas: { count: deltaValues.length, total: tokenDeltaTotal, values: deltaValues.slice(0, 20) },
      result: { status: result.status, usage: result.usage, durationMs: result.durationMs, error: result.error?.message },
      wallMs: Math.round(settledAt - startedAt),
      timedOut,
      cancel:
        fired && cancelCalledAt !== undefined
          ? { why: fired.why, triggeredAtMs: Math.round(fired.atMs), turnEndedBefore: fired.turnEndedBefore, cancelReturnedMs: Math.round(cancelReturnedMs ?? -1), waitSettledMs: Math.round(settledAt - cancelCalledAt), updatesAfter }
          : undefined,
    };
  } finally {
    clearTimeout(timer);
    await agent[Symbol.asyncDispose]().catch(() => {}); // nothing left to do with an agent that cannot be disposed
  }
}

/** The figures of `RunResult.usage` a `token-delta` total could be adding up to, with how far the total is from each. */
export function sumAgainstUsage(total: number, usage: RunResult["usage"]) {
  if (!usage) return { summable: false, closest: "no usage reported" };
  const figures: Record<string, number> = {
    outputTokens: usage.outputTokens,
    outputPlusReasoning: usage.outputTokens + (usage.reasoningTokens ?? 0),
    inputPlusOutput: usage.inputTokens + usage.outputTokens,
  };
  const ratios = Object.fromEntries(Object.entries(figures).map(([name, figure]) => [name, figure === 0 ? null : Number((total / figure).toFixed(3))]));
  const closest = Object.entries(ratios).filter((e): e is [string, number] => e[1] !== null).sort((a, b) => Math.abs(1 - a[1]) - Math.abs(1 - b[1]))[0];
  return { summable: closest !== undefined && Math.abs(1 - closest[1]) <= SUM_TOLERANCE, closest: closest?.[0] ?? "none", ratios };
}

/**
 * The decision rule of issue #37, applied to the long sends: 1 when a send emitted several `turn-ended` updates (only the docs
 * change), 2 when each emitted one and the `token-delta` updates sum to the usage (a mid-turn estimate becomes possible), 3
 * otherwise (the docs say "bounded by one send"). A single `token-delta` update is no evidence of a sum.
 */
export function turnRule({ turnEndedPerSend, tokenDeltaCount, summable }: { turnEndedPerSend: number[]; tokenDeltaCount: number; summable: boolean }): 1 | 2 | 3 {
  if (turnEndedPerSend.some((n) => n > 1)) return 1;
  return tokenDeltaCount > 1 && summable ? 2 : 3;
}

export default defineWorkflow({
  meta: {
    name: "verify-turn-granularity",
    description: "Verification: turn-ended and token-delta updates of a long local write step, and how Run.cancel() settles mid-turn (the live token caps).",
    roles: [{ name: "probe", cloud: "never", description: "Writes a small library and its tests in the repository.", defaults: { model: MODEL } }],
  },
  defaults: { timeoutMs: SEND_TIMEOUT_MS, retries: 0 },
  async run(ctx) {
    if (ctx.budget.maxTokens === null || ctx.budget.maxCents === null) throw new Error("verify-turn-granularity: pass --max-tokens and --max-cents (the run spends tokens on the real API).");
    if (existsSync(join(ctx.cwd, "lib"))) throw new Error(`verify-turn-granularity: ${ctx.cwd} already has a lib/ folder, so the step would not write the whole library. Use a new repository from scripts/verify/setup-probe-repo.sh.`);
    ctx.phase("engine-step");
    await ctx.agent(LONG_PROMPT, { role: "probe", label: "long-write", tools: TOOLS, settingSources: [], revertOnRetry: true });
    const engine = engineReport(ctx.cwd, ctx.runId, "long-write");

    const scratch = await mkdtemp(join(tmpdir(), "wf-turn-granularity-"));
    try {
      ctx.phase("sdk-deltas");
      const deltas = await directSend(join(scratch, "deltas"));
      ctx.phase("sdk-cancel");
      const cancel = await directSend(join(scratch, "cancel"), lowCapTrigger);

      const sum = sumAgainstUsage(deltas.tokenDeltas.total, deltas.result.usage);
      const rule = turnRule({ turnEndedPerSend: [engine.turnEvents, deltas.turnEnded], tokenDeltaCount: deltas.tokenDeltas.count, summable: sum.summable });
      ctx.metric("turn_events_long_step", engine.turnEvents);
      ctx.metric("turn_ended_long_send", deltas.turnEnded);
      ctx.metric("token_deltas_long_send", deltas.tokenDeltas.count);
      ctx.metric("cancel_wait_settled_ms", cancel.cancel?.waitSettledMs ?? -1);
      return {
        status: "done",
        model: MODEL.id,
        rule,
        engine,
        deltas: { ...deltas, sum },
        cancel,
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
});
