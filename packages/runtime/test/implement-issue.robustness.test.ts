// Seam 1, the run: `implement-issue` against the fake SDK, the fake gh and a temporary git repository (the environment is in
// implement-issue.fixture.ts). The tier comes from the highest matching label, a step that crashes the process again and
// again stops being resumed, and every retry of a write step starts from a clean tree.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runWorkflow } from "../src/runtime/engine.js";
import implementIssue from "../workflows/implement-issue.js";
import { PLAN, SUB_CODE, SUB_TEST, branchOf, failGh, fx, git, issue, names, run, setup, submit, teardown, worktreeOf, write } from "./implement-issue.fixture.js";
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

/**
 * The process "dies" in the middle of the green step of the first slice: the progress says the step is in flight and the tree is
 * dirty. `execution`: the execution of the run the record says began the step (absent, as in progress from older versions).
 */
function crashInGreen(runId: string, execution?: number) {
  const p = progressOf(runId);
  git(worktreeOf(runId), "add", "-A");
  p.inFlight = { id: `green:${p.slices[0].key}:1`, before: git(worktreeOf(runId), "write-tree").trim(), execution };
  writeFileSync(progressFile(runId), JSON.stringify(p));
  writeFileSync(join(worktreeOf(runId), "stray.txt"), "half-made edit\n");
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
  assert.ok(!existsSync(join(worktreeOf(first.runId), "stray.txt")), "the interrupted step was undone before the run gave up");

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

test("while a write step runs, the progress on disk says it is in flight (what a crash leaves for the resume to count) and it is cleared when the step ends", async () => {
  issue(["complexity:low"]);
  let inFlight: { id: string; before: string; interrupted?: boolean } | undefined;
  fx.handlers["codigo-1"] = (o) => {
    const runs = join(fx.repo, ".workflows", "runs");
    const dir = readdirSync(runs).find((d) => existsSync(join(runs, d, "tdd-progress.json")))!;
    inFlight = JSON.parse(readFileSync(join(runs, dir, "tdd-progress.json"), "utf8")).inFlight;
    write(o, "src/math.js", SUB_CODE);
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  const r = await run({});
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
  assert.match(inFlight!.id, /^green:/);
  assert.match(inFlight!.before, /^[0-9a-f]{40}$/, "the tree to go back to");
  assert.equal(inFlight!.interrupted, undefined, "a step that is still running was not interrupted");
  assert.equal(progressOf(r.runId).inFlight, undefined);
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

/**
 * Cancels run `runId` once at every command a write step runs after its agent answered and before the step is settled (the
 * suite, the tree snapshots, the checks): execution N cuts at the N-th of them, and the next execution resumes the run. After
 * each cut the mark the workflow's catch wrote is taken off the record, as when `wf` exits right after the run ends and the
 * catch never runs: the resume has to tell the cancel from a crash by the event log. No execution may count a crash. Returns
 * the cuts and the execution that got past the step, which runs on to the end.
 */
async function cancelAtEveryCommandAfter(label: string, runId: string) {
  const cuts: string[] = [];
  for (let cut = 1; cut <= 40; cut++) {
    const controller = new AbortController();
    let agentAnswered = false;
    let seen = 0;
    let at: string | undefined;
    const r = await runWorkflow(implementIssue, { issue: 7, testCommand: "node --test" } as any, {
      cwd: fx.repo,
      runId,
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === "step-end" && e.label === label && e.ok) agentAnswered = true;
        else if (e.type === "exec-start" && agentAnswered && at === undefined && ++seen === cut && progressOf(runId).inFlight) {
          at = e.label; // still inside the step: cancel while this command runs
          controller.abort();
        }
      },
    });
    assert.deepEqual(progressOf(runId).crashes ?? {}, {}, `before cut ${cut}: no crash counted`);
    if (at === undefined) return { cuts, past: r };
    cuts.push(at);
    assert.equal(r.status, "cancelled", `cut ${cut} (${at}): ${JSON.stringify(r)}`);
    await new Promise((resolve) => setTimeout(resolve, 50)); // the cancelled body is done unwinding
    const p = progressOf(runId);
    assert.ok(p.inFlight?.execution, `cut ${cut} (${at}): the step is in flight, with the execution that began it: ${JSON.stringify(p.inFlight)}`);
    delete p.inFlight.interrupted;
    writeFileSync(progressFile(runId), JSON.stringify(p));
  }
  throw new Error(`${label}: the step was never got past`);
}

for (const [step, label] of [["red", "teste-1"], ["green", "codigo-1"], ["refactor", "refatorar-1"]] as const) {
  test(`a cancel at any command of the ${step} step after its agent answered (the suite, a snapshot, a check) is not a crash`, async () => {
    issue(["complexity:low"]);
    // The red step also writes code, which the workflow discards: one more command (the restore) inside the step.
    fx.handlers["teste-1"] = (o) => {
      write(o, "test/sub.test.js", SUB_TEST);
      write(o, "src/stub.js", "export const stub = 1;\n");
      submit(o, { testFile: "test/sub.test.js", testName: "subtract" });
    };
    if (step === "refactor") {
      let round = 0;
      fx.handlers["review:standards"] = (o) =>
        submit(o, ++round === 1 ? { findings: [{ file: "src/math.js", rule: "Mysterious Name", kind: "hard", note: "bad name" }], worst: "name" } : { findings: [], worst: "" });
      fx.handlers["refatorar-1"] = (o) => {
        write(o, "src/math.js", `${SUB_CODE}// renamed\n`);
        submit(o, { summary: "renamed", filesChanged: ["src/math.js"] });
      };
    }
    const { cuts, past } = await cancelAtEveryCommandAfter(label, `cut-${step}`);
    assert.ok(cuts.length > 2, `more cancels than the default crash limit (2): ${cuts.join(", ")}`);
    // The green suite runs once the step is settled; the red and the refactor suites run inside theirs.
    if (step === "red") assert.ok(cuts.some((c) => c.startsWith("suite:red")), `the suite is one of the cuts: ${cuts.join(", ")}`);
    if (step === "refactor") assert.ok(cuts.includes("suite:refactor"), `the suite is one of the cuts: ${cuts.join(", ")}`);
    assert.equal(res(past).status, "done", JSON.stringify(res(past)));
  });
}

test("a crash is still counted when the next execution fails before it reaches the step, and when the execution that began the step ended failed", async () => {
  issue(["complexity:low"]);
  fx.handlers["codigo-1"] = FALL;
  const first = await run({}); // execution 1 ends failed
  assert.equal(first.status, "failed");
  crashInGreen(first.runId, 1); // a failed execution is no evidence the process lived through the step
  failGh("issue view", "HTTP 502: Bad Gateway"); // the next execution fails in triage, before the resume looks at the step
  const triage = await run({}, first.runId);
  assert.equal(triage.status, "failed", JSON.stringify(triage));
  assert.equal(progressOf(first.runId).inFlight?.interrupted, undefined, "the failed execution did not mark a step it did not begin");
  failGh("issue view", undefined);
  fx.handlers["codigo-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE);
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  const resumed = await run({}, first.runId);
  assert.equal(res(resumed).status, "done", JSON.stringify(res(resumed)));
  assert.deepEqual(Object.values(progressOf(first.runId).crashes ?? {}), [1]);
});

test("a resume cancelled while it undoes a step that crashed the process still counts that crash, once", async () => {
  issue(["complexity:low"]);
  fx.handlers["codigo-1"] = FALL;
  const first = await run({});
  crashInGreen(first.runId);
  const controller = new AbortController();
  const cancelled = await runWorkflow(implementIssue, { issue: 7, testCommand: "node --test" } as any, {
    cwd: fx.repo,
    runId: first.runId,
    signal: controller.signal,
    onEvent: (e) => {
      if (e.type === "log" && /undoing the interrupted step/.test(e.message)) controller.abort();
    },
  });
  assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
  assert.deepEqual(Object.values(progressOf(first.runId).crashes ?? {}), [1], "the crash is counted before the undo");
  fx.handlers["codigo-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE);
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  const resumed = await run({}, first.runId);
  assert.equal(res(resumed).status, "done", JSON.stringify(res(resumed)));
  assert.deepEqual(Object.values(progressOf(first.runId).crashes ?? {}), [1], "and the cancelled undo is not a second crash");
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
  assert.ok(!existsSync(join(worktreeOf(r.runId), "src", "junk.js")));
  assert.doesNotMatch(git(fx.repo, "show", "--stat", branchOf(r.runId)), /junk/, "the commit holds nothing of the failed attempt");
});
