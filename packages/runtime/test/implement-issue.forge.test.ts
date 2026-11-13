// Seam: the shipped `implement-issue` workflow run with `runWorkflow`, with the fake SDK and the environment of
// implement-issue.fixture.ts (fake `gh` and `glab` on the PATH, temp repo, real git); asserts on the run's progress record
// (`.workflows/runs/<runId>/tdd-progress.json`, the file `wf gc` reads) and on what the fake forge CLIs were asked. The forge's own
// calls are pinned by the delivery, robustness, config, hardening and exec tests, which run on the same fakes.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { failForge, forgeState, fx, issue, run, setup, teardown } from "./implement-issue.fixture.js";

beforeEach(setup);
afterEach(teardown);

const progressFile = (runId: string) => join(fx.repo, ".workflows", "runs", runId, "tdd-progress.json");
const progressOf = (runId: string) => JSON.parse(readFileSync(progressFile(runId), "utf8")) as { forge?: string };

test("a new run records its forge, github, in its progress record", async () => {
  issue(["complexity:low"]);
  const r = await run({ openPr: true });
  assert.equal((r.result as { status: string }).status, "done", JSON.stringify(r.result));
  assert.equal(progressOf(r.runId).forge, "github");
});

test("the forge is recorded when the run starts: a run that fails on its first forge call already has it", async () => {
  issue(["complexity:low"]);
  failForge("issue view", "HTTP 401: Bad credentials");
  const r = await run({});
  assert.equal(r.status, "failed", JSON.stringify(r.result));
  assert.match(r.error!, /Bad credentials/);
  assert.equal(progressOf(r.runId).forge, "github");
});

test("a run whose record names a forge this version does not know fails before it calls any forge CLI", async () => {
  issue(["complexity:low"]);
  mkdirSync(join(fx.repo, ".workflows", "runs", "forge-from-the-future"), { recursive: true });
  writeFileSync(progressFile("forge-from-the-future"), JSON.stringify({ slices: [], forge: "bitbucket" }));
  const r = await run({}, "forge-from-the-future");
  assert.equal(r.status, "failed", JSON.stringify(r.result));
  assert.match(r.error!, /forge "bitbucket".*does not know/);
  assert.deepEqual(forgeState().calls, [], "no CLI was asked: the run did not fall back to another forge's");
});
