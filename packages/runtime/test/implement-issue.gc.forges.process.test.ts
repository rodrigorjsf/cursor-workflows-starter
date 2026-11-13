// Seam: the `wf gc` CLI as a child process on a repository whose `origin` is on a forge's host (ADR-0009), asserting what it removes, what
// it keeps and which forge CLI it was asked. Real: git with a bare origin, the runs gc judges (made by `runWorkflow`) and the process.
// Stand-ins: the fake SDK, and the fake `gh` and `glab` of implement-issue.fixture.ts on the PATH (one fake forge state; the CLI of the
// other forge fails the call and records it in `wrongCli`). What happened on the forge (an MR merged, closed, locked) is set in the
// fake; what happened to the origin afterwards (the remote moved to another host) is set in the repo. The GitHub-only behaviour of gc
// stays in implement-issue.gc.process.test.ts.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { branchOf, changeForgeState, failForge, forgeState, forgeTest, fx, issue, originBranches, run, setOrigin, setPrState, worktreeOf, type TestForge } from "./implement-issue.fixture.js";
import { type GcOutput, age, delivered, editRecord, gc, stillThere } from "./implement-issue.gc.fixture.js";

/** `forgeTest`, on an issue whose label makes one slice and no planner: a run on it per scenario. */
const gcTest = (title: string, fn: (forge: TestForge) => unknown, forges?: readonly TestForge[]) =>
  forgeTest(
    title,
    async (forge) => {
      issue(["complexity:low"]);
      await fn(forge);
    },
    forges,
  );

/** The CLI of the forge the test is not on was never run: a run or a branch was never asked on the wrong forge. */
const assertWrongCliNeverRan = () => assert.equal(forgeState().wrongCli, undefined, `the other forge's CLI was run: ${JSON.stringify(forgeState().wrongCli)}`);
/** What the plan removes, as [run, reason, [action kind, target, result]]: no run for a branch that none owns. */
const removals = (out: GcOutput) => out.remove.map((x) => [x.runId, x.reason, x.actions.map((a) => [a.kind, a.target, a.result])]);

const GONE = { worktree: false, localBranch: false, originBranch: false };
const KEPT = { worktree: true, localBranch: true, originBranch: true };
const mrLookups = (since: number) => forgeState().calls.slice(since).filter((c) => c[0] === "api" && c.some((a) => a.includes("/merge_requests?")));

// The four states GitLab's REST API gives a merge request: the two that are live keep the branch, the two that are done lead to the
// actions a merged or closed PR leads to on GitHub.
for (const { glab, set, outcome } of [
  { glab: "opened", set: "OPEN", outcome: "kept" },
  { glab: "locked", set: "locked", outcome: "kept" },
  { glab: "merged", set: "MERGED", outcome: "pr-merged" },
  { glab: "closed", set: "CLOSED", outcome: "pr-closed" },
] as const) {
  gcTest(
    `gc reads a merge request that is ${glab} through glab: ${outcome === "kept" ? "the run and its branches stay" : "the worktree, the local branch and the origin branch go"}`,
    async () => {
      const d = await delivered();
      setPrState(d.branch, set);
      const since = forgeState().calls.length;

      const r = gc();
      assert.equal(r.status, 0, r.stderr);
      assert.ok(mrLookups(since).some((c) => c.some((a) => a.includes(`source_branch=${encodeURIComponent(d.branch)}`))), "gc asked glab for the merge request of the run's branch");
      assertWrongCliNeverRan();
      if (outcome === "kept") {
        assert.deepEqual(stillThere(d), KEPT);
        assert.deepEqual(r.out.remove, []);
        assert.match(r.out.kept.find((x) => x.runId === d.runId)?.why ?? "", /PR is open/);
      } else {
        assert.deepEqual(stillThere(d), GONE);
        assert.deepEqual(
          removals(r.out),
          [[d.runId, outcome, [["worktree", d.worktree, "removed"], ["local-branch", d.branch, "removed"], ["remote-branch", d.branch, "removed"]]]],
        );
      }
    },
    ["gitlab"],
  );
}

// What `opened` and `locked` being open is for: a run that failed long ago loses its worktree and its local branch, but deleting its
// origin branch would close a live merge request, so that stays.
for (const [glab, set] of [["opened", "OPEN"], ["locked", "locked"]] as const) {
  gcTest(
    `a failed run whose merge request is ${glab} loses its worktree and local branch, but its origin branch stays: deleting it would close the MR`,
    async () => {
      const d = await delivered();
      const resumed = await run({ openPr: true, testCommand: "exit 1" }, d.runId); // the resume fails after the MR was opened
      assert.equal((resumed.result as { status: string }).status, "tests-failed");
      setPrState(d.branch, set);
      age(d.runId, 30);

      const r = gc();
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(stillThere(d), { worktree: false, localBranch: false, originBranch: true });
      assert.match(r.out.remove[0]!.notes.join("\n"), /its PR is open/);
    },
    ["gitlab"],
  );
}

gcTest("gc asks the forge the run recorded, not the one its origin names now: the remote moved to the other forge's host", async (forge) => {
  const d = await delivered();
  setPrState(d.branch, "MERGED");
  setOrigin(forge === "gitlab" ? "https://github.com/owner/repo.git" : "https://gitlab.com/owner/repo.git");
  const since = forgeState().calls.length;

  const r = gc();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(forgeState().calls.slice(since).some((c) => c.some((a) => a.includes(d.branch) || a.includes(encodeURIComponent(d.branch)))), `${forge === "gitlab" ? "glab" : "gh"} was asked about the run's branch`);
  assertWrongCliNeverRan();
  assert.deepEqual(stillThere(d), GONE);
  assert.equal(r.out.remove.find((x) => x.runId === d.runId)?.reason, "pr-merged");
});

gcTest("gc asks gh for a run whose record has no forge, though its origin names GitLab now: a run from before the field is a GitHub run", async () => {
  const d = await delivered(); // on GitHub: the fake gh answers
  editRecord(d.runId, (record) => {
    assert.equal(record.forge, "github", "the workflow recorded it");
    delete record.forge;
  });
  setPrState(d.branch, "MERGED");
  setOrigin("https://gitlab.com/owner/repo.git");

  const r = gc();
  assert.equal(r.status, 0, r.stderr);
  assertWrongCliNeverRan();
  assert.deepEqual(stillThere(d), GONE);
  assert.equal(r.out.remove.find((x) => x.runId === d.runId)?.reason, "pr-merged");
}, ["github"]);

gcTest("gc takes the latest merge request of a branch: an older closed one does not make a run with a live MR a finished run", async () => {
  const d = await delivered(); // its MR is open
  changeForgeState((state) => state.prs.unshift({ url: "https://gitlab.com/owner/repo/-/merge_requests/99", body: "", head: d.branch, state: "CLOSED" })); // an MR of the branch from before

  const r = gc();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(stillThere(d), KEPT);
  assert.match(r.out.kept.find((x) => x.runId === d.runId)?.why ?? "", /PR is open/);
}, ["gitlab"]);

gcTest("gc prefers an open merge request of a branch to a newer closed one, as gh does: the branch of a live MR is kept", async () => {
  const d = await delivered(); // its MR is open
  changeForgeState((state) => state.prs.push({ url: "https://gitlab.com/owner/repo/-/merge_requests/98", body: "", head: d.branch, state: "CLOSED" })); // a newer MR of the branch, closed

  const r = gc();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(stillThere(d), KEPT);
  assert.match(r.out.kept.find((x) => x.runId === d.runId)?.why ?? "", /PR is open/);
}, ["gitlab"]);

gcTest("a run that pushed and never got its merge request is a failed run like any: glab answering an empty list is \"no MR\", and the origin branch goes with it", async () => {
  failForge("pr create", "HTTP 502");
  const r = await run({ openPr: true });
  assert.equal(r.status, "failed", "the push went through, the MR did not");
  const pushed = { branch: branchOf(r.runId), worktree: worktreeOf(r.runId) };
  assert.deepEqual(stillThere(pushed), KEPT);
  age(r.runId, 30);

  const out = gc();
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(stillThere(pushed), GONE);
  assert.equal(out.out.remove.find((x) => x.runId === r.runId)?.reason, "failed");
}, ["gitlab"]);

gcTest("when glab cannot say what became of a merge request the run is kept and gc fails: an auth error is not \"no MR\"", async () => {
  const d = await delivered();
  setPrState(d.branch, "MERGED");
  failForge("pr view", "HTTP 401 Unauthorized");

  const r = gc();
  assert.equal(r.status, 1);
  assert.deepEqual(stillThere(d), KEPT);
  assert.match(r.out.errors.join("\n"), new RegExp(`${d.runId}.*401`));
  assert.deepEqual(r.out.remove, []);
}, ["gitlab"]);

gcTest("a wf/ branch on a GitLab origin that no run of this repo owns is judged by its merge request, through glab: gone when merged or closed, kept when opened or locked", async () => {
  // Runs made in another clone: their branches are on the origin and their MRs on GitLab, but this repo has no state for them.
  const merged = await delivered();
  const closed = await delivered();
  const opened = await delivered();
  const locked = await delivered();
  rmSync(join(fx.repo, ".workflows", "runs"), { recursive: true });
  setPrState(merged.branch, "MERGED");
  setPrState(closed.branch, "CLOSED");
  setPrState(locked.branch, "locked");

  const r = gc();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.errors, []);
  assertWrongCliNeverRan();
  assert.deepEqual(originBranches().sort(), [opened.branch, locked.branch].sort());
  assert.deepEqual(
    removals(r.out).sort(),
    [
      [undefined, "pr-closed", [["remote-branch", closed.branch, "removed"]]],
      [undefined, "pr-merged", [["remote-branch", merged.branch, "removed"]]],
    ].sort(),
  );
}, ["gitlab"]);
