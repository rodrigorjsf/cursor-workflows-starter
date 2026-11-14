// Seam: the plumbing the real-GitLab scripts share (scripts/lib/gitlab-e2e.ts). `GitLabApi` is driven over real HTTP against a stand-in
// for GitLab's REST API on a loopback port (a `node:http` server that records what it was sent); the environment reader and the
// merge request number are called as functions. What GitLab itself does is the opt-in script's job (scripts/verify/gitlab-e2e.sh).
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { GitLabApi, GitLabHttpError, e2eEnv, mergeRequestNumber } from "../scripts/lib/gitlab-e2e.js";

interface Seen {
  method: string;
  url: string;
  token: string | undefined;
  body: string;
}

let server: Server;
let port: number;
const seen: Seen[] = [];

/** What the stand-in answers: a status and a JSON body, by path. */
const answers: Record<string, { status: number; body: unknown }> = {
  "/api/v4/version": { status: 200, body: { version: "19.5.5" } },
  "/api/v4/projects/owner%2Fnone": { status: 404, body: { message: "404 Project Not Found" } },
  "/api/v4/projects/1/merge_requests/1/merge": { status: 405, body: { message: "405 Method Not Allowed" } },
  "/api/v4/boom": { status: 500, body: { message: "500 Internal Server Error" } },
};

before(async () => {
  server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", token: req.headers["private-token"] as string | undefined, body });
      const answer = answers[req.url ?? ""] ?? { status: 404, body: {} };
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done)); // GitLab in Docker is published on 127.0.0.1 only
  port = (server.address() as AddressInfo).port;
});
after(() => new Promise<void>((done) => server.close(() => done())));

test("a call carries the token and the JSON body, and answers the parsed JSON; a base that says localhost reaches a server on 127.0.0.1", async () => {
  const api = new GitLabApi(`http://localhost:${port}`, "glpat-token-for-the-test");
  assert.deepEqual(await api.call("GET", "/version"), { version: "19.5.5" });
  await api.call("POST", "/version", { a: 1 });
  assert.deepEqual(
    seen.map((s) => [s.method, s.url, s.token, s.body]),
    [
      ["GET", "/api/v4/version", "glpat-token-for-the-test", ""],
      ["POST", "/api/v4/version", "glpat-token-for-the-test", '{"a":1}'],
    ],
  );
});

test("a refused call is a GitLabHttpError that names the call and carries the status, so a caller can tell GitLab's answer from its own bug", async () => {
  const api = new GitLabApi(`http://127.0.0.1:${port}`, "t");
  const refused = await api.call("PUT", "/projects/1/merge_requests/1/merge", {}).then(
    () => undefined,
    (err: unknown) => err,
  );
  assert.ok(refused instanceof GitLabHttpError);
  assert.equal(refused.status, 405);
  assert.match(refused.message, /^PUT \/projects\/1\/merge_requests\/1\/merge: HTTP 405 .*Method Not Allowed/);
  await assert.rejects(api.call("GET", "/boom"), (err: unknown) => err instanceof GitLabHttpError && err.status === 500);
});

test("find answers undefined for a 404 and still fails on any other refusal", async () => {
  const api = new GitLabApi(`http://127.0.0.1:${port}`, "t");
  assert.equal(await api.find("/projects/owner%2Fnone"), undefined);
  assert.deepEqual(await api.find("/version"), { version: "19.5.5" });
  await assert.rejects(api.find("/boom"), (err: unknown) => err instanceof GitLabHttpError && err.status === 500);
});

test("the number of a merge request is read from its URL, on any depth of groups, and is undefined for a text that holds none", () => {
  assert.equal(mergeRequestNumber("http://gitlab.example.com/owner/proof/-/merge_requests/12"), 12);
  assert.equal(mergeRequestNumber("https://gitlab.example.com/a/b/c/proof/-/merge_requests/7\n"), 7);
  assert.equal(mergeRequestNumber("Creating merge request for x into main\nhttp://localhost:8929/owner/repo/-/merge_requests/3"), 3);
  assert.equal(mergeRequestNumber("http://gitlab.example.com/owner/proof/-/issues/12"), undefined);
  assert.equal(mergeRequestNumber(""), undefined);
});

test("the environment the script hands its scripts is read whole, and a missing variable is named", () => {
  const keys = ["GITLAB_E2E_URL", "GITLAB_E2E_TOKEN", "GITLAB_E2E_PASSWORD", "GITLAB_E2E_IMAGE", "GITLAB_E2E_SCRATCH"] as const;
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = `value-of-${key}`;
    assert.deepEqual(e2eEnv(), { url: "value-of-GITLAB_E2E_URL", token: "value-of-GITLAB_E2E_TOKEN", password: "value-of-GITLAB_E2E_PASSWORD", image: "value-of-GITLAB_E2E_IMAGE", scratch: "value-of-GITLAB_E2E_SCRATCH" });
    delete process.env.GITLAB_E2E_PASSWORD;
    assert.throws(() => e2eEnv(), /GITLAB_E2E_PASSWORD is not set: this script is run by scripts\/verify\/gitlab-e2e\.sh/);
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});
