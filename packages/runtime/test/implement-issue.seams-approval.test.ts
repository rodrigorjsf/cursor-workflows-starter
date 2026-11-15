// Seam: the `observe` entry point reading what the shipped `implement-issue` workflow left behind when it stopped to ask a person about
// its seams (the real workflow, run with `runWorkflow` on the fake SDK and the recorded `gh` and `glab` fakes of
// implement-issue.fixture.ts). A dashboard decides on a proposal it did not make, so what it reads has to be what the workflow stored:
// the same seams, and the test command the run will execute once the proposal is approved. The actions that resume a run with the
// decision (`approveSeams`, `replaceSeams`) start real job processes and are tested through the dashboard's HTTP server.
import assert from "node:assert/strict";
import { PLAN, fx, forgeTest, issue, run, submit } from "./implement-issue.fixture.js";
import { readRun, seamsProposalOf } from "../src/observe.js";

const proposalOf = (runId: string) => {
  const detail = readRun(runId);
  assert.ok(detail, "the runs index names the run");
  return seamsProposalOf(detail);
};

/** A MED run that stopped at its seams proposal; its planner chose `plan`. */
async function proposed(plan: unknown = PLAN, title?: string) {
  issue(["complexity:medium"], title); // a read-only step is memoised by its prompt: another plan needs another issue text
  fx.handlers.plan = (o) => submit(o, plan);
  const first = await run({ testCommand: undefined }); // typed by nobody: the command is the planner's
  assert.equal((first.result as { status: string }).status, "seams-proposed", JSON.stringify(first.result));
  return first;
}

forgeTest("a run that stopped at its seams proposal offers the seams and the test command the plan will run once approved", async () => {
  const first = await proposed();
  const proposal = proposalOf(first.runId);
  assert.ok(proposal, "the run waits for a decision");
  assert.equal(proposal.stop, "seams-proposed");
  assert.deepEqual(proposal.seams, PLAN.seams);
  assert.equal(proposal.testCommand, PLAN.testCommand);
  assert.match(proposal.digest, /^[0-9a-f]{16}$/);
});

forgeTest("the test command is the kit's `npm test` when the planner proposed none", async () => {
  const first = await proposed({ ...PLAN, testCommand: "  " });
  assert.equal(proposalOf(first.runId)?.testCommand, "npm test");
});

forgeTest("a run that stopped at the test command the planner chose offers that command, as another proposal", async () => {
  const seams = await proposed({ ...PLAN, testCommand: "touch PWNED" });
  const asked = proposalOf(seams.runId);
  const stopped = await run({ seams: ["math.negate(a)"], testCommand: undefined }, seams.runId);
  assert.equal((stopped.result as { status: string }).status, "test-command-proposed", JSON.stringify(stopped.result));

  const proposal = proposalOf(seams.runId);
  assert.ok(proposal && asked, "both stops wait for a decision");
  assert.equal(proposal.stop, "test-command-proposed");
  assert.equal(proposal.testCommand, "touch PWNED");
  assert.notEqual(proposal.digest, asked.digest, "a page that showed the first proposal cannot approve the second");
});

forgeTest("a run that went on after the decision offers nothing", async () => {
  const first = await proposed();
  const second = await run({ approveSeams: true, testCommand: undefined }, first.runId);
  assert.equal((second.result as { status: string }).status, "done", JSON.stringify(second.result));
  assert.equal(proposalOf(first.runId), undefined);
});

forgeTest("a run that was never at a seams proposal offers nothing", async () => {
  issue(["complexity:low"]);
  const low = await run({});
  assert.equal((low.result as { status: string }).status, "done", JSON.stringify(low.result));
  assert.equal(proposalOf(low.runId), undefined);
});

forgeTest("two runs that stopped at different plans have different digests, and the digest is the same on every read", async () => {
  const one = await proposed();
  const two = await proposed({ ...PLAN, seams: [{ name: "math.negate", interface: "negate(a): number", why: "another plan" }] }, "Add negate(a)");
  assert.notEqual(proposalOf(one.runId)?.digest, proposalOf(two.runId)?.digest);
  assert.equal(proposalOf(one.runId)?.digest, proposalOf(one.runId)?.digest);
});
