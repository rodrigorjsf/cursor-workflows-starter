// Events written the way the runtime writes them, for the tests of the run graph and its layout. `engine-log.test.ts` checks
// against a real run that these shapes are what the engine emits.
import type { RunEvent } from "../src/ui/run-graph.js";

export const T0 = Date.parse("2026-01-10T10:00:00.000Z");
export const RUN = "wf-aaaa0001";

/** Events as `{type, ...fields}`; `stamp` gives them the `v`, `ts` and `runId` the log adds, one second apart. */
export type Draft = { type: string } & Record<string, unknown>;
export const stamp = (drafts: Draft[]): RunEvent[] => drafts.map((d, i) => ({ v: 1, ts: new Date(T0 + i * 1000).toISOString(), runId: RUN, ...d }));

export const runStart: Draft = { type: "run-start", workflow: "demo" };
export const phase = (title: string): Draft => ({ type: "phase", title });
export interface Ref {
  parentId?: string | null;
  groupId?: string | null;
}
export const ref = (stepId: string, r: Ref) => ({ stepId, parentId: r.parentId ?? null, groupId: r.groupId ?? null });

/** An agent step that has started. */
export const stepStart = (stepId: string, label: string, r: Ref = {}, extra: Record<string, unknown> = {}): Draft => ({
  type: "step-start",
  ...ref(stepId, r),
  attemptId: `${stepId}#1`,
  stepKey: `${stepId}:k`,
  label,
  cached: false,
  attempt: 1,
  model: "composer-2.5",
  ...extra,
});
/** The end of an agent attempt. */
export const stepEnd = (stepId: string, label: string, r: Ref = {}, extra: Record<string, unknown> = {}): Draft => ({
  type: "step-end",
  ...ref(stepId, r),
  attemptId: `${stepId}#1`,
  stepKey: `${stepId}:k`,
  label,
  ok: true,
  cached: false,
  chargedCents: 0,
  ...extra,
});
export const execStart = (stepId: string, label: string, r: Ref = {}, extra: Record<string, unknown> = {}): Draft => ({ type: "exec-start", ...ref(stepId, r), attemptId: `${stepId}#1`, label, command: "npm", timeoutMs: 60000, ...extra });
export const execEnd = (stepId: string, label: string, r: Ref = {}, extra: Record<string, unknown> = {}): Draft => ({
  type: "exec-end",
  ...ref(stepId, r),
  attemptId: `${stepId}#1`,
  label,
  command: "npm",
  ok: true,
  outcome: "exit",
  exitCode: 0,
  durationMs: 1000,
  outputChars: 0,
  ...extra,
});
export const groupStart = (groupId: string, kind: "parallel" | "pipeline", size: number, parentId: string | null, parentGroupId: string | null = null): Draft => ({ type: "group-start", groupId, kind, size, parentId, parentGroupId });
export const groupEnd = (groupId: string, ok = true): Draft => ({ type: "group-end", groupId, ok });
/** A step that ran to the end: its start and its end. */
export const step = (stepId: string, label: string, r: Ref = {}): Draft[] => [stepStart(stepId, label, r), stepEnd(stepId, label, r)];

