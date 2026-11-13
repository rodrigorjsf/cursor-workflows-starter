// Seam: the process. `scripts/dev/dash-fixtures.ts` is run the way a maintainer runs it (plain `tsx`, no tsconfig: it puts
// itself under the fake SDK), offline, into a scratch home. What it made is read back through the runtime's own read side,
// the one the dashboard uses, so the fixtures cannot rot silently when the engine or the events change.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ROOT } from "./mcp-support.js";

let scratch: string;
let manifest: { home: string; repo: string; runs: Record<string, string>; cloudStep: { runId: string; label: string } };
let events: (runId: string) => Array<Record<string, any>>;

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "wf-dash-fixtures-test-"));
  const home = join(scratch, "home");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: join(scratch, "user") }; // a fixture that wrote to ~ would show here
  for (const name of ["TSX_TSCONFIG_PATH", "WF_HOME", "WF_METRICS_DB", "WF_METRICS"]) delete env[name];
  const r = spawnSync(join(ROOT, "node_modules", ".bin", "tsx"), [join(ROOT, "scripts", "dev", "dash-fixtures.ts"), "--home", home], { cwd: ROOT, env, encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  manifest = JSON.parse(r.stdout);
  process.env.WF_HOME = manifest.home; // the runtime's read side finds the runs through this home's runs index
  const { eventLogOf } = await import("../packages/runtime/src/runtime/run-view.js");
  events = (runId) => readFileSync(eventLogOf(runId)!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
});
after(() => rmSync(scratch, { recursive: true, force: true }));

test("the fixture script makes a finished, a failed, a cancelled and an interrupted run, and touches nothing in ~", async () => {
  const { readRun } = await import("../packages/runtime/src/runtime/run-view.js");
  assert.deepEqual(Object.keys(manifest.runs).sort(), ["cancelled", "failed", "finished", "interrupted"]);
  const status = Object.fromEntries(Object.entries(manifest.runs).map(([name, runId]) => [name, readRun(runId)?.status]));
  assert.deepEqual(status, { finished: "finished", failed: "failed", cancelled: "cancelled", interrupted: "failed" });
  assert.ok(existsSync(join(manifest.home, "metrics.db")), "the runs are in the fixture home's metrics database");
  assert.ok(!existsSync(join(scratch, "user", ".cursor-workflows")), "nothing written under the user's home");
});

test("the finished run has the implement-issue shape: phases, a parallel group, cards and a cloud step with a cost", () => {
  const log = events(manifest.runs.finished!);
  assert.deepEqual(log.filter((e) => e.type === "phase").map((e) => e.title), ["Triage", "Plan", "Build", "Review", "Deliver"]);
  assert.ok(log.some((e) => e.type === "group-start"));
  assert.ok(log.some((e) => e.type === "card"));
  const cloud = log.find((e) => e.type === "step-end" && e.label === manifest.cloudStep.label);
  assert.equal(cloud?.location, "cloud");
  assert.ok(cloud.chargedCents > 0, JSON.stringify(cloud));
});

test("the interrupted run stopped mid-step: a step that started and never ended, and no run end", () => {
  const log = events(manifest.runs.interrupted!);
  assert.ok(!log.some((e) => e.type === "run-end"));
  const ended = new Set(log.filter((e) => e.type === "step-end").map((e) => e.stepId));
  assert.ok(log.some((e) => e.type === "step-start" && !ended.has(e.stepId)));
});
