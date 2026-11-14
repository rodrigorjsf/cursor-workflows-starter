// Seam: HTTP. The Start action of the dashboard, `POST /api/start`, and the two reads that feed its form (`GET /api/repos`,
// `GET /api/workflows`): which refusals come back, and that a refusal starts nothing. The dashboard server is real, with a
// throwaway `WF_HOME` and throwaway repos that hold real workflow files; no refusal reaches a job process (the test that
// starts a job is start.process.test.ts).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type DashboardServer, startDashboard } from "../src/server.js";
import { ECHO_WORKFLOW, PLAIN_WORKFLOW, type Reply, type Sandbox, http, repoWithWorkflows, sandbox, startRequest } from "./support.js";

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

const CAPS = { maxTokens: 50_000, maxCents: 20 };

const WORKFLOWS = { "echo.mjs": ECHO_WORKFLOW, "plain.mjs": PLAIN_WORKFLOW };

/** A repo the runs index knows, with the two workflows above in its `.agents/workflows/`. */
const knownRepo = (name = "repo"): string => repoWithWorkflows(box, name, WORKFLOWS);

const token = async (): Promise<string> => (await http(dash.url, "/api/csrf")).json.csrfToken as string;

/** `POST /api/start` with the token (unless `headers` says otherwise) and `body`. */
const start = (body: unknown, headers?: Record<string, string>): Promise<Reply> => startRequest(dash.url, body, headers);

/** Nothing a start would create is there: no job record, no run directory beyond the fixture's own. */
const startedNothing = (repo: string): boolean => !existsSync(join(repo, ".workflows", "jobs"));

test("start needs the CSRF token and a same-origin request: without them nothing is started", async () => {
  const repo = knownRepo();
  const good = await token();
  const refused: Array<[string, Record<string, string>]> = [
    ["no token", {}],
    ["an empty token", { "x-csrf-token": "" }],
    ["a wrong token", { "x-csrf-token": "0".repeat(64) }],
    ["a token of another length", { "x-csrf-token": good.slice(0, 10) }],
    ["a foreign origin", { "x-csrf-token": good, origin: "https://evil.example" }],
    ["a foreign port on the loopback", { "x-csrf-token": good, origin: "http://127.0.0.1:1" }],
    ["a cross-site fetch", { "x-csrf-token": good, "sec-fetch-site": "cross-site" }],
  ];
  for (const [what, headers] of refused) {
    const reply = await start({ repo, workflow: "plain", ...CAPS }, headers);
    assert.equal(reply.status, 403, what);
    assert.match(reply.json.error, /csrf/i, what);
  }
  const wrongHost = await http(dash.url, "/api/start", { method: "POST", host: "evil.example", headers: { "x-csrf-token": good }, body: { repo, workflow: "plain", ...CAPS } });
  assert.equal(wrongHost.status, 403);
  assert.ok(startedNothing(repo), "a refused start leaves no job record in the repository");
});

test("start refuses a request without both caps, naming the one that is missing or not a number above 0", async () => {
  const repo = knownRepo();
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["no maxTokens", { maxCents: 20 }, /maxTokens is required/],
    ["no maxCents", { maxTokens: 50_000 }, /maxCents is required/],
    ["neither", {}, /maxTokens is required/],
    ["a null cap", { maxTokens: null, maxCents: 20 }, /maxTokens is required/],
    ["a cap as text", { maxTokens: "50000", maxCents: 20 }, /maxTokens must be a number/],
    ["a cap of 0", { maxTokens: 50_000, maxCents: 0 }, /maxCents must be a number greater than 0/],
    ["a negative cap", { maxTokens: -1, maxCents: 20 }, /maxTokens must be a number greater than 0/],
  ];
  for (const [what, caps, message] of cases) {
    const reply = await start({ repo, workflow: "plain", ...caps });
    assert.equal(reply.status, 400, what);
    assert.match(reply.json.error, message, what);
  }
  const infinite = await start(`{"repo":${JSON.stringify(repo)},"workflow":"plain","maxTokens":1e999,"maxCents":20}`); // JSON.stringify writes this as null
  assert.equal(infinite.status, 400, "a cap that is not finite");
  assert.match(infinite.json.error, /maxTokens must be a number/);
  assert.ok(startedNothing(repo));
});

test("start refuses a body that is not a JSON object with a repository and a workflow", async () => {
  const repo = knownRepo();
  const cases: Array<[string, unknown, RegExp]> = [
    ["no body", undefined, /JSON object/],
    ["text that is not JSON", "{", /JSON/],
    ["a JSON array", [], /JSON object/],
    ["no repo", { workflow: "plain", ...CAPS }, /repo is required/],
    ["a repo that is not text", { repo: 4, workflow: "plain", ...CAPS }, /repo must be text/],
    ["no workflow", { repo, ...CAPS }, /workflow is required/],
    ["args that are not an object", { repo, workflow: "echo", args: [1], ...CAPS }, /args must be a JSON object/],
  ];
  for (const [what, body, message] of cases) {
    const reply = await start(body);
    assert.equal(reply.status, 400, what);
    assert.match(reply.json.error, message, what);
  }
  assert.ok(startedNothing(repo));
});

test("start refuses a repository the runs index does not know, even one that exists on disk", async () => {
  const repo = knownRepo();
  const stranger = box.repo("stranger"); // a real folder with a workflow, but no run of it was ever registered
  mkdirSync(join(stranger, ".agents", "workflows"), { recursive: true });
  writeFileSync(join(stranger, ".agents", "workflows", "plain.mjs"), PLAIN_WORKFLOW);
  const through = `${repo}/../stranger`; // not normalized: it names the stranger by walking out of a known repository
  for (const unknown of [stranger, through, "/nonexistent/place", "relative/path", "/"]) {
    const reply = await start({ repo: unknown, workflow: "plain", ...CAPS });
    assert.equal(reply.status, 404, unknown);
    assert.match(reply.json.error, /^unknown repository: /, unknown);
  }
  assert.ok(startedNothing(stranger), "nothing was started");
  assert.equal(existsSync(join(stranger, ".workflows")), false, "and nothing was written in the folder");
});

test("start refuses a workflow the repository does not list, and says which ones it lists", async () => {
  const repo = knownRepo();
  for (const workflow of ["nope", "../plain", "Plain", ""]) {
    const reply = await start({ repo, workflow, ...CAPS });
    assert.equal(reply.status, workflow === "" ? 400 : 404, JSON.stringify(workflow));
    if (workflow !== "") assert.match(reply.json.error, /^unknown workflow: .*; this repository lists: .*\becho\b.*\bplain\b/, workflow);
  }
  assert.ok(startedNothing(repo));
});

test("start refuses args that fail the workflow's argsSchema, with the message naming the field", async () => {
  const repo = knownRepo();
  const cases: Array<[string, unknown, RegExp]> = [
    ["a required field that is missing", {}, /^invalid args: .*required property 'issue'/],
    ["no args at all, which are {}", undefined, /^invalid args: .*required property 'issue'/],
    ["a field of the wrong type", { issue: "four" }, /^invalid args: .*\/issue must be integer/],
    ["a field below its minimum", { issue: 0 }, /^invalid args: .*\/issue must be >= 1/],
    ["a field the schema does not declare", { issue: 4, isue: 5 }, /^invalid args: .*additional properties.*isue/],
  ];
  for (const [what, args, message] of cases) {
    const reply = await start({ repo, workflow: "echo", args, ...CAPS });
    assert.equal(reply.status, 400, what);
    assert.match(reply.json.error, message, what);
  }
  assert.ok(startedNothing(repo));
});

test("the form's reads: the repositories the runs index knows, and the workflows a repository lists with an args skeleton", async () => {
  const repo = knownRepo("alpha");
  const other = knownRepo("beta");
  const repos = await http(dash.url, "/api/repos");
  assert.equal(repos.status, 200);
  assert.deepEqual([...repos.json.repos].sort(), [repo, other].sort());

  const listed = await http(dash.url, `/api/workflows?repo=${encodeURIComponent(repo)}`);
  assert.equal(listed.status, 200);
  const byName = new Map((listed.json.workflows as Array<{ name: string }>).map((w) => [w.name, w]));
  assert.deepEqual(byName.get("echo"), { name: "echo", description: "Echoes its args.", whenToUse: "Only in tests.", argsSkeleton: { issue: 0 }, optionalArgs: ["note"] });
  assert.deepEqual(byName.get("plain"), { name: "plain", description: "Takes no args.", argsSkeleton: {}, optionalArgs: [] });
  assert.ok(byName.has("smoke"), "the kit's own workflows are listed too, as they are for the chat");

  const stranger = await http(dash.url, `/api/workflows?repo=${encodeURIComponent(box.repo("stranger"))}`);
  assert.equal(stranger.status, 404);
  assert.match(stranger.json.error, /^unknown repository: /);
  assert.equal((await http(dash.url, "/api/workflows")).status, 400, "no repo in the query");
  assert.equal((await http(dash.url, "/api/start")).status, 405, "start is a POST");
  assert.equal((await http(dash.url, "/api/repos", { host: "evil.example" })).status, 403, "the reads keep the Host check");
  assert.equal((globalThis as { __fakeSdkLoaded?: boolean }).__fakeSdkLoaded, undefined, "listing a repository's workflows does not load the Cursor SDK into the dashboard");
});

test("a workflow file edited after the dashboard first listed it is listed, and checked, as it is now", async () => {
  const repo = knownRepo();
  const listed = async () => ((await http(dash.url, `/api/workflows?repo=${encodeURIComponent(repo)}`)).json.workflows as Array<{ name: string; argsSkeleton: unknown }>).find((w) => w.name === "echo");
  assert.deepEqual((await listed())?.argsSkeleton, { issue: 0 });

  writeFileSync(join(repo, ".agents", "workflows", "echo.mjs"), ECHO_WORKFLOW.replace('required: ["issue"]', 'required: ["ticket"]').replace("issue: { type", "ticket: { type: \"string\" }, issue: { type"));
  assert.deepEqual((await listed())?.argsSkeleton, { ticket: "" }, "the form's skeleton follows the edit");
  const stale = await start({ repo, workflow: "echo", args: { issue: 4 }, ...CAPS });
  assert.equal(stale.status, 400);
  assert.match(stale.json.error, /^invalid args: .*required property 'ticket'/, "and so does the check a start makes");
  assert.ok(startedNothing(repo));
});

test("a start from inside a workflow step is refused, like the CLI and the MCP server refuse it", async () => {
  const repo = knownRepo();
  const previous = process.env.WF_INSIDE_WORKFLOW;
  process.env.WF_INSIDE_WORKFLOW = "1";
  try {
    const reply = await start({ repo, workflow: "plain", ...CAPS });
    assert.equal(reply.status, 409);
    assert.equal(reply.json.error, "workflows cannot be started from inside a workflow step");
  } finally {
    if (previous === undefined) delete process.env.WF_INSIDE_WORKFLOW;
    else process.env.WF_INSIDE_WORKFLOW = previous;
  }
  assert.ok(startedNothing(repo));
});
