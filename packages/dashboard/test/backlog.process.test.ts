// Seam: HTTP, with the job as a real process. The run button of a Backlog card starts `implement-issue` for its issue through the
// dashboard's start action: the browser's own client sends the request a card's preset makes, the runtime spawns its detached job
// process, and the issue leaves the Backlog once its run exists. `gh` is a stand-in that answers from a recording of the real tool
// and refuses what it was not recorded for (so the job's run ends at its first question to it); the job gets the fake SDK, as every
// TypeScript child process of the tests does, so nothing reaches the Cursor API.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { backlogPreset } from "../app/backlog-board.js";
import { postStart } from "../app/start-api.js";
import { startBody } from "../app/start-form.js";
import { type DashboardServer, startDashboard } from "../src/server.js";
import { waitFor } from "../../runtime/test/wait-for.js";
import { type FakeGh, JOB_ENV, JOB_WAIT, type Sandbox, fakeGh, http, jobPidOf, repoWithOrigin, sandbox, startRequest } from "./support.js";

let box: Sandbox;
let gh: FakeGh;
let dash: DashboardServer;
let jobPids: number[];
let previousEnv: Record<string, string | undefined>;

beforeEach(async () => {
  box = sandbox();
  gh = fakeGh(box);
  previousEnv = Object.fromEntries(Object.keys(JOB_ENV).map((name) => [name, process.env[name]]));
  Object.assign(process.env, JOB_ENV);
  jobPids = [];
  dash = await startDashboard({ port: 0 });
});
afterEach(async () => {
  for (const pid of jobPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* the job ended on its own, which is what the tests wait for */
    }
  }
  await dash.close();
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  gh.restore();
  box.dispose();
});

const backlog = async () => (await http(dash.url, "/api/backlog")).json as { workflow: string; cards: Array<{ repo: string; issue: number; title: string }> };
const numbers = async () => (await backlog()).cards.map((card) => card.issue);

test("the run button of a card starts implement-issue for its issue through the start action, under the caps the form gave, and the issue leaves the Backlog", async () => {
  const repo = repoWithOrigin(box, "web", "https://github.com/owner/repo.git");
  gh.issues("ready-for-agent", [
    { number: 9, title: "Nine" },
    { number: 7, title: "Seven" },
  ]);
  const listed = await backlog();
  assert.deepEqual(listed.cards.map((card) => card.issue), [7, 9]);

  // What the browser does: the card's preset fills the form, the user gives both caps, and the form's request goes to the start action.
  const preset = backlogPreset(listed.workflow, listed.cards[0]!);
  const built = startBody({ repo: preset.repo, workflow: preset.workflow, argsText: preset.argsText, maxTokens: "50000", maxCents: "20" });
  assert.ok(built.ok, built.ok ? "" : built.error);
  const reply = await postStart(built.body, dash.url);
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.equal(reply.status, 202);
  assert.deepEqual({ repo: reply.body.repo, workflow: reply.body.workflow }, { repo, workflow: "implement-issue" });
  assert.match(reply.body.runId, /^implement-issue-[0-9a-f]{8}$/);
  jobPids.push(jobPidOf(repo, reply.body.jobId));

  const detail = await waitFor("the run of issue 7 to be known", async () => {
    const found = await http(dash.url, `/api/runs/${reply.body.runId}`);
    return found.status === 200 ? found.json : undefined;
  }, JOB_WAIT);
  assert.equal(detail.workflow, "implement-issue");
  assert.deepEqual(detail.start, { workflow: "implement-issue", args: { issue: 7 }, maxTokens: 50_000, maxCents: 20 }, "the job was started for issue 7, under the caps the form gave");
  assert.deepEqual(await waitFor("issue 7 to leave the Backlog", async () => ((await numbers()).includes(7) ? undefined : await numbers()), JOB_WAIT), [9]);
});

test("a run button cannot start an uncapped run: the start action refuses a request with no caps, whatever surface it came from", async () => {
  const repo = repoWithOrigin(box, "web", "https://github.com/owner/repo.git");
  gh.issues("ready-for-agent", [{ number: 7, title: "Seven" }]);
  const refused = await startRequest(dash.url, { repo, workflow: "implement-issue", args: { issue: 7 } });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /^maxTokens is required/);
  assert.deepEqual(await numbers(), [7], "nothing started, so the issue is still there");
});
