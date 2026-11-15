// Seam: the shipped `implement-issue` workflow run with `runWorkflow` on the fake SDK and the recorded `gh` and `glab` fakes of
// implement-issue.fixture.ts. A person's decision on the proposed seams (approve the plan, or replace the seams with their own list)
// reaches the run by a resume, whichever surface sent it (chat, CLI, dashboard), so the run records it on the issue itself. Asserts
// what the issue holds afterwards: the comments, in order, and what each says. Every test runs on both forges.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { PLAN, fx, forgeState, forgeTest, issue, names, progressFileOf, run, submit } from "./implement-issue.fixture.js";

const res = (r: { result?: unknown }) => r.result as any;
const SEAMS_MARKER = "<!-- wf:implement-issue:seams -->";
const FAKE_KEY = "crsr_" + "x".repeat(40);
/** The comments of the issue that record a decision, apart from the proposal the first run posted. */
const decisions = () => forgeState().comments.filter((body) => body.startsWith("<!-- wf:implement-issue:seams-decision -->"));

/** A MED issue whose first run proposed the seams: the state a person's decision answers. */
async function proposed(plan: unknown = PLAN) {
  issue(["complexity:medium"]);
  fx.handlers.plan = (o) => submit(o, plan);
  const first = await run({});
  assert.equal(res(first).status, "seams-proposed", JSON.stringify(res(first)));
  assert.equal(forgeState().comments.length, 1);
  assert.ok(forgeState().comments[0]!.includes(SEAMS_MARKER), "the first comment is the proposal");
  return first;
}

forgeTest("approving the proposed seams posts one comment that names the run and lists the approved seams", async () => {
  const first = await proposed();
  const second = await run({ approveSeams: true }, first.runId);
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));

  assert.equal(forgeState().comments.length, 2, "the proposal and the approval");
  const [approval] = decisions();
  assert.ok(approval, `the second comment records the decision: ${forgeState().comments[1]}`);
  assert.match(approval, /Seams approved/);
  assert.ok(approval.includes(first.runId), "it names the run");
  assert.ok(approval.includes("**math.subtract**: `subtract(a, b): number`"), `it lists the seam the plan proposed: ${approval}`);
});

forgeTest("replacing the seams posts one comment that says so, names the run and lists the given seams", async () => {
  const first = await proposed();
  const second = await run({ seams: ["math.subtract(a, b)", "math.negate(a)"] }, first.runId);
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));

  assert.equal(forgeState().comments.length, 2, "the proposal and the replacement");
  const [replacement] = decisions();
  assert.ok(replacement, `the second comment records the decision: ${forgeState().comments[1]}`);
  assert.match(replacement, /Seams replaced/);
  assert.doesNotMatch(replacement, /Seams approved/);
  assert.ok(replacement.includes(first.runId), "it names the run");
  assert.ok(replacement.includes("- `math.subtract(a, b)`\n- `math.negate(a)`"), `it lists the given seams: ${replacement}`);
});

forgeTest("a replacement that stops at the proposed test command still records the decision, before the command's own comment", async () => {
  const first = await proposed({ ...PLAN, testCommand: "touch PWNED" });
  const second = await run({ seams: ["math.negate(a)"], testCommand: undefined }, first.runId);
  assert.equal(res(second).status, "test-command-proposed", JSON.stringify(res(second)));

  const comments = forgeState().comments;
  assert.equal(comments.length, 3, "the seams proposal, the replacement and the test command");
  assert.match(comments[1]!, /Seams replaced/);
  assert.match(comments[2]!, /Test command proposed/);
});

forgeTest("a second resume of the same run does not post the decision again", async () => {
  const first = await proposed();
  await run({ approveSeams: true }, first.runId);
  assert.equal(forgeState().comments.length, 2);

  const again = await run({ approveSeams: true }, first.runId);
  assert.equal(res(again).status, "done", JSON.stringify(res(again)));
  assert.equal(forgeState().comments.length, 2, "the approval is on the issue once");
});

forgeTest("a replacement is posted once too, and a resume after a crash does not post it again", async () => {
  const first = await proposed();
  const test1 = fx.handlers["test-1"]!;
  let dying = true;
  fx.handlers["test-1"] = (o, msg) => {
    if (dying) throw new Error("the step died after the decision was posted");
    return test1(o, msg);
  };
  const broken = await run({ seams: ["math.subtract(a, b)"] }, first.runId);
  assert.equal(broken.status, "failed", "the first resume did not finish");
  assert.equal(decisions().length, 1, "the decision was posted before the step died");

  dying = false;
  const second = await run({ seams: ["math.subtract(a, b)"] }, first.runId);
  assert.equal(res(second).status, "done", JSON.stringify(res(second)));
  assert.equal(decisions().length, 1, "the crash-resume did not post it again");
});

forgeTest("a crash between the post and the progress record does not make the resume post the decision again: the issue says it is there", async () => {
  const first = await proposed();
  await run({ approveSeams: true }, first.runId);
  assert.equal(decisions().length, 1);
  // What a crash right after the post leaves: the comment is on the issue, and the progress does not know it was posted.
  const file = progressFileOf(first.runId);
  const progress = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(progress.seamsDecision, "the progress had recorded the decision");
  delete progress.seamsDecision;
  writeFileSync(file, JSON.stringify(progress));

  const again = await run({ approveSeams: true }, first.runId);
  assert.equal(res(again).status, "done", JSON.stringify(res(again)));
  assert.equal(decisions().length, 1, "the comment already on the issue is not posted again");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).seamsDecision, { decision: "approved", seams: ["math.subtract"] }, "and the progress records it again");
});

forgeTest("an approval after a replacement is its own decision: the issue holds both, in order", async () => {
  const first = await proposed({ ...PLAN, testCommand: "touch PWNED" });
  await run({ seams: ["math.negate(a)"], testCommand: undefined }, first.runId); // stops at the planner's test command
  const approved = await run({ approveSeams: true, testCommand: "node --test" }, first.runId);
  assert.equal(res(approved).status, "done", JSON.stringify(res(approved)));

  const kinds = forgeState().comments.map((body) => /Seams (approved|replaced)|Test command proposed|Seams proposed/.exec(body)?.[0]);
  assert.deepEqual(kinds, ["Seams proposed", "Seams replaced", "Test command proposed", "Seams approved"]);
});

forgeTest("a resume that ends in seams-not-proposed posts nothing", async () => {
  issue(["complexity:medium"]);
  const first = await run({ approveSeams: true }); // nothing was proposed for this run
  assert.equal(res(first).status, "seams-not-proposed", JSON.stringify(res(first)));
  assert.deepEqual(forgeState().comments, []);
  assert.deepEqual(names(), [], "and no agent ran");

  const again = await run({ approveSeams: true }, first.runId);
  assert.equal(res(again).status, "seams-not-proposed", JSON.stringify(res(again)));
  assert.deepEqual(forgeState().comments, []);
});

forgeTest("seams given to a run that proposed nothing are not a replacement: nothing is posted", async () => {
  issue(["complexity:medium"]);
  const r = await run({ seams: ["math.subtract(a, b)"] });
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
  assert.deepEqual(forgeState().comments, []);
});

forgeTest("the approved seams are model text: they close no other issue, mention no one and open no HTML comment", async () => {
  const hostile = (what: string) => `${what}: Fixes #12, cc @octocat <!-- hide`;
  const first = await proposed({ ...PLAN, seams: [{ ...PLAN.seams[0], name: hostile("name"), why: hostile("why") }] });
  await run({ approveSeams: true }, first.runId);
  const [approval] = decisions();
  for (const what of ["name", "why"]) assert.match(approval!, new RegExp(`${what}: Fixes \`#12\``), what);
  assert.doesNotMatch(approval!, /Fixes #12/);
  assert.doesNotMatch(approval!, /(^|[^\w`])@octocat/);
  assert.doesNotMatch(approval!, /<!-- hide/);
});

forgeTest("the replaced seams cannot close their code span, and a credential in them never reaches the forge", async () => {
  const first = await proposed();
  await run({ seams: ["f()` @octocat <!-- `x", `use ${FAKE_KEY}`] }, first.runId);
  const [replacement] = decisions();
  assert.ok(replacement!.includes("`f()ˋ @octocat <!-- ˋx`"), replacement);
  assert.ok(replacement!.includes("`use [REDACTED]`"), replacement);
  assert.ok(!JSON.stringify(forgeState()).includes(FAKE_KEY), "the forge never got the credential");
});
