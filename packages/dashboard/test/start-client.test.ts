// Seam: the browser's own client of the dashboard API (app/dashboard-api.ts and app/start-api.ts), run in Node with `fetch`
// against the real dashboard server on a loopback port: the token it fetches, the JSON body it sends, and how it reports an
// answer that is a refusal. The page's `fetch` is the same function with an empty origin. No job is started here (the start that
// works is in start.process.test.ts).
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { postAction } from "../app/dashboard-api.js";
import { loadRepos, loadWorkflows, postStart } from "../app/start-api.js";
import { type DashboardServer, startDashboard } from "../src/server.js";
import { ECHO_WORKFLOW, type Sandbox, repoWithWorkflows, sandbox } from "./support.js";

let box: Sandbox;
let dash: DashboardServer;

beforeEach(async () => {
  box = sandbox();
  dash = await startDashboard({ port: 0 });
});
afterEach(async () => {
  await dash.close();
  box.dispose();
});

/** A repo the runs index knows, with the `echo` workflow, which takes an `issue`. */
const knownRepo = (): string => repoWithWorkflows(box, "repo", { "echo.mjs": ECHO_WORKFLOW });

test("the form's reads come back typed: the known repositories, then the repository's workflows with their skeletons", async () => {
  const repo = knownRepo();
  const repos = await loadRepos(dash.url);
  assert.deepEqual(repos, { ok: true, status: 200, body: { repos: [repo] } });

  const listed = await loadWorkflows(repo, dash.url);
  assert.ok(listed.ok);
  assert.equal(listed.body.repo, repo);
  assert.deepEqual(listed.body.workflows.find((workflow) => workflow.name === "echo"), { name: "echo", description: "Echoes its args.", whenToUse: "Only in tests.", argsSkeleton: { issue: 0 }, optionalArgs: ["note"] });
});

test("an answer that is a refusal comes back as data with the server's own sentence and its status, never as a throw", async () => {
  const repo = knownRepo();
  const stranger = await loadWorkflows(box.repo("stranger"), dash.url);
  assert.equal(stranger.ok, false);
  assert.equal(stranger.ok ? 0 : stranger.status, 404);
  assert.match(stranger.ok ? "" : stranger.error, /^unknown repository: /);

  const noCaps = await postStart({ repo, workflow: "echo", args: { issue: 1 } }, dash.url);
  assert.equal(noCaps.ok, false, "the client fetched the token and sent the JSON body, so the server got as far as the caps");
  assert.equal(noCaps.ok ? 0 : noCaps.status, 400);
  assert.match(noCaps.ok ? "" : noCaps.error, /^maxTokens is required/);

  const badArgs = await postStart({ repo, workflow: "echo", args: { issue: "one" }, maxTokens: 1000, maxCents: 5 }, dash.url);
  assert.match(badArgs.ok ? "" : badArgs.error, /^invalid args: .*\/issue must be integer/);
});

test("a POST of an action goes behind the token, and a POST the server has no action for is reported with its status", async () => {
  const unknownRun = await postAction("/api/runs/nope-00000000/cancel", undefined, dash.url);
  assert.deepEqual(unknownRun, { ok: false, status: 404, error: "run not found" }, "the cancel route took the client's token");
  const noAction = await postAction("/api/no-such-action", {}, dash.url);
  assert.deepEqual(noAction, { ok: false, status: 405, error: "method not allowed" });
});

test("a dashboard that cannot be reached is reported as a sentence that says so", async () => {
  const gone = await loadRepos("http://127.0.0.1:1");
  assert.equal(gone.ok, false);
  assert.match(gone.ok ? "" : gone.error, /^could not reach the dashboard: /);
  const goneToo = await postAction("/api/start", {}, "http://127.0.0.1:1");
  assert.match(goneToo.ok ? "" : goneToo.error, /^could not reach the dashboard: /);
});
