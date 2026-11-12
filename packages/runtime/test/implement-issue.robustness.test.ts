// Seam 1, the run: `implement-issue` against the fake SDK, the fake gh and a temporary git repository (the environment is in
// implement-issue.fixture.ts). The tier comes from the highest matching label, a step that crashes the process again and
// again stops being resumed, and every retry of a write step starts from a clean tree.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runWorkflow } from "../src/runtime/engine.js";
import implementIssue from "../workflows/implement-issue.js";
import { PLAN, SUB_CODE, fx, git, issue, names, run, setup, submit, teardown, worktreeOf, write } from "./implement-issue.fixture.js";
import { writeRepoConfig } from "./config-fixtures.js";

beforeEach(setup);
afterEach(teardown);

const res = (r: { result?: unknown }) => r.result as any;
const DESIGN = { interface: "subtract(a, b)", usage: "subtract(5, 3)", hides: "nada", dependencies: "em processo", tradeoffs: "-" };

// ── The tier is the highest of the matching labels ───────────────────────────────────────

test("when several complexity labels match, the tier is the highest one, whatever the label order", async () => {
  fx.handlers["desenhar:minima"] = (o) => submit(o, DESIGN);
  fx.handlers["desenhar:flexivel"] = (o) => submit(o, DESIGN);
  fx.handlers["desenhar:comum"] = (o) => submit(o, DESIGN);
  fx.handlers.julgar = (o) => submit(o, PLAN);
  const cases: Array<[string[], string]> = [
    [["complexity:low", "complexity:medium"], "MED"],
    [["complexity:medium", "complexity:low"], "MED"],
    [["good first issue", "complexity:high"], "HIGH"],
    [["security", "complexity:low"], "HIGH"],
    [["Complexity:HIGH", "complexity:medium", "complexity:low"], "HIGH"],
    [["bug", "complexity:medium", "enhancement"], "MED"],
  ];
  for (const [labels, tier] of cases) {
    issue(labels);
    const r = await run({});
    assert.equal(res(r).tier, tier, `${labels.join(" + ")} -> ${JSON.stringify(res(r))}`);
  }
});

test("a label named like a member of Object.prototype is only a label: with no known label the classifier decides", async () => {
  issue(["constructor", "toString"]);
  fx.handlers.classificar = (o) => submit(o, { tier: "MED", reason: "typical" });
  const r = await run({});
  assert.equal(res(r).tier, "MED");
  assert.ok(names().includes("classificar"), "no label matched: the classifier ran");
});

// ── A crash loop stops ───────────────────────────────────────────────────────────────────

const progressFile = (runId: string) => join(fx.repo, ".workflows", "runs", runId, "tdd-progress.json");
const progressOf = (runId: string) => JSON.parse(readFileSync(progressFile(runId), "utf8"));
const FALL = () => ({ status: "error", error: { message: "simulated fall" } });

/** The process "dies" in the middle of the green step of the first slice: the progress says the step is in flight and the tree is dirty. */
function crashInGreen(runId: string) {
  const p = progressOf(runId);
  git(worktreeOf(), "add", "-A");
  p.inFlight = { id: `green:${p.slices[0].key}:1`, before: git(worktreeOf(), "write-tree").trim() };
  writeFileSync(progressFile(runId), JSON.stringify(p));
  writeFileSync(join(worktreeOf(), "stray.txt"), "half-made edit\n");
}

test("a step that crashed the process more than the limit fails instead of resuming again; raising the limit resumes it", async () => {
  issue(["complexity:low"]);
  fx.handlers["codigo-1"] = FALL;
  const first = await run({});
  assert.equal(first.status, "failed");

  // The default limit is 2: the step is resumed after its first and second crash...
  for (const n of [1, 2]) {
    crashInGreen(first.runId);
    const resumed = await run({}, first.runId);
    assert.equal(resumed.status, "failed", `resume ${n} ran the step again`);
  }
  // ...and not after its third.
  crashInGreen(first.runId);
  const before = names().length;
  const stopped = await run({}, first.runId);
  assert.equal(stopped.status, "finished", stopped.error);
  assert.equal(res(stopped).status, "step-crash-loop", JSON.stringify(res(stopped)));
  assert.equal(res(stopped).crashes, 3);
  assert.equal(res(stopped).limit, 2);
  assert.match(res(stopped).step, /^green:/);
  assert.deepEqual(names().slice(before), [], "no agent ran");
  assert.ok(!existsSync(join(worktreeOf(), "stray.txt")), "the interrupted step was undone before the run gave up");

  // The count is kept: the same limit stops the next resume too.
  const again = await run({}, first.runId);
  assert.equal(res(again).status, "step-crash-loop");
  assert.deepEqual(names().slice(before), [], "still no agent");

  // Raising the limit in the config lets the step run again.
  writeRepoConfig(fx.repo, { workflows: { "implement-issue": { settings: { maxStepCrashes: 3 } } } });
  fx.handlers["codigo-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE);
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  const resumed = await run({}, first.runId);
  assert.equal(res(resumed).status, "done", JSON.stringify(res(resumed)));
});

test("a limit of 0 stops the step at the first crash", async () => {
  issue(["complexity:low"]);
  writeRepoConfig(fx.repo, { workflows: { "implement-issue": { settings: { maxStepCrashes: 0 } } } });
  fx.handlers["codigo-1"] = FALL;
  const first = await run({});
  assert.equal(first.status, "failed");
  crashInGreen(first.runId);
  const stopped = await run({}, first.runId);
  assert.equal(res(stopped).status, "step-crash-loop", JSON.stringify(res(stopped)));
  assert.equal(res(stopped).crashes, 1);
  assert.equal(res(stopped).limit, 0);
});

test("a cancel in the middle of a write step is not a crash: any number of them still resumes", async () => {
  issue(["complexity:low"]);
  fx.handlers["codigo-1"] = (o) => {
    write(o, "src/math.js", `${SUB_CODE}// half-made edit\n`);
    return { hang: true };
  };
  let runId: string | undefined;
  for (let n = 1; n <= 4; n++) {
    const controller = new AbortController();
    const cancelled = await runWorkflow(implementIssue, { issue: 7, testCommand: "node --test" } as any, {
      cwd: fx.repo,
      runId,
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === "step-start" && e.label === "codigo-1") setTimeout(() => controller.abort(), 100);
      },
    });
    assert.equal(cancelled.status, "cancelled", `cancel ${n}`);
    runId = cancelled.runId;
    assert.ok(progressOf(runId).inFlight, "the cancelled step is still marked in flight, so the resume undoes it");
  }
  fx.handlers["codigo-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE);
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  const resumed = await run({}, runId);
  assert.equal(res(resumed).status, "done", JSON.stringify(res(resumed)));
});

// ── A retried write step starts from a clean tree ────────────────────────────────────────

test("what a failed attempt of a write step left in the worktree is gone when the step is retried, and is not delivered", async () => {
  issue(["complexity:low"]);
  let attempt = 0;
  const seenByRetry: boolean[] = [];
  fx.handlers["codigo-1"] = (o) => {
    attempt++;
    if (attempt === 1) {
      write(o, "src/junk.js", "export const junk = 1;\n");
      write(o, "src/math.js", `${SUB_CODE}// half-made edit\n`);
      return FALL();
    }
    seenByRetry.push(existsSync(join(o.local.cwd, "src", "junk.js")), readFileSync(join(o.local.cwd, "src", "math.js"), "utf8").includes("half-made"));
    write(o, "src/math.js", SUB_CODE);
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  const r = await run({});
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
  assert.equal(attempt, 2, "the step was retried once");
  assert.deepEqual(seenByRetry, [false, false], "the retry found neither the new file nor the half-made edit");
  assert.ok(!existsSync(join(worktreeOf(), "src", "junk.js")));
  assert.doesNotMatch(git(fx.repo, "show", "--stat", "wf/issue-7"), /junk/, "the commit holds nothing of the failed attempt");
});
