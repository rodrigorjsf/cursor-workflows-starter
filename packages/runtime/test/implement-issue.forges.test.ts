// Seam: the shipped `implement-issue` workflow run with `runWorkflow` on a repository whose `origin` is on a forge's host, with the
// fake SDK and the fake `gh` and `glab` of implement-issue.fixture.ts on the PATH (real git, one fake forge state). Asserts what the
// forge's CLI was asked and held afterwards, and what the run reports (its result and its progress record). The tests that hold for
// both forges run on both (`forgeTest`); the ones that name GitLab's own commands and routes run on gitlab.com only.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUB_CODE, branchOf, failForge, forgeState, forgeTest, fx, git, issue, run, submit, write, type TestForge } from "./implement-issue.fixture.js";

const res = (r: { result?: unknown }) => r.result as any;
const progressOf = (runId: string) => JSON.parse(readFileSync(join(fx.repo, ".workflows", "runs", runId, "tdd-progress.json"), "utf8")) as { forge?: string };
/** Changes what the fake forge holds: the comments the issue already has, the system notes GitLab added, the PRs that exist. */
function seed(change: (state: Record<string, unknown>) => void) {
  const state = JSON.parse(readFileSync(fx.forgeStateFile, "utf8"));
  change(state);
  writeFileSync(fx.forgeStateFile, JSON.stringify(state));
}
const SEAMS_MARKER = "<!-- wf:implement-issue:seams -->";
/** Makes `url` the URL of `origin`, reached through the bare repository the fixture made (as the fixture does for its own forge). */
function setOrigin(url: string) {
  git(fx.repo, "remote", "set-url", "origin", url);
  git(fx.repo, "config", "--add", `url.${join(fx.root, "origin.git")}.insteadOf`, url);
}

forgeTest("a run speaks only to the CLI of its origin's forge, and records that forge in its progress", async (forge) => {
  issue(["complexity:low"]);
  const r = await run({ openPr: true });
  assert.equal(res(r).status, "done", JSON.stringify(res(r)));
  assert.equal(progressOf(r.runId).forge, forge);
  assert.ok(forgeState().calls.length > 0, "the forge's CLI was asked");
  assert.equal(forgeState().wrongCli, undefined, `the other forge's CLI was never run: ${JSON.stringify(forgeState().wrongCli)}`);
});

/** The ways an origin URL names the host of each forge. */
const SPELLINGS: Record<TestForge, string[]> = {
  github: ["https://github.com/owner/repo.git", "git@github.com:owner/repo.git", "https://x-access-token:ghs_abc@GitHub.com/owner/repo"],
  gitlab: [
    "https://gitlab.com/group/sub/project.git",
    "https://oauth2:glpat-abc@gitlab.com/group/project.git",
    "git@gitlab.com:group/project.git",
    "ssh://git@gitlab.com:22/group/project.git",
    "https://GitLab.com/group/project",
  ],
};

forgeTest("a new run takes the forge of its origin's host, however the URL spells the host", async (forge) => {
  issue(["complexity:medium"]); // stops at the seams: the run reads the issue and posts, which is all this test needs
  for (const url of SPELLINGS[forge]) {
    setOrigin(url);
    const r = await run({});
    assert.equal(res(r).status, "seams-proposed", `${url}: ${JSON.stringify(res(r))}`);
    assert.equal(progressOf(r.runId).forge, forge, url);
  }
  assert.equal(forgeState().wrongCli, undefined, "the other forge's CLI was never run");
});

forgeTest(
  "a resume keeps the forge its record names, whatever the origin's host is by then",
  async () => {
    issue(["complexity:medium"]);
    const first = await run({});
    assert.equal(res(first).status, "seams-proposed", JSON.stringify(res(first)));
    assert.equal(progressOf(first.runId).forge, "github");

    setOrigin("https://gitlab.com/owner/repo.git"); // the repository moved; the run did not
    const second = await run({ approveSeams: true }, first.runId);
    assert.equal(res(second).status, "done", JSON.stringify(res(second)));
    assert.equal(progressOf(first.runId).forge, "github");
    assert.equal(forgeState().wrongCli, undefined, "glab was never run");
  },
  ["github"],
);

forgeTest(
  "a run whose record is from before the forge field is GitHub on resume, even when the origin is on gitlab.com now",
  async () => {
    issue(["complexity:low"]);
    setOrigin("https://gitlab.com/owner/repo.git");
    mkdirSync(join(fx.repo, ".workflows", "runs", "before-forges"), { recursive: true });
    writeFileSync(join(fx.repo, ".workflows", "runs", "before-forges", "tdd-progress.json"), JSON.stringify({ slices: [] })); // no `forge`: what every run recorded before the field existed
    const r = await run({}, "before-forges");
    assert.equal(res(r).status, "done", JSON.stringify(res(r)));
    assert.equal(progressOf("before-forges").forge, "github");
    assert.equal(forgeState().wrongCli, undefined, "glab was never run");
  },
  ["github"],
);

forgeTest("the issue's title and body reach the classifier, and a label, not the classifier, chooses the tier when one matches", async () => {
  issue(["needs-triage"], "Add subtract(a, b)");
  let prompt = "";
  fx.handlers.classify = (o, msg) => {
    prompt = msg;
    submit(o, { tier: "LOW", reason: "typical" });
  };
  const unlabelled = await run({});
  assert.equal(res(unlabelled).tier, "LOW");
  assert.match(prompt, /Add subtract\(a, b\)/);
  assert.match(prompt, /Exportar `subtract\(a, b\)` em src\/math\.js/);

  issue(["complexity:medium", "needs-triage"]);
  let classified = false;
  fx.handlers.classify = (o) => {
    classified = true;
    submit(o, { tier: "LOW", reason: "typical" });
  };
  const labelled = await run({});
  assert.equal(res(labelled).tier, "MED");
  assert.equal(classified, false, "a label chose the tier: the classifier was not asked");
});

forgeTest("the seams comment is posted once: a resume does not post it again when the issue has more than 20 comments", async () => {
  issue(["complexity:medium"]);
  seed((state) => (state.comments = Array.from({ length: 24 }, (_, i) => `an earlier comment, ${i + 1}`)));
  const first = await run({});
  assert.equal(res(first).status, "seams-proposed", JSON.stringify(res(first)));
  assert.equal(forgeState().comments.length, 25, "the comment is the 25th: past the first page of 20");

  const second = await run({}, first.runId);
  assert.equal(res(second).status, "seams-proposed", JSON.stringify(res(second)));
  assert.equal(forgeState().comments.length, 25, "the resume found its comment past the first page and did not post it again");
});

// ── GitLab: the commands and routes of glab ──────────────────────────────────────────

forgeTest(
  "a system note is not a comment: one that quotes the seams comment does not stop the run from posting it",
  async () => {
    issue(["complexity:medium"]);
    seed((state) => (state.systemNotes = [`mentioned ${SEAMS_MARKER} run-a`]));
    const r = await run({}, "run-a");
    assert.equal(res(r).status, "seams-proposed", JSON.stringify(res(r)));
    assert.equal(forgeState().comments.length, 1, "the comment was posted although a system note held the same text");
  },
  ["gitlab"],
);

forgeTest(
  "the issue is read with `glab issue view --output json`, and its notes through the REST API with every page asked for",
  async () => {
    issue(["complexity:medium"]);
    await run({});
    const calls = forgeState().calls;
    assert.deepEqual(calls[0], ["issue", "view", "7", "--output", "json"]);
    assert.deepEqual(calls.find((c) => c[0] === "api" && !c.includes("POST")), ["api", "--paginate", "projects/:fullpath/issues/7/notes"]);
  },
  ["gitlab"],
);

forgeTest(
  "the comment is posted as a note whose body glab reads from a file, not as text on the command line",
  async () => {
    issue(["complexity:medium"]);
    await run({});
    const post = forgeState().calls.find((c) => c.includes("POST"))!;
    assert.deepEqual(post.slice(0, 4), ["api", "--method", "POST", "projects/:fullpath/issues/7/notes"]);
    assert.equal(post[4], "-F");
    assert.match(post[5]!, /^body=@\/.+/, "the body is a file");
    assert.match(forgeState().comments[0]!, /Seams proposed by the `implement-issue` workflow/);
  },
  ["gitlab"],
);

forgeTest(
  "the MR is opened from the run's branch with --source-branch, never -H (the head repository), and its URL is the run's prUrl",
  async () => {
    issue(["complexity:low"]);
    const r = await run({ openPr: true });
    assert.equal(res(r).status, "done", JSON.stringify(res(r)));
    const create = forgeState().calls.find((c) => c[0] === "mr" && c[1] === "create")!;
    assert.equal(create[create.indexOf("--source-branch") + 1], branchOf(r.runId));
    assert.ok(create.includes("--yes"), "no prompt");
    assert.ok(!create.includes("-H") && !create.includes("--head"), `no -H: ${create.join(" ")}`);
    assert.equal(create[create.indexOf("--title") + 1], "Add subtract(a, b) (#7)");
    assert.match(forgeState().prs[0]!.body, /^Closes #7/m, "the description is the PR body: GitLab closes the issue from `Closes #7`");
    assert.equal(res(r).prUrl, "https://gitlab.com/owner/repo/-/merge_requests/1", "the URL out of the text glab prints around it");
  },
  ["gitlab"],
);

forgeTest(
  "with several MRs on the branch the latest one is the run's: its URL is used and no other is opened",
  async () => {
    issue(["complexity:low"]);
    const branch = branchOf("run-a");
    seed((state) => {
      state.prs = [
        { url: "https://gitlab.com/owner/repo/-/merge_requests/1", body: "the first, closed", head: branch, state: "CLOSED" },
        { url: "https://gitlab.com/owner/repo/-/merge_requests/2", body: "the second, the latest", head: branch, state: "OPEN" },
      ];
    });
    const r = await run({ openPr: true }, "run-a");
    assert.equal(res(r).status, "done", JSON.stringify(res(r)));
    assert.equal(res(r).prUrl, "https://gitlab.com/owner/repo/-/merge_requests/2");
    assert.equal(forgeState().prs.length, 2, "no third MR was opened");
  },
  ["gitlab"],
);

forgeTest(
  "a repository named in --repo goes to glab as its path, and the one that is the cwd's own shares the cwd's issue lock",
  async () => {
    const locksDuring: string[][] = [];
    fx.handlers["code-1"] = (o) => {
      locksDuring.push(readdirSync(join(fx.repo, ".workflows", "locks")));
      write(o, "src/math.js", SUB_CODE);
      submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
    };
    issue(["complexity:low"]);
    const own = await run({ repo: "owner/repo" });
    assert.equal(res(own).status, "done", JSON.stringify(res(own)));
    assert.deepEqual(locksDuring[0], ["issue-7.lock"], "owner/repo is the repository of the cwd: the lock of issue 7");

    issue(["complexity:low"]);
    const other = await run({ repo: "other/x", openPr: true });
    assert.equal(res(other).status, "done", JSON.stringify(res(other)));
    assert.match(locksDuring[1]![0]!, /^issue-7-[0-9a-f]{12}\.lock$/, "other/x is another repository: a lock of its own");
    const calls = forgeState().calls;
    assert.ok(calls.some((c) => c.join(" ") === "issue view 7 --repo other/x --output json"), "the issue is read from the named repository");
    assert.ok(calls.some((c) => c.join(" ") === "api projects/other%2Fx"), "the lock asks glab which repository it is, by its path");
    const lookup = `projects/other%2Fx/merge_requests?source_branch=${encodeURIComponent(branchOf(other.runId))}&order_by=created_at&sort=desc&per_page=1`;
    assert.ok(calls.some((c) => c.join(" ") === `api ${lookup}`), "its MR is looked up by the project path, the latest first");
    const create = calls.find((c) => c[0] === "mr" && c[1] === "create")!;
    assert.equal(create[create.indexOf("--repo") + 1], "other/x");
  },
  ["gitlab"],
);

forgeTest(
  "a glab error is an error, never \"no MR\": the run fails with what glab said and opens nothing on the strength of it",
  async () => {
    issue(["complexity:low"]);
    failForge("pr view", "glab: 401 Unauthorized");
    const r = await run({ openPr: true });
    assert.equal(r.status, "failed", JSON.stringify(r.result));
    assert.match(r.error!, /glab api/);
    assert.match(r.error!, /401 Unauthorized/);
    assert.equal(forgeState().prs.length, 0);
  },
  ["gitlab"],
);
