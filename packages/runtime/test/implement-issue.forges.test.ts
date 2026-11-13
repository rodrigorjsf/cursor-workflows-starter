// Seam: the shipped `implement-issue` workflow run with `runWorkflow` on a repository whose `origin` is on a forge's host, with the
// fake SDK and the fake `gh` and `glab` of implement-issue.fixture.ts on the PATH (real git, one fake forge state). Asserts what the
// forge's CLI was asked and held afterwards, and what the run reports (its result and its progress record). The tests that hold for
// both forges run on both (`forgeTest`); the ones that name GitLab's own commands and routes run on gitlab.com only.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { calls } from "@cursor/sdk";
import { writeGlobalConfig, writeRepoConfig } from "./config-fixtures.js";
import { SUB_CODE, branchOf, changeForgeState, failForge, forgeState, forgeTest, fx, git, issue, progressFileOf, run, setOrigin, submit, write, type TestForge } from "./implement-issue.fixture.js";

const res = (r: { result?: unknown }) => r.result as any;
const progressOf = (runId: string) => JSON.parse(readFileSync(progressFileOf(runId), "utf8")) as { forge?: string };
const SEAMS_MARKER = "<!-- wf:implement-issue:seams -->";

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

// ── The forges map: hosts the kit does not know, and the repo argument's own host ──────

/** A host the kit does not know, in each forge's tests. */
const SELF_MANAGED: Record<TestForge, string> = { github: "ghe.corp.example", gitlab: "git.example.com" };
const OTHER: Record<TestForge, TestForge> = { github: "gitlab", gitlab: "github" };
/** Makes the fake CLI of `forge` the one that answers: the test's `origin` and the repository it names are on different forges. */
const answerWith = (forge: TestForge) => changeForgeState((state) => (state.forge = forge));
/** What a run that fails before any step leaves: no forge call, no agent, no progress record, no lock, no run branch. */
function assertNothingStarted(message: string) {
  assert.deepEqual(forgeState().calls, [], `${message}: no forge call`);
  assert.equal(forgeState().wrongCli, undefined, `${message}: no wrong CLI`);
  assert.equal(calls.length, 0, `${message}: no agent`);
  const locks = join(fx.repo, ".workflows", "locks");
  assert.deepEqual(existsSync(locks) ? readdirSync(locks).filter((name) => name.startsWith("issue-")) : [], [], `${message}: no issue lock held`);
  assert.equal(git(fx.repo, "branch", "--list", "wf/*").trim(), "", `${message}: no run branch`);
}

forgeTest("an origin on a host the config declares runs with that host's forge: declared in the global file, in the repo file, and the repo file's word wins", async (forge) => {
  const host = SELF_MANAGED[forge];
  issue(["complexity:medium"]);
  setOrigin(`https://${host}/group/project.git`);

  writeGlobalConfig({ forges: { [host]: forge } });
  const viaGlobal = await run({});
  assert.equal(res(viaGlobal).status, "seams-proposed", JSON.stringify(res(viaGlobal)));
  assert.equal(progressOf(viaGlobal.runId).forge, forge);

  writeGlobalConfig({});
  writeRepoConfig(fx.repo, { forges: { [host]: forge } });
  const viaRepo = await run({});
  assert.equal(res(viaRepo).status, "seams-proposed", JSON.stringify(res(viaRepo)));
  assert.equal(progressOf(viaRepo.runId).forge, forge);

  writeGlobalConfig({ forges: { [host]: OTHER[forge] } });
  const both = await run({});
  assert.equal(res(both).status, "seams-proposed", JSON.stringify(res(both)));
  assert.equal(progressOf(both.runId).forge, forge, "the repo file said so, over the global file");
  assert.equal(forgeState().wrongCli, undefined, "the other forge's CLI was never run");
});

forgeTest("an origin on a host nobody declared fails before any step, naming the host and the `forges` key", async () => {
  issue(["complexity:low"]);
  for (const url of ["https://git.example.com/group/project.git", "git@git.example.com:group/project.git", "ssh://git@Git.Example.com:2222/group/project.git"]) {
    setOrigin(url);
    const r = await run({ openPr: true });
    assert.equal(r.status, "failed", `${url}: ${JSON.stringify(r.result)}`);
    assert.match(r.error!, /git\.example\.com/, url);
    assert.match(r.error!, /"forges"/, url);
    assertNothingStarted(url);
  }
});

forgeTest(
  "a declared host matches by its port when the origin's URL has one, and by the bare host on any port: a port nobody declared is an unknown host",
  async () => {
    issue(["complexity:medium"]);
    const cases: Array<{ origin: string; declared: string }> = [
      { origin: "https://git.example.com:8443/group/project.git", declared: "git.example.com:8443" },
      { origin: "https://git.example.com:8443/group/project.git", declared: "git.example.com" },
      { origin: "ssh://git@git.example.com:2222/group/project.git", declared: "git.example.com" },
    ];
    for (const { origin, declared } of cases) {
      setOrigin(origin);
      writeGlobalConfig({ forges: { [declared]: "gitlab" } });
      const r = await run({});
      assert.equal(res(r).status, "seams-proposed", `${origin} with ${declared}: ${JSON.stringify(res(r))}`);
      assert.equal(progressOf(r.runId).forge, "gitlab", `${origin} with ${declared}`);
    }
    setOrigin("https://git.example.com:8443/group/project.git");
    writeGlobalConfig({ forges: { "git.example.com:9000": "gitlab" } });
    const r = await run({});
    assert.equal(r.status, "failed", JSON.stringify(r.result));
    assert.match(r.error!, /git\.example\.com:8443/, "the host as the origin spells it, port included");
    assert.match(r.error!, /"forges"/);
  },
  ["gitlab"],
);

forgeTest(
  "an origin that names no host (a local path, a drive path) is GitHub, as it was before GitLab: nothing to declare, no error",
  async () => {
    issue(["complexity:medium"]);
    for (const origin of ["/srv/git/repo.git", "../mirrors/repo.git", "C:/repos/repo.git"]) {
      setOrigin(origin);
      const r = await run({});
      assert.equal(res(r).status, "seams-proposed", `${origin}: ${JSON.stringify(res(r))}`);
      assert.equal(progressOf(r.runId).forge, "github", origin);
    }
  },
  ["github"],
);

forgeTest("a repo argument that is a URL on another host decides the forge by that host, whatever the origin's host is", async (forge) => {
  const other = OTHER[forge];
  const url = other === "gitlab" ? "https://gitlab.com/group/sub/project" : "https://github.com/other/x";
  issue(["complexity:medium"]);
  answerWith(other);
  const r = await run({ repo: url });
  assert.equal(res(r).status, "seams-proposed", JSON.stringify(res(r)));
  assert.equal(progressOf(r.runId).forge, other);
  const read = forgeState().calls.find((c) => c[0] === "issue" && c[1] === "view" && c[2] === "7");
  assert.ok(read?.includes(url), `the issue is read from the repository the argument names: ${JSON.stringify(read)}`);
  assert.equal(forgeState().wrongCli, undefined, `the CLI of the origin's forge (${forge}) was never run`);
});

forgeTest("a repo argument without a host leaves the forge to the origin's host", async (forge) => {
  issue(["complexity:medium"]);
  const r = await run({ repo: "group/sub/project" });
  assert.equal(res(r).status, "seams-proposed", JSON.stringify(res(r)));
  assert.equal(progressOf(r.runId).forge, forge);
  assert.equal(forgeState().wrongCli, undefined);
});

forgeTest("a repo argument on a host nobody declared fails before any step, naming that host and the `forges` key; declared, its forge answers", async (forge) => {
  issue(["complexity:medium"]);
  const url = "https://git.example.com/group/sub/project";
  const r = await run({ repo: url });
  assert.equal(r.status, "failed", JSON.stringify(r.result));
  assert.match(r.error!, /git\.example\.com/);
  assert.match(r.error!, /"forges"/);
  assert.match(r.error!, /repo/, "it says the argument named the host, not the origin");
  assertNothingStarted("an undeclared host in the repo argument");

  const other = OTHER[forge];
  writeRepoConfig(fx.repo, { forges: { "git.example.com": other } });
  answerWith(other);
  const declared = await run({ repo: url });
  assert.equal(res(declared).status, "seams-proposed", JSON.stringify(res(declared)));
  assert.equal(progressOf(declared.runId).forge, other);
});

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
  changeForgeState((state) => (state.comments = Array.from({ length: 24 }, (_, i) => `an earlier comment, ${i + 1}`)));
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
    changeForgeState((state) => (state.systemNotes = [`mentioned ${SEAMS_MARKER} run-a`]));
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

forgeTest("a PR body of many multi-byte characters still opens the PR: the body is cut by bytes too, not only by characters", async () => {
  issue(["complexity:low"]);
  // 60 000 three-byte characters: under the character cap, but some 180 KB, past Linux's 128 KiB limit on one argument (glab
  // mr create takes the description as one).
  fx.handlers["pr-text"] = (o) => submit(o, { summary: "\u20AC".repeat(60_000), door: "two-way", blastRadius: "local" });
  const r = await run({ openPr: true });
  assert.equal(res(r).status, "done", JSON.stringify(res(r)).slice(0, 2000));
  const body = forgeState().prs[0]!.body;
  assert.match(body, /_\(body truncated\)_$/);
  assert.ok(Buffer.byteLength(body) <= 100_000, `the body is ${Buffer.byteLength(body)} bytes`);
});

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
    changeForgeState((state) => {
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
    const lookup = `projects/other%2Fx/merge_requests?source_branch=${encodeURIComponent(branchOf(other.runId))}&order_by=created_at&sort=desc&per_page=100`;
    assert.ok(calls.some((c) => c.join(" ") === `api --paginate ${lookup}`), "its MR is looked up by the project path, the latest first");
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

// ── GitLab paths with nested groups: the argument, the run's lock and the same-repository check ──

/** The names of the issue locks held while a run with `args` is writing its code (the run is on its issue 7, `complexity:low`, and delivers nothing). */
async function issueLocksDuring(args: Record<string, unknown>): Promise<string[]> {
  let held: string[] = [];
  fx.handlers["code-1"] = (o) => {
    held = readdirSync(join(fx.repo, ".workflows", "locks")).filter((name) => name.startsWith("issue-"));
    write(o, "src/math.js", SUB_CODE);
    submit(o, { summary: "subtract", filesChanged: ["src/math.js"] });
  };
  issue(["complexity:low"]);
  const r = await run(args);
  assert.equal(res(r).status, "done", `${JSON.stringify(args)}: ${JSON.stringify(res(r))}`);
  return held;
}
const OWN_LOCK = ["issue-7.lock"];
const FOREIGN_LOCK = /^issue-7-[0-9a-f]{12}\.lock$/;

forgeTest(
  "group/sub/project works as the repo argument: glab gets it as a path, and the lock and the same-repository check tell the cwd's own repository from any other, whatever the case or the spelling",
  async () => {
    setOrigin("https://gitlab.com/group/sub/project.git");
    // The repository of the cwd, as the argument can spell it, and the project route glab's REST API gets for each spelling.
    const ownSpellings: Array<[string, string]> = [
      ["group/sub/project", "projects/group%2Fsub%2Fproject"],
      ["GROUP/Sub/PROJECT", "projects/GROUP%2FSub%2FPROJECT"],
      ["https://gitlab.com/group/sub/project", "projects/group%2Fsub%2Fproject"],
      ["https://GitLab.com/Group/Sub/Project.git/", "projects/Group%2FSub%2FProject"],
      ["git@gitlab.com:group/sub/project.git", "projects/group%2Fsub%2Fproject"],
    ];
    for (const [own, route] of ownSpellings) {
      assert.deepEqual(await issueLocksDuring({ repo: own }), OWN_LOCK, `${own} is the repository of the cwd: the lock of issue 7`);
      const asked = forgeState().calls;
      assert.ok(asked.some((c) => c[0] === "api" && c.at(-1) === route), `${own}: the nested path is one encoded segment of the REST route ${route}: ${JSON.stringify(asked)}`);
      assert.ok(asked.some((c) => c.join(" ") === `issue view 7 --repo ${own} --output json`), `${own}: glab gets the repo argument as it was given`);
    }

    for (const other of ["group/sub/other", "group/project", "group/sub", "other/sub/project", "https://gitlab.com/group/sub/other"]) {
      const held = await issueLocksDuring({ repo: other });
      assert.equal(held.length, 1, other);
      assert.match(held[0]!, FOREIGN_LOCK, `${other} is another repository: a lock of its own`);
    }
    const named = await issueLocksDuring({ repo: "group/sub/other" });
    const again = await issueLocksDuring({ repo: "GROUP/SUB/OTHER" });
    assert.deepEqual(again, named, "the lock of another repository is the same whatever the case of its path");
  },
  ["gitlab"],
);

forgeTest(
  "a repo URL on another host of a declared forge goes to glab with --hostname, and is another repository than the cwd's even when the path is the same",
  async () => {
    setOrigin("https://git.example.com/group/sub/project.git");
    writeGlobalConfig({ forges: { "git.example.com": "gitlab" } });
    issue(["complexity:medium"]);
    const sameHost = await run({ repo: "https://git.example.com/group/sub/project" });
    assert.equal(res(sameHost).status, "seams-proposed", JSON.stringify(res(sameHost)));
    assert.deepEqual(forgeState().calls.find((c) => c.includes("--paginate")), ["api", "--hostname", "git.example.com", "--paginate", "projects/group%2Fsub%2Fproject/issues/7/notes"], "the notes come from the host the argument names");

    issue(["complexity:medium"]);
    const otherPort = await run({ repo: "https://git.example.com:8443/group/sub/project" });
    assert.equal(res(otherPort).status, "seams-proposed", JSON.stringify(res(otherPort)));
    const calls = forgeState().calls;
    assert.ok(calls.some((c) => c.join(" ") === "api --hostname git.example.com:8443 projects/group%2Fsub%2Fproject"), "an http(s) URL's port is part of the host glab is told");
    assert.ok(calls.some((c) => c.join(" ") === "issue view 7 --repo https://git.example.com:8443/group/sub/project --output json"));

    assert.deepEqual(await issueLocksDuring({ repo: "https://git.example.com/group/sub/project" }), OWN_LOCK, "the cwd's own repository, by URL");
    const held = await issueLocksDuring({ repo: "https://git.example.com:8443/group/sub/project" });
    assert.match(held[0]!, FOREIGN_LOCK, "the same path on another host is another repository");
  },
  ["gitlab"],
);
