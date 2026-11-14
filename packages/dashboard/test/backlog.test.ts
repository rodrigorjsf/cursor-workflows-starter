// Seam: HTTP, with stand-ins for the `gh` and `glab` CLIs that answer from recordings of the real tools. The Backlog
// (`GET /api/backlog`) lists the open issues, of every repository the runs index names, that carry the backlog label and that no
// run of `implement-issue` has taken on, read through the runtime's forge seam. The dashboard server runs in this process on a random
// loopback port, against a throwaway per-user home and throwaway git repositories whose `origin` names the forge.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { type DashboardServer, startDashboard } from "../src/server.js";
import { type FakeGh, type FakeGlab, type Sandbox, fakeGh, fakeGlab, http, repoWithOrigin, sandbox, writeJobRecord, writeRepoConfig, writeRun } from "./support.js";

let box: Sandbox;
let gh: FakeGh;
let glab: FakeGlab;
let dash: DashboardServer;
beforeEach(async () => {
  box = sandbox();
  gh = fakeGh(box);
  glab = fakeGlab(box);
  dash = await startDashboard({ port: 0 });
});
afterEach(async () => {
  await dash.close();
  glab.restore(); // before gh: each puts back the PATH it found
  gh.restore();
  box.dispose();
});

const GITHUB = "https://github.com/owner/repo.git";
const GITLAB = "https://gitlab.com/owner/repo.git";
const T0 = Date.parse("2026-01-10T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const backlog = async () => (await http(dash.url, "/api/backlog")).json;
const issueCalls = (cli: FakeGh | FakeGlab) => cli.calls().filter((call) => call[0] === "issue");

/** The numbers of the cards a reply lists, in the order it lists them. */
const numbers = (reply: { cards: Array<{ issue: number }> }) => reply.cards.map((card) => card.issue);

test("the Backlog lists the open issues that carry the backlog label and have no run, oldest first, and drops an issue once a run for it exists", async () => {
  const repo = repoWithOrigin(box, "web", GITHUB);
  gh.issues("ready-for-agent", [
    { number: 9, title: "Nine" },
    { number: 7, title: "Seven" },
    { number: 3, title: "Three" },
  ]);

  assert.deepEqual(await backlog(), {
    workflow: "implement-issue",
    cards: [
      { repo, issue: 3, title: "Three", url: "https://github.com/owner/repo/issues/3" },
      { repo, issue: 7, title: "Seven", url: "https://github.com/owner/repo/issues/7" },
      { repo, issue: 9, title: "Nine", url: "https://github.com/owner/repo/issues/9" },
    ],
    errors: [],
  });
  assert.deepEqual(issueCalls(gh), [["issue", "list", "--state", "open", "--label=ready-for-agent", "--limit", "100", "--json", "number,title,url"]]);

  // Issue 7 has a run started as a job: its record says which issue, the moment the job starts.
  writeRun(box.home, repo, { runId: "implement-issue-aaaa0001", workflow: "implement-issue", startedAt: at(1), jobId: "job00001" });
  writeJobRecord(repo, { jobId: "job00001", runId: "implement-issue-aaaa0001", start: { args: { issue: 7 }, maxTokens: 50_000, maxCents: 20 } });
  assert.deepEqual(numbers(await backlog()), [3, 9], "a run started as a job takes its issue off the Backlog");

  // Issue 3 has a run with no job (`wf run` in a terminal): its card says which issue.
  writeRun(box.home, repo, { runId: "implement-issue-bbbb0002", workflow: "implement-issue", startedAt: at(2), events: [{ type: "card", title: "#3 Three" }] });
  assert.deepEqual(numbers(await backlog()), [9], "so does a run with no job, by its card");
  assert.equal(issueCalls(gh).length, 1, "the runs are looked at again on every request; the forge is not");
});

test("a run of another workflow, or a run that works on an issue of another repository, takes no issue off the Backlog", async () => {
  const repo = repoWithOrigin(box, "web", GITHUB);
  gh.issues("ready-for-agent", [
    { number: 5, title: "Five" },
    { number: 6, title: "Six" },
    { number: 8, title: "Eight" },
  ]);
  writeRun(box.home, repo, { runId: "smoke-aaaa0001", workflow: "smoke", startedAt: at(1), jobId: "job00001" });
  writeJobRecord(repo, { jobId: "job00001", runId: "smoke-aaaa0001", start: { args: { issue: 5 } } });
  writeRun(box.home, repo, { runId: "implement-issue-bbbb0002", workflow: "implement-issue", startedAt: at(2), jobId: "job00002" });
  writeJobRecord(repo, { jobId: "job00002", runId: "implement-issue-bbbb0002", start: { args: { issue: 6, repo: "owner/elsewhere" } } });
  writeRun(box.home, repo, { runId: "implement-issue-cccc0003", workflow: "implement-issue", startedAt: at(3), events: [{ type: "card", title: "Eight, and more words on the card" }] });

  assert.deepEqual(numbers(await backlog()), [5, 6, 8]);
});

test("a GitLab repository's Backlog is read through glab, and drops an issue once a run for it exists", async () => {
  const repo = repoWithOrigin(box, "api", GITLAB);
  glab.issues("ready-for-agent", [
    { number: 4, title: "Four" },
    { number: 2, title: "Two" },
  ]);

  assert.deepEqual((await backlog()).cards, [
    { repo, issue: 2, title: "Two", url: "https://gitlab.com/owner/repo/-/work_items/2" },
    { repo, issue: 4, title: "Four", url: "https://gitlab.com/owner/repo/-/work_items/4" },
  ]);
  assert.deepEqual(issueCalls(glab), [["issue", "list", "--label=ready-for-agent", "--per-page", "100", "--output", "json"]]);
  assert.deepEqual(issueCalls(gh), [], "a GitLab repository is never asked of gh");

  writeRun(box.home, repo, { runId: "implement-issue-aaaa0001", workflow: "implement-issue", startedAt: at(1), events: [{ type: "card", title: "#2 Two" }] });
  assert.deepEqual(numbers(await backlog()), [4]);
});

test("a host the config's forges map declares is read through the CLI the map names", async () => {
  const repo = repoWithOrigin(box, "inner", "https://git.example.com/owner/repo.git");
  glab.issues("ready-for-agent", [{ number: 1, title: "One" }]);
  const undeclared = await backlog();
  assert.deepEqual(undeclared.cards, []);
  assert.match(undeclared.errors[0].error, /git\.example\.com/);
  assert.match(undeclared.errors[0].error, /forges/, "the error names the key that declares a host");

  await dash.close();
  dash = await startDashboard({ port: 0, backlogCacheMs: 0 });
  writeRepoConfig(repo, { forges: { "git.example.com": "gitlab" } });
  assert.deepEqual(numbers(await backlog()), [1]);
});

test("a repo config with another label changes what is listed", async () => {
  const repo = repoWithOrigin(box, "web", GITHUB);
  gh.issues("ready-for-agent", [{ number: 1, title: "Ready for an agent" }]);
  gh.issues("triaged", [{ number: 2, title: "Triaged" }]);
  writeRepoConfig(repo, { workflows: { "implement-issue": { settings: { backlogLabel: "triaged" } } } });

  assert.deepEqual(numbers(await backlog()), [2]);
  assert.deepEqual(issueCalls(gh), [["issue", "list", "--state", "open", "--label=triaged", "--limit", "100", "--json", "number,title,url"]]);
});

test("a second request within the cache time does not call the forge again, and one after it does", async () => {
  repoWithOrigin(box, "web", GITHUB);
  gh.issues("ready-for-agent", [{ number: 1, title: "One" }]);
  const [first, second] = await Promise.all([backlog(), backlog()]);
  assert.deepEqual(first, second);
  assert.deepEqual(numbers(await backlog()), [1]);
  assert.equal(issueCalls(gh).length, 1, "three requests, one question to the forge (the first two at once)");

  await dash.close();
  dash = await startDashboard({ port: 0, backlogCacheMs: 0 }); // nothing is kept: every request asks
  await backlog();
  await backlog();
  assert.equal(issueCalls(gh).length, 3);
});

test("a forge that fails shows as an error for that repository, the other repositories still list, and the runs still render", async () => {
  const web = repoWithOrigin(box, "web", GITHUB);
  const api = repoWithOrigin(box, "api", GITLAB);
  gh.failIssueList("HTTP 502: Bad Gateway (https://api.github.com/graphql)");
  glab.issues("ready-for-agent", [{ number: 4, title: "Four" }]);
  writeRun(box.home, web, { runId: "smoke-aaaa0001", workflow: "smoke", startedAt: at(1), events: [{ type: "phase", title: "Ping" }] });

  const reply = await backlog();
  assert.deepEqual(reply.cards, [{ repo: api, issue: 4, title: "Four", url: "https://gitlab.com/owner/repo/-/work_items/4" }]);
  assert.equal(reply.errors.length, 1);
  assert.equal(reply.errors[0].repo, web);
  assert.match(reply.errors[0].error, /^gh issue list .* exited with code 1: .*HTTP 502: Bad Gateway/);

  const board = await http(dash.url, "/api/board");
  assert.equal(board.status, 200);
  assert.ok(board.json.boards.some((b: { workflow: string; cards: Array<{ runId: string }> }) => b.workflow === "smoke" && b.cards.some((c) => c.runId === "smoke-aaaa0001")), "the board does not wait for, or depend on, the Backlog");
});

test("an unusable config shows as an error for that repository, naming the field, and a forge that lists nothing is an empty column, not an error", async () => {
  const broken = repoWithOrigin(box, "broken", GITHUB);
  writeRepoConfig(broken, { workflows: { "implement-issue": { settings: { backlogLabel: 5 } } } });
  repoWithOrigin(box, "quiet", GITHUB);

  const reply = await backlog();
  assert.deepEqual(reply.cards, []);
  assert.equal(reply.errors.length, 1, "only the broken repository has an error");
  assert.equal(reply.errors[0].repo, broken);
  assert.match(reply.errors[0].error, /^invalid configuration:/);
  assert.match(reply.errors[0].error, /backlogLabel/);
});

test("with no repository the runs index knows there is nothing to list and nothing is asked, and the Backlog keeps the Host check", async () => {
  assert.deepEqual(await backlog(), { workflow: "implement-issue", cards: [], errors: [] });
  assert.equal((await http(dash.url, "/api/backlog", { host: "evil.example" })).status, 403);
  assert.equal((await http(dash.url, "/api/backlog", { method: "POST" })).status, 405, "a read, with no action behind it");
  assert.deepEqual(gh.calls(), []);
  assert.equal((globalThis as { __fakeSdkLoaded?: boolean }).__fakeSdkLoaded, undefined, "reading a Backlog does not load the Cursor SDK into the dashboard");
});
