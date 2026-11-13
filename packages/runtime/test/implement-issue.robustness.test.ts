// Seam 1, the run: `implement-issue` against the fake SDK, the fake gh and a temporary git repository (the environment is in
// implement-issue.fixture.ts). The tier comes from the highest matching label, a step that crashes the process again and
// again stops being resumed, and every retry of a write step starts from a clean tree.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { runWorkflow } from "../src/runtime/engine.js";
import implementIssue from "../workflows/implement-issue.js";
import { PLAN, SUB_CODE, SUB_TEST, branchOf, failForge, forgeTest, fx, git, issue, names, run, submit, worktreeOf, write } from "./implement-issue.fixture.js";
import { writeRepoConfig } from "./config-fixtures.js";
import { waitFor } from "./wait-for.js";

const res = (r: { result?: unknown }) => r.result as any;
const DESIGN = { interface: "subtract(a, b)", usage: "subtract(5, 3)", hides: "nada", dependencies: "em processo", tradeoffs: "-" };

// ── The tier is the highest of the matching labels ───────────────────────────────────────

forgeTest("when several complexity labels match, the tier is the highest one, whatever the label order", async () => {
  fx.handlers["design:minimal"] = (o) => submit(o, DESIGN);
  fx.handlers["design:flexible"] = (o) => submit(o, DESIGN);
  fx.handlers["design:common"] = (o) => submit(o, DESIGN);
  fx.handlers.judge = (o) => submit(o, PLAN);
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

forgeTest("a label named like a member of Object.prototype is only a label: with no known label the classifier decides", async () => {
  issue(["constructor", "toString"]);
  fx.handlers.classify = (o) => submit(o, { tier: "MED", reason: "typical" });
  const r = await run({});
  assert.equal(res(r).tier, "MED");
  assert.ok(names().includes("classify"), "no label matched: the classifier ran");
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

forgeTest("a step that crashed the process more than the limit fails instead of resuming again; raising the limit resumes it", async () => {
  issue(["complexity:low"]);
  fx.handlers["code-1"] = FALL;
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
  fx.handlers["code-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE);
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  const resumed = await run({}, first.runId);
  assert.equal(res(resumed).status, "done", JSON.stringify(res(resumed)));
});

forgeTest("while a write step runs, the progress on disk says it is in flight (what a crash leaves for the resume to count) and it is cleared when the step ends", async () => {
  issue(["complexity:low"]);
  let inFlight: { id: string; before: string; interrupted?: boolean } | undefined;
  fx.handlers["code-1"] = (o) => {
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

forgeTest("a limit of 0 stops the step at the first crash", async () => {
  issue(["complexity:low"]);
  writeRepoConfig(fx.repo, { workflows: { "implement-issue": { settings: { maxStepCrashes: 0 } } } });
  fx.handlers["code-1"] = FALL;
  const first = await run({});
  assert.equal(first.status, "failed");
  crashInGreen(first.runId);
  const stopped = await run({}, first.runId);
  assert.equal(res(stopped).status, "step-crash-loop", JSON.stringify(res(stopped)));
  assert.equal(res(stopped).crashes, 1);
  assert.equal(res(stopped).limit, 0);
});

forgeTest("a cancel in the middle of a write step is not a crash: any number of them still resumes", async () => {
  issue(["complexity:low"]);
  fx.handlers["code-1"] = (o) => {
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
        if (e.type === "step-start" && e.label === "code-1") setTimeout(() => controller.abort(), 100);
      },
    });
    assert.equal(cancelled.status, "cancelled", `cancel ${n}`);
    runId = cancelled.runId;
    assert.ok(progressOf(runId).inFlight, "the cancelled step is still marked in flight, so the resume undoes it");
  }
  fx.handlers["code-1"] = (o) => {
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
    await waitFor("the cancelled body to mark the step interrupted", () => progressOf(runId).inFlight?.interrupted === true); // the body unwinds after the run ends
    const p = progressOf(runId);
    assert.ok(p.inFlight?.execution, `cut ${cut} (${at}): the step is in flight, with the execution that began it: ${JSON.stringify(p.inFlight)}`);
    delete p.inFlight.interrupted;
    writeFileSync(progressFile(runId), JSON.stringify(p));
  }
  throw new Error(`${label}: the step was never got past`);
}

for (const [step, label] of [["red", "test-1"], ["green", "code-1"], ["refactor", "refactor-1"]] as const) {
  forgeTest(`a cancel at any command of the ${step} step after its agent answered (the suite, a snapshot, a check) is not a crash`, async () => {
    issue(["complexity:low"]);
    // The red step also writes code, which the workflow discards: one more command (the restore) inside the step.
    fx.handlers["test-1"] = (o) => {
      write(o, "test/sub.test.js", SUB_TEST);
      write(o, "src/stub.js", "export const stub = 1;\n");
      submit(o, { testFile: "test/sub.test.js", testName: "subtract" });
    };
    if (step === "refactor") {
      let round = 0;
      fx.handlers["review:standards"] = (o) =>
        submit(o, ++round === 1 ? { findings: [{ file: "src/math.js", rule: "Mysterious Name", kind: "hard", note: "bad name" }], worst: "name" } : { findings: [], worst: "" });
      fx.handlers["refactor-1"] = (o) => {
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

forgeTest("a crash is still counted when the next execution fails before it reaches the step, and when the execution that began the step ended failed", async () => {
  issue(["complexity:low"]);
  fx.handlers["code-1"] = FALL;
  const first = await run({}); // execution 1 ends failed
  assert.equal(first.status, "failed");
  crashInGreen(first.runId, 1); // a failed execution is no evidence the process lived through the step
  failForge("issue view", "HTTP 502: Bad Gateway"); // the next execution fails in triage, before the resume looks at the step
  const triage = await run({}, first.runId);
  assert.equal(triage.status, "failed", JSON.stringify(triage));
  assert.equal(progressOf(first.runId).inFlight?.interrupted, undefined, "the failed execution did not mark a step it did not begin");
  failForge("issue view", undefined);
  fx.handlers["code-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE);
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  const resumed = await run({}, first.runId);
  assert.equal(res(resumed).status, "done", JSON.stringify(res(resumed)));
  assert.deepEqual(Object.values(progressOf(first.runId).crashes ?? {}), [1]);
});

forgeTest("a resume cancelled while it undoes a step that crashed the process still counts that crash, once", async () => {
  issue(["complexity:low"]);
  fx.handlers["code-1"] = FALL;
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
  fx.handlers["code-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE);
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  const resumed = await run({}, first.runId);
  assert.equal(res(resumed).status, "done", JSON.stringify(res(resumed)));
  assert.deepEqual(Object.values(progressOf(first.runId).crashes ?? {}), [1], "and the cancelled undo is not a second crash");
});

forgeTest("a command that fails after a write step's agent answered is not a crash: the run's catch marks the step, and the resume counts nothing", async () => {
  issue(["complexity:low"]);
  let lock = "";
  let once = true;
  fx.handlers["test-1"] = (o) => {
    write(o, "test/sub.test.js", SUB_TEST);
    if (once) {
      once = false;
      const gd = git(o.local.cwd, "rev-parse", "--git-dir").trim();
      lock = join(isAbsolute(gd) ? gd : join(o.local.cwd, gd), "index.lock");
      writeFileSync(lock, ""); // the snapshot after the step (`git add -A`) fails: a CommandError, not a cancel
    }
    submit(o, { testFile: "test/sub.test.js", testName: "subtract" });
  };
  const first = await run({});
  assert.equal(first.status, "failed", JSON.stringify(first));
  assert.match(String(first.error), /index\.lock/);
  assert.equal(progressOf(first.runId).inFlight?.interrupted, true, JSON.stringify(progressOf(first.runId).inFlight));
  rmSync(lock, { force: true });
  const resumed = await run({}, first.runId);
  assert.deepEqual(progressOf(first.runId).crashes ?? {}, {}, "a failed git is not a crash");
  assert.equal(res(resumed).status, "done", JSON.stringify(res(resumed)));
});

forgeTest("a step begun after a cancelled execution belongs to the execution that began it: if that one did not end cancelled, the resume counts a crash", async () => {
  issue(["complexity:low"]);
  const runId = "implement-issue-cancelthenfall";
  let lock = "";
  let execution = 0;
  fx.handlers["code-1"] = (o) => {
    if (execution === 1) return { hang: true }; // cancelled while the step runs
    write(o, "src/math.js", SUB_CODE);
    if (execution === 2) {
      const gd = git(o.local.cwd, "rev-parse", "--git-dir").trim();
      lock = join(isAbsolute(gd) ? gd : join(o.local.cwd, gd), "index.lock");
      writeFileSync(lock, ""); // the check after the step fails: execution 2 ends failed, not cancelled
    }
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  for (execution = 1; execution <= 2; execution++) {
    const controller = new AbortController();
    const r = await runWorkflow(implementIssue, { issue: 7, testCommand: "node --test" } as any, {
      cwd: fx.repo,
      runId,
      signal: controller.signal,
      onEvent: (e) => {
        if (execution === 1 && e.type === "step-start" && e.label === "code-1") setTimeout(() => controller.abort(), 100);
      },
    });
    assert.equal(r.status, execution === 1 ? "cancelled" : "failed", `execution ${execution}: ${JSON.stringify(r)}`);
    await waitFor("the cancelled body to mark the step interrupted", () => progressOf(runId).inFlight?.interrupted === true); // the body unwinds after the run ends
    const p = progressOf(runId);
    assert.equal(p.inFlight?.execution, execution, `the step in flight says which execution began it: ${JSON.stringify(p.inFlight)}`);
    delete p.inFlight.interrupted; // as when the process dies before the catch writes the mark
    writeFileSync(progressFile(runId), JSON.stringify(p));
  }
  rmSync(lock, { force: true });
  const resumed = await run({}, runId);
  assert.equal(res(resumed).status, "done", JSON.stringify(res(resumed)));
  assert.deepEqual(Object.values(progressOf(runId).crashes ?? {}), [1], "execution 2 began the step and ended failed: one crash");
});

// ── A fix round counts once its fix step ran to its end ──────────────────────────────────

/** Green writes a wrong subtract: the green suite fails and the fix rounds start. */
const WRONG_SUB = SUB_CODE.replace("a - b", "a + b");
const wrongGreen = (o: any) => {
  write(o, "src/math.js", WRONG_SUB);
  submit(o, { summary: "s", filesChanged: ["src/math.js"] });
};
const rightFix = (o: any) => {
  write(o, "src/math.js", SUB_CODE);
  submit(o, { summary: "fixed", filesChanged: ["src/math.js"] });
};

forgeTest("a cancel while a fix step runs does not use up the fix round: the resume runs the same round again", async () => {
  issue(["complexity:low"]);
  fx.handlers["code-1"] = wrongGreen;
  fx.handlers["fix-1-1"] = rightFix;
  fx.handlers["fix-1-2"] = rightFix;
  const runId = "implement-issue-fixcancel1";
  // More cancels than the default fixRounds (2): none of them may count as a round.
  for (let n = 1; n <= 3; n++) {
    const controller = new AbortController();
    const r = await runWorkflow(implementIssue, { issue: 7, testCommand: "node --test" } as any, {
      cwd: fx.repo,
      runId,
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === "step-start" && String(e.label).startsWith("fix-")) controller.abort();
      },
    });
    assert.equal(r.status, "cancelled", `cancel ${n}: ${JSON.stringify(r)}`);
  }
  const resumed = await run({}, runId);
  assert.equal(res(resumed).status, "done", JSON.stringify(res(resumed)));
  assert.ok(!names().includes("fix-1-2"), `every cancelled step was round 1: ${names().join(", ")}`);
});

forgeTest("a fix step that ran to its end counts, even when the run is cancelled during its suite: the resume goes on to the next round", async () => {
  issue(["complexity:low"]);
  fx.handlers["code-1"] = wrongGreen;
  fx.handlers["fix-1-1"] = (o) => {
    write(o, "src/math.js", SUB_CODE.replace("a - b", "a * b")); // still wrong
    submit(o, { summary: "tried", filesChanged: ["src/math.js"] });
  };
  fx.handlers["fix-1-2"] = rightFix;
  const runId = "implement-issue-fixsuitecancel";
  const controller = new AbortController();
  const cancelled = await runWorkflow(implementIssue, { issue: 7, testCommand: "node --test" } as any, {
    cwd: fx.repo,
    runId,
    signal: controller.signal,
    onEvent: (e) => {
      if (e.type === "exec-start" && String(e.label).startsWith("suite:fix:1:1")) controller.abort();
    },
  });
  assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
  const resumed = await run({}, runId);
  assert.equal(res(resumed).status, "done", JSON.stringify(res(resumed)));
  assert.deepEqual(names().filter((s) => s.startsWith("fix-")), ["fix-1-1", "fix-1-2"], "round 1 is not run again");
});

forgeTest("a right fix that ran to its end stays when the run is cancelled during its suite: the resume keeps it and runs no other round", async () => {
  issue(["complexity:low"]);
  fx.handlers["code-1"] = wrongGreen;
  fx.handlers["fix-1-1"] = rightFix;
  const runId = "implement-issue-fixsuitecancel-right";
  const controller = new AbortController();
  const cancelled = await runWorkflow(implementIssue, { issue: 7, testCommand: "node --test" } as any, {
    cwd: fx.repo,
    runId,
    signal: controller.signal,
    onEvent: (e) => {
      if (e.type === "exec-start" && String(e.label).startsWith("suite:fix:1:1")) controller.abort();
    },
  });
  assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
  const resumed = await run({}, runId);
  assert.equal(res(resumed).status, "done", JSON.stringify(res(resumed)));
  assert.deepEqual(names().filter((s) => s.startsWith("fix-")), ["fix-1-1"], "the counted fix is not undone, so no round 2");
});

forgeTest("a fix step that crashes the process again and again stops at the crash limit, like any write step", async () => {
  issue(["complexity:low"]);
  fx.handlers["code-1"] = wrongGreen;
  // The fix step "crashes": what the progress held while it ran is what a dead process leaves behind.
  let held: string | undefined;
  const crashingFix = (o: any) => {
    held ??= readFileSync(progressFile(runId), "utf8");
    write(o, "src/math.js", `${WRONG_SUB}// half-made edit\n`);
    return FALL();
  };
  fx.handlers["fix-1-1"] = crashingFix;
  fx.handlers["fix-1-2"] = crashingFix;
  const runId = "implement-issue-fixcrash";
  const crash = () => {
    assert.ok(held, "the fix step ran");
    writeFileSync(progressFile(runId), held!);
    writeFileSync(join(worktreeOf(runId), "stray.txt"), "half-made edit\n");
    held = undefined;
  };
  const first = await run({}, runId);
  assert.equal(first.status, "failed", JSON.stringify(first));
  crash();
  // The default limit is 2: the step is resumed after its first and second crash, as the same round...
  for (const n of [1, 2]) {
    const resumed = await run({}, runId);
    assert.equal(resumed.status, "failed", `resume ${n} ran the fix step again: ${JSON.stringify(resumed)}`);
    crash();
  }
  // ...and not after its third.
  const stopped = await run({}, runId);
  assert.equal(res(stopped).status, "step-crash-loop", JSON.stringify(res(stopped)));
  assert.match(res(stopped).step, /^fix:.*:1$/);
  assert.equal(res(stopped).crashes, 3);
  assert.ok(!names().includes("fix-1-2"), `a crashed round is not a round that ran: ${names().join(", ")}`);
});

// ── A retried write step starts from a clean tree ────────────────────────────────────────

forgeTest("what a failed attempt of a write step left in the worktree is gone when the step is retried, and is not delivered", async () => {
  issue(["complexity:low"]);
  let attempt = 0;
  const seenByRetry: boolean[] = [];
  fx.handlers["code-1"] = (o) => {
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
